# web5250 — Web-to-5250 Terminal Gateway for IBM i

A self-contained, containerized TN5250 gateway that renders an authentic
green-screen 5250 terminal in any modern browser. It speaks the real 5250
Telnet interface to your IBM i / AS/400 and streams screen updates to a
WebSocket-connected SPA — designed from the ground up to be published through
the [Pangolin](https://pangolin.notrs.com) zero-trust reverse proxy.

```
[ Browser ]                                        HTTPS / WSS
     │
[ Pangolin Reverse Proxy / Site Connector ]        (auth enforced here)
     │  HTTP / WS (proxied)
[ web5250 container  :8080 ]
     │  TN5250 over TCP :23  (or TLS :992)
[ IBM i / AS/400 ]
```

## Features

- **Full TN5250 client protocol** implemented from RFC 1205 / RFC 2877 and
  cross-checked byte-for-byte against the battle-tested tn5250j and tn5250
  emulators: telnet negotiation (TERMINAL-TYPE, END-OF-RECORD,
  TRANSMIT-BINARY, NEW-ENVIRON), GDS record framing with IAC escaping,
  DEVNAME device naming via NEW-ENVIRON, and the 5250 Query (WSF) reply.
- **5250 data stream engine**: Write to Display with all core orders (SBA,
  SF/extended SF with FFW + FCW, IC, MC, RA, EA, SOH, transparent data),
  Clear Unit / Clear Unit Alternate (**27×132** switching), Save/Restore
  Screen, Write Error Code (X II + Reset), Roll, Read Input Fields /
  Read MDT Fields / Read MDT Immediate / Read Screen, and negative-response
  handling.
- **Authentic terminal model**: 24×80 or 27×132 cell matrix, field table
  with MDT semantics, numeric-only / auto-enter / monocase / bypass fields,
  non-display (password) fields, attribute-driven colors (green, white, red,
  yellow, turquoise, blue, pink, reverse video), OIA indicators
  (`X SYSTEM`, `X II`, insert `^`, `MW`), audible alarm, and keyboard
  locking identical to a real controller.
- **Connection menu**: the app opens on a retro green-screen *System
  Selection* panel (number keys / arrows + Enter, or tap) listing the remote
  systems an administrator maintains — each with its own host, port, TLS,
  terminal model, code page and device prefix. Systems live in a SQLite file
  on a persistent volume; the list is seeded from `IBM_I_*` on first boot, so
  upgrading deployments keep working unchanged.
- **Admin editor**: a PIN-protected (`ADMIN_PIN`) editor manages the system
  list — add, edit, delete, reorder. PINs are compared in constant time with
  a lockout after repeated failures; tokens expire after 8 hours.
- **Browser UX**: canvas renderer with IBM Plex Mono, complete 5250 key
  interception (F1–F24 incl. Shift+F1–F12 → PF13–PF24), field exit, insert
  mode, roll keys, SysReq/Attn, Reset, on-screen keypad for touch devices,
  click-to-position, and reconnect handling. Screen state is edited
  server-side; only diffs travel over the WebSocket, and non-display field
  contents are blanked server-side so **passwords never reach the browser**.
- **Proxy-friendly**: relative asset paths (works under any sub-path),
  accepts upgrades on any `…/ws` path, WebSocket keepalive pings, `/healthz`
  for uptime checks, zero client-side dependencies beyond static assets.
- **Operations**: single non-root distroless-style container (Node 22
  alpine, ≥ 22.13 for the built-in `node:sqlite`), no runtime npm
  dependencies (everything is bundled), healthcheck built in, ~15 MB runtime
  footprint.

## Quick start

Configuration lives in a `.env` file next to `docker-compose.yml` (compose
reads it automatically):

```bash
cp .env.example .env      # then edit IBM_I_HOST etc.
```

### With a real IBM i

```bash
docker compose up -d --build          # builds locally, uses .env
```

Or run a published image instead of building —
[`docker-compose.registry.yml`](docker-compose.registry.yml) has no `build:`
and pulls whatever `IMAGE` points at (default is a placeholder for the
public release, so set `IMAGE` in `.env`, e.g.
`IMAGE=ghcr.io/OWNER/web5250:latest`):

```bash
docker compose -f docker-compose.registry.yml up -d
```

The internal CI pipeline pushes to the project GitLab registry
(`registry.example.com/web5250`) — point `IMAGE` there the same way,
or keep using the build variant with `docker compose up -d --no-build`.

Then open the published Pangolin resource (or `http://localhost:8080` for
local testing). You'll land on the **System Selection** menu — pick a system
(or press **Admin** to edit the list, see
[System selection & admin](#system-selection--admin)) and sign on. See
[Connecting to IBM i](#connecting-to-ibm-i) for port/TLS/code page details.

### Without an IBM i (built-in demo)

The repository ships a **mock IBM i** that implements the server side of the
protocol (sign-on screen, MAIN menu, help, SysReq window, sign-off):

```bash
IBM_I_HOST=mock-host IBM_I_PORT=8023 docker compose --profile demo up -d --build
open http://localhost:8080            # any non-empty user + password signs on
```

## CI / CD

`.gitlab-ci.yml` runs two stages on every push:

- **validate** — `npm ci` + typecheck + full build (Node 22 alpine).
- **web5250-image** — multi-stage Docker build via rootless BuildKit (no
  privileged runner), pushed to the project's GitLab container registry:

  | Event | Tags pushed |
  | :--- | :--- |
  | any commit | `:$CI_COMMIT_SHORT_SHA` |
  | branch push | additionally `:$CI_COMMIT_REF_SLUG` |
  | default branch (`main`) | additionally `:latest` |
  | tag | additionally `:$CI_COMMIT_REF_NAME` and `:latest` |

  Merge-request pipelines build without pushing (validation only). Registry
  credentials come from the built-in CI job token — nothing to configure.

## Configuration

All configuration is via environment variables — see [`.env.example`](.env.example)
for a commented template and `docker-compose.yml` for the full wiring:

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | Published web port on the host (the container always listens on 8080 internally) | `8080` |
| `HOST` | Bind address | `0.0.0.0` |
| `IBM_I_HOST` | Target IBM i IP or hostname | `127.0.0.1` |
| `IBM_I_PORT` | TN5250 port (23 telnet, 992 TLS) | `23` |
| `IBM_I_SSL` | TLS connection to host (`true`/`false`) | `false` |
| `IBM_I_CODEPAGE` | EBCDIC code page: `cp037` `cp273` `cp277` `cp278` `cp280` `cp284` `cp285` `cp297` `cp500` `cp871` `cp1047` `cp1140` | `cp037` |
| `IBM_I_TERM_TYPE` | Terminal model (`IBM-3477-FC` = color + 27×132, `IBM-3179-2` = 24×80 color, …) | `IBM-3477-FC` |
| `IBM_I_DEV_PREFIX` | Prefix for auto-generated device names (max 10 chars total) | `PANG_` |
| `ALLOW_CUSTOM_HOST` | Let users point a session at another host via query params (`?host=&port=&ssl=1&term=&cp=&devname=`) | `false` |
| `ADMIN_PIN` | PIN for the connection-menu admin editor (≥ 4 chars; empty disables admin) | – |
| `WEB5250_DB` | SQLite file for the system catalog (compose mounts the `web5250-data` volume at `/data`) | `/data/web5250.db` in the container, `data/web5250.db` locally |
| `IBM_I_TLS_REJECT_UNAUTHORIZED` | Enforce CA validation for host TLS (IBM i certs are usually self-signed) | `false` |
| `WEB5250_TRACE` | `1` dumps raw TN5250 hex traffic to the log (debugging) | – |

Each browser session gets its own 5250 device. Device names are generated as
`<prefix><random>`; if the name collides, the gateway automatically retries
with a numbered suffix (RFC 2877 behaviour).

## System selection & admin

On first start the app shows a 5250-style menu of systems. Connection
parameters resolve in order: URL overrides (`ALLOW_CUSTOM_HOST`) → the
menu-selected system → the `IBM_I_*` environment defaults. On first boot the
catalog is seeded with the environment host, so existing single-host
deployments see exactly one entry and behave as before. Deep links work:
`?system=<id>` opens that system directly, `?host=…` keeps the legacy
custom-host behaviour.

**Admin** (bottom of the menu, or press `A`): enter `ADMIN_PIN`, then add /
edit / delete / reorder systems. Edits persist to SQLite (mount the compose
volume) and apply immediately — no restart needed. Every system carries its
own host, port, TLS flag, terminal model, code page and optional device
prefix.

The JSON API behind it (all sub-path tolerant, like `/healthz`):

| Method & path | Auth | Purpose |
| :-- | :-- | :-- |
| `GET /api/meta` | – | admin enabled?, terminal models, code pages, form defaults |
| `GET /api/systems` | – | the menu list |
| `POST /api/admin/auth` | PIN | `{pin}` → `{token}` (8 h bearer token) |
| `POST /api/admin/systems` | token | create |
| `PUT /api/admin/systems/<id>` | token | update |
| `DELETE /api/admin/systems/<id>` | token | delete |
| `POST /api/admin/systems/<id>/move` | token | `{dir: up\|down}` reorder |

WebSocket sessions target a system with `?system=<id>` (rejected with 404 if
the id no longer exists — the browser falls back to the menu). Failed PIN
attempts lock administration for 60 s after 5 tries.

## Connecting to IBM i

1. Make sure the telnet device controller allows your device-name pattern.
   A controller `AUTOCFG(*YES)` with `DEVNAME(PANG_*)` style naming is the
   easiest; alternatively pre-create devices and pass `?devname=MYDEV` in the
   URL (validated to `[A-Z0-9#$@_]{1,10}`).
2. Plain telnet: `IBM_I_PORT=23`, `IBM_I_SSL=false`.
   TLS: `IBM_I_PORT=992`, `IBM_I_SSL=true`.
3. Pick the code page matching your system's CCSID (037 US, 273 German,
   277 Danish/Norwegian, 278 Finnish/Swedish, 280 Italian, 284/285 Spanish/UK,
   297 French, 500 International, 871 Icelandic, 1140 = 037 with Euro).
4. Verify: open the app — you should see the `QDSIGNON` sign-on display,
   cursor waiting in the **User** field. Type your user profile, `Tab`,
   password (typed characters stay invisible — that's the 5250 non-display
   attribute doing its job), then `Enter`.

## Keyboard mapping

| Browser key | 5250 function |
| :--- | :--- |
| `Enter` | Enter (transmit screen) |
| `Tab` / `Shift+Tab` | Next / previous field |
| `F1`–`F12` | PF1–PF12 |
| `Shift+F1`–`Shift+F12` | PF13–PF24 |
| `Numpad +` or `Ctrl+Enter` | Field Exit |
| `Numpad -` | Field− |
| `Esc` | SysReq (`Shift+Esc` = Attn) |
| `Insert` | Insert / overwrite toggle |
| `Delete` | Delete character (shift field left) |
| `Backspace` | Cursor left (authentic non-destructive 5250 backspace) |
| `Home` / `End` | Home field / end of field |
| `PageUp` / `PageDown` | Roll Up / Roll Down |
| `Ctrl+R` or `Alt+R` | Reset (clears `X II` keyboard errors) |
| `Alt+H` / `Alt+P` | Help / host print |

While the OIA shows `X SYSTEM` or `X II`, data keys are blocked exactly like
a real terminal (SysReq, Attn and Reset still work). The on-screen keypad
(button in the top bar) mirrors everything for touch devices.

## Publishing through Pangolin

The gateway is an ordinary HTTP+WebSocket upstream with **no built-in
authentication** — Pangolin is the auth boundary. Never expose the container
directly to the internet.

1. **Deploy the container** next to your Pangolin site connector (same
   docker network as Newt / the connector):
   ```yaml
   services:
     web5250:
       build: .
       restart: unless-stopped
       environment:
         IBM_I_HOST: as400.corp.lan
       # no host port binding needed - the connector reaches it over the network
       expose: ["8080"]
   networks: [default]   # attach to the connector's network
   ```
2. **Create a resource** in Pangolin (e.g. `as400.yourdomain.com`):
   - Type: **HTTP**, upstream `http://web5250:8080`.
   - WebSockets are proxied automatically; the app pings every 30 s to keep
     idle tunnels healthy.
3. **Or use a path-based rule** on an existing site (e.g.
   `https://intranet.yourdomain.com/as400/*` → `http://web5250:8080/*`).
   The SPA uses relative asset paths and derives its WebSocket URL from the
   page path, so it works with or without path rewriting. `/healthz`
   responds on any prefix (`/as400/healthz` included) for uptime monitors.
4. Attach your Pangolin **access rules** (users/groups) as usual. Every
   browser tab holds one 5250 session; closing the tab ends the device
   session on the host.

## Local development

```bash
npm install
npm run gen:ebcdic      # regenerate EBCDIC tables (requires iconv; committed already)
npm run mock            # mock IBM i on :8023
npm run dev:server      # backend on :8080 (Node type-stripping + watch)
npm run dev:client      # Vite dev server on :5173, proxies /ws to :8080
```

Local runs keep the SQLite catalog in `./data/web5250.db` (git-ignored) —
override with `WEB5250_DB`. Set `ADMIN_PIN` to try the admin editor.

Build + verify (Node ≥ 22.13 for `node:sqlite`):

```bash
npm run build           # vite (SPA) + esbuild (server, mock) -> dist/
npm run smoke           # end-to-end: mock host + gateway + WS client
node scripts/mock-host.mjs &   # visual test drives real Chromium
PORT=8080 IBM_I_HOST=127.0.0.1 IBM_I_PORT=8023 ADMIN_PIN=1234 npm start &
npm run visual          # screenshots land in artifacts/
```

The smoke test covers: sign-on rendering, cursor placement, X II error +
Reset, typing, Tab, Field Exit, password non-display over the wire, Enter →
MAIN menu, F1/F3, option entry and sign-off — plus the menu API (list, PIN
auth, system CRUD, `?system=` sessions, rate limiting).

## How it works

- `src/server/tn5250/` — protocol: `telnet.ts` (negotiation + GDS framing),
  `parser.ts` (inbound command/order engine), `screen.ts` (cell matrix,
  field table, OIA, local key semantics), `client.ts` (session + AID
  transmission), `ebcdic*.ts` (bidirectional code page tables).
- `src/server/gateway.ts` — one WebSocket ⇄ one 5250 session; browsers send
  logical key events, receive batched cell diffs + OIA updates.
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

## Troubleshooting

- **Blank screen / stuck at "Negotiating"** — check `IBM_I_HOST`/`PORT`
  reachability from the container; set `WEB5250_TRACE=1` and compare the hex
  dump with a working tn5250j session.
- **Garbled characters** — wrong code page; set `IBM_I_CODEPAGE` to your
  system CCSID's EBCDIC page.
- **"Device not available"** — the host controller rejects the generated
  device name; adjust `IBM_I_DEV_PREFIX` or pre-create the device and pass
  `?devname=`.
- **Session drops after ~1 min idle** — the gateway already sends telnet
  NOPs and WS pings; if a middlebox still kills it, lower Pangolin's idle
  timeout or check the connector's keepalive settings.
- **TLS handshake fails** — `IBM_I_SSL=true` and the correct port (usually
  992); for internal CAs set `IBM_I_TLS_REJECT_UNAUTHORIZED=true` only if
  you mount the CA into the container.

## Security notes

- No auth in the app **by design** — publish only through Pangolin (or
  another authenticated edge). Every request that reaches the container is
  assumed to be authorized.
- The `ADMIN_PIN` gates host-list administration only; it is not user
  authentication (Pangolin does that). It is hashed and compared in constant
  time, with a 60 s lockout after 5 failed attempts; tokens are random,
  in-memory and expire after 8 h.
- 5250 traffic to the host is plaintext telnet unless `IBM_I_SSL=true`
  (per system in the menu).
- Non-display field contents (passwords) are stripped server-side before
  anything is sent to the browser.

## License

MIT — see [LICENSE](LICENSE).
