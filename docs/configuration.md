# Configuration

*Every environment variable*

All configuration is via environment variables — see [`.env.example`](../.env.example)
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
| `IBM_I_MOUSE_GUI` | Claim pointer-device capability in the 5250 query reply (5494 GUI support). Hosts that speak the dialect program the mouse per screen — right-click opens the application's own context menu, double-click runs its action, like IBM ACS; Shift+right-click keeps this app's local Copy/Paste menu. Hosts without the dialect ignore the capability | `false` |
| `IBM_I_PROXY_HOST` | SOCKS5 proxy the first-boot seed system tunnels through (per-system afterwards, in the admin editor) | – |
| `IBM_I_PROXY_PORT` | SOCKS5 proxy port | `1080` |
| `IBM_I_PROXY_USER` | SOCKS5 username (RFC 1929, with `IBM_I_PROXY_PASSWORD`) | – |
| `IBM_I_PROXY_PASSWORD` | SOCKS5 password — stored in SQLite on the data volume, never served to unauthenticated browsers | – |
| `IBM_I_PRINTER_ENABLED` | First-boot seed: keep a printer session up for the seeded system (per-system afterwards, in the admin editor) | `false` |
| `IBM_I_PRINTER_DEVNAME` | Printer device name the seed system claims (`CRTDEVPRT … TYPE(3812) MODEL(1)`, or let `QAUTOVRT` auto-configure) | `WEB5250P` |
| `IBM_I_PRINTER_MODE` | Seed printer delivery mode: `text` (extract plain text from SCS) or `raw` (store host-print-transform bytes, sniff `%PDF`/PCL) | `text` |
| `PRINTER_IDLE_MS` | Printer sessions are demand-driven: stop a system's printer this long after the last display session to it ends; `0` = always-on | `300000` (5 min) |
| `PRINTJOBS_MAX_COUNT` | Spool-job retention: newest jobs kept per system (drop-oldest) | `200` |
| `PRINTJOBS_MAX_BYTES` | Spool-job retention: total bytes kept per system (drop-oldest) | `104857600` (100 MB) |
| `PRINTJOBS_TTL_MS` | Spool-job retention: age limit, swept periodically and at boot | `2592000000` (30 days) |
| `AUDIT_TTL_MS` | Audit-trail retention: rows older than this are pruned (a 5000-row cap bounds size on busy systems) | `2592000000` (30 days) |
| `TRUSTED_USER_HEADER` | Edge-injected identity header (e.g. the header Pangolin sets). Stamps sessions with the user's identity (console, assist prompts, audit, History). Only safe when the container is reachable solely through the edge | – |
| `ASSIST_ENABLED` | Remote assist: viewers of a share link may request control | `true` |
| `ASSIST_MAX_MS` | Remote assist: maximum control-lease duration | `1800000` (30 min) |
| `ASSIST_IDLE_MS` | Remote assist: auto-release after this much controller inactivity | `300000` (5 min) |
| `ASSIST_CONSENT_TIMEOUT_MS` | Remote assist: how long an unanswered consent request waits | `30000` (30 s) |
| `ASSIST_CONSENT_DEFAULT` | What an unanswered request does: `allow` (auto-grant) or `deny` | `allow` |
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
| `DIRECTORY_URL` | Base URL of a [directory service](automation.md#directory-systems-menu--automatic-sign-on-from-your-database) microservice; menu entries + per-entry sign-on credentials (see [docs/directory-service.md](directory-service.md)). Unset = feature off | – |
| `DIRECTORY_TOKEN` | Bearer token the directory service requires | – |
| `DIRECTORY_SYNC_INTERVAL_MS` | Directory re-sync cadence (clamped 15 s–24 h) | `300000` |
| `DIRECTORY_TIMEOUT_MS` | Per-request timeout for directory service calls | `5000` |
| `DIRECTORY_TLS_REJECT_UNAUTHORIZED` | Enforce CA validation for the directory service TLS certificate | `true` |
| `DIRECTORY_TEMPLATE_*` | Connection settings every directory entry inherits — `NAME`/`DESCRIPTION` (`{name}`/`{host}` patterns), `PORT`, `SSL`, `TERM_TYPE`, `CODEPAGE`, `DEV_PREFIX`, `PROXY_HOST/PORT/USER/PASSWORD`, `PRINTER_ENABLED/DEVNAME/MODE`, `RECORDING`; entries may override `port`/`ssl` per row | port 23, else the gateway defaults |
| `FRAME_ANCESTORS` | When set, HTML responses carry `Content-Security-Policy: frame-ancestors …` to restrict which origins may embed the app in an iframe (e.g. `https://angular.internal`) | unset (any) |
| `SHOW_DIAG_BUTTON` | Show the `Diag` button in the top bar (copies raw 5250 session diagnostics to the clipboard for bug reports) | `false` |
| `IBM_I_TRACE_CONSOLE` | Mirror the per-session 5250 protocol trace (negotiation bytes, first records' hex, field maps) into the container log; `false` keeps the trace in memory for the Diag button only | `true` |
| `IBM_I_TRACE_RECORDS` | Cap on how many inbound records each session's Diag trace captures | `200` (clamped 8–5000) |
| `WEB5250_TRACE` | `1` dumps raw TN5250 hex traffic to the log (debugging) | – |

Each browser session gets its own 5250 device. Device names are generated as
`<prefix><random>`; if the name collides, the gateway automatically retries
with a numbered suffix (RFC 2877 behaviour).
