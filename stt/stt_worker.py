"""Speech-to-text worker of the voice command feature (src/ozellikler/sesli-komut).

Local only: audio arrives on stdin, is kept in memory and dropped after use. Nothing is written to disk and
nothing is sent anywhere (Hugging Face is forced offline; the models were downloaded by the installer).

Framing, both directions: uint32 little-endian length N, then N bytes: 1 byte kind + payload.
  kind 1  JSON (UTF-8)
  kind 2  audio (stdin only): 1 byte key length L, L bytes key (ASCII "guildId:userId"), s16le 16 kHz mono PCM
Messages in:  config {hotwords}, guild {g, wake}, idle {k}, end {k}, endGuild {g}, verify {id}, retry {id, hotwords},
              ping {id}, shutdown
Messages out: ready, utt {id, k, dur, text, nsp, cr, logp, sec, gate, vad, age}, skip {k, why}, verified {id, ...},
              retried {id, ...},
              health {id, ...}, error {msg}, fatal {msg}
The protocol is pinned by test/sesli-komut-isci.test.js (with a fake worker) on the Node side.

usage: python -I -X utf8 stt_worker.py --root <component dir> [--model auto|turbo|small] [--device auto|cuda|cpu]
"""

import argparse
import collections
import glob
import json
import os
import re
import struct
import subprocess
import sys
import threading
import time
import unicodedata

# Never reach the network: the installer downloaded the models; a missing file must fail, not download.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

# CTranslate2 on Windows loads cuBLAS 12 / cuDNN 9 from the nvidia-* wheels (site-packages/nvidia/*/bin).
for _d in glob.glob(os.path.join(sys.prefix, "Lib", "site-packages", "nvidia", "*", "bin")):
    try:
        os.add_dll_directory(_d)
    except (AttributeError, OSError):
        pass
    os.environ["PATH"] = _d + os.pathsep + os.environ.get("PATH", "")

PROTO_OUT = sys.stdout.buffer
PROTO_IN = sys.stdin.buffer
sys.stdout = sys.stderr  # library prints must never reach the protocol channel

import numpy as np  # noqa: E402

sys.dont_write_bytecode = True  # nothing written into the project folder
# -I leaves the script folder off sys.path: add it for the job queue module next to this file.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kuyruk import Held, JobQueue  # noqa: E402

SR = 16000
CHUNK = 512  # Silero VAD v6 window at 16 kHz (32 ms)
CONTEXT = 64
MAX_FRAME = 1 << 20
KIND_JSON = 1
KIND_AUDIO = 2

ap = argparse.ArgumentParser()
ap.add_argument("--root", required=True, help="component folder with models/turbo and models/small")
ap.add_argument("--model", default="auto", choices=["auto", "turbo", "small"])
ap.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"])
ap.add_argument("--min-sec", type=float, default=0.6)
ap.add_argument("--max-age", type=float, default=4.0, help="a sentence that waited longer is dropped")
ap.add_argument("--max-sec", type=float, default=10.0)
ap.add_argument("--min-free-vram-mb", type=int, default=3000)
ap.add_argument("--prefix-sec", type=float, default=1.5)
ap.add_argument("--cpu-beam", type=int, default=1, help="beam size on the CPU (karar: 1)")
ap.add_argument("--threads", type=int, default=min(4, os.cpu_count() or 4))
args = ap.parse_args()

out_lock = threading.Lock()


def send(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    with out_lock:
        PROTO_OUT.write(struct.pack("<IB", len(data) + 1, KIND_JSON) + data)
        PROTO_OUT.flush()


def log(text):
    print(text, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------------------------- wake prefix gate
# Only a cheap, lenient check for the CPU pre-slice gate. The real decision (4 gates) is made by the Node side.
TR_LOWER = str.maketrans({"I": "ı", "İ": "i"})


def fold(text):
    t = text.translate(TR_LOWER).lower().replace("ı", "i")
    t = "".join(c for c in unicodedata.normalize("NFD", t) if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", t)).strip()


def lev(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def maybe_wake(text, wake):
    w = fold(wake).replace(" ", "")
    words = fold(text).split()
    for i in range(min(3, len(words))):
        for j in range(i + 1, min(len(words), i + 4) + 1):
            cand = "".join(words[i:j])
            if lev(cand, w) <= 3:
                return True
            # The first syllable may be lost at the very start: compare with the end of the wake phrase.
            if i == 0 and 4 <= len(cand) < len(w) and lev(cand, w[len(w) - len(cand):]) <= 1:
                return True
    return False


# ---------------------------------------------------------------------------------------------- model
def free_vram_mb():
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        values = [int(v) for v in out.stdout.split() if v.strip().isdigit()]
        return max(values) if values else None
    except Exception:
        return None


def load_model():
    import ctranslate2
    from faster_whisper import WhisperModel

    models = os.path.join(args.root, "models")
    have = {name: os.path.isfile(os.path.join(models, name, "model.bin")) for name in ("turbo", "small")}
    cuda = args.device != "cpu" and ctranslate2.get_cuda_device_count() > 0
    if args.device == "cuda" and not cuda:
        log("CUDA aygıtı yok; CPU kullanılıyor")
    vram = free_vram_mb() if cuda else None
    if args.model == "auto":
        name = "turbo" if cuda and (vram is None or vram >= args.min_free_vram_mb) else "small"
    else:
        name = args.model
    if not have.get(name):
        other = "small" if name == "turbo" else "turbo"
        if args.model == "auto" and have.get(other) and (other == "small" or cuda):
            name = other
        else:
            raise FileNotFoundError(f"model yok: {name}")
    t = time.perf_counter()
    path = os.path.join(models, name)
    if cuda:
        try:
            return WhisperModel(path, device="cuda", compute_type="int8_float16"), name, "cuda", "int8_float16", vram, t
        except Exception as e:  # driver or DLL problem: fall back to the CPU
            log(f"GPU kullanılamadı ({e}); CPU'ya geçiliyor")
            if name == "turbo" and args.model == "auto" and have.get("small"):
                name, path = "small", os.path.join(models, "small")
    return (WhisperModel(path, device="cpu", compute_type="int8", cpu_threads=args.threads), name, "cpu", "int8",
            None, t)


try:
    model, MODEL_NAME, DEVICE, COMPUTE, VRAM, t_load = load_model()
    LOAD_SEC = time.perf_counter() - t_load
    from faster_whisper.vad import get_vad_model

    VAD = get_vad_model().session
except Exception as e:
    send({"t": "fatal", "msg": str(e)[:300]})
    sys.exit(3)

ON_CPU = DEVICE == "cpu"
BEAM = max(1, args.cpu_beam) if ON_CPU else 5
hotwords = None
wakes = {}  # guild id -> wake phrase as the user wrote it


def transcribe(audio, wake, use_hotwords):
    t = time.perf_counter()
    segs, _ = model.transcribe(
        audio, language="tr", beam_size=BEAM, temperature=0.0, without_timestamps=True,
        condition_on_previous_text=False, vad_filter=False,
        initial_prompt=f"{wake}," if wake else None,
        hotwords=hotwords if use_hotwords else None,
    )
    segs = list(segs)
    return {
        "text": " ".join(s.text for s in segs).strip(),
        "nsp": round(max((s.no_speech_prob for s in segs), default=1.0), 3),
        "cr": round(max((s.compression_ratio for s in segs), default=0.0), 3),
        "logp": round(min((s.avg_logprob for s in segs), default=0.0), 3),
        "sec": round(time.perf_counter() - t, 3),
    }


t_warm = time.perf_counter()
transcribe(np.zeros(SR, np.float32), "", False)
WARM_SEC = time.perf_counter() - t_warm


# ---------------------------------------------------------------------------------------------- VAD streams
class Stream:
    """One speaker: Silero VAD state, a 500 ms ring of audio before speech, the utterance being collected."""

    START, KEEP = 0.5, 0.35
    END_SILENCE = int(0.6 * SR / CHUNK)  # ~600 ms below KEEP ends an utterance
    RING = int(0.5 * SR / CHUNK) + 1  # ~500 ms kept before the speech onset

    def __init__(self, key):
        self.key = key
        self.reset_vad()
        self.ring = collections.deque(maxlen=self.RING)
        self.rest = np.zeros(0, np.float32)
        self.speech = None  # list of chunks while triggered
        self.samples = 0
        self.silence = 0
        self.peak = 0.0  # highest speech probability of the utterance being collected
        self.peak_idle = 0.0  # ... of audio that did not start an utterance
        self.speech_chunks = 0
        self.onset_ms = None
        self.artificial = False
        self.split = False  # the previous utterance was cut at max_sec and the speech goes on
        self.heard = 0  # chunks since the last idle (to tell "no audio" from "audio below the threshold")

    def reset_vad(self):
        self.h = np.zeros((1, 1, 128), np.float32)
        self.c = np.zeros((1, 1, 128), np.float32)
        self.ctx = np.zeros(CONTEXT, np.float32)

    def prob(self, chunk):
        x = np.concatenate([self.ctx, chunk])[None, :]
        p, self.h, self.c = VAD.run(None, {"input": x, "h": self.h, "c": self.c})
        self.ctx = chunk[-CONTEXT:]
        return float(np.asarray(p).reshape(-1)[0])

    def push(self, pcm):
        """Feeds float audio; returns finished utterances as (skip reason or None, audio, vad info)."""
        data = np.concatenate([self.rest, pcm]) if self.rest.size else pcm
        n = data.size // CHUNK * CHUNK
        self.rest = data[n:].copy()
        done = []
        for i in range(0, n, CHUNK):
            chunk = data[i:i + CHUNK]
            p = self.prob(chunk)
            self.heard += 1
            if self.speech is None:
                self.ring.append(chunk)
                self.peak_idle = max(self.peak_idle, p)
                if p >= self.START:
                    # How long the received audio ran before speech started: about 0 means the start may be cut
                    # (Discord's voice activity opened late); after a max_sec split it is an artificial start.
                    self.onset_ms = int((self.heard - 1) * CHUNK * 1000 / SR)
                    self.artificial = self.split
                    self.split = False
                    self.speech = list(self.ring)
                    self.samples = sum(c.size for c in self.speech)
                    self.ring.clear()
                    self.silence = 0
                    self.peak = p
                    self.speech_chunks = 0
                continue
            self.speech.append(chunk)
            self.samples += chunk.size
            self.peak = max(self.peak, p)
            if p >= self.KEEP:
                self.speech_chunks += 1
            self.silence = 0 if p >= self.KEEP else self.silence + 1
            if self.silence >= self.END_SILENCE:
                done.append(self.finish("sessizlik", trailing=self.silence))
            elif self.samples >= args.max_sec * SR:
                # Never dropped for being long (an open microphone or music behind the speaker gives no pause):
                # the first max_sec go on, the command is at the start anyway; what follows starts again.
                done.append(self.finish("azami"))
                self.split = True
        return done

    def finish(self, reason, trailing=0):
        speech = self.speech
        self.speech, self.samples, self.silence = None, 0, 0
        self.heard, self.peak_idle = 0, 0.0
        if speech is None:
            return None
        keep = max(0, len(speech) - max(0, trailing - 6))  # leave ~200 ms of the closing silence
        audio = np.concatenate(speech[:keep]) if keep else np.zeros(0, np.float32)
        vad = {"bitis": reason, "tepe": round(self.peak, 2), "konusma": round(self.speech_chunks * CHUNK / SR, 2),
               "onsetMs": self.onset_ms, "yapay": self.artificial}
        return (None, audio, vad)

    def idle(self):
        """The speaker stopped sending audio: Discord sends nothing in silence, so this ends the utterance."""
        result = self.finish("idle") if self.speech is not None else None
        if result is None and self.heard:
            # Audio came but never reached the speech threshold (quiet microphone, noise suppression).
            result = ("vad", np.zeros(0, np.float32), {"bitis": "tetiklenmedi",
                      "tepe": round(self.peak_idle, 2), "duyulan": round(self.heard * CHUNK / SR, 2)})
        self.heard = 0
        self.peak_idle = 0.0
        self.split = False
        self.rest = np.zeros(0, np.float32)
        self.ring.clear()
        self.reset_vad()
        return [result] if result else []


streams = {}
jobs = JobQueue(max_utts=4, max_age=args.max_age)
held = Held(hold_sec=15.0, max_items=8)
next_id = 0
started = time.time()


def guild_of(key):
    return key.split(":", 1)[0]


def emit_utterances(key, results):
    global next_id
    for result in results:
        if result is None:
            continue
        why, audio, vad = result
        dur = round(audio.size / SR, 2)
        if why:
            send({"t": "skip", "k": key, "why": why, "dur": vad.get("duyulan", dur), "vad": vad})
        elif dur < args.min_sec:
            send({"t": "skip", "k": key, "why": "short", "dur": dur, "vad": vad})
        else:
            next_id += 1
            dropped = jobs.put_utt(next_id, key, (audio, vad))
            if dropped:
                send({"t": "skip", "k": dropped[1], "why": "busy"})


def decode_loop():
    while True:
        job = jobs.get(timeout=5)
        if job is None:
            return
        held.expire()  # also while idle: held audio never outlives its 15 s
        try:
            if job[0] == "timeout":
                continue
            if job[0] == "stale":
                send({"t": "skip", "k": job[2], "why": "stale"})
            elif job[0] == "utt":
                _, uid, key, (audio, vad), ended_at = job
                wake = wakes.get(guild_of(key), "")
                gate = None
                if ON_CPU and wake and audio.size > args.prefix_sec * SR * 1.2:
                    head = transcribe(audio[: int(args.prefix_sec * SR)], wake, True)
                    gate = "prefix"
                    if not maybe_wake(head["text"], wake):
                        send({"t": "skip", "k": key, "why": "prefix", "dur": round(audio.size / SR, 2), "vad": vad})
                        continue
                r = transcribe(audio, wake, True)
                if key not in streams:
                    continue  # the speaker left or excluded themselves meanwhile: nothing is kept or sent
                held.put(uid, key, audio, wake)
                # age: seconds since the sentence ended (the Node side refuses commands that are too old)
                send({"t": "utt", "id": uid, "k": key, "dur": round(audio.size / SR, 2), "gate": gate, "vad": vad,
                      "age": round(time.monotonic() - ended_at, 3), **r})
            elif job[0] == "verify":
                # ("verify", uid): second pass with the wake phrase as prompt, no hotwords (çift kanıt);
                # ("retry", uid, hotwords): a pass without any prompt - the Node side asks for it only when the
                # text had no wake phrase but was a command, because the prompt can make Whisper leave the wake
                # phrase out ("Kutluay bot, sırada ne var" -> "Sırada ne var?").
                item = job[1] if isinstance(job[1], tuple) else ("verify", job[1], False)
                kind, uid, use_hotwords = item
                held_item = held.peek(uid)
                reply = "verified" if kind == "verify" else "retried"
                if not held_item:
                    send({"t": reply, "id": uid, "gone": True})
                    continue
                _, audio, wake = held_item
                prompt = wake if kind == "verify" else ""
                send({"t": reply, "id": uid, **transcribe(audio, prompt, bool(use_hotwords))})
        except Exception as e:
            send({"t": "error", "msg": str(e)[:300]})


def read_exact(n):
    buf = bytearray()
    while len(buf) < n:
        part = PROTO_IN.read(n - len(buf))
        if not part:
            return None
        buf += part
    return bytes(buf)


def handle_json(msg):
    global hotwords
    t = msg.get("t")
    if t == "config":
        hw = msg.get("hotwords")
        hotwords = str(hw)[:500] if hw else None
    elif t == "guild":
        wake = str(msg.get("wake") or "")[:60]
        if wake:
            wakes[str(msg.get("g"))] = wake
        else:
            wakes.pop(str(msg.get("g")), None)
    elif t == "idle":
        s = streams.get(str(msg.get("k")))
        if s:
            emit_utterances(s.key, s.idle())
    elif t == "end":
        # The speaker left or excluded themselves: their stream, waiting sentences and held audio go at once.
        key = str(msg.get("k"))
        streams.pop(key, None)
        jobs.drop_key(lambda k: k == key)
        held.drop_key(lambda k: k == key)
    elif t == "endGuild":
        g = str(msg.get("g"))
        for key in [k for k in streams if guild_of(k) == g]:
            del streams[key]
        wakes.pop(g, None)
        jobs.drop_key(lambda k: guild_of(k) == g)
        held.drop_key(lambda k: guild_of(k) == g)
    elif t == "verify":
        try:
            jobs.put_verify(("verify", int(msg.get("id")), False))
        except (TypeError, ValueError):
            send({"t": "verified", "id": msg.get("id"), "gone": True})
    elif t == "retry":
        try:
            jobs.put_verify(("retry", int(msg.get("id")), bool(msg.get("hotwords"))))
        except (TypeError, ValueError):
            send({"t": "retried", "id": msg.get("id"), "gone": True})
    elif t == "ping":
        send({"t": "health", "id": msg.get("id"), "streams": len(streams), "queue": jobs.size(), "held": len(held),
              "model": MODEL_NAME, "device": DEVICE, "uptime": round(time.time() - started)})
    elif t == "shutdown":
        return False
    return True


def main():
    worker = threading.Thread(target=decode_loop, daemon=True)
    worker.start()
    send({"t": "ready", "model": MODEL_NAME, "device": DEVICE, "compute": COMPUTE, "beam": BEAM,
          "loadSec": round(LOAD_SEC, 2), "warmSec": round(WARM_SEC, 2), "freeVramMb": VRAM})
    while True:
        head = read_exact(4)
        if head is None:
            break
        (length,) = struct.unpack("<I", head)
        if length < 1 or length > MAX_FRAME:
            send({"t": "fatal", "msg": f"bozuk çerçeve ({length} bayt)"})
            break
        body = read_exact(length)
        if body is None:
            break
        kind, payload = body[0], body[1:]
        try:
            if kind == KIND_JSON:
                if not handle_json(json.loads(payload.decode("utf-8"))):
                    break
            elif kind == KIND_AUDIO and payload:
                klen = payload[0]
                key = payload[1:1 + klen].decode("ascii")
                pcm = np.frombuffer(payload[1 + klen:], dtype="<i2").astype(np.float32) / 32768.0
                s = streams.get(key)
                if s is None:
                    s = streams[key] = Stream(key)
                emit_utterances(key, s.push(pcm))
        except Exception as e:
            send({"t": "error", "msg": str(e)[:300]})
    jobs.close()
    worker.join(timeout=5)


if __name__ == "__main__":
    main()
