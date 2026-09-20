import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TOKEN_FILE = '.service-remote-token';
const COOKIE_NAME = 'service-remote-token';

interface SecurityOptions {
  basePath?: string;
  env?: NodeJS.ProcessEnv;
  /** Extra hostnames accepted by the Host/Origin boundary (e.g. a Tailscale FQDN). */
  allowedHosts?: readonly string[];
}

interface RequestSecurity {
  /** Return true when the request presents the installation token. */
  authenticate(req: Request): boolean;
  /** Return a host/origin rejection response, or null for an allowed request. */
  checkHost(req: Request): Response | null;
  /** Return a token bootstrap redirect, or null when this is not a bootstrap request. */
  bootstrap(req: Request): Response | null;
  /** Return an authentication rejection response, or null when authenticated. */
  requireAuth(req: Request): Response | null;
}

function tokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readOrCreateToken(configPath: string, env: NodeJS.ProcessEnv): string {
  const tokenFromEnv = env.SERVICE_REMOTE_TOKEN?.trim();
  const tokenPath = path.join(path.dirname(configPath), TOKEN_FILE);

  if (tokenFromEnv) {
    // Keep the persistent token available for installations that later remove the
    // override. This also makes an unwritable installation fail explicitly rather
    // than silently running without a recoverable token.
    try {
      if (!fs.existsSync(tokenPath)) {
        const generated = crypto.randomBytes(32).toString('hex');
        const fd = fs.openSync(tokenPath, 'wx', 0o600);
        try { fs.writeFileSync(fd, generated + '\n', 'utf8'); } finally { fs.closeSync(fd); }
      } else {
        fs.chmodSync(tokenPath, 0o600);
      }
    } catch (err) {
      throw new Error(`Unable to create service remote token file: ${(err as Error).message}`);
    }
    return tokenFromEnv;
  }

  try {
    if (fs.existsSync(tokenPath)) {
      const token = fs.readFileSync(tokenPath, 'utf8').trim();
      if (!token) throw new Error('token file is empty');
      fs.chmodSync(tokenPath, 0o600);
      return token;
    }
    const token = crypto.randomBytes(32).toString('hex');
    const fd = fs.openSync(tokenPath, 'wx', 0o600);
    try { fs.writeFileSync(fd, token + '\n', 'utf8'); } finally { fs.closeSync(fd); }
    return token;
  } catch (err) {
    throw new Error(`Unable to create or read service remote token file: ${(err as Error).message}`);
  }
}

function normalizeHostname(value: string): string {
  let host = value.trim().toLowerCase();
  if (host.startsWith('[') && host.includes(']')) host = host.slice(1, host.indexOf(']'));
  // A trailing dot is equivalent for DNS names, but not useful in an Origin
  // comparison. Zone identifiers are accepted by URL parsing but normalized here.
  host = host.replace(/\.$/, '').split('%')[0];
  return host;
}

function hostNameFromAuthority(value: string): string {
  const text = value.trim();
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end >= 0) return normalizeHostname(text.slice(0, end + 1));
  }
  const colon = text.lastIndexOf(':');
  return colon > -1 && text.indexOf(':') === colon ? normalizeHostname(text.slice(0, colon)) : normalizeHostname(text);
}

function isAllowedHostname(host: string, allowedHosts: Set<string>): boolean {
  return allowedHosts.has(host) || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
}

function normalizeAuthority(value: string): string {
  const text = value.trim().toLowerCase();
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end >= 0) return `${normalizeHostname(text.slice(0, end + 1))}${text.slice(end + 1)}`;
  }
  const colon = text.lastIndexOf(':');
  if (colon > -1 && text.indexOf(':') === colon) return `${normalizeHostname(text.slice(0, colon))}${text.slice(colon)}`;
  return normalizeHostname(text);
}

function collectAllowedHosts(extraAllowedHosts: readonly string[]): Set<string> {
  const allowed = new Set(['localhost', '127.0.0.1', '::1']);
  allowed.add(normalizeHostname(os.hostname()));
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address.internal) allowed.add(normalizeHostname(address.address));
    }
  }
  for (const host of extraAllowedHosts) {
    const normalized = normalizeHostname(host.trim());
    if (normalized) allowed.add(normalized);
  }
  return allowed;
}


function cookieValue(req: Request, name: string): string | null {
  const cookieHeader = req.headers.get('cookie');
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return null; }
  }
  return null;
}

function bearerValue(req: Request): string | null {
  const value = req.headers.get('authorization');
  if (!value) return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function createSecurity(configPath: string, options: SecurityOptions = {}): RequestSecurity {
  const basePath = (options.basePath ?? '').replace(/\/+$/, '');
  const token = readOrCreateToken(configPath, options.env ?? process.env);
  const allowedHosts = collectAllowedHosts(options.allowedHosts ?? []);

  function queryValue(req: Request): string | null {
    return new URL(req.url).searchParams.get('token');
  }

  function authenticate(req: Request): boolean {
    const presented = [bearerValue(req), cookieValue(req, COOKIE_NAME), queryValue(req)];
    return presented.some((value) => value !== null && tokenEqual(value, token));
  }

  function checkHost(req: Request): Response | null {
    const host = req.headers.get('host');
    if (!host || !isAllowedHostname(hostNameFromAuthority(host), allowedHosts)) {
      return new Response('Forbidden', { status: 403 });
    }
    const origin = req.headers.get('origin');
    if (origin) {
      try {
        const originUrl = new URL(origin);
        if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return new Response('Forbidden', { status: 403 });
        if (normalizeAuthority(originUrl.host) !== normalizeAuthority(host)) return new Response('Forbidden', { status: 403 });
      } catch {
        return new Response('Forbidden', { status: 403 });
      }
    }
    return null;
  }

  function bootstrap(req: Request): Response | null {
    const url = new URL(req.url);
    const queryToken = url.searchParams.get('token');
    // WebSocket clients cannot follow an HTTP redirect. They authenticate the
    // upgrade directly with the query token instead.
    if (!queryToken || req.headers.get('upgrade')?.toLowerCase() === 'websocket' || !tokenEqual(queryToken, token)) return null;
    url.searchParams.delete('token');
    const headers = new Headers({ Location: url.toString() });
    const cookieParts = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'HttpOnly', 'SameSite=Strict', `Path=${basePath || '/'}`, 'Max-Age=2592000'];
    if (url.protocol === 'https:') cookieParts.push('Secure');
    headers.set('Set-Cookie', cookieParts.join('; '));
    return new Response(null, { status: 302, headers });
  }

  function requireAuth(req: Request): Response | null {
    if (authenticate(req)) return null;
    return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
  }

  return { authenticate, checkHost, bootstrap, requireAuth };
}

export { createSecurity, COOKIE_NAME, TOKEN_FILE };
export type { RequestSecurity, SecurityOptions };
