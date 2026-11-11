// Crossfade: the PCM mixer on its own (byte-exact hand-over, gains, back-pressure) and the
// GuildPlayer around it with a fake @discordjs/voice that really reads the resource streams.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { AudioPlayerStatus, VoiceConnectionStatus } from '@discordjs/voice';
import { CrossfadeMixer, PCM_BYTES_PER_MS, fadeGains, mixFade, pcmBytes } from '../src/music/crossfade.js';
import { GuildPlayer } from '../src/music/GuildPlayer.js';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await tick();
};

/** PCM where every sample of both channels is `value` (easy to tell two tracks apart). */
function constantPcm(ms, value) {
  const buffer = Buffer.alloc(pcmBytes(ms));
  for (let i = 0; i < buffer.length; i += 2) buffer.writeInt16LE(value, i);
  return buffer;
}

/** PCM whose sample i is i % 30000 (left) and -(i % 30000) (right): every position is unique. */
function rampPcm(ms) {
  const buffer = Buffer.alloc(pcmBytes(ms));
  for (let i = 0, f = 0; i < buffer.length; i += 4, f++) {
    buffer.writeInt16LE(f % 30000, i);
    buffer.writeInt16LE(-(f % 30000), i + 2);
  }
  return buffer;
}

/** A readable that hands out `buffer` in chunks of random-ish sizes (odd sizes included). */
function chunked(buffer, sizes = [4096, 333, 65536, 7, 12_000]) {
  let offset = 0;
  let i = 0;
  return new Readable({
    read() {
      if (offset >= buffer.length) {
        this.push(null);
        return;
      }
      const size = sizes[i++ % sizes.length];
      this.push(buffer.subarray(offset, offset + size));
      offset += size;
    },
  });
}

async function readAll(stream) {
  const parts = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts);
}

describe('crossfade math', () => {
  it('equal-power gains start at (1, 0), end at (0, 1) and keep the power constant', () => {
    assert.deepEqual(fadeGains(0), { out: 1, in: 0 });
    const end = fadeGains(1);
    assert.ok(Math.abs(end.out) < 1e-12 && end.in === 1);
    for (const p of [0.1, 0.25, 0.5, 0.9]) {
      const g = fadeGains(p);
      assert.ok(Math.abs(g.out ** 2 + g.in ** 2 - 1) < 1e-12);
    }
  });

  it('mixFade blends both signals, clamps, and treats a missing side as silence', () => {
    const a = constantPcm(10, 10_000);
    const b = constantPcm(10, 20_000);
    const length = a.length;
    const mid = mixFade(a, b, { offset: length / 2, fadeBytes: length * 2, length: 4 });
    // p = 0.25: 10000*cos(pi/8) + 20000*sin(pi/8)
    const expected = Math.round(10_000 * Math.cos(Math.PI / 8) + 20_000 * Math.sin(Math.PI / 8));
    assert.equal(mid.readInt16LE(0), expected);
    const loud = mixFade(constantPcm(1, 32_000), constantPcm(1, 32_000), { offset: 96, fadeBytes: 192, length: 4 });
    assert.equal(loud.readInt16LE(0), 32_767, 'clamped instead of wrapping around');
    const onlyB = mixFade(null, b, { offset: 0, fadeBytes: 8, length: 8 });
    assert.equal(onlyB.readInt16LE(0), 0);
    assert.equal(onlyB.readInt16LE(4), Math.round(20_000 * Math.sin(Math.PI / 4)));
  });
});

describe('CrossfadeMixer', () => {
  it('passes the primary through unchanged without a fade', async () => {
    const pcm = rampPcm(500);
    const out = await readAll(new CrossfadeMixer(chunked(pcm)));
    assert.ok(out.equals(pcm));
  });

  it('fades at the given byte, ends after the fade and leaves the rest of the next track untouched', async () => {
    const a = constantPcm(3000, 10_000);
    const bPcm = rampPcm(3000);
    const nextMixer = new CrossfadeMixer(chunked(bPcm));
    const mixer = new CrossfadeMixer(chunked(a));
    const events = [];
    mixer.scheduleFade({
      atByte: pcmBytes(2000),
      fadeBytes: pcmBytes(1000),
      next: nextMixer,
      shouldStart: () => events.push('asked') > 0,
      onStart: () => events.push(['start', mixer.bytesOut]),
    });
    const out = await readAll(mixer);
    assert.deepEqual(events, ['asked', ['start', pcmBytes(2000)]]);
    assert.equal(out.length, pcmBytes(3000), 'A until the fade, then exactly one fade length');
    assert.ok(out.subarray(0, pcmBytes(2000)).equals(a.subarray(0, pcmBytes(2000))), 'before the fade: A as it is');

    // In the fade every frame is A*cos + B*sin of its own position.
    const fadeBytes = pcmBytes(1000);
    for (const ms of [0, 250, 500, 750, 999]) {
      const pos = pcmBytes(ms);
      const g = fadeGains(pos / fadeBytes);
      const expected = Math.round(10_000 * g.out + bPcm.readInt16LE(pos) * g.in);
      assert.equal(out.readInt16LE(pcmBytes(2000) + pos), Math.max(-32768, Math.min(32767, expected)), `at ${ms} ms`);
    }
    // The next track's mixer continues exactly where the fade stopped.
    const rest = await readAll(nextMixer);
    assert.ok(rest.equals(bPcm.subarray(fadeBytes)), 'no sample of B lost or doubled');
  });

  it('keeps fading the next track in when the outgoing one ends early (shorter than announced)', async () => {
    const a = constantPcm(1500, 8000);
    const b = constantPcm(3000, 16_000);
    const nextMixer = new CrossfadeMixer(chunked(b));
    const mixer = new CrossfadeMixer(chunked(a));
    mixer.scheduleFade({ atByte: pcmBytes(1000), fadeBytes: pcmBytes(1000), next: nextMixer });
    const out = await readAll(mixer);
    assert.equal(out.length, pcmBytes(2000));
    // After A ended (1500 ms) only B is heard, still rising.
    const at = (ms) => out.readInt16LE(pcmBytes(ms));
    assert.equal(at(1600), Math.round(16_000 * fadeGains(0.6).in));
    assert.ok(at(1999) > at(1600));
    assert.equal((await readAll(nextMixer)).length, pcmBytes(2000));
  });

  it('shouldStart() false keeps the primary playing to its end', async () => {
    const a = rampPcm(1000);
    const nextMixer = new CrossfadeMixer(chunked(constantPcm(1000, 5)));
    const mixer = new CrossfadeMixer(chunked(a));
    let started = false;
    mixer.scheduleFade({
      atByte: pcmBytes(500),
      fadeBytes: pcmBytes(300),
      next: nextMixer,
      shouldStart: () => false,
      onStart: () => {
        started = true;
      },
    });
    const out = await readAll(mixer);
    assert.equal(started, false);
    assert.ok(out.equals(a));
    assert.equal(nextMixer.consumed, 0, 'nothing of the next track was used');
    assert.ok((await readAll(nextMixer)).equals(constantPcm(1000, 5)), 'it still starts from its beginning');
  });

  it('does not pull more than its buffer from a fast source (back-pressure)', async () => {
    let produced = 0;
    const source = new Readable({
      highWaterMark: 16 * 1024,
      read() {
        produced += 16 * 1024;
        this.push(Buffer.alloc(16 * 1024));
      },
    });
    const mixer = new CrossfadeMixer(source, { highWaterMark: 64 * 1024 });
    mixer.read(0);
    await settle(20);
    assert.ok(produced < 512 * 1024, `bounded buffering (${produced} bytes)`);
    mixer.destroy();
  });
});

// ---------------------------------------------------------------- GuildPlayer + crossfade

/**
 * Fake @discordjs/voice whose resources really read their stream: advance(ms) consumes that much
 * PCM from the playing resource (20 ms frames), counts playbackDuration and goes Idle at the end.
 * Everything played is recorded in `played`.
 */
function readingVoice() {
  const played = [];
  const audioPlayer = Object.assign(new EventEmitter(), {
    state: { status: AudioPlayerStatus.Idle },
    play(resource) {
      const old = this.state;
      this.state = { status: AudioPlayerStatus.Playing, resource };
      this.emit('stateChange', old, this.state);
    },
    stop() {
      const old = this.state;
      if (old.status === AudioPlayerStatus.Idle) return false;
      this.state = { status: AudioPlayerStatus.Idle };
      this.emit('stateChange', old, this.state);
      return true;
    },
    pause() {
      this.state = { ...this.state, status: AudioPlayerStatus.Paused };
      return true;
    },
    unpause() {
      this.state = { ...this.state, status: AudioPlayerStatus.Playing };
      return true;
    },
  });
  const connection = Object.assign(new EventEmitter(), {
    state: { status: VoiceConnectionStatus.Ready },
    joinConfig: { channelId: 'v1' },
    subscribe() {},
    destroy() {
      this.state = { status: VoiceConnectionStatus.Destroyed };
    },
  });
  const resources = [];
  const frame = 20 * PCM_BYTES_PER_MS;

  async function readFrame(stream) {
    for (;;) {
      // Whole 20 ms frames; the last, shorter piece once the stream has ended.
      const chunk = stream.read(frame) ?? (stream._readableState?.ended ? stream.read() : null);
      if (chunk) return chunk;
      if (stream.readableEnded || stream.destroyed) return null;
      // A partial frame is buffered: adding a 'readable' listener now would fire at once (Node), so
      // yield to I/O instead until the rest arrives.
      if (stream.readableLength > 0) {
        await new Promise((resolve) => setImmediate(resolve));
        continue;
      }
      await new Promise((resolve) => {
        const done = () => {
          stream.off('readable', done);
          stream.off('end', done);
          stream.off('close', done);
          resolve();
        };
        stream.on('readable', done);
        stream.on('end', done);
        stream.on('close', done);
      });
    }
  }

  return {
    audioPlayer,
    connection,
    resources,
    played,
    /** Plays `ms` of audio from whatever resource is current (hand-overs included). */
    async advance(ms) {
      let left = ms;
      while (left > 0) {
        const { status, resource } = audioPlayer.state;
        if (status !== AudioPlayerStatus.Playing || !resource) {
          await settle();
          if (audioPlayer.state.status !== AudioPlayerStatus.Playing) return;
          continue;
        }
        const chunk = await readFrame(resource.playStream);
        if (audioPlayer.state.resource !== resource) continue; // replaced meanwhile
        if (!chunk) {
          audioPlayer.stop();
          await settle();
          continue;
        }
        played.push({ resource, chunk });
        resource.playbackDuration += (chunk.length / PCM_BYTES_PER_MS) | 0;
        left -= chunk.length / PCM_BYTES_PER_MS;
        await tick();
      }
    },
    module: {
      joinVoiceChannel: () => connection,
      createAudioPlayer: () => audioPlayer,
      createAudioResource: (stream) => {
        const resource = {
          playStream: stream,
          playbackDuration: 0,
          silencePaddingFrames: 5,
          silenceRemaining: -1,
          volume: {
            level: 1,
            setVolume(v) {
              this.level = v;
            },
          },
        };
        resources.push(resource);
        return resource;
      },
      entersState: async () => connection,
    },
  };
}

/** Fake ffmpeg: stdout plays the PCM chosen for the track by its stream's video id. */
function pcmSpawn(pcmFor) {
  const processes = [];
  const spawnImpl = (path, args) => {
    const proc = Object.assign(new EventEmitter(), {
      path,
      args,
      killed: false,
      stdin: new PassThrough(),
      stdout: null,
      stderr: new PassThrough(),
      kill() {
        this.killed = true;
        this.stdout.destroy();
        return true;
      },
    });
    proc.stdin.once('pipe', (src) => {
      proc.stdout = proc.stdout ?? chunked(pcmFor(src.videoId));
    });
    processes.push(proc);
    return proc;
  };
  return { processes, spawnImpl };
}

function track(title, durationMs, extra = {}) {
  return {
    encoded: `enc-${title}`,
    info: {
      title,
      author: 'Sanatçı',
      duration: durationMs,
      identifier: title,
      sourceName: 'youtube',
      isStream: false,
      isSeekable: true,
      ...extra,
    },
    pluginInfo: {},
  };
}

function crossfadeSetup({ crossfadeSeconds = 2, values = { a: 10_000, b: 20_000, c: 5000 }, durations = {} } = {}) {
  const voice = readingVoice();
  const pcm = {};
  for (const [name, value] of Object.entries(values)) pcm[name] = constantPcm(durations[name] ?? 6000, value);
  // The fake ffmpeg starts after the stream is piped in; the stream knows which track it is.
  const { processes, spawnImpl } = pcmSpawn((videoId) => pcm[videoId]);
  const wrapped = (path, args, options) => {
    const proc = spawnImpl(path, args, options);
    // stdout must exist right after spawn (the player wraps it at once): fill it lazily.
    const lazy = new PassThrough();
    proc.stdout = lazy;
    proc.stdin.once('pipe', (src) => chunked(pcm[src.videoId]).pipe(lazy));
    return proc;
  };
  const streams = [];
  const rest = {
    connected: true,
    loadTracks: async () => ({ loadType: 'empty', tracks: [] }),
    openStream: async (videoId) => {
      const stream = Object.assign(new PassThrough(), { videoId, truncated: false });
      streams.push(stream);
      return stream;
    },
  };
  const events = [];
  const player = new GuildPlayer({
    guildId: 'g',
    voiceChannelId: 'v1',
    textChannelId: 't1',
    volume: 80,
    client: { guilds: { cache: new Map([['g', { voiceAdapterCreator: () => ({}) }]]) } },
    rest,
    config: { music: { twentyFourSeven: true, leaveAfterQueueEndSeconds: 1 } },
    logger: silent,
    emit: (event, ...args) => events.push([event, ...args]),
    voice: voice.module,
    spawnImpl: wrapped,
    ffmpegFinder: async () => 'ffmpeg',
    crossfadeSeconds,
  });
  const trackEvents = () =>
    events
      .filter(([name]) => name === 'trackStart' || name === 'trackEnd')
      .map(([name, , t, payload]) =>
        name === 'trackStart' ? `start:${t.info.title}` : `end:${t.info.title}:${payload.reason}`,
      );
  return { player, voice, processes, streams, events, trackEvents, pcm };
}

/** Advances in small steps and asks the player to check its crossfade timing, like its 1 s timer. */
async function playFor(t, ms, step = 500) {
  for (let done = 0; done < ms; done += step) {
    await t.voice.advance(Math.min(step, ms - done));
    t.player.checkCrossfade();
    await settle();
  }
}

describe('GuildPlayer crossfade', () => {
  it('fades A into B at duration - N, switches tracks at the fade start and hands B over without a gap', async () => {
    const t = crossfadeSetup();
    t.player.queue.add([track('a', 6000), track('b', 6000)]);
    await t.player.play();
    await playFor(t, 3500);
    assert.deepEqual(t.trackEvents(), ['start:a'], 'nothing switched before the fade');
    assert.equal(t.processes.length, 2, 'B was opened ahead of the fade');

    await playFor(t, 1000); // crosses 4000 ms: the fade starts
    assert.deepEqual(t.trackEvents(), ['start:a', 'end:a:finished', 'start:b']);
    assert.equal(t.player.queue.current.info.title, 'b');
    assert.ok(t.player.crossfading);
    assert.ok(t.player.position > 300 && t.player.position <= 600, `B position counts the fade (${t.player.position})`);

    t.player.setVolume(50);
    assert.equal(t.voice.resources[0].volume.level, 0.5, 'volume reaches the resource playing the mix');

    await playFor(t, 2000); // fade done -> B on its own resource
    assert.equal(t.player.crossfading, false);
    assert.equal(t.voice.resources.length, 2);
    assert.equal(t.voice.resources[1].volume.level, 0.5);
    assert.equal(t.processes[0].killed, true, "A's ffmpeg was closed after the fade");
    const position = t.player.position;
    // 6.5 s played in total, B audible since 4 s.
    assert.ok(Math.abs(position - 2500) <= 60, `B position continues across the hand-over (${position})`);

    await playFor(t, 4000); // B to its end
    const all = Buffer.concat(t.voice.played.map((p) => p.chunk));
    assert.equal(all.length, pcmBytes(4000 + 2000 + 4000), 'A 4 s + fade 2 s + B 4 s, nothing lost or doubled');
    const sample = (ms) => all.readInt16LE(pcmBytes(ms));
    assert.equal(sample(3990), 10_000, 'A alone before the fade');
    assert.equal(
      sample(5000),
      Math.round(10_000 * fadeGains(0.5).out + 20_000 * fadeGains(0.5).in),
      'both in the middle',
    );
    assert.equal(sample(6100), 20_000, 'B alone after it');
    assert.deepEqual(t.trackEvents(), ['start:a', 'end:a:finished', 'start:b', 'end:b:finished']);
  });

  it('no crossfade into the same track with track repeat', async () => {
    const t = crossfadeSetup();
    t.player.queue.add([track('a', 6000), track('b', 6000)]);
    await t.player.play();
    await t.player.setRepeatMode('track');
    await playFor(t, 5000);
    assert.equal(t.processes.length, 1, 'nothing prepared');
    assert.deepEqual(t.trackEvents(), ['start:a']);
  });

  it('no crossfade from or into a live stream, nor when it is off', async () => {
    const live = crossfadeSetup();
    live.player.queue.add([track('a', 6000), track('b', 0, { isStream: true, isSeekable: false })]);
    await live.player.play();
    await playFor(live, 5000);
    assert.equal(live.processes.length, 1);

    const off = crossfadeSetup({ crossfadeSeconds: 0 });
    off.player.queue.add([track('a', 6000), track('b', 6000)]);
    await off.player.play();
    await playFor(off, 5000);
    assert.equal(off.processes.length, 1);
  });

  it('a skip during the fade moves on at once and closes both faded pipelines', async () => {
    const t = crossfadeSetup();
    t.player.queue.add([track('a', 6000), track('b', 6000), track('c', 6000)]);
    await t.player.play();
    await playFor(t, 4500);
    assert.ok(t.player.crossfading);
    await t.player.skip();
    assert.equal(t.player.queue.current.info.title, 'c');
    assert.equal(t.player.crossfading, false);
    assert.ok(t.processes[0].killed && t.processes[1].killed, 'A and B closed');
    assert.deepEqual(t.trackEvents().slice(-3), ['start:b', 'end:b:replaced', 'start:c']);
    await t.voice.advance(100);
    assert.equal(t.voice.played.at(-1).chunk.readInt16LE(0), 5000, 'C plays from its start, no fade');
  });

  it('a seek while B is prepared drops B; removing B before the fade fades into the new next track', async () => {
    const t = crossfadeSetup();
    t.player.queue.add([track('a', 6000), track('b', 6000), track('c', 6000)]);
    await t.player.play();
    await playFor(t, 2000);
    assert.equal(t.processes.length, 2);
    await t.player.seek(1000);
    assert.equal(t.processes[1].killed, true, 'prepared B closed by the seek');

    await playFor(t, 1500); // prepared again (position 2500)
    const prepared = t.processes.at(-1);
    t.player.queue.remove(0); // B removed before the fade
    await playFor(t, 2000);
    assert.equal(prepared.killed, true, 'the removed track was closed');
    assert.equal(t.player.queue.current.info.title, 'c');
    assert.ok(!t.trackEvents().includes('start:b'), 'B never played');
    assert.ok(!t.voice.played.some((p) => p.chunk.readInt16LE(0) === 20_000), 'no audio of B');
  });

  it('consecutive fades A->B->C keep every middle track at full length', async () => {
    const t = crossfadeSetup();
    t.player.queue.add([track('a', 6000), track('b', 6000), track('c', 6000)]);
    await t.player.play();
    await playFor(t, 16_000, 250);
    const all = Buffer.concat(t.voice.played.map((p) => p.chunk));
    assert.equal(all.length, pcmBytes(14_000), 'A 4 + fade 2 + B 2 + fade 2 + C 4');
    const s = (ms) => all.readInt16LE(pcmBytes(ms));
    assert.equal(s(3990), 10_000, 'A alone');
    assert.equal(s(7000), 20_000, 'B alone between the fades');
    assert.equal(s(7990), 20_000, 'second fade starts at B duration - N');
    assert.equal(s(10_100), 5000, 'C alone');
    assert.deepEqual(t.trackEvents(), [
      'start:a',
      'end:a:finished',
      'start:b',
      'end:b:finished',
      'start:c',
      'end:c:finished',
    ]);
  });

  it('A->B->C->D: three fades in a row, each at duration - N of its track', async () => {
    const t = crossfadeSetup({ values: { a: 10_000, b: 20_000, c: 5000, d: 15_000 } });
    t.player.queue.add([track('a', 6000), track('b', 6000), track('c', 6000), track('d', 6000)]);
    await t.player.play();
    await playFor(t, 22_000, 250);
    const all = Buffer.concat(t.voice.played.map((p) => p.chunk));
    assert.equal(all.length, pcmBytes(18_000), 'A 4 + (fade 2 + 2) x 2 + fade 2 + D 4');
    const s = (ms) => all.readInt16LE(pcmBytes(ms));
    assert.deepEqual([s(3990), s(7000), s(11_000), s(14_100)], [10_000, 20_000, 5000, 15_000]);
    assert.equal(t.trackEvents().filter((e) => e.endsWith(':finished')).length, 4);
  });

  it('the play counter sees A finish and B start at the fade, with B position from the fade start', async () => {
    const t = crossfadeSetup();
    t.player.queue.add([track('a', 6000), track('b', 6000)]);
    await t.player.play();
    await playFor(t, 4000);
    await playFor(t, 1000);
    const startB = t.events.findIndex(([name, , tr]) => name === 'trackStart' && tr.info.title === 'b');
    const endA = t.events.findIndex(
      ([name, , tr, p]) => name === 'trackEnd' && tr.info.title === 'a' && p.reason === 'finished',
    );
    assert.ok(endA >= 0 && endA < startB, 'trackEnd(A) comes before trackStart(B)');
    assert.ok(t.player.position >= 900 && t.player.position <= 1100, `${t.player.position}`);
  });
});
