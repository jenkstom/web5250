# Architecture

*How the gateway works inside*

- `src/server/tn5250/` — protocol: `telnet.ts` (negotiation + GDS framing),
  `parser.ts` (inbound command/order engine), `screen.ts` (cell matrix,
  field table, OIA, local key semantics), `client.ts` (session + AID
  transmission), `ebcdic*.ts` (bidirectional code page tables).
- `src/server/gateway.ts` — one WebSocket ⇄ one 5250 session; browsers send
  logical key events, receive batched cell diffs + OIA updates. `?view=`
  sockets attach as read-only mirrors that receive the same broadcast.
- `src/server/systems.ts` + `src/server/api.ts` — SQLite-backed system
  catalog (node:sqlite) and the JSON API feeding the connection menu and its
  PIN-gated admin editor.
- `src/server/index.ts` — HTTP static serving (sub-path tolerant), `/healthz`,
  `/api/*`, WS upgrade handling with menu-system resolution.
- `src/client/` — canvas terminal, keyboard interception, OIA bar, keypad.
- `scripts/mock-host.mjs` — scriptable mock IBM i (also bundled into the
  image for the compose `demo` profile).

Protocol constants were verified against RFC 1205, RFC 2877 and the
tn5250j/tn5250 implementations rather than inferred; quirks that matter for
real hosts (GDS `12A0` framing, escape-separated command streams, SF length
including the attribute cell, WSF query reply bytes, DEVNAME via
NEW-ENVIRON) are all implemented faithfully.
