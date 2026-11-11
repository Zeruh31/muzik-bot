// GuildPlayer with a fake @discordjs/voice, a fake ffmpeg process and a fake Lavalink REST:
// pipeline clean-up, serialized commands, early stream ends and mirrored sources.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { AudioPlayerStatus, VoiceConnectionStatus } from '@discordjs/voice';
import { GuildPlayer } from '../src/music/GuildPlayer.js';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
};

function track(title, { duration = 213_000, source = 'youtube', isrc } = {}) {
  return {
    encoded: `enc-${title}`,
    info: { title, author: 'Sanatçı', duration, identifier: `id-${title}`, sourceName: source, isrc, isStream: false },
    pluginInfo: {},
  };
}

/** Fake @discordjs/voice: connections are Ready at once, resources report playbackDuration. */
function fakeVoice() {
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
  return {
    audioPlayer,
    connection,
    resources,
    module: {
      joinVoiceChannel: () => connection,
      createAudioPlayer: () => audioPlayer,
      createAudioResource: (stream) => {
        const resource = {
          playStream: stream,
          playbackDuration: 0,
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
    /** Ends the resource that is playing as @discordjs/voice would after the stream finished. */
    endCurrent(playedMs) {
      audioPlayer.state.resource.playbackDuration = playedMs;
      audioPlayer.stop();
    },
  };
}

function fakeSpawn() {
  const processes = [];
  const spawnImpl = (path, args) => {
    const proc = Object.assign(new EventEmitter(), {
      path,
      args,
      killed: false,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {
        this.killed = true;
        return true;
      },
    });
    processes.push(proc);
    return proc;
  };
  return { processes, spawnImpl };
}

function fakeRest({ connected = true, openStreamFails = false } = {}) {
  const streams = [];
  const loads = [];
  return {
    connected,
    streams,
    loads,
    loadTracks: async (identifier) => {
      loads.push(identifier);
      return { loadType: 'search', tracks: [track('yt-hit')] };
    },
    openStream: async (videoId) => {
      if (openStreamFails) throw new Error('fetch failed');
      const stream = Object.assign(new PassThrough(), { videoId, truncated: false });
      streams.push(stream);
      return stream;
    },
  };
}

function setup(options = {}) {
  const voice = fakeVoice();
  const { processes, spawnImpl } = fakeSpawn();
  const rest = fakeRest(options);
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
    spawnImpl,
    ffmpegFinder: async () => 'ffmpeg',
  });
  const names = () => events.map((e) => e[0]);
  const seekArg = (proc) => {
    const i = proc.args.indexOf('-ss');
    return i >= 0 ? proc.args[i + 1] : null;
  };
  return { player, voice, processes, rest, events, names, seekArg };
}

describe('GuildPlayer pipeline', () => {
  it('plays the current track: opens the stream, spawns ffmpeg, announces trackStart', async () => {
    const t = setup();
    t.player.queue.add([track('a')]);
    await t.player.play();
    assert.equal(t.processes.length, 1);
    assert.equal(t.rest.streams[0].videoId, 'id-a');
    assert.equal(t.seekArg(t.processes[0]), null);
    assert.ok(t.names().includes('trackStart'));
    assert.equal(t.player.playing, true);
    assert.equal(t.voice.resources[0].volume.level, 0.8);
  });

  it('closes the HTTP stream and ffmpeg when a track finishes, then plays the next one', async () => {
    const t = setup();
    t.player.queue.add([track('a'), track('b')]);
    await t.player.play();
    t.voice.endCurrent(213_000);
    await settle();
    assert.equal(t.rest.streams[0].destroyed, true, 'first stream destroyed');
    assert.equal(t.processes[0].killed, true, 'first ffmpeg killed');
    assert.deepEqual(
      t.events.filter((e) => e[0] === 'trackEnd').map((e) => [e[2].info.title, e[3].reason]),
      [['a', 'finished']],
    );
    assert.equal(t.player.queue.current.info.title, 'b');
    assert.equal(t.processes.length, 2);
  });

  it('closes the stream and ffmpeg on failure paths too', async () => {
    const t = setup();
    t.player.queue.add([track('a')]);
    await t.player.play();
    t.rest.streams[0].truncated = true;
    t.voice.endCurrent(500); // almost nothing played and the source was cut: a failure
    await settle();
    assert.equal(t.rest.streams[0].destroyed, true);
    assert.equal(t.processes[0].killed, true);
    assert.ok(t.names().includes('trackError'));
  });

  it('resumes from its position when the source ends early, without a new trackStart', async () => {
    const t = setup();
    t.player.queue.add([track('a')]);
    await t.player.play();
    t.rest.streams[0].truncated = true;
    t.voice.endCurrent(93_000); // 93 s of a 213 s track
    await settle();
    assert.equal(t.processes.length, 2);
    assert.equal(t.seekArg(t.processes[1]), '93.000');
    assert.equal(t.names().filter((n) => n === 'trackStart').length, 1);
    assert.equal(t.names().filter((n) => n === 'trackEnd').length, 0);
    assert.equal(t.player.position, 93_000);
    assert.equal(t.rest.streams[0].destroyed, true);
  });

  it('hands a mid-track loss to the recovery when Lavalink is unreachable', async () => {
    const t = setup();
    t.player.queue.add([track('a')]);
    await t.player.play();
    t.rest.connected = false;
    t.rest.streams[0].truncated = true;
    t.voice.endCurrent(40_000);
    await settle();
    const lost = t.events.find((e) => e[0] === 'sourceLost');
    assert.deepEqual(lost[2], { position: 40_000, paused: false });
    assert.equal(t.player.queue.current.info.title, 'a');
    assert.equal(t.processes.length, 1, 'no automatic reopen while the source is down');
  });

  it('serializes commands: three concurrent seeks apply in order and the last one wins', async () => {
    const t = setup();
    t.player.queue.add([track('a')]);
    await t.player.play();
    await Promise.all([t.player.seek(30_000), t.player.seek(60_000), t.player.seek(90_000)]);
    assert.deepEqual(
      t.processes.slice(1).map((p) => t.seekArg(p)),
      ['30.000', '60.000', '90.000'],
    );
    assert.equal(t.player.position, 90_000);
    assert.ok(
      t.processes.slice(0, 3).every((p) => p.killed),
      'superseded pipelines were closed',
    );
    assert.equal(t.processes[3].killed, false);
  });

  it('a seek racing a skip does not leak the old position into the next track', async () => {
    const t = setup();
    t.player.queue.add([track('a'), track('b')]);
    await t.player.play();
    await Promise.all([t.player.seek(120_000), t.player.skip()]);
    assert.equal(t.player.queue.current.info.title, 'b');
    assert.equal(t.seekArg(t.processes.at(-1)), null, 'b starts from 0');
    assert.equal(t.player.position, 0);
  });

  it('bassboost restarts the running track at its position with the filter', async () => {
    const t = setup();
    t.player.queue.add([track('a')]);
    await t.player.play();
    t.voice.resources[0].playbackDuration = 12_000;
    await t.player.setBassboost('high');
    const proc = t.processes.at(-1);
    assert.equal(t.seekArg(proc), '12.000');
    assert.ok(proc.args.includes('-af'));
    assert.equal(t.player.bassboost, 'high');
  });

  it('restartCurrent rejects when the source cannot be reopened', async () => {
    const t = setup();
    t.player.queue.add([track('a')]);
    await t.player.play();
    await t.player.suspend();
    assert.equal(t.player.playing, false);
    t.rest.openStream = async () => {
      throw new Error('video gone');
    };
    await assert.rejects(t.player.restartCurrent(50_000), /video gone/);
    assert.equal(t.player.queue.current.info.title, 'a', 'the track stays for the caller to decide');
    assert.ok(!t.names().includes('trackError'), 'no trackError: the recovery handles it');
  });

  it('remembers the YouTube match of a Spotify track across seeks and shows it', async () => {
    const t = setup();
    const spotify = track('sp', { source: 'spotify', isrc: 'ISRC1' });
    t.player.queue.add([spotify]);
    await t.player.play();
    await t.player.seek(10_000);
    await t.player.seek(20_000);
    assert.equal(t.rest.loads.length, 1, 'YouTube searched once');
    assert.equal(spotify.mirror.videoId, 'id-yt-hit');
    assert.ok(t.rest.streams.every((s) => s.videoId === 'id-yt-hit'));
  });

  it('destroy closes everything and reports cleanup', async () => {
    const t = setup();
    t.player.queue.add([track('a'), track('b')]);
    await t.player.play();
    await t.player.destroy('Durduruldu');
    assert.equal(t.rest.streams[0].destroyed, true);
    assert.equal(t.processes[0].killed, true);
    assert.equal(t.voice.connection.state.status, VoiceConnectionStatus.Destroyed);
    const last = t.events.at(-1);
    assert.deepEqual([last[0], last[2]], ['playerDestroy', 'Durduruldu']);
    assert.equal(t.player.queue.size, 0);
    await assert.rejects(t.player.play(), (e) => e.code === 'NO_PLAYER'); // after destroy
  });
});

describe('GuildPlayer previous', () => {
  it('plays the previous track from the start and puts the current one back in front', async () => {
    const t = setup();
    t.player.queue.add([track('a'), track('b'), track('c')]);
    await t.player.play();
    t.voice.endCurrent(213_000); // a finished, b plays
    await settle();
    t.voice.resources.at(-1).playbackDuration = 50_000;
    const now = await t.player.previous();
    assert.equal(now.info.title, 'a');
    assert.deepEqual(
      t.player.queue.tracks.map((x) => x.info.title),
      ['b', 'c'],
    );
    assert.equal(t.seekArg(t.processes.at(-1)), null, 'a starts from 0');
    assert.equal(t.player.position, 0);
    const ends = t.events.filter((e) => e[0] === 'trackEnd').map((e) => [e[2].info.title, e[3].reason]);
    assert.deepEqual(ends.at(-1), ['b', 'replaced']);
    assert.equal(t.names().filter((n) => n === 'trackStart').length, 3);
    assert.equal(t.processes.at(-2).killed, true, "b's pipeline was closed");
  });

  it('brings the last track back after the queue ended, and after a skip at the end', async () => {
    const t = setup();
    t.player.queue.add([track('a')]);
    await t.player.play();
    await t.player.stopPlaying(); // /skip on the last track
    assert.equal(t.player.queue.current, null);
    const now = await t.player.previous();
    assert.equal(now.info.title, 'a');
    assert.equal(t.player.playing, true);
  });

  it('does not offer a track that failed to play', async () => {
    const t = setup();
    t.player.queue.add([track('a')]);
    await t.player.play();
    t.rest.streams[0].truncated = true;
    t.voice.endCurrent(300); // failure
    await settle();
    assert.ok(t.names().includes('trackError'));
    assert.equal(await t.player.previous(), null);
  });
});

describe('GuildPlayer quick button presses', () => {
  it('togglePause alternates even when presses arrive together; cycleRepeatMode steps once per press', async () => {
    const t = setup();
    t.player.queue.add([track('a')]);
    await t.player.play();
    const states = await Promise.all([t.player.togglePause(), t.player.togglePause(), t.player.togglePause()]);
    assert.deepEqual(states, [true, false, true]);
    assert.equal(t.player.paused, true);
    const next = (mode) => ({ off: 'track', track: 'queue', queue: 'off' })[mode];
    const modes = await Promise.all([1, 2, 3, 4].map(() => t.player.cycleRepeatMode(next)));
    assert.deepEqual(modes, ['track', 'queue', 'off', 'track']);
  });
});
