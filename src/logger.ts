import fs = require('fs');

interface LogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

const MAX_MEMORY = 500;
const entries: LogEntry[] = [];
let logFilePath: string | null = null;

function setLogFile(filePath: string): void {
  logFilePath = filePath;
}

function write(level: LogEntry['level'], args: unknown[]): void {
  const msg = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(' ');
  const ts = new Date().toISOString();
  const entry: LogEntry = { ts, level, msg };

  entries.push(entry);
  if (entries.length > MAX_MEMORY) entries.shift();

  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleFn(msg);

  if (logFilePath) {
    try {
      fs.appendFileSync(logFilePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (_) {
      // best-effort
    }
  }
}

function log(...args: unknown[]): void {
  write('info', args);
}

function warn(...args: unknown[]): void {
  write('warn', args);
}

function error(...args: unknown[]): void {
  write('error', args);
}

function getLogs(): LogEntry[] {
  return [...entries];
}

export = { log, warn, error, getLogs, setLogFile };
