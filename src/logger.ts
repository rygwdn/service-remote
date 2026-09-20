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
interface LogFileTarget {
  path: string;
  maxSizeBytes: number;
  sizeBytes: number;
  sizeKnown: boolean;
}

let logFile: LogFileTarget | null = null;
let fileWriteQueue: Promise<void> = Promise.resolve();

function setLogFile(filePath: string, opts?: LogFileOptions): void {
  logFile = {
    path: filePath,
    maxSizeBytes: opts?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE,
    sizeBytes: 0,
    sizeKnown: false,
  };
}

/** Rotate the active log file, overwriting any previous .1 file. */
async function appendFileEntry(target: LogFileTarget, line: string): Promise<void> {
  if (!target.sizeKnown) {
    try {
      target.sizeBytes = (await fs.promises.stat(target.path)).size;
    } catch {
      target.sizeBytes = 0;
    }
    target.sizeKnown = true;
  }

  if (target.sizeBytes >= target.maxSizeBytes) {
    try {
      try { await fs.promises.unlink(target.path + '.1'); } catch {}
      await fs.promises.rename(target.path, target.path + '.1');
    } catch {
      // If rename fails (for example, the file does not exist yet), continue.
    }
    // Keep the in-memory estimate aligned with the fresh file we are about to write.
    target.sizeBytes = 0;
  }

  try {
    await fs.promises.appendFile(target.path, line, 'utf-8');
    target.sizeBytes += Buffer.byteLength(line, 'utf8');
  } catch {
    // Logging is best-effort and must not reject the caller's operation.
  }
}

function enqueueFileEntry(entry: LogEntry): void {
  const target = logFile;
  if (!target) return;
  const line = JSON.stringify(entry) + '\n';
  fileWriteQueue = fileWriteQueue
    .then(() => appendFileEntry(target, line))
    .catch(() => {
      // A logging failure must never become an unhandled rejection.
    });
}

function redact(text: string): string {
  let result = text.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]');
  result = result.replace(/(["']?(?:password|clientSecret|refreshToken|accessToken)["']?\s*[:=]\s*)(["'][^"']*["']|[^,\s}&]+)/gi, (_match, prefix: string, value: string) => {
    return `${prefix}${value.startsWith('"') || value.startsWith("'") ? '"[REDACTED]"' : '[REDACTED]'}`;
  });
  return result;
}

function write(level: LogEntry['level'], args: unknown[]): void {
  const msg = redact(args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(' '));
  const ts = new Date().toISOString();
  const entry: LogEntry = { ts, level, msg };

  entries.push(entry);
  if (entries.length > MAX_MEMORY) entries.shift();

  if (level !== 'debug') {
    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleFn(msg);
  }

  enqueueFileEntry(entry);
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

/** Resolves once all queued log-file writes have completed (test and shutdown seam). */
function flushLogWrites(): Promise<void> {
  return fileWriteQueue;
}

export { log, warn, error, debug, getLogs, setLogFile, flushLogWrites };
