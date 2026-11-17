# Systems, admin & console

*The connection menu, its admin editor, the JSON API and the session console*

## System selection & admin

On first start the app shows a 5250-style menu of systems. Connection
parameters resolve in order: URL overrides (`ALLOW_CUSTOM_HOST`) → the
menu-selected system → the `IBM_I_*` environment defaults. On first boot the
catalog is seeded with the environment host, so existing single-host
deployments see exactly one entry and behave as before. Deep links work:
`?system=<id>` opens that system directly, `?host=…` keeps the legacy
custom-host behaviour.

**Pages and filter at catalog scale.** Hundreds of directory + manual hosts
don't fit one panel, so the list shows one page at a time — 10 rows on the
landing menu, 6 in the split-pane picker — under a ‹ Prev / Page x / y /
Next › bar: PgUp/PgDn turns pages, arrows walk across page boundaries with
the cursor kept visible, and a typed number jumps to its page. The field is
dual-mode (**Option/Filter ==>**): digits alone keep the classic
jump/select (4 digits now), while any letter turns it into a live filter
over name, description and host — whitespace-separated terms AND together,
rows renumber within the matches, an `N of M` count appears while
filtering, a letter typed over the echoed number overtakes it 5250-style,
and Esc clears the filter first. `A` opens admin anywhere outside the
field, so a filter may start with a letter.

**Admin** (bottom of the menu, or press `A`): enter `ADMIN_PIN`, then add /
edit / delete / reorder systems. Edits persist to SQLite (mount the compose
`web5250-data` volume) and apply immediately — no restart needed. Every
system carries its own host, port, TLS flag, terminal model, code page and
optional device prefix, can be routed through a **SOCKS5 proxy** (host,
port, optional username/password), can keep a **printer session** up
(enabled flag, printer device name, `text`/`raw` mode — see
[Spool printing](printing.md)), and can have sessions
**recorded** for replay (see
[Session recording & replay](recording.md)): the gateway's TN5250
connection is tunneled through the proxy with TLS-to-host still layered
inside the tunnel when the system has TLS enabled, and the printer session
follows the same connection settings. Proxy and printer-infrastructure
details are visible only inside the authenticated editor; the public menu
list shows just a `SOCKS5` / `printer` marker.

**Export / import**: the editor's `Export` button downloads every system —
proxy and printer settings included — and every custom keymap as a JSON
file to your computer; `Import` uploads such a file back and **replaces
the whole list** (the Import button asks for a second click first, since
the previous list is gone). Every row is validated before anything
changes, so a file with one bad system or keymap imports nothing; a good
file's rows land in menu order. Handy for backing up before an experiment,
cloning one deployment into another, or moving the catalog out of a
throwaway container's volume. Older exports (systems only, no `keymaps`
section) still import and leave the stored keymaps alone.

**Keymaps** (the `Keymaps` tab): custom keyboard maps for the sessions —
users migrating from a thick-client emulator get their muscle memory back.
Upload the `.kmp` file IBM i Access / Personal Communications exports
(Keyboard Remap → Save as; the repo ships a sample at `data/IBMi.kmp`),
download any stored map back as a `.kmp`, or edit bindings by hand in the
visual keyboard: click a keycap (or pick a key), then set what its Plain /
Shift / Ctrl / Alt states send. A binding **overrides the built-in
[browser mapping](keyboard.md)** for that one key; anything left on
`(default)` falls through to it, and `(browser)` hands the key back to the
browser. Entries a `.kmp` carries that this emulator cannot express (macros,
key-to-key translations, host functions with no 5250 equivalent) are
reported on import — nothing is guessed at. One map can be the **default**
applied to every host; each system's editor has a *Keymap* select for a
map of its own (or *built-in map*, which ignores the default). Precedence:
host-assigned map → default keymap → built-in mapping. Sessions pick up
keymap changes the next time the system menu appears; deleting a map drops
its hosts back to the default. Keymaps live in the SQLite catalog with
everything else and ride the export above.

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
| `GET /api/printer-status` | – | per-system printer session state (ready / connecting / error / idle) |
| `GET /api/printjobs` | – | spool jobs, newest first (token, system, device, size, pages, time) |
| `GET /api/printjobs/<token>` | – | job download (content type by format; `no-store`) |
| `DELETE /api/printjobs/<token>` | – | delete one job (any spool viewer; audited) |
| `POST /api/admin/auth` | PIN | `{pin}` → `{token}` (8 h bearer token) |
| `POST /api/admin/systems` | token | create |
| `PUT /api/admin/systems/<id>` | token | update |
| `DELETE /api/admin/systems/<id>` | token | delete |
| `POST /api/admin/systems/<id>/move` | token | `{dir: up\|down}` reorder |
| `GET /api/keymaps` | – | keymap overlays + the default id (sessions need them pre-connect) |
| `GET /api/admin/keymaps` | token | keymaps with bindings + which hosts use them |
| `POST /api/admin/keymaps` | token | create (`{name, description, bindings}`) |
| `POST /api/admin/keymaps/import` | token | upload `{name, kmp}` — the text of a `.kmp` file |
| `PUT /api/admin/keymaps/<id>` | token | update bindings |
| `DELETE /api/admin/keymaps/<id>` | token | delete (hosts fall back to the default) |
| `GET /api/admin/keymaps/<id>/download` | token | download as a `.kmp` file (attachment) |
| `PUT /api/admin/keymaps/default` | token | `{id\|null}` set / clear the default keymap |
| `GET /api/admin/config` | token | export systems + keymaps as a JSON download (attachment) |
| `PUT /api/admin/config` | token | import a JSON export — replaces the whole list |
| `GET /api/admin/sessions` | token | live session list (internal ids, no tokens) |
| `POST /api/admin/sessions/<id>/view` | token | mint a `?view=` mirror link for one session |
| `POST /api/admin/sessions/<id>/signal` | token | `{message, level}` banner on that session's screen |
| `POST /api/admin/sessions/<id>/end` | token | end the session now (`{notice}` shows briefly first) |
| `POST /api/admin/systems/<id>/maintenance` | token | `{on, message, deadlineMs?}` window for one system |
| `POST /api/admin/maintenance` | token | the same, gateway-wide |
| `GET /api/admin/maintenance` | token | current windows |
| `GET /api/admin/audit` | token | audit trail, newest first, paged (`?limit=&offset=`, body carries `total`) |
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

## Session console

The admin editor grows tabs next to Systems (one PIN, one token):

- **Keymaps** — the custom keyboard maps above: upload / edit / download /
  default / delete, with a visual keyboard for hand-editing bindings.
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
  (5000 entries), lives in the SQLite DB; rows older than `AUDIT_TTL_MS`
  (30 days) are pruned on a periodic sweep and at boot. The tab pages
  100 entries at a time — Prev / Next with a page counter, Refresh back
  to the newest page.

Sessions are also maintenance control: the same tab starts and stops
[windows](#maintenance-windows) per system or gateway-wide.

## Maintenance windows

A maintenance window blocks *new* sessions on a system (or gateway-wide)
and asks everyone signed on to sign out immediately — they can sign back
in when the window ends. The menu entry shows a MAINTENANCE line with the
message, and a connect attempt is refused with the reason. With a
deadline (minutes), the live sessions get banner reminders at T-10, T-5
and T-1 minutes and any left running are ended at the bell — the
host-backup / IPL ritual without having to walk anyone off. Window state
is runtime-only by design: a gateway restart clears it, which is the safe
failure direction. Every
transition is audited.
