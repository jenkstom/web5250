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
- **GUI windows & pull-down menus**: CREATE WINDOW drawn like the 5494 /
  IBM ACS does it — border presentation (GUI box characters or host-specified
  ones) with the frame put into the cell buffer, work area cleared, window
  title/footer minor structures rendered into the border, covered screen
  saved and put back on REMOVE GUI WINDOW / RESTORE — plus DEFINE SELECTION
  FIELD choice lists placed cell-exact inside the window, and box-drawing
  characters rendered as continuous canvas lines so frames have no font
  gaps.
- **Connection menu**: the app opens on a retro green-screen *System
  Selection* panel (number keys / arrows + Enter, or tap) listing the remote
  systems an administrator maintains — each with its own host, port, TLS,
  terminal model, code page, device prefix and optional SOCKS5 proxy (with
  username/password auth) its connection is tunneled through. Systems live
  in a SQLite file on a persistent volume; the list is seeded from `IBM_I_*`
  on first boot, so upgrading deployments keep working unchanged.
- **Admin editor**: a PIN-protected (`ADMIN_PIN`) editor manages the system
  list — add, edit, delete, reorder. PINs are compared in constant time with
  a lockout after repeated failures; tokens expire after 8 hours. Proxy
  credentials are only ever served to the authenticated editor — the public
  menu list shows no more than a "SOCKS5" marker.
- **Browser UX**: canvas renderer with IBM Plex Mono, complete 5250 key
  interception (F1–F24 incl. Shift+F1–F12 → PF13–PF24), field exit, insert
  mode, roll keys, SysReq/Attn, Reset, on-screen keypad for touch devices,
  click-to-position, and reconnect handling. Screen state is edited
  server-side; only diffs travel over the WebSocket, and non-display field
  contents are blanked server-side so **passwords never reach the browser**.
  The terminal always **fits its window** (and its split pane), re-fitting
  as the layout changes.
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
  [Mouse selection and clipboard](#mouse-selection-and-clipboard).
- **Split view — several sessions on one page, one chrome**: every pane
  carries **↔ / ↕ split buttons** (side by side / top and bottom), a **☰
  system picker**, a **share button** (view-only mirror link), **↗ pop-out
  into a real browser window** and **× close** — single-session view
  included. Splitting divides that pane in two, nesting into any layout (up
  to 6 panes), and every divider line is **draggable to resize**
  (double-click resets); see
  [Multiple sessions on one page](#multiple-sessions-on-one-page).
- **Share a session as a live view-only mirror**: the pane-header share
  button copies a URL; anyone who opens it — on another window, another
  machine, anywhere that can reach the gateway — watches the session's
  screen update in real time but cannot type. Any number of viewers at
  once; see [Sharing a session (view-only mirror)](#sharing-a-session-view-only-mirror).
- **Sessions outlive their window**: every session carries an unguessable
  re-attach token; a closed tab, a reload, a dropped connection or a split
  pop-out leaves the host session running for `SESSION_GRACE_MS` and a
  browser can re-bind to it (`?attach=`, automatic on reload, via the
  Reconnect button) — see
  [Sessions outlive their window](#sessions-outlive-their-window).
- **Automated data-entry launches**: open the app in an iframe with `?auto=1`
  and it signs on with a server-held identity (`AUTO_SIGNON_*`), types a
  caller-supplied string into the user profile's initial-program screen, and
  `postMessage`s the embedding page when the user exits and the host drops
  the session — one-line deep links for other apps' data-entry screens.
- **Spool printing to the browser (TN5250E printer sessions)**: the
  gateway keeps one always-on printer device per system (RFC 4777 printer
  flow — terminal type `IBM-3812-1`, no extra host infrastructure). Press
  Print on the host or move a spool file to the device's output queue and
  it appears in the browser under the top-bar **Spool** button —
  downloadable, printable on a local printer, or forwarded as a real PDF
  when the device has host print transform configured. `text` mode extracts
  plain text from the SCS stream (form feeds become page breaks); `raw`
  mode stores the transformed bytes and sniffs the format (`%PDF`, PCL).
  Storage is bounded (`PRINTJOBS_*`), jobs never contain credentials, and
  a collision on the configured device name surfaces as an error instead
  of a silent rename; see
  [Spool printing (printer sessions)](#spool-printing-printer-sessions).
- **Session console (admin)**: the PIN-gated admin editor gains Sessions /
  Recordings / Audit tabs — see every live session (who, where, which
  device, signed-on user), open a view-only mirror of any of them, show a
  banner on a user's screen, or end a session outright (device and message
  queue freed immediately); plus a recording browser with replay and JSONL
  download, and an audit trail of every console action; see
  [Session console](#session-console).
- **Maintenance windows**: block new sessions per system or gateway-wide
  with a message on the menu, warn the users of live sessions
  (T-10 / T-5 / T-1), and drain them at a deadline — the host-backup /
  IPL ritual without walking anyone off the system; see
  [Maintenance windows](#maintenance-windows).
- **Remote assist — consent-based shared control**: a viewer of a share
  link can *request control*; the owner gets a Grant / Deny / Deny+block
  prompt and can revoke at any moment. The lease is bounded, idle-released,
  one controller at a time, and every controller keypress is named on the
  owner's screen (`Tab · HELPDESK`). Assist never sees a password (the
  stream was already blanked server-side); see [Remote assist](#remote-assist).
- **Session recording & replay**: systems can opt into recording; the
  gateway stores exactly the wire stream a mirror would have seen —
  passwords are blanked *before* capture — as seekable JSONL. Users replay
  their own sessions from the **History** button; admins replay anyone's
  from the console. Replay links are revocable bearer tokens; see
  [Session recording & replay](#session-recording--replay).
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
| `IBM_I_PROXY_HOST` | SOCKS5 proxy the first-boot seed system tunnels through (per-system afterwards, in the admin editor) | – |
| `IBM_I_PROXY_PORT` | SOCKS5 proxy port | `1080` |
| `IBM_I_PROXY_USER` | SOCKS5 username (RFC 1929, with `IBM_I_PROXY_PASSWORD`) | – |
| `IBM_I_PROXY_PASSWORD` | SOCKS5 password — stored in SQLite on the data volume, never served to unauthenticated browsers | – |
| `IBM_I_PRINTER_ENABLED` | First-boot seed: keep a printer session up for the seeded system (per-system afterwards, in the admin editor) | `false` |
| `IBM_I_PRINTER_DEVNAME` | Printer device name the seed system claims (`CRTDEVPRT … TYPE(3812) MODEL(1)`, or let `QAUTOVRT` auto-configure) | `WEB5250P` |
| `IBM_I_PRINTER_MODE` | Seed printer delivery mode: `text` (extract plain text from SCS) or `raw` (store host-print-transform bytes, sniff `%PDF`/PCL) | `text` |
| `PRINTJOBS_MAX_COUNT` | Spool-job retention: newest jobs kept per system (drop-oldest) | `200` |
| `PRINTJOBS_MAX_BYTES` | Spool-job retention: total bytes kept per system (drop-oldest) | `104857600` (100 MB) |
| `PRINTJOBS_TTL_MS` | Spool-job retention: age limit, swept periodically | `1209600000` (14 days) |
| `TRUSTED_USER_HEADER` | Edge-injected identity header (e.g. the header Pangolin sets). Stamps sessions with the user's identity (console, assist prompts, audit, History). Only safe when the container is reachable solely through the edge | – |
| `ASSIST_ENABLED` | Remote assist: viewers of a share link may request control | `true` |
| `ASSIST_MAX_MS` | Remote assist: maximum control-lease duration | `1800000` (30 min) |
| `ASSIST_IDLE_MS` | Remote assist: auto-release after this much controller inactivity | `300000` (5 min) |
| `ADMIN_ASSIST_BREAKGLASS` | Admin may take control without owner consent (audited loudly) | `false` |
| `RECORDINGS_MAX_COUNT` | Recording retention: newest recordings kept (drop-oldest) | `200` |
| `RECORDINGS_MAX_BYTES` | Recording retention: total bytes kept | `524288000` (500 MB) |
| `RECORDINGS_TTL_MS` | Recording retention: age limit, swept periodically | `2592000000` (30 days) |
| `ALLOW_CUSTOM_HOST` | Let users point a session at another host via query params (`?host=&port=&ssl=1&term=&cp=&devname=`) | `false` |
| `ALLOW_HOST_URL_OPEN` | Let host `STRPCCMD` commands that carry an http(s) URI open it in the user's browser (the browser's own popup warning/consent applies) | `true` |
| `ADMIN_PIN` | PIN for the connection-menu admin editor (≥ 4 chars; empty disables admin) | – |
| `WEB5250_DB` | SQLite file for the system catalog (compose mounts the `web5250-data` volume at `/data`) | `/data/web5250.db` in the container, `data/web5250.db` locally |
| `IBM_I_TLS_REJECT_UNAUTHORIZED` | Enforce CA validation for host TLS (IBM i certs are usually self-signed) | `false` |
| `WS_PING_INTERVAL_MS` | Browser-liveness ping cadence; a vanished front-end's socket is dropped after `WS_PING_MAX_MISSES` missed pongs — grace ≈ interval × misses | `30000` |
| `WS_PING_MAX_MISSES` | Consecutive missed pongs tolerated before a dead browser socket is dropped | `4` |
| `SESSION_GRACE_MS` | How long a session with no attached browser stays alive and re-attachable (`?attach=<token>`, reload resume, pop-out); `0` = strict legacy teardown on socket close | `300000` |
| `AUTO_SIGNON_USER` | User profile for `?auto=1` automated data-entry launches (server-held; required together with `AUTO_SIGNON_PASSWORD`, otherwise auto upgrades are refused) | – |
| `AUTO_SIGNON_PASSWORD` | Its password — never leaves the server or crosses the WebSocket | – |
| `FRAME_ANCESTORS` | When set, HTML responses carry `Content-Security-Policy: frame-ancestors …` to restrict which origins may embed the app in an iframe (e.g. `https://angular.internal`) | unset (any) |
| `SHOW_DIAG_BUTTON` | Show the `Diag` button in the top bar (copies raw 5250 session diagnostics to the clipboard for bug reports) | `false` |
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
`web5250-data` volume) and apply immediately — no restart needed. Every
system carries its own host, port, TLS flag, terminal model, code page and
optional device prefix, can be routed through a **SOCKS5 proxy** (host,
port, optional username/password), can keep a **printer session** up
(enabled flag, printer device name, `text`/`raw` mode — see
[Spool printing](#spool-printing-printer-sessions)), and can have sessions
**recorded** for replay (see
[Session recording & replay](#session-recording--replay)): the gateway's TN5250
connection is tunneled through the proxy with TLS-to-host still layered
inside the tunnel when the system has TLS enabled, and the printer session
follows the same connection settings. Proxy and printer-infrastructure
details are visible only inside the authenticated editor; the public menu
list shows just a `SOCKS5` / `printer` marker.

**Export / import**: the editor's `Export` button downloads every system —
proxy and printer settings included — as a JSON file to your computer;
`Import` uploads such a file back and **replaces the whole list** (the
Import button asks for a second click first, since the previous list is
gone). Every row is validated before anything changes, so a file with one
bad system imports nothing; a good file's rows land in menu order. Handy
for backing up before an experiment, cloning one deployment into another,
or moving the catalog out of a throwaway container's volume.

**Display name** (the `Display` field on the menu): an optional 5250
device name for this browser's sessions, saved in `localStorage` and sent
as `?devname=` on connect. The gateway keeps live display names unique —
if another session already holds yours it appends a number (`TOM` →
`TOM1` → `TOM2`, always within the 10-character device-name limit) and
logs the substitution; the actual name is shown next to the connection
state once the session opens. Leave it empty to use the configured device
prefix with a random suffix.

The JSON API behind it (all sub-path tolerant, like `/healthz`):

| Method & path | Auth | Purpose |
| :-- | :-- | :-- |
| `GET /api/meta` | – | admin enabled?, terminal models, code pages, form defaults |
| `GET /api/systems` | – | the menu list |
| `GET /api/printer-status` | – | per-system printer session state (ready / connecting / error) |
| `GET /api/printjobs` | – | spool jobs, newest first (token, system, device, size, pages, time) |
| `GET /api/printjobs/<token>` | – | job download (content type by format; `no-store`) |
| `DELETE /api/printjobs/<token>` | – | delete one job (any spool viewer; audited) |
| `POST /api/admin/auth` | PIN | `{pin}` → `{token}` (8 h bearer token) |
| `POST /api/admin/systems` | token | create |
| `PUT /api/admin/systems/<id>` | token | update |
| `DELETE /api/admin/systems/<id>` | token | delete |
| `POST /api/admin/systems/<id>/move` | token | `{dir: up\|down}` reorder |
| `GET /api/admin/config` | token | export all systems as a JSON download (attachment) |
| `PUT /api/admin/config` | token | import a JSON export — replaces the whole list |
| `GET /api/admin/sessions` | token | live session list (internal ids, no tokens) |
| `POST /api/admin/sessions/<id>/view` | token | mint a `?view=` mirror link for one session |
| `POST /api/admin/sessions/<id>/signal` | token | `{message, level}` banner on that session's screen |
| `POST /api/admin/sessions/<id>/end` | token | end the session now (`{notice}` shows briefly first) |
| `POST /api/admin/systems/<id>/maintenance` | token | `{on, message, deadlineMs?}` window for one system |
| `POST /api/admin/maintenance` | token | the same, gateway-wide |
| `GET /api/admin/maintenance` | token | current windows |
| `GET /api/admin/audit` | token | recent audit trail (`?limit=`) |
| `GET /api/admin/recordings` | token | recording metadata, newest first |
| `GET /api/admin/recordings/<id>/download` | token | raw JSONL event stream (attachment) |
| `POST /api/admin/recordings/<id>/link` | token | mint a replay link |
| `DELETE /api/admin/recordings/<id>` | token | delete one recording (a live one is stopped first) |
| `DELETE /api/admin/replay/<token>` | token | revoke a replay link |
| `GET /api/recordings/mine` | edge identity | the requesting user's own recordings |
| `POST /api/replay/mint` | edge identity | mint a replay link for an own recording |
| `GET /api/replay/<token>` | – | one recording: metadata + frames (revocable token) |

WebSocket sessions target a system with `?system=<id>` (rejected with 404 if
the id no longer exists — the browser falls back to the menu). Failed PIN
attempts lock administration for 60 s after 5 tries.

## Spool printing (printer sessions)

The 5250 display protocol has no file transfer — the only channel a host
can push bytes down is a **TN5250E printer session** (the mechanism ACS and
tn5250 use for "print to local printer"). When a system has its printer
enabled, the gateway keeps one always-on printer device connected
(independent of any display sessions, reconnected with backoff): like a
real printer being powered on, the device must be there for the host's
writer to send to it. Print on the host — or move any spool file to the
device's output queue — that's the queue **named like the device**, which
CRTDEVPRT auto-created in QUSRSYS (device descriptions have no OUTQ
parameter; the attached session is the writer, so `WRKCFGSTS` shows the
device ACTIVE while it's connected; files with a blank form type raise the
CPA3394 form-type inquiry — the scoped fix is `FORMTYPE(*STD)` on routed
files, `CHGWTR … FORMTYPE(*ALL) OPTION(*IMMED)` for the live writer, or a
reply-list entry only if every printer on the system is unattended)
— and the job lands in the browser: the top-bar
**Spool** button (with a pending-jobs count) opens the job list, where each
job can be **downloaded** or **printed** on a locally connected printer.

Two delivery modes per system:

- **`text`** (default): the device is an SCS printer (`IBM-3812-1`); the
  gateway extracts plain text from the SCS stream — form feeds become page
  breaks, page counts are shown, the print view paginates properly. Zero
  host-side transform configuration.
- **`raw`**: for devices created with host print transform
  (`CRTDEVPRT … TRANSFORM(*YES) MFRTYPMDL(...)` or a WSCST), the gateway
  stores the bytes as-is and sniffs the format — `%PDF` jobs download as
  real PDFs and print through the browser's PDF viewer; PCL is
  download-only (browsers cannot render it).

Host-side setup (once, as an admin): a `*VRT` device must name a virtual
controller, and a manually created one starts varied off — `CRTCTLVDE
CTLD(QVIRCD0001)` (if it doesn't exist) and `VRYCFG … CFGTYPE(*CTL)
STATUS(*ON)` — without the controller vary-on the device sits at "Powered
off or not yet available" (and with no controller at all, vary-on fails
with reason code 2301). Then `CRTDEVPRT DEVD(WEB5250P) DEVCLS(*VRT)
CTL(QVIRCD0001) TYPE(3812) MODEL(1) FONT(011) FORMFEED(*CONT)` and
`VRYCFG … STATUS(*ON)`. Or skip the manual commands entirely and let
`QAUTOVRT` auto-configure the device when the session first connects (it
arrives with the exact DEVNAME, so the created device carries that name,
controller and all). The printer device name is exact — its output queue
is per device — so a name collision is reported as an error in the spool
list (and `printer-status`) instead of being silently renamed; rename the
configured device to fix it. The full byte-level
protocol write-up is in
[`docs/printer-session-notes.md`](docs/printer-session-notes.md); the design
discussion in [`docs/printer-session.md`](docs/printer-session.md).

Jobs live in a bounded store on the data volume next to the SQLite DB
(`<data>/printjobs/…`): newest `PRINTJOBS_MAX_COUNT` jobs / total
`PRINTJOBS_MAX_BYTES` bytes per system (drop-oldest) and a
`PRINTJOBS_TTL_MS` age limit, with the per-job download keyed by an
unguessable token under the app's usual edge-authentication trust model.
Job files never contain credentials. Anyone viewing the Spool window can
also remove individual jobs (the gateway deletes the stored file and
records the removal in the audit trail) — the shared list is readable by
every gateway user, so removal follows the same visibility.

## Multiple sessions on one page

The gateway gives **every WebSocket its own 5250 device**, so one browser can
hold several concurrent sessions. The layout is a **split tree** grown in
place — **no nested views, no iframes**: a pane's **↔** button divides it
into left and right halves, **↕** into top and bottom, and the same buttons
live on every pane (single-session view included, alongside **☰** pick a
system, **↗** pop out and **×** close). Splitting keeps the session running
in its half; the fresh half shows its own **system picker inside the pane**
(the full-page menu stays the landing state of the single-session view).
Splits nest freely — split the bottom half of a ↔/↕ pair side by side and
you get one large pane over two smaller ones — up to 6 panes. Every
**divider line is draggable** to resize the two sides it separates
(double-click resets a divider to halves), **dragging a pane by its header
onto another pane swaps the two** — or onto one of its **edges to split
that pane's slot** with the dragged pane taking that side — and the
arrangement plus divider positions survive a reload. **+ Pane** splits the
roomiest pane, and clicking a pane (or its tab in Tabs mode) hands it the
keyboard; the top bar always describes the focused session.

Deep links preassign panes: `?grid=2&systems=1,3` opens two panes that
connect straight to system 1 and system 3 (ids from the menu's admin
editor). Without `systems=`, every pane boots into its in-pane picker for a
per-pane pick. If a **Display** name is set, the gateway dedupes it across
panes (`TOM` → `TOM1`), exactly as it does across browsers.

**Tabs.** The **Tabs** button switches to one session at a time with a tab
strip up top; the hidden sessions keep running, and clicking a tab brings
that session back and hands it the keyboard. Nothing ever reloads — panes
are plain DOM. Dragging a pane by its header (or a tab) onto another pane
swaps the two. The Tiles/Tabs choice and the active tab are remembered.

**Pop-out: a pane becomes a real browser window.** The ↗ button on a pane
header opens a popup window that takes over the pane's running session — same
5250 device, same screen, mid-typing — and the pane disappears from the
layout. This works because sessions live in the gateway, not in the page (see
[Sessions outlive their window](#sessions-outlive-their-window)).

## Sharing a session (view-only mirror)

Every session carries a second unguessable **share token** (independent of
the re-attach token — one can never be used as the other). The **share
button** on a pane header (between ☰ and ↗) copies a link like

```
https://as400.yourdomain.com/?view=<share token>
```

Opening that URL — in another window, on a remote computer, in any browser
that can reach the gateway through your edge — shows a **live, view-only
mirror** of that session:

- The mirror receives the same screen stream as the owner: cells, cursor,
  OIA indicators, even host-drawn windows and pull-downs, in real time.
- **The owner's special keys are named in the mirror's status bar.** Keys
  that don't echo as text — Enter, F1–F24, Tab, Field Exit, SysReq, Reset,
  Roll, arrows … — appear in the OIA strip for two seconds (or until the
  next one), so a viewer can keep up with what is driving the screen.
  Printable characters are not announced; they echo on the screen anyway.
- **Nothing a viewer does reaches the host.** Keystrokes, clicks, paste and
  the on-screen keypad are all dropped client- and server-side; the mirror
  has no keyboard at all. Local text selection and copy still work.
- **Any number of viewers** can watch at once; they neither evict the owner
  nor each other, and the owner is never told they connected.
- Non-display (password) fields are blanked server-side before anything is
  sent, exactly as for the owning browser — the mirror never sees a
  password.
- The mirror follows the session's life: it ends (with a notice) when the
  owner ends or the session expires after its grace period, and it
  reconnects on reload. Viewers do **not** keep an abandoned session alive
  — a mirror nobody can type into must not hold a 5250 device hostage.

The share link is a bearer credential for *watching* the session, with the
same trust model as the rest of the app: Pangolin (or whatever fronts the
gateway) authenticates who may open the URL at all. Treat the link like a
live window into that terminal — it shows everything the signed-on user
sees; revoke it by ending the session.

**Close (×) ends the session.** After its confirmation (skipped on the
sign-on screen and for never-assigned panes), closing a pane ends the host
session outright: the device name and the signed-on user's message queue
free up immediately. That matters because IBM i shows
*Message queue USER is allocated to another job* on the next sign-on of the
same user while one of their jobs lingers — the detach grace is exactly such
a lingering job, so × refuses to leave one behind. The grace still covers
its intended cases: a closed tab, a reload, a dropped connection and the
moment of a pop-out transfer.

Two deployment notes:

- `FRAME_ANCESTORS` keeps working for external embedders (the split view no
  longer frames anything itself).
- A browser tab holds one 5250 device per pane. With the default grace
  period the sessions survive the tab closing for a while and are then
  cleaned up host-side; use **Exit split** (or a pane's ×) to end them
  immediately.

## Session console

The admin editor grows three tabs next to Systems (one PIN, one token):

- **Sessions** — every live session on this gateway: device name, the
  signed-on IBM i user (captured from the sign-on screen as it is
  submitted), the edge identity or source address, state (active /
  connecting / detached-with-grace-countdown), started and last-active
  times, viewer count, assist holder, REC marker. Row actions:
  **Mirror** (opens a `?view=` window — from there a console operator can
  request control like any assist), **Signal** (a banner on that user's
  screen, never painted into the 5250 buffer), **End** (same path as the
  pane × button: the device and the user's message queue free up
  immediately, after an optional warning banner). The list auto-refreshes
  every 5 s and never carries session/share tokens — those are minted per
  action.
- **Recordings** — every finished recording: play (opens the replay
  player), download the raw JSONL (evidence export), mint replay links.
- **Audit** — who did what to which session, when: console actions,
  assist lifecycle (request / grant / deny / revoke / break-glass),
  maintenance transitions, replay-link minting. Append-only, bounded
  (5000 entries), lives in the SQLite DB.

Sessions are also maintenance control: the same tab starts and stops
[windows](#maintenance-windows) per system or gateway-wide.

## Maintenance windows

A maintenance window blocks *new* sessions on a system (or gateway-wide)
while leaving running ones alone: the menu entry shows a MAINTENANCE line
with the message, and a connect attempt is refused with the reason. With a
deadline (minutes), the live sessions get banner warnings at T-10, T-5 and
T-1 minutes and are ended at the bell — the host-backup / IPL ritual
without having to walk anyone off. Window state is runtime-only by design:
a gateway restart clears it, which is the safe failure direction. Every
transition is audited.

## Remote assist

A share-link viewer watches; with assist it can also *drive* — but only
with consent, and only for a while:

1. The viewer clicks **Request control** on the mirror. The owner's screen
   shows a modal: *"BOB requests control of this session"* with
   **Grant / Deny / Deny + block 1h**. A request nobody answers expires
   after a minute; one pending request at a time.
2. On Grant, that viewer's socket gains the owner's input set — keys,
   SysReq, host-programmed mouse, pull-down picks — under a **lease**:
   bounded (`ASSIST_MAX_MS`), auto-released after `ASSIST_IDLE_MS` of
   controller silence, ended by the owner's ever-visible **Revoke**
   button, the helper's own **Release**, or the session ending. One
   controller at a time.
3. Nobody loses the keyboard: owner and helper can both type, like two
   people at one desk. Every controller keypress is named on the owner's
   status bar (`Enter · BOB`), and the owner alone can end the session or
   receive host-pushed `STRPCCMD` windows.
4. Everyone sees the state: the owner's bar counts down the lease, other
   mirrors see who holds control, and a late joiner's hello carries the
   current lease.

The privacy invariant is inherited, not added: a controller sees exactly
what a mirror sees, and non-display fields were blanked server-side before
the stream existed — an assist session cannot leak a password, same as a
colleague leaning over a shoulder never learns one. Admins assist through
a session's Mirror like anyone else; with `ADMIN_ASSIST_BREAKGLASS=true`
an authenticated console may take control *without* consent — every use
lands in the audit log, which is why the default is off.

Identity comes from `TRUSTED_USER_HEADER` (the header your edge sets after
authenticating — Pangolin does): requests are named with it, sessions are
stamped with it, and without it the gateway falls back to device names.
Only set it when the container is reachable solely through the edge.

## Session recording & replay

A system with **Recording** enabled in the admin editor lets its users
record sessions. Nothing is captured by default: the owner clicks the
top-bar **REC** button to start and clicks it again to stop. While a
recording runs, the gateway stores exactly the outbound wire stream — full
screen snapshots (one per host screen; these are the player's seek
points), cell diffs, OIA states, statuses, named keys with their origin,
notice and assist events — as one JSON frame per line on the data volume,
with SQLite metadata. Retention mirrors the spool store: newest
`RECORDINGS_MAX_COUNT` recordings, `RECORDINGS_MAX_BYTES` total,
`RECORDINGS_TTL_MS` age, drop-oldest.

**A replay contains exactly what a view-only mirror would have seen —
nothing more.** Password fields are blanked by the wire encoder *before*
the recorder runs; keys typed into hidden fields leave no recoverable
trace. Recording is per-system opt-in and owner-only — mirrors cannot
start or stop one — and every start, stop and console removal is audited.

- **Users** replay their own finished sessions from the top-bar
  **History** button (needs `TRUSTED_USER_HEADER`, which is what makes
  "own" mean anything) and can mint replay links for their recordings.
- **Admins** replay everything from the console's Recordings tab, download
  JSONL, mint links, and **Remove** recordings entirely (file, metadata and
  every replay link die together; a still-live recording is stopped first,
  which also clears the session's REC marker). Removal is audited.
- **Replay links** are unguessable bearer tokens (`?replay=<token>`) under
  the same trust model as share links; they are revocable (console or by
  outliving their recording) and the player is the terminal renderer
  itself — scrub bar, 1×–16× speed, a clickable event lane (keys, assist
  grants, notices) and wall-clock timestamps.

## Sessions outlive their window

Every session gets an unguessable token (sent to the browser in the `hello`
handshake). The browser holds the session with a WebSocket; when the socket
drops — tab closed, page reloaded, network blip, split-view pane popped out —
the **host session keeps running** for `SESSION_GRACE_MS` (default 5 minutes)
and can be re-bound to a new connection:

- **Reload** (F5) of a session page resumes it: the browser remembers the
  token in `sessionStorage` and reattaches instead of dropping you at the
  menu.
- **Pop-out** uses the same mechanism to move a pane's session into a real
  browser window (`?attach=<token>` deep link).
- The **Reconnect** button first tries to reattach, so a dropped Wi-Fi link
  no longer costs you your sign-on or your half-filled screen.
- After the grace expires with nobody reattached, the session is torn down
  and its device name freed, exactly as a closing socket did before.

`?attach=<token>` without a live session (expired, or the gateway restarted —
the registry is in-memory) reports the failure and, if the URL also carries
`?system=<id>`, falls back to a fresh session on that system. The token is a
bearer credential for the session within your origin — the same trust model
as the rest of the app (Pangolin enforces identity at the edge) — and
`SESSION_GRACE_MS=0` restores the strict socket-closed-equals-session-ended
behaviour everywhere. `?auto=1` embedded launches always keep that strict
contract, so embedders' "removing the iframe ends the session" assumption
holds unchanged.

## Automated data-entry launches

> **Embedding in another app?** See [docs/angular-integration.md](docs/angular-integration.md)
> for the full integration guide written for the embedding side (Angular):
> launch URL reference, the `postMessage` contract, a ready-to-adapt
> component, local development with the mock host, and troubleshooting.

For embedding a single data-entry session inside another app (e.g. Angular),
open the gateway in an **iframe** with `?auto=1` and optional launch
parameters:

```
https://gateway.example/?system=3&auto=1&input=CUST123&parentorigin=https://angular.internal
```

| Param | Default | Meaning |
| :--- | :--- | :--- |
| `auto` | – | `1` activates the automated launch |
| `input` | – | String (≤ 256 printable ASCII) typed into the initial program's screen |
| `inputenter` | `1` | Press Enter after typing `input` (`0` = type only) |
| `inputdelay` | `500` | Minimum wait (ms, 0–10000) after the screen is ready before typing |
| `parentorigin` | `*` | `targetOrigin` used for the end-of-session `postMessage` to the parent page |

What happens:

1. The gateway signs on itself using `AUTO_SIGNON_USER` / `AUTO_SIGNON_PASSWORD`
   — the credentials live only in the server environment; the password is
   typed into the non-display field server-side and never reaches the browser.
2. The user profile's **initial program** (INLPGM) on the IBM i opens the
   data-entry screen — nothing is typed by the gateway beyond the sign-on.
3. Once that screen invites input (plus `inputdelay` ms), the gateway types
   `input` and optionally presses Enter. User keystrokes are held back only
   during the injection; from then on the user works the screen normally
   (the system menu is hidden in this mode).
4. When the user exits the program, the IBM i signs off and drops the
   connection; the gateway tears the session down.
5. The page notifies its parent via `postMessage` so the embedding app can
   remove the iframe:

```js
// Angular side
window.addEventListener('message', (e) => {
  if (e.data?.source === 'web5250' && e.data?.type === 'session-end') {
    // e.data.reason: 'closed' | 'error' | 'signon-failed' | 'timeout'
    removeTerminalIframe();
  }
});
iframe.src = 'https://gateway.example/?system=3&auto=1&input=CUST123';
// The iframe needs focus (a click) before keyboard input reaches the terminal.
```

Failure modes end the launch the same way: a rejected sign-on or a screen
that never appears (30 s) produce `session-end` with `signon-failed` /
`timeout`, and an unconfigured gateway (`AUTO_SIGNON_*` unset) refuses the
WebSocket upgrade outright. Set `FRAME_ANCESTORS` to restrict which origins
may embed the app at all.

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

### Mouse selection and clipboard

Right-click opens the local menu (**Copy selection** / **Copy screen** /
**Paste**). Text can also be marked directly on the screen, the way a desktop
terminal emulator does:

- **Left-drag** marks a text-flow selection and copies it to the clipboard on
  release. **Alt+drag** marks a column rectangle instead (handy for option
  numbers or record columns).
- **Double-click** marks the word under the mouse (unless the host programmed
  the double click itself).
- **Ctrl+C** / **Cmd+C** re-copies the standing mark; a plain click clears it
  and places the host cursor as before.
- **Ctrl+V** / **Cmd+V** pastes at the cursor with no browser prompt - tabs in
  the pasted text advance to the next field, line breaks are dropped.
- **Paste** (the right-click item) has to *read* the clipboard, and the
  browser answers that read with its own confirmation box (Safari and Firefox
  every time, Chrome once and then remembered). That box is the browser's
  clipboard privacy rule, not something the page can skip - use **Ctrl+V** /
  **Cmd+V** to paste in one step.
- Text in hidden (non-display) fields - e.g. the sign-on password - always
  copies as blanks.

On plain-HTTP origins without the async clipboard API the copy falls back to
`execCommand`, and to a selectable dialog box if the browser blocks that too.

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
npm run test:real       # regression: real-IBM-i SF-order dialect (no FFW bytes,
                        #   WCC0 lock bits, attr-only Start-of-Field orders)
node scripts/mock-host.mjs &   # visual/mobile tests drive real Chromium
PORT=8080 IBM_I_HOST=127.0.0.1 IBM_I_PORT=8023 ADMIN_PIN=1234 npm start &
npm run visual          # screenshots land in artifacts/
npm run test:zoomgrid   # split view: fit-to-window sizing, ?grid=2|4 panes,
                        #   per-pane device-name dedupe, exit flow
npm run test:share      # share button + ?view= mirror: link copy, live
                        #   updates, read-only enforcement, session end
npm run test:admin      # admin PIN/editor keyboard: Enter in the PIN form
                        #   opens the editor (not a connection), menu keys
                        #   intact (gateway needs ADMIN_PIN=1234)
npm run test:socks      # SOCKS5 per-system proxy: tunnelled session,
                        #   username/password auth, failure paths, proxy
                        #   credentials kept off the public API, SQLite
                        #   migration of pre-proxy databases
npm run test:printer    # TN5250E printer sessions: SCS jobs arrive/list/
                        #   download, framing stress (records + TCP
                        #   segments), retention purge, host-refusal and
                        #   device-collision paths, raw-mode PDF sniffing
npm run test:console    # session console: identity stamping, sign-on
                        #   capture, signal banners, assist consent/lease/
                        #   revoke, maintenance windows + drain, recording
                        #   + replay tokens + history, audit trail
npm run test:pcuri      # STRPCCMD: host-pushed URI arrives as an openurl
                        #   message (never painted), Enter completion,
                        #   non-URI commands ignored, mirrors excluded
npm run test:mobile     # phone-size viewport: fit, soft-keyboard focus,
                        #   keypad, keyboard open/close shrink+expand
```

The smoke test covers: sign-on rendering, cursor placement, X II error +
Reset, typing, Tab, Field Exit, password non-display over the wire, Enter →
MAIN menu, F1/F3, option entry and sign-off — plus the menu API (list, PIN
auth, system CRUD, `?system=` sessions, rate limiting), session
attach/takeover/grace, and the `?view=` share mirrors (token separation,
live updates, input rejection, teardown).

`test:real` replays a QDSIGNON-shaped stream the way a live IBM i emits it
(field length counts data cells only, attribute-only SF orders, keyboard-lock
WCC bits) and guards against the class of bugs where fields parse but turn
out unenterable (bypass-poisoned) or the read response lands at the wrong
buffer address (CPF1296 on valid input).

## How it works

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
