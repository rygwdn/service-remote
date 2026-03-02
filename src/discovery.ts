import dgram = require('dgram');
import os = require('os');
import net = require('net');

export interface DiscoveryResult {
  found: boolean;
  address?: string;
  port?: number;
  error?: string;
}

// Compute broadcast addresses for all non-loopback IPv4 interfaces
export function getBroadcastAddresses(): string[] {
  const addrs: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ipInt = ipToInt(addr.address);
      const maskInt = ipToInt(addr.netmask);
      const broadcastInt = (ipInt & maskInt) | (~maskInt >>> 0);
      addrs.push(intToIp(broadcastInt));
    }
  }
  return addrs;
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

function intToIp(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

// Encode a minimal OSC message for /xremote (no args)
function encodeOscXremote(): Buffer {
  // address: /xremote\0 = 8 chars (already 4-byte aligned)
  // type tag: ,\0\0\0 (4 bytes)
  const address = Buffer.from('/xremote\0\0\0\0', 'ascii'); // 12 bytes
  const typeTag = Buffer.from(',\0\0\0', 'ascii');           // 4 bytes
  return Buffer.concat([address, typeTag]);
}

export async function discoverX32(timeoutMs = 3000): Promise<DiscoveryResult> {
  return new Promise((resolve) => {
    const broadcasts = getBroadcastAddresses();
    if (broadcasts.length === 0) {
      resolve({ found: false, error: 'No network interfaces found' });
      return;
    }

    const socket = dgram.createSocket('udp4');
    let settled = false;

    const done = (result: DiscoveryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };

    const timer = setTimeout(() => done({ found: false }), timeoutMs);

    socket.on('message', (_msg, rinfo) => {
      done({ found: true, address: rinfo.address, port: 10023 });
    });

    socket.on('error', (err) => {
      done({ found: false, error: err.message });
    });

    socket.bind(0, () => {
      socket.setBroadcast(true);
      const msg = encodeOscXremote();
      for (const addr of broadcasts) {
        socket.send(msg, 10023, addr, () => {});
      }
    });
  });
}

export async function discoverObs(timeoutMs = 2000): Promise<DiscoveryResult> {
  return new Promise((resolve) => {
    let settled = false;

    const done = (result: DiscoveryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.destroy(); } catch { /* ignore */ }
      resolve(result);
    };

    const timer = setTimeout(() => done({ found: false }), timeoutMs);

    // Use a plain TCP connection to avoid requiring 'ws' at module level
    const ws = new net.Socket();
    ws.connect(4455, '127.0.0.1', () => {
      done({ found: true, address: 'ws://localhost:4455', port: 4455 });
    });
    ws.on('error', () => {
      done({ found: false });
    });
  });
}

export async function discoverProclaim(timeoutMs = 2000): Promise<DiscoveryResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('http://127.0.0.1:52195/', { signal: controller.signal });
    clearTimeout(timer);
    // Any HTTP response (even 4xx) means the server is present
    void res;
    return { found: true, address: '127.0.0.1', port: 52195 };
  } catch (err) {
    clearTimeout(timer);
    const error = (err as Error).name === 'AbortError' ? 'timeout' : (err as Error).message;
    // Connection refused or timeout → not found
    if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED' || (err as Error).name === 'AbortError') {
      return { found: false };
    }
    return { found: false, error };
  }
}
