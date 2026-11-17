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

## Screenshots

Taken against the bundled mock host (`npm run shots` and `npm run shots:admin`
regenerate them); the system catalog and keymaps are mocked up through the
admin API.

| | |
|---|---|
| ![System selection](docs/screenshots/menu.png)<br>**System selection** — the admin-maintained catalog with TLS, SOCKS5-tunnel and auto sign-on markers | ![Sign-on](docs/screenshots/signon.png)<br>**Sign-on** — the host's own QDSIGNON screen; password cells never leave the server |
| ![IBM i main menu](docs/screenshots/main-menu.png)<br>**IBM i main menu** — attribute-driven colors, command line, click-to-position cursor | ![Work list](docs/screenshots/worklist.png)<br>**Work list** — option columns, one input field per row |
| ![Multiline SQL paste](docs/screenshots/sql-paste.png)<br>**Multiline paste** — a pasted SQL statement fills one input line per row | ![Split view](docs/screenshots/split.png)<br>**Split view** — two independent sessions side by side, draggable divider |

### Administration & configuration

The PIN-gated admin console (`A` on the menu, or the Admin button) — the
[full guide](docs/admin.md) covers every field and endpoint.

| | |
|---|---|
| ![Admin sign-on](docs/screenshots/admin-pin.png)<br>**Admin sign-on** — the console is gated by `ADMIN_PIN`, compared in constant time with a lockout | ![System catalog](docs/screenshots/admin-systems.png)<br>**System catalog** — every host with its TLS / SOCKS5 / auto sign-on markers, reorderable |
| ![System editor](docs/screenshots/admin-system-form.png)<br>**System editor** — connection, SOCKS5 proxy, printer session, recording, stored sign-on account, and the per-host keymap | ![Keymaps](docs/screenshots/admin-keymaps.png)<br>**Keymaps** — uploaded `.kmp` files and hand-built maps, one as the gateway default |
| ![Keymap editor](docs/screenshots/admin-keymap-editor.png)<br>**Visual keymap editor** — click a keycap, set what its Plain/Shift/Ctrl/Alt states send; the built-in behavior is shown for every state | ![Session console](docs/screenshots/admin-sessions.png)<br>**Session console** — live sessions (device, signed-on user, origin) with Mirror / Signal / End, plus maintenance windows per system or gateway-wide |
| ![Settings](docs/screenshots/admin-settings.png)<br>**Settings** — the sign-on protection PIN: one shared secret in front of automatic sign-ons | ![Audit trail](docs/screenshots/admin-audit.png)<br>**Audit trail** — who exercised power over which session, when |

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
- **GUI windows & pull-down menus**: CREATE WINDOW drawn like the 5494 /
  IBM ACS does it — border presentation (GUI box characters or host-specified
  ones) with the frame put into the cell buffer, work area cleared, window
  title/footer minor structures rendered into the border, covered screen
  saved and put back on REMOVE GUI WINDOW / RESTORE — plus DEFINE SELECTION
  FIELD choice lists placed cell-exact inside the window, and box-drawing
  characters rendered as continuous canvas lines so frames have no font
  gaps. With `IBM_I_MOUSE_GUI=true` the query reply claims pointer-device
  capability, so 5494-dialect hosts program the mouse per screen: right-click
  opens the application's own menu, double-click runs its action
  (Shift+right-click keeps the local menu).
- **Connection menu**: the app opens on a retro green-screen *System
  Selection* panel (number keys / arrows + Enter, or tap) listing the remote
  systems an administrator maintains — each with its own host, port, TLS,
  terminal model, code page, device prefix and optional SOCKS5 proxy (with
  username/password auth) its connection is tunneled through. Long catalogs
  page (10 rows on the menu, 6 in the split-pane picker) and the option field
  doubles as a live filter — letters narrow the list by name, description or
  host, digits keep the classic jump-to-row; see
  [Systems, admin & console](docs/admin.md). Systems live
  in a SQLite file on a persistent volume; the list is seeded from `IBM_I_*`
  on first boot, so upgrading deployments keep working unchanged.
- **Admin editor**: a PIN-protected (`ADMIN_PIN`) editor manages the system
  list — add, edit, delete, reorder. PINs are compared in constant time with
  a lockout after repeated failures; tokens expire after 8 hours. Proxy
  credentials are only ever served to the authenticated editor — the public
  menu list shows no more than a "SOCKS5" marker. Each system may also carry
  a **stored sign-on account** (username + password, same admin-only trust
  model): picking it signs the user on automatically — the public list shows
  only an `auto sign-on` marker. An optional system-wide **sign-on
  protection PIN** (Settings tab) gates those automatic sign-ons behind one
  shared secret: users enter it once per page before a system signs them on;
  without it the session still opens — just on the normal sign-on screen.
- **Directory systems**: menu entries and **automatic sign-on** served from
  your own database of hosts and accounts through a tiny read-only
  microservice (`DIRECTORY_URL`, [docs/directory-service.md](docs/directory-service.md)
  + [OpenAPI spec](docs/directory-service-openapi.yaml)). Entries are built
  from a `DIRECTORY_TEMPLATE_*` template (proxy, code page, printer, …) and
  re-synced on a timer — held in memory only, so they are on the menu for
  exactly as long as the service keeps answering; a user picking one is
  signed on with the entry's stored credential — fetched at session start,
  typed server-side, never written to disk and never sent to the browser.
- **Browser UX**: canvas renderer with IBM Plex Mono, complete 5250 key
  interception (F1–F24 incl. Shift+F1–F12 → PF13–PF24), field exit, insert
  mode, roll keys, SysReq/Attn, Reset, on-screen keypad for touch devices,
  click-to-position, and reconnect handling. Screen state is edited
  server-side; only diffs travel over the WebSocket, and non-display field
  contents are blanked server-side so **passwords never reach the browser**.
  The terminal always **fits its window** (and its split pane), re-fitting
  as the layout changes.
- **Built-in manuals**: a retro AS/400-style hypertext help system —
  green-screen panels, turquoise links, Tab-cycled selection cursor — with a
  **user guide** (Help button on the selection panel, `?` key, or the `?`
  button on any terminal pane) and an **admin guide** (Help in the console
  toolbar). Pages cross-link like the 5250's own help, every page ends with
  a topic index, and navigation backtracks like a browser (Backspace /
  Alt+← to go back, Alt+→ forward, Esc to exit).
- **STRPCCMD opens URIs in the browser**: when a host program runs
  `STRPCCMD PCCMD('start https://…')` (the PC-command escape real emulators
  implement), the gateway extracts the http(s) URI — it never appears on
  the 5250 screen — and the browser opens it in a new window under its own
  popup management, so the user's browser asks before allowing it.
  Commands that carry no URI are ignored; read-only mirrors never receive
  them. Disable with `ALLOW_HOST_URL_OPEN=false`.
- **Select & copy**: drag with the left button to mark a screen region and it
  is on the clipboard when you release (Alt+drag marks a column rectangle,
  double-click a word, Ctrl+C re-copies) — with hidden-field contents always
  copying as blanks; see
  [Keyboard & mouse](docs/keyboard.md).
- **Split view — several sessions on one page, one chrome**: every pane
  carries **↔ / ↕ split buttons** (side by side / top and bottom), a **☰
  system picker**, a **share button** (view-only mirror link), **↗ pop-out
  into a real browser window** and **× close** — single-session view
  included. Splitting divides that pane in two, nesting into any layout (up
  to 6 panes), and every divider line is **draggable to resize**
  (double-click resets); see
  [Sessions](docs/sessions.md).
- **Share a session as a live view-only mirror**: the pane-header share
  button copies a URL; anyone who opens it — on another window, another
  machine, anywhere that can reach the gateway — watches the session's
  screen update in real time but cannot type. Any number of viewers at
  once; see [Sharing & remote assist](docs/sharing-and-assist.md).
- **Sessions outlive their window**: every session carries an unguessable
  re-attach token; a closed tab, a reload, a dropped connection or a split
  pop-out leaves the host session running for `SESSION_GRACE_MS` and a
  browser can re-bind to it (`?attach=`, automatic on reload, via the
  Reconnect button) — see
  [the detach grace](docs/sessions.md#sessions-outlive-their-window).
- **Automated data-entry launches**: open the app in an iframe with `?auto=1`
  and it signs on with a server-held identity (`AUTO_SIGNON_*`), types a
  caller-supplied string into the user profile's initial-program screen, and
  `postMessage`s the embedding page when the user exits and the host drops
  the session — one-line deep links for other apps' data-entry screens; see
  [Automation](docs/automation.md).
- **Spool printing to the browser (TN5250E printer sessions)**: the
  gateway opens one printer device per system on demand (RFC 4777 printer
  flow — terminal type `IBM-3812-1`, no extra host infrastructure): it
  connects when the first display session opens to the system and stays up
  for `PRINTER_IDLE_MS` (default 5 minutes) after the last one ends; `0`
  keeps it always-on. Press Print on the host or move a spool file to the
  device's output queue and
  it appears in the browser under the top-bar **Spool** button —
  downloadable, printable on a local printer, or forwarded as a real PDF
  when the device has host print transform configured. `text` mode extracts
  plain text from the SCS stream (form feeds become page breaks); `raw`
  mode stores the transformed bytes and sniffs the format (`%PDF`, PCL).
  Storage is bounded (`PRINTJOBS_*`), jobs never contain credentials, and
  a collision on the configured device name surfaces as an error instead
  of a silent rename; see
  [Spool printing](docs/printing.md).
- **Session console (admin)**: the PIN-gated admin editor gains Sessions /
  Recordings / Audit tabs — see every live session (who, where, which
  device, signed-on user), open a view-only mirror of any of them, show a
  banner on a user's screen, or end a session outright (device and message
  queue freed immediately); plus a recording browser with replay and JSONL
  download, and an audit trail of every console action; see
  [Session console](docs/admin.md#session-console).
- **Maintenance windows**: block new sessions per system or gateway-wide
  with a message on the menu, warn the users of live sessions
  (T-10 / T-5 / T-1), and drain them at a deadline — the host-backup /
  IPL ritual without walking anyone off the system; see
  [Maintenance windows](docs/admin.md#maintenance-windows).
- **Remote assist — consent-based shared control**: a viewer of a share
  link can *request control*; the owner gets a Grant / Deny / Deny+block
  prompt and can revoke at any moment. The lease is bounded, idle-released,
  one controller at a time, and every controller keypress is named on the
  owner's screen (`Tab · HELPDESK`). Assist never sees a password (the
  stream was already blanked server-side); see [Remote assist](docs/sharing-and-assist.md#remote-assist).
- **Session recording & replay**: systems can opt into recording; the
  gateway stores exactly the wire stream a mirror would have seen —
  passwords are blanked *before* capture — as seekable JSONL. Users replay
  their own sessions from the **History** button; admins replay anyone's
  from the console. Replay links are revocable bearer tokens; see
  [Recording & replay](docs/recording.md).
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
and pulls whatever `IMAGE` points at (default:
`ghcr.io/jenkstom/web5250:latest`):

```bash
docker compose -f docker-compose.registry.yml up -d
```

GitHub CI builds the image for amd64 and arm64 and publishes it to GHCR on
every push to `main`; with `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN` secrets
configured it mirrors the same tags to Docker Hub under that username
(`<dockerhub-user>/web5250:latest`). Point `IMAGE` at any other registry the
same way, or keep using the build variant with `docker compose up -d
--no-build`.

Then open the published Pangolin resource (or `http://localhost:8080` for
local testing). You'll land on the **System Selection** menu — pick a system
(or press **Admin** to edit the list, see
[Systems, admin & console](docs/admin.md)) and sign on. See
[Connecting to IBM i](#connecting-to-ibm-i) for port/TLS/code page details.

### Without an IBM i (built-in demo)

The repository ships a **mock IBM i** that implements the server side of the
protocol (sign-on screen, MAIN menu, help, SysReq window, sign-off):

```bash
IBM_I_HOST=mock-host IBM_I_PORT=8023 docker compose --profile demo up -d --build
open http://localhost:8080            # any non-empty user + password signs on
```

## Documentation

| Guide | Contents |
| :-- | :-- |
| [Configuration](docs/configuration.md) | Every environment variable |
| [Systems, admin & console](docs/admin.md) | Connection menu, admin editor, JSON API, session console, maintenance windows |
| [Spool printing](docs/printing.md) | Printer sessions, `text`/`raw` delivery, host-side device setup, job retention |
| [Sessions](docs/sessions.md) | Split view, tabs, pop-out windows, detach grace & re-attach |
| [Sharing & remote assist](docs/sharing-and-assist.md) | View-only mirror links, consent-based control leases |
| [Recording & replay](docs/recording.md) | Session recording, the replay player, retention |
| [Automation](docs/automation.md) | `?auto=1` data-entry launches, directory systems, stored sign-on accounts |
| [Keyboard & mouse](docs/keyboard.md) | Key mapping, screen selection, clipboard and paste |
| [Architecture](docs/architecture.md) | How the gateway works inside |
| [Development & CI](docs/development.md) | Local development, test suites, pipelines |
| [Angular embedding](docs/angular-integration.md) | Full integration guide for the embedding side |
| [Directory service](docs/directory-service.md) | Contract for the menu/sign-on microservice |

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
  anything is sent to the browser — mirrors, assist controllers and the
  session recorder included: a replay cannot contain a password.
- `TRUSTED_USER_HEADER` names the header your edge sets after
  authenticating (session console identity, assist requesters, History).
  It is trusted, not verified — set it only when the container is
  reachable solely through the edge, never with a directly exposed port.

## License

MIT — see [LICENSE](LICENSE).