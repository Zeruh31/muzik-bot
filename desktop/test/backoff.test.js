'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RestartPolicy } = require('../src/main/backoff');

test('delays double up to the cap, then stop after maxAttempts', () => {
  const policy = new RestartPolicy({ baseMs: 1000, maxMs: 5000, maxAttempts: 5 });
  assert.deepEqual(
    Array.from({ length: 6 }, () => policy.nextDelay()),
    [1000, 2000, 4000, 5000, 5000, null],
  );
});

test('a process that stayed up long enough gets a fresh set of attempts', () => {
  let now = 0;
  const policy = new RestartPolicy({ baseMs: 1000, maxAttempts: 2, stableAfterMs: 60_000, now: () => now });
  assert.equal(policy.nextDelay(), 1000);
  policy.markUp();
  now += 10_000; // crashed again quickly
  assert.equal(policy.nextDelay(), 2000);
  policy.markUp();
  now += 5_000;
  assert.equal(policy.nextDelay(), null, 'limit reached');

  policy.markUp();
  now += 61_000; // healthy for over a minute
  assert.equal(policy.nextDelay(), 1000);
});

test('reset forgets earlier failures', () => {
  const policy = new RestartPolicy({ baseMs: 1, maxAttempts: 1 });
  assert.equal(policy.nextDelay(), 1);
  assert.equal(policy.nextDelay(), null);
  policy.reset();
  assert.equal(policy.nextDelay(), 1);
});
