// A stand-in for stt/stt_worker.py (no Python, no model): speaks the same framed protocol on stdin/stdout.
// The scenario is the value of --model: "auto" (normal), "fatal" (refuses to start), "crash" (exits after ready),
// "silent" (never answers pings), "slow" (never gets ready).
// Normal: audio of a key is collected; "idle" turns it into an utterance whose text is "müzik bot geç" for audio
// with any sample above 1000, else "" (silence); verify repeats the text; ping answers health.
import { FrameDecoder, jsonFrame } from '../../src/ozellikler/sesli-komut/protokol.js';

const args = process.argv.slice(2);
const scenario = args[args.indexOf('--model') + 1] ?? 'auto';
const send = (message) => process.stdout.write(jsonFrame(message));

if (scenario === 'fatal') {
  send({ t: 'fatal', msg: 'model yok: turbo' });
  process.exit(3);
}
if (scenario !== 'slow') {
  send({ t: 'ready', model: 'turbo', device: 'cuda', compute: 'int8_float16', beam: 5, loadSec: 0, warmSec: 0 });
}
if (scenario === 'crash') setTimeout(() => process.exit(1), 50);

const audio = new Map();
const held = new Map();
const config = { hotwords: null, wakes: {} };
let nextId = 0;
const decoder = new FrameDecoder();
process.stdin.on('data', (chunk) => {
  for (const frame of decoder.push(chunk)) {
    if (frame.kind === 2) {
      const list = audio.get(frame.key) ?? [];
      list.push(frame.pcm);
      audio.set(frame.key, list);
      continue;
    }
    const m = frame.json;
    if (m.t === 'config') config.hotwords = m.hotwords;
    else if (m.t === 'guild') config.wakes[m.g] = m.wake;
    else if (m.t === 'end') audio.delete(m.k);
    else if (m.t === 'endGuild') {
      for (const k of [...audio.keys()]) if (k.startsWith(`${m.g}:`)) audio.delete(k);
    } else if (m.t === 'idle') {
      const list = audio.get(m.k) ?? [];
      audio.delete(m.k);
      const samples = list.reduce((n, p) => n + p.length, 0);
      if (!samples) continue;
      const loud = list.some((p) => p.some((s) => Math.abs(s) > 1000));
      const id = ++nextId;
      const text = loud ? `${config.wakes[m.k.split(':')[0]] ?? '?'} geç` : '';
      held.set(id, text);
      send({
        t: 'utt',
        id,
        k: m.k,
        dur: samples / 16000,
        text,
        nsp: loud ? 0.01 : 0.9,
        cr: 1,
        logp: -0.2,
        sec: 0.1,
        gate: null,
      });
    } else if (m.t === 'verify') {
      send(
        held.has(m.id)
          ? { t: 'verified', id: m.id, text: held.get(m.id), nsp: 0.01, cr: 1 }
          : { t: 'verified', id: m.id, gone: true },
      );
      held.delete(m.id);
    } else if (m.t === 'retry') {
      send(
        held.has(m.id)
          ? { t: 'retried', id: m.id, text: held.get(m.id), nsp: 0.01, cr: 1 }
          : { t: 'retried', id: m.id, gone: true },
      );
    } else if (m.t === 'ping' && scenario !== 'silent') {
      send({
        t: 'health',
        id: m.id,
        streams: audio.size,
        queue: 0,
        model: 'turbo',
        device: 'cuda',
        hotwords: config.hotwords,
      });
    } else if (m.t === 'shutdown') process.exit(0);
  }
});
process.stdin.on('end', () => process.exit(0));
