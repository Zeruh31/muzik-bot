// Node ile konuşma tanıma işçisi (stt/stt_worker.py) arasındaki çerçeve biçimi. İki yönde de:
//   uint32 (little-endian) uzunluk N, ardından N bayt: 1 bayt tür + yük
//   tür 1  JSON (UTF-8)
//   tür 2  ses (yalnız Node → işçi): 1 bayt anahtar uzunluğu L, L bayt anahtar ("sunucu:kullanıcı"), s16le 16 kHz mono
// Normalde bu dosyaya dokunmana gerek yok.

export const KIND_JSON = 1;
export const KIND_AUDIO = 2;
/** The worker refuses bigger frames; the decoder here too (a broken stream must not grow memory). */
export const MAX_FRAME = 1 << 20;
const KEY = /^[0-9]{1,20}:[0-9]{1,20}$/;

/** A JSON frame. */
export function jsonFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.alloc(5);
  head.writeUInt32LE(body.length + 1, 0);
  head.writeUInt8(KIND_JSON, 4);
  return Buffer.concat([head, body]);
}

/** An audio frame for one speaker. `pcm` is an Int16Array of 16 kHz mono samples. */
export function audioFrame(key, pcm) {
  if (!KEY.test(key)) throw new Error(`Geçersiz ses anahtarı: ${key}`);
  const keyBytes = Buffer.from(key, 'ascii');
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const head = Buffer.alloc(6);
  head.writeUInt32LE(1 + 1 + keyBytes.length + data.length, 0);
  head.writeUInt8(KIND_AUDIO, 4);
  head.writeUInt8(keyBytes.length, 5);
  return Buffer.concat([head, keyBytes, data]);
}

/**
 * Splits a byte stream into frames. push() returns the complete frames so far as { kind, json?, key?, pcm? };
 * a frame that is too big or malformed throws (the caller then restarts the worker).
 */
export class FrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    const frames = [];
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length < 1 || length > MAX_FRAME) throw new Error(`Bozuk çerçeve (${length} bayt)`);
      if (this.#buffer.length < 4 + length) break;
      const body = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);
      const kind = body[0];
      if (kind === KIND_JSON) {
        frames.push({ kind, json: JSON.parse(body.subarray(1).toString('utf8')) });
      } else if (kind === KIND_AUDIO) {
        const keyLength = body[1];
        const key = body.subarray(2, 2 + keyLength).toString('ascii');
        const bytes = body.subarray(2 + keyLength);
        const pcm = new Int16Array(bytes.length >> 1); // own aligned copy
        Buffer.from(pcm.buffer).set(bytes.subarray(0, pcm.byteLength));
        frames.push({ kind, key, pcm });
      } else {
        throw new Error(`Bilinmeyen çerçeve türü ${kind}`);
      }
    }
    return frames;
  }
}
