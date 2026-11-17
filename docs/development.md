# Development & CI

*Building, testing and pipelines*

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
npm run test:keymaps    # Keymaps tab: .kmp import/download round-trip,
                        #   CRUD + per-host/default assignment, config
                        #   export/import, visual editor + live overlay key
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
npm run test:mousegui   # IBM_I_MOUSE_GUI: query reply claims the pointer,
                        #   host-programmed right-click opens the host menu
                        #   (save-image dialect, pick flow), Shift+right-
                        #   click keeps the local menu, flag off stays local
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
