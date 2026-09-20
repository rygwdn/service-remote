import assert from 'node:assert/strict';
import { applyLiveStatus, dbToMul, extractObsPeak, mulToDb } from '../../src/connections/obs';

describe('OBS conversion helpers', () => {
  test('extractObsPeak returns the largest peak channel value', () => {
    assert.equal(extractObsPeak([[0.1, 0.4, 0.9], [0.2, 0.7, 0.95]]), 0.7);
  });

  test('extractObsPeak ignores inputPeak and empty channels', () => {
    assert.equal(extractObsPeak([]), 0);
    assert.equal(extractObsPeak([[0.1, 0.3, 0.98], [0.1, 0, 0.99]]), 0.3);
  });

  test('mulToDb handles unity, attenuation, and silence', () => {
    assert.equal(mulToDb(1), 0);
    assert.equal(Math.round(mulToDb(0.5) * 1000) / 1000, -6.021);
    assert.equal(mulToDb(0), -Infinity);
  });

  test('dbToMul is the inverse of mulToDb for finite values', () => {
    const multiplier = dbToMul(-12);
    assert.ok(Math.abs(mulToDb(multiplier) - (-12)) < 1e-12);
  });
});

describe('OBS live source status', () => {
  test('marks active sources live and resets levels for inactive sources', () => {
    const previous = [
      { name: 'Mic 1', live: true, level: 0.8 },
      { name: 'Desktop Audio', live: false, level: 0 },
    ];
    assert.deepEqual(applyLiveStatus(previous, new Set(['Desktop Audio'])), [
      { name: 'Mic 1', live: false, level: 0 },
      { name: 'Desktop Audio', live: true, level: 0 },
    ]);
  });

  test('preserves levels for sources that remain active', () => {
    const previous = [{ name: 'Mic 1', live: true, level: 0.42 }];
    assert.deepEqual(applyLiveStatus(previous, new Set(['Mic 1'])), previous);
  });
});
