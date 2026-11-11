"""Downloads the speech models of the voice command component (run by the desktop app's installer).

Each model is pinned to a Hugging Face commit and its model.bin is checked with SHA-256 after the download.
Prints one JSON line per step on stdout: {"model", "asama": "basliyor"|"bitti"|"hata", "mesaj"?}.
Re-running continues an interrupted download (huggingface_hub resumes files) and skips verified models.

usage: python -I -X utf8 model_indir.py --out <component dir>/models --models turbo,small
"""

import argparse
import hashlib
import json
import os
import sys

os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

# name -> (repository, commit, sha256 of model.bin). Licences: MIT (OpenAI Whisper weights, CTranslate2 conversions).
MODELS = {
    "turbo": (
        "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
        "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf",
        "e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da",
    ),
    "small": (
        "Systran/faster-whisper-small",
        "536b0662742c02347bc0e980a01041f333bce120",
        "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671",
    ),
}


def say(**obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--models", default="turbo,small")
    args = ap.parse_args()
    names = [n for n in args.models.split(",") if n]
    unknown = [n for n in names if n not in MODELS]
    if unknown:
        say(model=",".join(unknown), asama="hata", mesaj="bilinmeyen model")
        return 2
    from faster_whisper.utils import download_model

    for name in names:
        repo, commit, digest = MODELS[name]
        target = os.path.join(args.out, name)
        binary = os.path.join(target, "model.bin")
        if os.path.isfile(binary) and sha256(binary) == digest:
            say(model=name, asama="bitti", mesaj="zaten var")
            continue
        say(model=name, asama="basliyor")
        try:
            download_model(repo, output_dir=target, revision=commit)
        except Exception as e:
            say(model=name, asama="hata", mesaj=str(e)[:300])
            return 1
        if sha256(binary) != digest:
            os.remove(binary)
            say(model=name, asama="hata", mesaj="SHA-256 uyuşmadı; dosya silindi")
            return 1
        say(model=name, asama="bitti")
    return 0


if __name__ == "__main__":
    sys.exit(main())
