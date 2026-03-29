import fs from 'fs';

interface LogEntry {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
}

interface LogFileOptions {
  /** Rotate when the log file exceeds this many bytes. Default: 5 MB. */
  maxFileSizeBytes?: number;
}

const MAX_MEMORY = 500;
const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

const entries: LogEntry[] = [];
let logFilePath: string | null = null;
let maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE;

function setLogFile(filePath: string, opts?: LogFileOptions): void {
  logFilePath = filePath;
  maxFileSizeBytes = opts?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
}

/** Rotate logFile → logFile.1 (overwriting any previous .1), then start fresh. */
function rotate(): void {
  if (!logFilePath) return;
  try {
    fs.renameSync(logFilePath, logFilePath + '.1');
  } catch (_) {
    // If rename fails (e.g. file doesn't exist yet), continue silently
  }
}

function write(level: LogEntry['level'], args: unknown[]): void {
  const msg = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(' ');
  const ts = new Date().toISOString();
  const entry: LogEntry = { ts, level, msg };

  entries.push(entry);
  if (entries.length > MAX_MEMORY) entries.shift();

  if (level !== 'debug') {
    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleFn(msg);
  }

  if (logFilePath) {
    try {
      // Check size before appending and rotate if needed
      let size = 0;
      try { size = fs.statSync(logFilePath).size; } catch (_) { /* file may not exist yet */ }
      if (size >= maxFileSizeBytes) rotate();
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

function debug(...args: unknown[]): void {
  write('debug', args);
}

function getLogs(): LogEntry[] {
  return [...entries];
}

export { log, warn, error, debug, getLogs, setLogFile };
