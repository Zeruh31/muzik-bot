// describeLoadError turns youtube-source / Lavalink exception text into Turkish for users.
// Inputs are real messages: from Lavalink logs and youtube-source's Client#getPlayabilityStatus.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeLoadError } from '../src/music/MusicService.js';

const say = (message) => describeLoadError({ message });

// As logged by Lavalink 4.2.2 + youtube-source 1.18.2 when nothing could play.
const ALL_CLIENTS_FAILED = [
  '(yts.version: 1.18.2) All clients failed to load the item.',
  'Client [TVHTML5] failed: The page needs to be reloaded.',
  'Client [ANDROID_VR] failed: This video requires login.',
  'Client [WEB] failed: No supported audio streams available, available types: ',
  'Client [WEB_EMBEDDED_PLAYER] failed: This video is unavailable',
].join('\n');

describe('describeLoadError', () => {
  it('"The page needs to be reloaded" is NOT an age restriction ("page" contains "age")', () => {
    assert.doesNotMatch(say('The page needs to be reloaded.'), /yaş/);
    assert.doesNotMatch(say('Client [TVHTML5] failed: The page needs to be reloaded.'), /yaş/);
  });

  it('AllClientsFailedException asks the bot owner to update, even if one client said "login"', () => {
    const text = say(ALL_CLIENTS_FAILED);
    assert.match(text, /YouTube şu an bu parçayı vermiyor/);
    assert.match(text, /güncellemesi/);
    assert.doesNotMatch(text, /yaş|oturum/);
  });

  it('maps youtube-source playability messages', () => {
    assert.match(say('This video requires age verification.'), /yaş kısıtlamalı/);
    assert.match(say('Sign in to confirm your age'), /yaş kısıtlamalı/);
    assert.match(say('This video requires login.'), /oturum açılmasını/);
    assert.match(say("Sign in to confirm you're not a bot"), /oturum açılmasını/);
    assert.match(say('This video cannot be viewed anonymously.'), /oturum açılmasını/);
    assert.match(say('This is a private video.'), /özel/);
    assert.match(say('This video is unavailable'), /kullanılamıyor/);
  });

  it('unknown or missing messages get the generic text', () => {
    assert.match(say('Something else broke'), /Parça yüklenemedi/);
    assert.match(describeLoadError(undefined), /Parça yüklenemedi/);
    assert.match(say('Usage of this storage is too high'), /Parça yüklenemedi/, '"age" inside a word must not match');
  });
});
