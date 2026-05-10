import events = require('events');
import fs from 'fs';
import path from 'path';
import * as logger from './logger';
import { gitSha } from './version';

const GITHUB_REPO = 'rygwdn/service-remote';
const RELEASE_TAG  = 'dev';
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface UpdateInfo {
  downloadUrl: string;
  publishedAt: string;
  sha: string;
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
    if (!asset) { logger.warn('[Updater] No service-remote.exe asset found in dev release'); return null; }

    // The release notes contain "Git SHA: <sha>" injected by build.ts
    const shaMatch = data.body?.match(/git sha[:\s]+([0-9a-f]{7,40})/i);
    const sha = shaMatch?.[1]?.slice(0, 7) ?? 'unknown';

    return { downloadUrl: asset.browser_download_url, publishedAt: data.published_at ?? '', sha };
  }

  async download(info: UpdateInfo, destDir: string): Promise<string> {
    const destPath = path.join(destDir, 'service-remote-update.exe');
    logger.log(`[Updater] Downloading update from ${info.downloadUrl} …`);

    const res = await fetch(info.downloadUrl, {
      headers: { 'User-Agent': 'service-remote-updater' },
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

    const buf = await res.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(buf));
    logger.log(`[Updater] Download complete → ${destPath}`);
    return destPath;
  }
}

const updater = new Updater();
export default updater;
