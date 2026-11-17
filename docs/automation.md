# Automation

*Automated data-entry launches, directory systems and stored sign-on accounts*

## Automated data-entry launches

> **Embedding in another app?** See [docs/angular-integration.md](angular-integration.md)
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

## Directory systems (menu + automatic sign-on from your database)

> Full guide: [docs/directory-service.md](directory-service.md) ·
> API contract: [docs/directory-service-openapi.yaml](directory-service-openapi.yaml) ·
> runnable reference service: [docs/directory-service.mjs](directory-service.mjs).

If you keep your 5250 hosts and their accounts in a database, point web5250
at a small read-only microservice in front of it (`DIRECTORY_URL`) and the
gateway will

1. list every host on the connection menu — materialized from a
   `DIRECTORY_TEMPLATE_*` template so the proxy, code page, terminal model,
   printer and recording settings are set once for all of them (marked
   `· directory` on the menu), and
2. sign users on automatically when they pick one — the entry's
   username/password is fetched at session start, typed into the host's
   sign-on screen by the same server-side automation `?auto=1` uses, and
   forgotten. Credentials never touch the gateway's SQLite file or the
   browser; entries without a stored credential open on the normal manual
   sign-on screen (marked plainly, no `· auto sign-on`).

The list re-syncs on a timer (`DIRECTORY_SYNC_INTERVAL_MS`, default 5 min)
and on demand from the admin editor's **Sync directory** button; rows keep
their `dir:<entry id>` address across syncs, so live sessions, printer
devices and deep links survive every sync. Directory hosts are **held in
memory only — never written to the catalog**: they list after the manual
ones, are absent from the admin editor and export/import (they are managed
at the directory, not locally), and a failed sync (service down, wrong
token) removes them from the menu until the service answers again — a down
directory shows nothing instead of stale hosts. Syncs and failures land in
the Audit tab (`directory.sync` / `directory.error`).

Manually-configured systems can do the same without a directory: the admin
editor's **Sign-on user / Sign-on password** fields store an account on the
system row (the proxy password's trust model — admin-only view, never on the
public list, never in the browser) and opening the system signs on
with it. Empty both fields to return to the normal sign-on screen; import/
export files carry the pair like every other setting.

Both kinds of automatic sign-on can be gated by an optional system-wide
**protection PIN** (admin console → Settings → *Automatic sign-on
protection*): while it is set, users are asked for the PIN the first time a
system would sign them on automatically (once per page). Entering it wrong —
or choosing *Sign on myself* — still connects, just without the automatic
sign-on. The PIN is stored hashed, and the browser exchanges it for a
single-use ticket so the PIN itself never appears in a URL. Unattended
`?auto=1` launches on the shared `AUTO_SIGNON_*` account are exempt.
