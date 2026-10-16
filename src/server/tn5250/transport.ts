// Host-socket acquisition shared by display and printer sessions: direct
// TCP, TLS, or a SOCKS5 tunnel (optionally with TLS layered inside it).
// Factored out of Tn5250Client so printer sessions get the same transport
// options (and the same preread handling for bytes that arrive piggy-backed
// on the SOCKS handshake) without duplicating the wiring.
import * as net from 'node:net';
import * as tls from 'node:tls';
import { socks5Connect, type SocksProxy } from './socks.ts';

export interface HostEndpoint {
  host: string;
  port: number;
  ssl: boolean;
  /** Route the host TCP connection through this SOCKS5 proxy. */
  proxy?: SocksProxy;
}

export interface OpenSocketOptions {
  tlsRejectUnauthorized: boolean;
  connectTimeoutMs?: number;
  /**
   * Fires as soon as a socket exists (even mid SOCKS handshake), so a
   * caller can destroy it while the handshake is still running (connect
   * timeout, session teardown).
   */
  onSocket?: (socket: net.Socket) => void;
}

export interface HostSocket {
  socket: net.Socket;
  /**
   * Bytes that arrived with the SOCKS handshake reply (the host starts its
   * telnet negotiation the moment the tunnel opens). Plain connections
   * never carry any: replay them to the telnet layer before live data.
   */
  preread: Buffer;
  /**
   * The event that marks the transport established: 'connect' for direct
   * sockets, 'secureConnect' for TLS, null when the socket is already
   * talking (a plain proxy tunnel).
   */
  ready: 'connect' | 'secureConnect' | null;
}

/** Open the raw transport to the host (direct / TLS / SOCKS5 + optional TLS). */
export function openHostSocket(
  endpoint: HostEndpoint,
  opts: OpenSocketOptions
): Promise<HostSocket> {
  const { host, port, ssl, proxy } = endpoint;
  if (proxy) {
    return socks5Connect(proxy, { host, port }, opts.onSocket).then(({ socket: raw, preread }) => {
      if (!ssl) return { socket: raw, preread, ready: null };
      // TLS rides inside the tunnel, so bytes that arrived with the proxy
      // reply are the start of the TLS handshake: push them back into the
      // socket for the TLS layer to parse, not into telnet.
      if (preread.length) raw.unshift(preread);
      const secure = tls.connect({
        socket: raw,
        servername: net.isIP(host) ? undefined : host,
        rejectUnauthorized: opts.tlsRejectUnauthorized
      });
      return { socket: secure, preread: Buffer.alloc(0), ready: 'secureConnect' };
    });
  }
  const socket: net.Socket = ssl
    ? tls.connect({ host, port, rejectUnauthorized: opts.tlsRejectUnauthorized })
    : net.connect({ host, port });
  opts.onSocket?.(socket);
  return Promise.resolve({ socket, preread: Buffer.alloc(0), ready: 'connect' });
}
