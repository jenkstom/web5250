// Minimal SOCKS5 client (RFC 1928) with username/password authentication
// (RFC 1929) - the one feature a per-system egress proxy needs: CONNECT to
// the host's host:port through the proxy, then get out of the way. After the
// handshake the socket is a raw bidirectional pipe, so the telnet layer
// cannot tell it is not talking to the IBM i directly.
import * as net from 'node:net';

export interface SocksProxy {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface SocksTunnel {
  socket: net.Socket;
  /**
   * Bytes that arrived piggy-backed on the handshake replies. The host
   * starts its telnet negotiation the moment the tunnel opens, so its first
   * bytes can share a TCP segment with the proxy's CONNECT reply; they are
   * buffered here instead of being handed to the (not yet attached)
   * consumer, and must be replayed before any live socket data.
   */
  preread: Buffer;
}

/** RFC 1928 CONNECT reply codes, for error text worth acting on. */
const REP_MESSAGES: Record<number, string> = {
  0x01: 'general SOCKS failure',
  0x02: 'connection not allowed by ruleset',
  0x03: 'network unreachable',
  0x04: 'host unreachable',
  0x05: 'connection refused',
  0x06: 'TTL expired',
  0x07: 'command not supported',
  0x08: 'address type not supported'
};

/**
 * Open a SOCKS5 CONNECT tunnel to target.host:target.port via the proxy.
 * `onSocket` fires as soon as the TCP connection to the proxy exists, so a
 * caller can destroy the socket while the handshake is still in flight
 * (connect timeout, session teardown).
 */
export function socks5Connect(
  proxy: SocksProxy,
  target: { host: string; port: number },
  onSocket?: (socket: net.Socket) => void
): Promise<SocksTunnel> {
  return new Promise((resolve, reject) => {
    const haveCreds = proxy.username !== undefined || proxy.password !== undefined;
    const user = Buffer.from(proxy.username ?? '', 'utf8');
    const pass = Buffer.from(proxy.password ?? '', 'utf8');
    if (user.length > 255 || pass.length > 255) {
      reject(new Error('socks5: proxy username and password are limited to 255 bytes each'));
      return;
    }

    const socket = net.connect({ host: proxy.host, port: proxy.port });
    onSocket?.(socket);

    let settled = false;
    let stage: 'greeting' | 'auth' | 'connect' = 'greeting';
    let buf: Buffer = Buffer.alloc(0);

    const fail = (msg: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(new Error(`socks5 ${proxy.host}:${proxy.port}: ${msg}`));
    };

    const sendConnect = (): void => {
      // ATYP by target spelling: IPv4/IPv6 literals go as binary addresses,
      // names as a length-prefixed domain the proxy resolves on its side.
      const addr = net.isIP(target.host) === 4
        ? ipv4Bytes(target.host)
        : net.isIP(target.host) === 6
          ? ipv6Bytes(target.host)
          : null;
      const name = addr ?? Buffer.from(target.host, 'utf8');
      if (name.length > 255) {
        fail('target host name longer than 255 bytes');
        return;
      }
      const atyp = addr ? (addr.length === 4 ? 1 : 4) : 3;
      socket.write(
        addr
          ? Buffer.concat([Buffer.from([5, 1, 0, atyp]), addr, portBytes(target.port)])
          : Buffer.concat([Buffer.from([5, 1, 0, atyp, name.length]), name, portBytes(target.port)])
      );
      stage = 'connect';
    };

    const onData = (chunk: Buffer): void => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      // One chunk can carry several handshake replies back to back; drain
      // until the current stage needs more bytes than have arrived.
      for (;;) {
        if (stage === 'greeting') {
          if (buf.length < 2) return;
          const [ver, method] = buf;
          if (ver !== 5) {
            fail('proxy is not speaking SOCKS v5');
            return;
          }
          buf = buf.subarray(2);
          if (method === 0x00) {
            // No auth. If credentials were configured the proxy waived
            // them; the tunnel is what matters, so proceed.
            sendConnect();
            continue;
          }
          if (method === 0x02) {
            if (!haveCreds) {
              fail('proxy requires a username/password (none configured for this system)');
              return;
            }
            socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
            stage = 'auth';
            continue;
          }
          fail(
            method === 0xff
              ? 'no acceptable auth method (proxy refuses no-auth and username/password)'
              : `unexpected auth method 0x${method.toString(16)}`
          );
          return;
        }
        if (stage === 'auth') {
          if (buf.length < 2) return;
          const [ver, status] = buf;
          if (ver !== 1) {
            fail('malformed username/password reply');
            return;
          }
          buf = buf.subarray(2);
          if (status !== 0) {
            fail('proxy rejected the username/password');
            return;
          }
          sendConnect();
          continue;
        }
        // stage === 'connect': [VER REP RSV ATYP bnd.addr bnd.port]
        if (buf.length < 4) return;
        if (buf[0] !== 5) {
          fail('malformed CONNECT reply');
          return;
        }
        const atyp = buf[3];
        let addrLen: number;
        if (atyp === 0x01) addrLen = 4;
        else if (atyp === 0x04) addrLen = 16;
        else if (atyp === 0x03) {
          if (buf.length < 5) return;
          addrLen = 1 + buf[4];
        } else {
          fail(`unexpected bound-address type 0x${atyp.toString(16)}`);
          return;
        }
        if (buf.length < 4 + addrLen + 2) return;
        const rep = buf[1];
        buf = buf.subarray(4 + addrLen + 2);
        if (rep !== 0x00) {
          fail(REP_MESSAGES[rep] ?? `CONNECT failed (reply 0x${rep.toString(16)})`);
          return;
        }
        settled = true;
        cleanup();
        resolve({ socket, preread: buf });
        return;
      }
    };

    const onError = (err: Error): void => fail(err.message);
    const onClose = (): void => fail('proxy closed the connection during the handshake');

    function cleanup(): void {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    }

    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('data', onData);

    // Offer no-auth and username/password when configured, no-auth alone
    // otherwise; a proxy that demands something else answers 0xFF above.
    const methods = haveCreds ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([5, methods.length, ...methods]));
  });
}

const portBytes = (port: number): Buffer => Buffer.from([(port >> 8) & 0xff, port & 0xff]);

/** Dotted-quad literal to 4 bytes, or null when malformed (then sent as a name). */
function ipv4Bytes(host: string): Buffer | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const out = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const b = Number(parts[i]);
    if (b > 255) return null;
    out[i] = b;
  }
  return out;
}

/**
 * IPv6 literal (as accepted by net.isIP) to 16 bytes, or null when it uses
 * a spelling this parser does not expand (v4-mapped "::ffff:1.2.3.4") - the
 * address then travels as a domain, which proxies resolve identically.
 */
function ipv6Bytes(host: string): Buffer | null {
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const groups = (s: string): number[] =>
    s === '' ? [] : s.split(':').map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? Number.parseInt(g, 16) : NaN));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if ([...head, ...tail].some(Number.isNaN)) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const out = Buffer.alloc(16);
  [...head, ...new Array<number>(missing).fill(0), ...tail].forEach((g, i) =>
    out.writeUInt16BE(g, i * 2)
  );
  return out;
}
