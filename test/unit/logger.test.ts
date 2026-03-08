import assert = require('node:assert/strict');
import fs = require('node:fs');
import path = require('node:path');
import os = require('node:os');

// Test log rotation by exercising the logger's setLogFile + rotation behaviour.
// We use a temp directory so tests don't pollute the repo.

describe('logger log rotation', () => {
  let tmpDir: string;
  let logFile: string;

  // Re-require logger fresh for each test so module state is reset
  function freshLogger() {
    // Clear require cache so we get a clean module instance
    const key = require.resolve('../../src/logger');
    delete require.cache[key];
    return require('../../src/logger') as typeof import('../../src/logger');
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
    logFile = path.join(tmpDir, 'test.log');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes log entries to file', () => {
    const logger = freshLogger();
    logger.setLogFile(logFile);
    logger.log('hello world');
    const content = fs.readFileSync(logFile, 'utf-8');
    assert.ok(content.includes('hello world'));
  });

  test('rotates log file when it exceeds MAX_FILE_SIZE', () => {
    const logger = freshLogger();
    logger.setLogFile(logFile, { maxFileSizeBytes: 200 });

    // Write enough to exceed 200 bytes
    for (let i = 0; i < 20; i++) {
      logger.log(`log line number ${i} with some padding to make it longer`);
    }

    // The rotated file should exist
    assert.ok(fs.existsSync(logFile + '.1'), 'rotated file .1 should exist');
    // The current log file should be smaller than the total written
    const currentSize = fs.statSync(logFile).size;
    const rotatedSize = fs.statSync(logFile + '.1').size;
    assert.ok(currentSize > 0, 'current log file should have content');
    assert.ok(rotatedSize > 0, 'rotated log file should have content');
    // Together they must hold more data than either alone
    assert.ok(rotatedSize + currentSize > currentSize, 'rotation moved data');
  });

  test('only keeps one rotated file (overwrites .1 on subsequent rotations)', () => {
    const logger = freshLogger();
    logger.setLogFile(logFile, { maxFileSizeBytes: 100 });

    for (let i = 0; i < 60; i++) {
      logger.log(`entry ${i} padding padding padding padding padding`);
    }

    // Should have .1 but not .2
    assert.ok(fs.existsSync(logFile + '.1'), '.1 should exist');
    assert.ok(!fs.existsSync(logFile + '.2'), '.2 should not exist');
  });

  test('does not rotate when file is within size limit', () => {
    const logger = freshLogger();
    logger.setLogFile(logFile, { maxFileSizeBytes: 100000 });
    logger.log('small log entry');
    assert.ok(!fs.existsSync(logFile + '.1'), '.1 should not exist for small file');
  });
});
