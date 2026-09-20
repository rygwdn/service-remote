import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSecurity, COOKIE_NAME, TOKEN_FILE } from '../../src/security';

function tempConfigPath(): { dir: string; configPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-remote-security-'));
  return { dir, configPath: path.join(dir, 'config.json') };
}

function request(url: string, headers?: Record<string, string>): Request {
  return new Request(url, { headers });
}

describe('security token lifecycle', () => {
  test('creates a persistent token with restrictive permissions and reuses it', () => {
    const { dir, configPath } = tempConfigPath();
    try {
      const first = createSecurity(configPath, { env: {} });
      const tokenPath = path.join(dir, TOKEN_FILE);
      const token = fs.readFileSync(tokenPath, 'utf8').trim();
      assert.match(token, /^[0-9a-f]{64}$/);
      assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
      assert.equal(first.authenticate(request(`http://localhost/api?token=${token}`)), true);

      const second = createSecurity(configPath, { env: {} });
      assert.equal(second.authenticate(request('http://localhost/api', { Authorization: `Bearer ${token}` })), true);
      assert.equal(fs.readFileSync(tokenPath, 'utf8').trim(), token);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('uses an environment override while preserving the persistent fallback', () => {
    const { dir, configPath } = tempConfigPath();
    try {
      const override = 'environment-token';
      const fromEnv = createSecurity(configPath, { env: { SERVICE_REMOTE_TOKEN: ` ${override} ` } });
      assert.equal(fromEnv.authenticate(request('http://localhost/api', { Authorization: `Bearer ${override}` })), true);
      assert.equal(fromEnv.authenticate(request('http://localhost/api', { Authorization: 'Bearer another-token' })), false);

      const persisted = fs.readFileSync(path.join(dir, TOKEN_FILE), 'utf8').trim();
      assert.notEqual(persisted, override);
      const withoutOverride = createSecurity(configPath, { env: {} });
      assert.equal(withoutOverride.authenticate(request(`http://localhost/api?token=${encodeURIComponent(persisted)}`)), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('accepts bearer, cookie, and query authentication but rejects wrong tokens', () => {
    const { dir, configPath } = tempConfigPath();
    try {
      const token = crypto.randomBytes(24).toString('hex');
      const security = createSecurity(configPath, { env: { SERVICE_REMOTE_TOKEN: token } });
      assert.equal(security.authenticate(request('http://localhost/api', { Authorization: `Bearer ${token}` })), true);
      assert.equal(security.authenticate(request('http://localhost/api', { Cookie: `${COOKIE_NAME}=${encodeURIComponent(token)}` })), true);
      assert.equal(security.authenticate(request(`http://localhost/api?token=${encodeURIComponent(token)}`)), true);
      assert.equal(security.authenticate(request('http://localhost/api', { Authorization: 'Bearer wrong' })), false);
      assert.equal(security.authenticate(request(`http://localhost/api?token=${encodeURIComponent(token)}-wrong`)), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('security request boundary', () => {
  test('bootstraps a token into a clean redirect and strict cookie', () => {
    const { dir, configPath } = tempConfigPath();
    try {
      const token = 'bootstrap-token';
      const security = createSecurity(configPath, { basePath: '/service', env: { SERVICE_REMOTE_TOKEN: token } });
      const response = security.bootstrap(request(`http://localhost/service/api/state?token=${token}&topics=state`));
      assert.ok(response);
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), '/service/api/state?topics=state');
      const cookie = response.headers.get('set-cookie') ?? '';
      assert.match(cookie, new RegExp(`^${COOKIE_NAME}=${token}`));
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Strict/);
      assert.match(cookie, /Path=\/service/);
      assert.match(cookie, /Max-Age=2592000/);
      assert.doesNotMatch(cookie, /Secure/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('marks HTTPS bootstrap cookies Secure and does not bootstrap WebSocket upgrades', () => {
    const { dir, configPath } = tempConfigPath();
    try {
      const security = createSecurity(configPath, { env: { SERVICE_REMOTE_TOKEN: 'secure-token' } });
      const response = security.bootstrap(request('https://localhost/api/state?token=secure-token'));
      assert.ok(response);
      assert.match(response.headers.get('set-cookie') ?? '', /Secure/);
      const upgrade = security.bootstrap(request('https://localhost/ws?token=secure-token', { Upgrade: 'websocket' }));
      assert.equal(upgrade, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('allows local hosts and matching origins while rejecting foreign hosts and origins', () => {
    const { dir, configPath } = tempConfigPath();
    try {
      const security = createSecurity(configPath, { env: { SERVICE_REMOTE_TOKEN: 'host-token' } });
      assert.equal(security.checkHost(request('http://localhost/api', { Host: 'localhost' })), null);
      assert.equal(security.checkHost(request('http://localhost/api', { Host: '127.0.0.1:3000', Origin: 'http://127.0.0.1:3000' })), null);
      assert.equal(security.checkHost(request('http://localhost/api', { Host: 'attacker.example' }))?.status, 403);
      assert.equal(security.checkHost(request('http://localhost/api', { Host: 'localhost:3000', Origin: 'http://attacker.example:3000' }))?.status, 403);
      assert.equal(security.checkHost(request('http://localhost/api', { Host: 'localhost', Origin: 'ftp://localhost' }))?.status, 403);
      assert.equal(security.checkHost(request('http://localhost/api', { Host: 'localhost', Origin: 'not-an-origin' }))?.status, 403);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('allows configured extra hosts with matching origins while still rejecting others', () => {
    const { dir, configPath } = tempConfigPath();
    try {
      const security = createSecurity(configPath, {
        env: { SERVICE_REMOTE_TOKEN: 'host-token' },
        allowedHosts: ['soundroom.tailcb2070.ts.net'],
      });
      assert.equal(security.checkHost(request('http://x/api', { Host: 'soundroom.tailcb2070.ts.net' })), null);
      assert.equal(
        security.checkHost(request('https://x/api', { Host: 'soundroom.tailcb2070.ts.net', Origin: 'https://soundroom.tailcb2070.ts.net' })),
        null,
      );
      assert.equal(security.checkHost(request('http://x/api', { Host: 'SOUNDROOM.TAILCB2070.TS.NET' })), null);
      assert.equal(security.checkHost(request('http://x/api', { Host: 'soundroom.tailcb2070.ts.net.evil.example' }))?.status, 403);
      assert.equal(security.checkHost(request('http://x/api', { Host: 'other.tailcb2070.ts.net' }))?.status, 403);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
