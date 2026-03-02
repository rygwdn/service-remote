#!/usr/bin/env bun
/**
 * Checks that no TypeScript source files use console.* directly.
 * All logging must go through src/logger.ts (which itself calls console internally).
 */

import fs = require('fs');
import path = require('path');

const ROOT = path.resolve(import.meta.dir, '..');
const SEARCH_DIRS = ['src', 'server.ts', 'test'];
const EXCLUDED_FILES = new Set(['src/logger.ts']);
const CONSOLE_RE = /\bconsole\.(log|warn|error|info|debug|trace)\s*\(/;

function collectFiles(entry: string): string[] {
  const abs = path.join(ROOT, entry);
  if (!fs.existsSync(abs)) return [];
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    return (entry.endsWith('.ts') || entry.endsWith('.js')) ? [entry] : [];
  }
  return fs.readdirSync(abs, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.js')))
    .map((e) => path.relative(ROOT, path.join(e.parentPath, e.name)));
}

const allFiles = SEARCH_DIRS.flatMap(collectFiles);
const violations: { file: string; line: number; text: string }[] = [];

for (const rel of allFiles) {
  if (EXCLUDED_FILES.has(rel)) continue;
  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf-8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (CONSOLE_RE.test(lines[i])) {
      violations.push({ file: rel, line: i + 1, text: lines[i].trim() });
    }
  }
}

if (violations.length === 0) {
  console.log('✓ No direct console.* calls found outside of logger.ts');
  process.exit(0);
}

console.error(`✗ Found ${violations.length} direct console.* call(s) — use src/logger.ts instead:\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  ${v.text}`);
}
process.exit(1);
