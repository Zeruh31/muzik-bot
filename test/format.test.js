import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeMarkdown, formatDuration, parseTime, progressBar, truncate } from '../src/util/format.js';

describe('formatDuration', () => {
  it('formats minutes and hours', () => {
    assert.equal(formatDuration(65_000), '1:05');
    assert.equal(formatDuration(3_725_000), '1:02:05');
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(-5), '0:00');
    assert.equal(formatDuration(Number.NaN), '0:00');
  });
});

describe('parseTime', () => {
  const cases = [
    ['90', 90_000],
    ['1:30', 90_000],
    ['1:02:30', 3_750_000],
    ['1m30s', 90_000],
    ['2m 10s', 130_000],
    ['1h 5m', 3_900_000],
    ['2dk 10sn', 130_000],
    ['1sa', 3_600_000],
    ['45 saniye', 45_000],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" -> ${expected}`, () => assert.equal(parseTime(input), expected));
  }
  for (const input of ['', 'abc', '1:75', '10x', '1m abc']) {
    it(`rejects "${input}"`, () => assert.equal(parseTime(input), null));
  }
});

describe('progressBar', () => {
  it('places the knob proportionally', () => {
    assert.equal(progressBar(0, 100, 5), '🔘▬▬▬▬');
    assert.equal(progressBar(100, 100, 5), '▬▬▬▬🔘');
    assert.equal(progressBar(50, 100, 5), '▬▬🔘▬▬');
  });
  it('shows live for streams', () => assert.match(progressBar(10, 0), /CANLI/));
});

describe('text helpers', () => {
  it('truncate', () => {
    assert.equal(truncate('abcdef', 4), 'abc…');
    assert.equal(truncate('abc', 4), 'abc');
  });
  it('escapeMarkdown', () => assert.equal(escapeMarkdown('a*b_[c]'), 'a\\*b\\_\\[c\\]'));
});
