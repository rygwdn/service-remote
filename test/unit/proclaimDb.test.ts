import assert from 'node:assert/strict';
import { describe, test } from 'bun:test';
import { lyricsToSlides } from '../../src/connections/proclaimDb';

const PARAGRAPH = (text: string) =>
  `<Paragraph Language="en-US" Margin="0,0,0,0"><Run Text="${text}" /></Paragraph>`;

describe('proclaimDb.lyricsToSlides', () => {
  test('splits lyrics on blank paragraphs into per-slide line arrays', () => {
    const xaml = [
      PARAGRAPH('Verse 1'),
      PARAGRAPH('Amazing grace! How sweet the sound'),
      PARAGRAPH('That saved a wretch like me'),
      PARAGRAPH(''), // blank paragraph = slide boundary
      PARAGRAPH('I once was lost, but now am found'),
      PARAGRAPH(''),
      PARAGRAPH('Chorus'),
      PARAGRAPH('My chains are gone'),
    ].join('\n');
    // Section labels are kept so slide indexes stay aligned with Proclaim's slideIndex
    assert.deepEqual(lyricsToSlides(xaml), [
      ['Verse 1', 'Amazing grace! How sweet the sound', 'That saved a wretch like me'],
      ['I once was lost, but now am found'],
      ['Chorus', 'My chains are gone'],
    ]);
  });

  test('keeps section labels so slide indexes align with Proclaim slideIndex', () => {
    const xaml = [
      PARAGRAPH('Chorus 2:'),
      PARAGRAPH('Hallelujah'),
      PARAGRAPH(''),
      PARAGRAPH('Bridge'),
      PARAGRAPH(''),
      PARAGRAPH('[Custom Section]'),
      PARAGRAPH('Ending line'),
    ].join('\n');
    assert.deepEqual(lyricsToSlides(xaml), [
      ['Chorus 2:', 'Hallelujah'],
      ['Bridge'],
      ['[Custom Section]', 'Ending line'],
    ]);
  });

  test('handles empty and self-closing paragraphs', () => {
    const xaml = [
      PARAGRAPH('Line one'),
      '<Paragraph Language="en-US" Margin="0,0,0,0" />',
      PARAGRAPH('Line two'),
    ].join('\n');
    assert.deepEqual(lyricsToSlides(xaml), [['Line one'], ['Line two']]);
  });

  test('returns [] for empty or missing lyrics', () => {
    assert.deepEqual(lyricsToSlides(''), []);
    assert.deepEqual(lyricsToSlides('<Paragraph Language="en-US" Margin="0,0,0,0" />'), []);
  });

  test('falls back to Run Text regex for malformed XML', () => {
    const xaml = 'broken xml <Run Text="still works" /></Paragraph>';
    assert.deepEqual(lyricsToSlides(xaml), [['still works']]);
  });
});
