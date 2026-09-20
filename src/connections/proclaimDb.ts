// Reading Proclaim's local PresentationManager.db for song lyric text.
//
// The onair HTTP API (ProclaimRemoteAppAPI.md) does not expose item content —
// song items only carry slide ids/indices — so lyric text is read directly from
// Proclaim's local SQLite database, which lives on the same machine as the
// server. Layout reference: docs in proclaim-ed (db reference, rich_text.py).

import { Database } from 'bun:sqlite';
import fs from 'fs';
import config from '../config';
import * as logger from '../logger';

// ── Lyrics XAML parsing ──────────────────────────────────────────────────────

// Matches section label lines in song lyrics, which Proclaim treats as
// structure, not content: "Verse 1", "VERSE 1:", "Chorus 2", "Bridge",
// "[Custom Section]".
const SONG_SECTION_LABEL = /^(?:verse\s*\d*|chorus\s*\d*|bridge\s*\d*|\[.*\]):?$/i;

interface Paragraph {
  text: string;
  blank: boolean;
}

function parseParagraphs(xaml: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  // Self-closing paragraph = blank line
  const re = /<Paragraph[^>]*\/>|<Paragraph[^>]*>([\s\S]*?)<\/Paragraph>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xaml)) !== null) {
    if (m[1] === undefined) {
      paragraphs.push({ text: '', blank: true });
      continue;
    }
    let text = '';
    const runRe = /<Run[^>]*\bText="([^"]*)"[^>]*\/>/g;
    let run: RegExpExecArray | null;
    while ((run = runRe.exec(m[1])) !== null) {
      text += run[1];
    }
    paragraphs.push({ text, blank: text === '' });
  }
  return paragraphs;
}

/**
 * Convert a song's RichTextXml lyrics XAML to per-slide line arrays.
 * A single blank paragraph is a slide boundary; section labels
 * (Verse N, Chorus, Bridge, [Custom]) are excluded from the lines.
 */
export function lyricsToSlides(xaml: string): string[][] {
  if (!xaml) return [];
  const paragraphs = parseParagraphs(xaml);
  if (paragraphs.length === 0) {
    // Malformed XML — fall back to collecting Run Text as unlabeled lines
    const runs = [...xaml.matchAll(/<Run[^>]*\bText="([^"]*)"[^>]*\/>/g)].map((m) => m[1]);
    return runs.length > 0 ? [runs] : [];
  }
  const slides: string[][] = [];
  let current: string[] = [];
  for (const para of paragraphs) {
    if (para.blank) {
      if (current.length > 0) slides.push(current);
      current = [];
      continue;
    }
    // Section labels are kept: dropping label-only slides would misalign
    // slide indexes against Proclaim's statusChanged slideIndex.
    current.push(para.text);
  }
  if (current.length > 0) slides.push(current);
  return slides;
}

// ── Database reading ─────────────────────────────────────────────────────────

// Flat key/value store stored per service item in the ServiceItems table.
interface ServiceItemRow {
  ServiceItemId: string;
  Title: string;
  ServiceItemKind: string;
  Content: string;
}

function openPresentationDb(dbPath: string): Database {
  const db = new Database(dbPath, { readonly: true });
  db.exec('PRAGMA journal_mode = DELETE'); // tolerate WAL-less shared reads
  return db;
}

/**
 * Fetch per-slide lyric lines for the given song item id from Proclaim's
 * local PresentationManager.db. Returns null when the DB is unavailable or
 * the item is not found (caller falls back to thumbnail-only display).
 */
export function getSongSlides(itemId: string): string[][] | null {
  const dbPath = config.proclaim.presentationDbPath;
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  let db: Database | null = null;
  try {
    db = openPresentationDb(dbPath);
    const row = db
      .query<ServiceItemRow, [string]>(
        `SELECT ServiceItemId, Title, ServiceItemKind, Content
         FROM ServiceItems WHERE ServiceItemId = ? LIMIT 1`
      )
      .get(itemId);
    if (!row) return null;
    const content = JSON.parse(row.Content ?? '{}') as Record<string, string>;
    return lyricsToSlides(content['_richtextfield:Lyrics'] ?? '');
  } catch (err) {
    // DB schema/location differences must never break the server
    logger.log(`[ProclaimDb] read failed: ${(err as Error).message}`);
    return null;
  } finally {
    db?.close();
  }
}
