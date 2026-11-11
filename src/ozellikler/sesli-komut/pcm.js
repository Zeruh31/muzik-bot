// Discord'un sesi (Opus çözülünce 48 kHz stereo) → konuşma tanıma için 16 kHz mono. Konuşmacı başına bir örnek;
// durumlu olduğu için ardışık 20 ms'lik çerçeveler tıkırtısız birleşir. Ölçüm: ses saniyesi başına ~2.6 ms.
// Normalde bu dosyaya dokunmana gerek yok.

const TAPS = 47;
const CUTOFF = 7000 / 48000; // normalised cutoff, below the 8 kHz Nyquist of the 16 kHz output

function makeKernel() {
  const h = new Float32Array(TAPS);
  const mid = (TAPS - 1) / 2;
  let sum = 0;
  for (let i = 0; i < TAPS; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * CUTOFF : Math.sin(2 * Math.PI * CUTOFF * x) / (Math.PI * x);
    const blackman =
      0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (TAPS - 1));
    h[i] = sinc * blackman;
    sum += h[i];
  }
  for (let i = 0; i < TAPS; i++) h[i] /= sum;
  return h;
}
const KERNEL = makeKernel();

export class Downsampler48kStereoTo16kMono {
  #hist = new Float32Array(TAPS - 1); // last mono samples of the previous frame
  #phase = 0; // index (in the joined stream) of the next output sample, modulo 3

  /** @param {Buffer} pcm interleaved s16le stereo at 48 kHz  @returns {Int16Array} mono s16 at 16 kHz */
  push(pcm) {
    const frames = pcm.length >> 2;
    const len = this.#hist.length + frames;
    const mono = new Float32Array(len);
    mono.set(this.#hist, 0);
    for (let i = 0, o = this.#hist.length; i < frames; i++, o++) {
      mono[o] = (pcm.readInt16LE(i * 4) + pcm.readInt16LE(i * 4 + 2)) * 0.5;
    }
    const out = [];
    let n = TAPS - 1 + this.#phase;
    for (; n < len; n += 3) {
      let acc = 0;
      for (let k = 0; k < TAPS; k++) acc += KERNEL[k] * mono[n - k];
      out.push(acc > 32767 ? 32767 : acc < -32768 ? -32768 : Math.round(acc));
    }
    this.#phase = n - len;
    this.#hist = mono.slice(len - (TAPS - 1));
    return Int16Array.from(out);
  }
}
