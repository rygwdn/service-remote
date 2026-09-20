import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Database } from 'bun:sqlite';
import config from '../../src/config';
import { getSongSlides } from '../../src/connections/proclaimDb';

const P = (text: string) =>
  `<Paragraph Language="en-US" Margin="0,0,0,0"><Run Text="${text}" /></Paragraph>`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proclaimdb-'));
  config.proclaim.presentationDbPath = path.join(tmpDir, 'PresentationManager.db');
});

afterEach(() => {
  config.proclaim.presentationDbPath = '';
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function createDb(rows: Array<{ id: string; kind: string; title: string; content: object }>): void {
  const db = new Database(path.join(tmpDir, 'PresentationManager.db'));
  db.exec(`CREATE TABLE ServiceItems (
    ServiceItemId TEXT, PresentationId TEXT, RecordId INTEGER,
    Title TEXT, ServiceItemKind TEXT, Content TEXT)`);
  const stmt = db.prepare('INSERT INTO ServiceItems VALUES (?, ?, ?, ?, ?, ?)');
  rows.forEach((r, i) => stmt.run(r.id, 'pres1', i + 1, r.title, r.kind, JSON.stringify(r.content)));
  db.close();
}

describe('proclaimDb.getSongSlides', () => {
  test('extracts per-slide lyric lines for a SongLyrics item by ServiceItemId', () => {
    createDb([
      {
        id: '069c7db7-26b3-4be7-ae3d-6357cfe5146c',
        kind: 'SongLyrics',
        title: 'Amazing Grace',
        content: {
          '_richtextfield:Lyrics': [
            P('Verse 1'),
            P('Amazing grace, how sweet the sound'),
            P(''),
            P('Chorus'),
            P('My chains are gone'),
          ].join(''),
        },
      },
    ]);
    assert.deepEqual(getSongSlides('069c7db7-26b3-4be7-ae3d-6357cfe5146c'), [
      ['Verse 1', 'Amazing grace, how sweet the sound'],
      ['Chorus', 'My chains are gone'],
    ]);
  });

  test('returns [] for a song item without lyrics content', () => {
    createDb([{ id: 'song1', kind: 'SongLyrics', title: 'Silent', content: {} }]);
    assert.deepEqual(getSongSlides('song1'), []);
  });

  test('returns null for unknown item id', () => {
    createDb([{ id: 'song1', kind: 'SongLyrics', title: 'X', content: {} }]);
    assert.equal(getSongSlides('nope'), null);
  });

  test('returns null when DB path is unset or missing', () => {
    config.proclaim.presentationDbPath = '';
    assert.equal(getSongSlides('song1'), null);
    config.proclaim.presentationDbPath = path.join(tmpDir, 'nope.db');
    assert.equal(getSongSlides('song1'), null);
  });

  test('returns null on malformed Content JSON without throwing', () => {
    const db = new Database(path.join(tmpDir, 'PresentationManager.db'));
    db.exec(`CREATE TABLE ServiceItems (
      ServiceItemId TEXT, PresentationId TEXT, RecordId INTEGER,
      Title TEXT, ServiceItemKind TEXT, Content TEXT)`);
    db.prepare('INSERT INTO ServiceItems VALUES (?, ?, ?, ?, ?, ?)').run(
      'song1', 'pres1', 1, 'Broken', 'SongLyrics', 'not-json{'
    );
    db.close();
    assert.equal(getSongSlides('song1'), null);
  });
});
