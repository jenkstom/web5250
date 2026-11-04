# Directory service — menu entries + automatic sign-on from your own database

You have a database of IBM i / AS/400 hosts (IP addresses) and the accounts
that connect to them. This feature publishes that database to web5250
**through a microservice of your choosing** — the gateway never touches the
database directly — and uses it for two things:

1. **Menu entries**: every host in the database appears on the gateway's
   connection menu, materialized from a *template* you configure with
   environment variables (SOCKS5 proxy, code page, terminal model, printer
   session, recording — everything except the host itself).
2. **Automatic sign-on**: when a user picks such an entry, the gateway
   fetches that host's username/password from the microservice at session
   start and signs on by itself — the user lands past the sign-on screen
   without ever seeing (or being able to read) the credential.

```
[ Browser ]─HTTPS/WSS─[ Pangolin ]─┐
                                   ▼
                        [ web5250 container ]
                         │ TN5250          │ HTTP + bearer token
                         ▼                 ▼
                 [ IBM i / AS/400 ]  [ directory service ]──[ your database ]
                                     (this microservice)    (hosts + accounts)
```

The directory service is **read-only** and needs exactly three endpoints —
the complete contract is in
[directory-service-openapi.yaml](directory-service-openapi.yaml), and a
working reference implementation ships next to this document as
[directory-service.mjs](directory-service.mjs).

| Call | When web5250 calls it | What it returns |
| :--- | :--- | :--- |
| `GET /v1/entries` | at boot + every `DIRECTORY_SYNC_INTERVAL_MS` (default 5 min), and when an admin clicks **Sync directory** | the menu list: `{entries: [{id, name, description?, host, port?, ssl?, autoSignOn}]}` — **no credentials** |
| `GET /v1/entries/{id}/credentials` | once per session, when a user opens that system | `{username, password}` — or **404** when no credential is stored (session opens on the manual sign-on screen) |
| `GET /healthz` | container health checks | `{status: "ok"}` |

---

## How the gateway behaves

Understanding these rules makes the directory service easy to operate:

- **The entry `id` is the sync key.** Menu rows are matched by it across
  syncs, so a row keeps its gateway id (deep links, live sessions and printer
  devices survive a re-sync). Renaming a host's row in your database is
  seamless; recycling an id for a *different* host re-points the menu row.
- **Directory rows list after the manual ones**, in the order the service
  returns them; reordering the query reorders the menu on the next sync.
- **Every field of a directory row is overwritten by each sync** (the admin
  editor shows a note on directory rows). To change one permanently, change
  the database or the `DIRECTORY_TEMPLATE_*` environment — not the row.
- **Deleting a directory row in the admin editor** works, but the next sync
  brings it back. Remove the entry in your database instead.
- **Export/import ignore directory rows** (export notes how many were
  excluded; import never deletes them) — they are derived data.
- **`autoSignOn: true`** (a username *and* password exist for the entry) is
  what makes the menu say `· auto sign-on`. Entries without a stored
  credential still appear and open on the normal sign-on screen.
- **Failure behaviour**: if the list call fails, the last-good menu rows stay
  and the failure is logged + audited (`directory.error`). If a credential
  call fails mid-outage, the session still opens — on the manual sign-on
  screen, with a banner explaining that automatic sign-on is unavailable.
- **Credentials never persist.** They are fetched at session start, typed
  into the host's sign-on screen by the same server-side automation
  `?auto=1` uses, and forgotten. They are not written to the gateway's
  SQLite file, never sent to the browser (password fields are blanked
  server-side before any screen update, as always), and never appear in the
  admin editor. (That is the directory's trust model. A *manually*
  configured system may instead store a sign-on pair in the admin editor —
  the proxy password's model: kept in the catalog, admin-only view. Both
  give the same automatic sign-on; directory entries are simply never
  written down.)

## Configuring web5250

Everything is environment-driven (compose/.env), and the feature is **off**
unless `DIRECTORY_URL` is set.

### Connection

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `DIRECTORY_URL` | – | Base URL of the microservice, e.g. `http://directory:8088` (compose network) or `https://directory.internal:8443`. Unset = feature off. |
| `DIRECTORY_TOKEN` | – | Bearer token the service requires. Strongly recommended; a warning is logged without it. |
| `DIRECTORY_SYNC_INTERVAL_MS` | `300000` | Re-sync cadence, clamped to 15 s–24 h. |
| `DIRECTORY_TIMEOUT_MS` | `5000` | Per-request timeout (list + credentials), clamped 1–30 s. |
| `DIRECTORY_TLS_REJECT_UNAUTHORIZED` | `true` | Set `false` for a self-signed/internal-CA certificate. |

### The template (`DIRECTORY_TEMPLATE_*`)

Every entry is materialized with these settings; the database supplies only
identity and reachability. `name`/`description` are patterns where `{name}`
substitutes the entry's label and `{host}` its address.

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `DIRECTORY_TEMPLATE_NAME` | `{name}` | Menu name pattern, e.g. `{name} ({host})` |
| `DIRECTORY_TEMPLATE_DESCRIPTION` | – | Second-line pattern (`{name}`/`{host}`/`{description}`); when empty, the entry's own `description` is used |
| `DIRECTORY_TEMPLATE_PORT` | `23` | Telnet port (per-entry `port` overrides) |
| `DIRECTORY_TEMPLATE_SSL` | `false` | TLS (per-entry `ssl` overrides) |
| `DIRECTORY_TEMPLATE_TERM_TYPE` | `IBM-3477-FC` | 5250 device model |
| `DIRECTORY_TEMPLATE_CODEPAGE` | `cp037` | EBCDIC code page |
| `DIRECTORY_TEMPLATE_DEV_PREFIX` | – | Device-name prefix for sessions on these systems |
| `DIRECTORY_TEMPLATE_PROXY_HOST` | – | **SOCKS5 proxy** every directory host is reached through |
| `DIRECTORY_TEMPLATE_PROXY_PORT` | `1080` | …its port |
| `DIRECTORY_TEMPLATE_PROXY_USER` | – | …its username (RFC 1929 auth) |
| `DIRECTORY_TEMPLATE_PROXY_PASSWORD` | – | …its password |
| `DIRECTORY_TEMPLATE_PRINTER_ENABLED` | `false` | Gateway-owned printer session (spool in the browser) |
| `DIRECTORY_TEMPLATE_PRINTER_DEVNAME` | – | Printer device name |
| `DIRECTORY_TEMPLATE_PRINTER_MODE` | `text` | `text` or `raw` spool handling |
| `DIRECTORY_TEMPLATE_RECORDING` | `false` | Allow session recording on these systems |

A typical "everything through the proxy jump host" setup:

```env
DIRECTORY_URL=http://directory:8088
DIRECTORY_TOKEN=<same random token as the service>
DIRECTORY_TEMPLATE_PROXY_HOST=socks.internal
DIRECTORY_TEMPLATE_PROXY_PORT=1080
DIRECTORY_TEMPLATE_PROXY_USER=web5250
DIRECTORY_TEMPLATE_PROXY_PASSWORD=********
DIRECTORY_TEMPLATE_SSL=true
DIRECTORY_TEMPLATE_PORT=992
DIRECTORY_TEMPLATE_DEV_PREFIX=DIR_
DIRECTORY_TEMPLATE_NAME={name}
DIRECTORY_TEMPLATE_DESCRIPTION=managed by the host directory
```

---

## Building the microservice

### Option A — run the reference implementation (fastest)

`docs/directory-service.mjs` is a complete, dependency-free service
(Node ≥ 22.13, `node:sqlite`). Copy it out of the repo, point it at a
database, run it:

```bash
mkdir directory-service && cd directory-service
cp /path/to/web5250/docs/directory-service.mjs .
export API_TOKEN="$(openssl rand -hex 32)"
export DB_PATH=/srv/assets/hosts.db    # your existing SQLite file
export LISTEN_HOST=127.0.0.1           # loopback: only same-host callers
export PORT=8088
node directory-service.mjs
```

It expects (and, on an empty file, creates) this table — change the two SQL
constants at the top to match your real schema instead:

```sql
CREATE TABLE hosts (
  id       TEXT PRIMARY KEY,   -- stable sync key: letters/digits . _ : - (≤64)
  label    TEXT NOT NULL,      -- menu name; blank falls back to host
  host     TEXT NOT NULL,      -- IP or hostname the gateway connects to
  port     INTEGER,            -- NULL = template port
  ssl      INTEGER,            -- 0/1; NULL = template setting
  username TEXT,               -- NULL in either column = no auto sign-on
  password TEXT
);
```

For example, if your existing database is a `credentials` table keyed by IP:

```js
const LIST_SQL = `
  SELECT ip AS id, hostname AS label, ip AS host, port, ssl, username, password
  FROM credentials WHERE retired = 0 ORDER BY hostname`;
const CRED_SQL = `
  SELECT username, password FROM credentials WHERE ip = ?`;
```

That is the whole adaptation — the rest of the file is transport, auth and
validation.

### Option B — container next to web5250 (compose)

```dockerfile
# directory-service/Dockerfile
FROM node:22-slim
COPY directory-service.mjs /app/directory-service.mjs
ENV DB_PATH=/data/directory.db LISTEN_HOST=0.0.0.0 PORT=8088
EXPOSE 8088
CMD ["node", "/app/directory-service.mjs"]
```

```yaml
# docker-compose.yml — additions
services:
  web5250:
    environment:
      DIRECTORY_URL: http://directory:8088
      DIRECTORY_TOKEN: ${DIRECTORY_TOKEN}
      # ...plus any DIRECTORY_TEMPLATE_* settings from the table above

  directory:
    build: ./directory-service
    restart: unless-stopped
    environment:
      API_TOKEN: ${DIRECTORY_TOKEN}      # same value as web5250's side
    volumes:
      - directory-data:/data             # holds directory.db
    # Deliberately NO `ports:` — the service must be reachable only by the
    # web5250 container over the compose network.

volumes:
  directory-data:
```

Put `DIRECTORY_TOKEN=<openssl rand -hex 32>` in `.env`, `docker compose up -d
--build`, and directory systems appear on the menu within seconds (sync runs
at boot). The admin editor gains a **Sync directory** button for immediate
pulls, and the Audit tab records every sync (`directory.sync`) and every
failure (`directory.error`).

### Option C — your own stack

Any HTTP service implementing
[directory-service-openapi.yaml](directory-service-openapi.yaml) works — the
gateway only ever makes those two GET calls with a bearer header. Keep the
contract's edge rules in mind:

- **401 vs 403** for missing vs wrong token (the gateway surfaces both as a
  sync/credential failure — and keeps working from its last-good state),
- **404/204 means "no credential for this entry"**, not an error,
- respond to the credentials call quickly — the session's WebSocket upgrade
  waits for it (gateway timeout `DIRECTORY_TIMEOUT_MS`),
- skip invalid rows rather than failing the whole list (the gateway also
  tolerates individual bad rows, but a clean list is better),
- never include credentials in `GET /v1/entries` responses.

### TLS

Credentials cross this interface as cleartext JSON, so pick one:

- **Compose network / loopback** (the examples above): container-to-container
  traffic never leaves the host — plain HTTP is the common choice.
- **TLS terminating proxy**: put the service behind the same nginx/Pangolin
  infra you already run, with an internal upstream.
- **Direct TLS**: front it with `stunnel`, or extend the sample with
  `node:tls` certs. With a self-signed/internal-CA certificate set
  `DIRECTORY_TLS_REJECT_UNAUTHORIZED=false` on the gateway.

## Security notes

- The microservice is the only thing that reads the credential database —
  scope its DB user to `SELECT` on the one table it needs.
- Generate the token once, store it in `.env`/your secret manager, and keep
  it out of logs. The sample compares it in constant time.
- No `ports:` mapping for the service container; reachability is the
  web5250 container plus nothing else.
- On the gateway, credentials exist only in process memory during the
  sign-on automation; the SQLite catalog never stores them, and password
  fields are blanked server-side before any screen data is streamed (to
  browsers, mirrors and recordings alike).
- The audit trail records syncs and failures — never credential material.

## Testing

With the gateway source checked out:

```bash
npm run build && npm run test:directory
```

spins up a mock directory service and a mock 5250 host, and verifies the
whole path: template materialization, per-entry overrides, removal on
disappearance, auto sign-on through a real session, manual fallback when no
credential exists, and the degraded banner when the service fails.
