import events = require('events');
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as logger from './logger';
import { gitSha } from './version';

const GITHUB_REPO = 'rygwdn/service-remote';
const RELEASE_TAG  = 'dev';
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface UpdateInfo {
  downloadUrl: string;
  /** URL for the SHA-256 sidecar published with the executable. */
  checksumUrl?: string;
  publishedAt: string;
  sha: string;
}

const CHECKSUM_ASSET_NAME = 'service-remote.exe.sha256';

function parseSha256(text: string): string {
  // Accept either a bare digest or the standard sha256sum output for this
  // executable, with exactly one optional trailing line ending.
  const content = text.endsWith('\r\n') ? text.slice(0, -2) : text.endsWith('\n') ? text.slice(0, -1) : text;
  const match = /^([a-f0-9]{64})(?:[ \t]+\*?service-remote\.exe)?$/i.exec(content);
  if (!match) throw new Error('Invalid SHA-256 checksum sidecar');
  return match[1].toLowerCase();
}

async function removeTempDir(tempDir: string | null): Promise<void> {
  if (!tempDir) return;
  try {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  } catch (err) {
    logger.warn('[Updater] Failed to remove temporary update files:', err instanceof Error ? err.message : String(err));
  }
}

class Updater extends (events.EventEmitter as new () => import('events').EventEmitter) {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastKnownSha: string | null = null;

  start(): void {
    this.check();
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref(); // don't keep the process alive
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async check(): Promise<void> {
    try {
      const info = await this.fetchRelease();
      if (!info) return;
      // Already notified about this SHA
      if (info.sha === this.lastKnownSha) return;
      // Same as what's running — no update
      if (gitSha !== 'unknown' && info.sha === gitSha) return;
      this.lastKnownSha = info.sha;
      logger.log(`[Updater] Update available (sha: ${info.sha}, published: ${info.publishedAt})`);
      this.emit('update-available', info);
    } catch (err) {
      logger.warn('[Updater] Update check failed:', err instanceof Error ? err.message : String(err));
    }
  }

  private async fetchRelease(): Promise<UpdateInfo | null> {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${RELEASE_TAG}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'service-remote-updater', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      logger.warn(`[Updater] GitHub API returned ${res.status}`);
      return null;
    }
    const data = await res.json() as {
      body?: string;
      published_at?: string;
      assets?: { name: string; browser_download_url: string }[];
    };

    const asset = data.assets?.find((a) => a.name === 'service-remote.exe');
    const checksumAsset = data.assets?.find((a) => a.name === CHECKSUM_ASSET_NAME);
    if (!asset || !checksumAsset) {
      logger.warn('[Updater] Dev release is missing service-remote.exe or its SHA-256 sidecar');
      return null;
    }

    // The release notes contain "Git SHA: <sha>" injected by build.ts
    const shaMatch = data.body?.match(/git sha[:\s]+([0-9a-f]{7,40})/i);
    const sha = shaMatch?.[1]?.slice(0, 7) ?? 'unknown';

    return {
      downloadUrl: asset.browser_download_url,
      checksumUrl: checksumAsset.browser_download_url,
      publishedAt: data.published_at ?? '',
      sha,
    };
  }

  async download(info: UpdateInfo, destDir: string): Promise<string> {
    let tempDir: string | null = null;
    try {
      // mkdtemp creates a private randomized directory, while the UUID keeps
      // the executable name unpredictable even within that directory.
      tempDir = await fs.promises.mkdtemp(path.join(destDir, 'service-remote-update-'));
      const destPath = path.join(tempDir, `service-remote-${crypto.randomUUID()}.exe`);
      const checksumUrl = info.checksumUrl ?? `${info.downloadUrl}.sha256`;
      logger.log(`[Updater] Downloading update from ${info.downloadUrl} …`);

      const checksumRes = await fetch(checksumUrl, {
        headers: { 'User-Agent': 'service-remote-updater' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!checksumRes.ok) throw new Error(`Checksum download failed: HTTP ${checksumRes.status}`);
      const expectedDigest = parseSha256(await checksumRes.text());

      const res = await fetch(info.downloadUrl, {
        headers: { 'User-Agent': 'service-remote-updater' },
        signal: AbortSignal.timeout(5 * 60_000),
      });
      if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

      // Buffering lets us verify the complete response before creating an
      // executable path that another process could run.
      const buffer = Buffer.from(await res.arrayBuffer());
      const actualDigest = crypto.createHash('sha256').update(buffer).digest('hex');
      if (actualDigest !== expectedDigest) throw new Error('Downloaded executable checksum mismatch');

      await fs.promises.writeFile(destPath, buffer, { flag: 'wx' });
      logger.log(`[Updater] Download complete → ${destPath}`);
      return destPath;
    } catch (err) {
      await removeTempDir(tempDir);
      throw err;
    }
  }

}

const updater = new Updater();
export default updater;
