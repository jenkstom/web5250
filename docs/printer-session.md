# TN5250E printer sessions — local spool printing & download

**Status: IMPLEMENTED (M0–M7). One item remains open: a real-IBM i
end-to-end validation (`scripts/printer-real-test.mjs` + the DoD checklist
below).** The M0 research findings — which reshaped M2 — are in
[`printer-session-notes.md`](printer-session-notes.md): printer sessions
need no telnet option 0x24 and no `12 A1` START_SESSION record; the classic
tn5250 flow (TTYPE `IBM-3812-1` + DEVNAME + startup-response record) is the
implemented, byte-verified path.

Goal: let a user press Print on the IBM i (or move a spool file to the
web5250 printer's output queue) and get that spool file **in the browser** —
downloadable, and printable on a locally connected printer — without any
host-side file transfer, SSH, or NetServer setup beyond creating the device.

```
[ IBM i ]                    TN5250E printer session (RFC 2877)
    │  SCS / host-print-transform data over telnet, device *PRINT
    │
[ web5250 gateway ]          one printer client per configured system
    │  job store (bounded, data volume)          API: list/download
    │
[ Browser ]                  "Spool" button → job list → Download / Print
```

Why this design: the 5250 display protocol has no file transfer — the only
channel a host can push bytes down is a **TN5250E printer session** (the
mechanism ACS and tn5250j use for "print to local printer"). The gateway
already terminates the display side of telnet; adding the printer side gives
spool files a path into the browser with no new infrastructure.

---

## Decisions already made (rationale)

1. **Printer sessions are per-system, gateway-owned, always-on.** A printer
   device must be connected for the host's writer to send to it — like a
   real printer being powered on. They are independent of display sessions
   (connecting one does not connect the other) and reconnect with backoff.
2. **Reuse the existing socket path.** The raw-socket acquisition in
   `Tn5250Client.connect()` (direct / TLS / SOCKS5) is factored into a
   shared helper so printer sessions get TLS and SOCKS5 for free.
3. **Two delivery modes per system:**
   - `text` (default): device type is an SCS printer (e.g. `IBM-3812-1`);
     the gateway extracts plain text from the SCS stream (page breaks
     preserved as form feeds). Zero host-side transform configuration.
   - `raw`: for hosts with **host print transform** configured on the
     device (WSCST), the gateway stores the bytes as-is and sniffs the
     format (`%PDF` → `.pdf`, PCL → `.pcl`, else `.txt`). Power users get
     real PDFs; nobody is forced to configure a WSCST.
4. **Display sessions stay exactly as they are** — plain RFC 1205, no
   TN5250E sign-on on the display path. The E-option negotiation lives
   behind a flag used only by printer clients, so the proven display flow
   is untouched.
5. **Job delivery follows the app's existing security model**: identity is
   enforced by Pangolin at the edge; downloads use unguessable per-job
   tokens (same trust model as `?attach=`/`?view=` session tokens), and job
   files never contain credentials.
6. **Bounded storage on the data volume** next to the SQLite DB (e.g.
   `<data>/printjobs/<system>/<token>.txt`), with retention knobs
   (count / total bytes / TTL) and drop-oldest behavior — mirroring the
   "everything is bounded" approach of `traceRecords` and `diagLines`.

## Open questions (resolved by the v1 implementation)

- [x] **Q1 — Who may list/download jobs?** Any app user (Pangolin-authenticated):
      list/download/status are public routes; only `DELETE /api/printjobs/<token>`
      is admin-gated. The jobs are already behind the zero-trust edge.
- [x] **Q2 — Device creation on the host.** Both supported: pre-created
      `CRTDEVPRT … TYPE(3812) MODEL(1)` (v1's documented recipe) or
      `QAUTOVRT` auto-configuration; startup-response codes (2702/8940/8901…)
      tell the admin which is missing. See printer-session-notes.md §6.
      Confirming the exact `QAUTOVRT` behaviour on the real host stays with
      the real-host validation item.
- [x] **Q3 — Device name collisions.** Fail loudly: printer sessions disable
      the display-style auto-rename (the output queue is per device name);
      the collision surfaces in `/api/printer-status` and the spool modal,
      and the admin renames the configured device.
- [x] **Q4 — One printer device per system, or N?** v1: one.
- [x] **Q5 — "Print" in the browser for text jobs.** Both: download plus a
      print-formatted view (white page, monospace, one page per form feed,
      `window.print()`); PDFs print via a hidden iframe.
- [x] **Q6 — Retention defaults.** As proposed: newest 200 jobs / 100 MB per
      system / 14-day TTL, whichever hits first, drop-oldest.
- [x] **Q7 — Job metadata shown.** Device + timestamp + size + format +
      pages (text mode) + system; spool file name/user/job number are not in
      the SCS stream and are not parsed (banners stay part of the text).
- [x] **Q8 — Keepalive.** Reused the display heartbeat (IAC NOP / 45 s);
      no RFC requires anything stronger for printer sessions.

---

## Implementation checklist

### M0 — Protocol spike (read-only research, no product code)

- [ ] Extract the exact TN5250E flows from RFC 2877 and cross-check
      byte-for-byte against tn5250j's `TN5250jInputStream`/session code and
      the classic tn5250 sources — the same method used for the display
      protocol. Write the findings into `docs/printer-session-notes.md`:
      - [ ] Telnet option 0x24 negotiation order (who sends DO/WILL when).
      - [ ] START_SESSION request (GDS `12 A1`) layout: flags byte,
            DEVNAME field, E-option terminal-type value for SCS printers.
      - [ ] START_SESSION response (`12 A2`) status byte values (ok,
            name-in-use, invalid name, recovery …) and the assigned-name
            field.
      - [ ] Print data records: GDS shape host→client, whether the client
            must acknowledge records/pages, end-of-page vs end-of-job
            markers, and how the host signals "job complete".
      - [ ] SCS subset that actually occurs on *SCS printer sessions:
            which control codes appear in practice (transparent text, HT,
            NL, FF, RFF, set-presentation etc.) → define the `text` mode
            extractor's rules.
      - [ ] Whether IBM i requires the device to be varied on by the telnet
            server or by the admin (`VRYCFG`), and the writer semantics.
- [ ] Confirm the host-side recipe on the real target host (with admin):
      create/test a `*SCS` device, start a writer or move a spool file to
      its output queue, capture a real SCS trace for the extractor tests.

### M1 — Socket plumbing shared with display sessions

- [ ] Factor the direct/TLS/SOCKS5 connection acquisition out of
      `Tn5250Client.connect()` / `connectThroughProxy()`
      (`src/server/tn5250/client.ts`) into a shared `openHostSocket()`
      helper (same file or `transport.ts`); display behavior unchanged.
- [ ] Prove no regression: `npm run smoke`, `test:socks` still green with
      the refactor (no functional change yet).

### M2 — Telnet layer: TN5250E option

- [ ] `src/server/tn5250/constants.ts`: telnet option `0x24` and the
      START_SESSION GDS IDs/flags/status values from M0.
- [ ] `src/server/tn5250/telnet.ts`: opt-in E support — when enabled,
      answer `DO 0x24` with `WILL`, send `DO 0x24` after the classic
      negotiation, and expose a hook for the sign-on record. Display
      sessions construct with E disabled → bytes on the wire identical to
      today (verify with trace).
- [ ] `sendGds()` already generic enough for the sign-on record, or extend
      it (opcode/flags semantics differ from WTD).

### M3 — Printer session client

- [ ] New `src/server/tn5250/printer-client.ts`: lifecycle (connect →
      negotiate E → START_SESSION with configured DEVNAME → idle/ready),
      status states (`connecting | ready | error | disabled`), reconnect
      with capped exponential backoff, heartbeat per Q8 outcome.
- [ ] Receive print records; assemble SCS stream; detect job boundaries
      per M0 findings; hand complete jobs to the store.
- [ ] `text` mode extractor: EBCDIC→Unicode via the system's configured
      code page (`Ebcdic` class reuse), control-code handling, form-feed
      page separation.
- [ ] `raw` mode: passthrough + format sniffing (PDF/PCL/plain).
- [ ] Diagnostics parity: bounded `diagLines` + `WEB5250_TRACE=1` hex
      dumps, like `Tn5250Client`.

### M4 — Job store & gateway wiring

- [ ] New `src/server/printers.ts`: per-system printer-client registry,
      job store (write-to-disk + in-memory index), retention enforcement
      (drop-oldest, TTL sweep), job tokens (`randomBytes`, same style as
      session tokens).
- [ ] Lifecycle: start configured printers at boot; stop/restart on admin
      config changes (systems list edits apply live, like display edits).
- [ ] `src/server/systems.ts`: per-system fields `printerEnabled`,
      `printerDeviceName`, `printerMode` (`text|raw`) — validation,
      `ALTER TABLE` in-place migration (proxy-column pattern), public-row
      stripping (device name is infrastructure detail — same policy as
      proxy host), admin (authed) rows carry them.
- [ ] `src/server/config.ts` + seed: `IBM_I_PRINTER_ENABLED`,
      `IBM_I_PRINTER_DEVNAME`, `IBM_I_PRINTER_MODE` for first boot;
      retention knobs `PRINTJOBS_MAX_COUNT / _MAX_BYTES / _TTL`.
- [ ] Log lines in the house style (`[printer WEB5250P] job 0012 …`).

### M5 — API

- [ ] `GET /api/printjobs` → list for the menu's systems (metadata only:
      token, system id/name, device, mode, bytes, pages?, timestamp).
- [ ] `GET /api/printjobs/<token>` → file download (content-type by mode;
      `cache-control: no-store`); unknown/expired token → 404 JSON.
- [ ] `DELETE /api/printjobs/<token>` — admin-gated (Bearer), if we keep
      manual cleanup at all (retention may suffice).
- [ ] `GET /api/printer-status` (or fold into `/api/meta`): per-system
      printer state for the UI badge/button gating.
- [ ] Update the route table comment block at the top of `api.ts`.

### M6 — Browser UI

- [ ] Top-bar **Spool** button (visible when the current system has a
      printer; follows the `Diag` button gating pattern) with a small
      pending-jobs count.
- [ ] Job modal (retro-styled like the admin modal): list rows — time,
      system, device, size, format; actions **Download** and **Print**
      (per Q5) — text print view + `window.print()`, PDF via iframe.
- [ ] Printer-state surfacing: ready/reconnecting badge in the modal.
- [ ] Admin editor form: printer fields (enabled checkbox, device name,
      mode select) following the SOCKS5-proxy fields pattern; SOCKS5
      marker-style display on the menu row ("· printer").

### M7 — Mock host + tests

- [ ] `scripts/mock-host.mjs`: printer mode (separate port or flag) —
      telnet server side of option 0x24 + START_SESSION, canned SCS jobs
      (2–3 jobs, EBCDIC text, FF page breaks) sent on session start or on
      an env-configured schedule; a name-in-use scenario for the error
      path; a job-split-across-segments case (record framing stress).
- [ ] `scripts/printer-test.mjs` (+ `npm run test:printer`), following
      `socks-test.mjs`: printer-enabled system → jobs arrive → list →
      download → text matches → retention purge → failure paths (auth/
      collision via mock) → proxy-credentials-style leak checks on the new
      API (device names not in public systems list).
- [ ] Real-host validation script `scripts/printer-real-test.mjs`
      (env-gated like `test:real`): connect, print a known spool file,
      compare extracted text.
- [ ] README: feature bullet, env table rows, admin docs, test list entry;
      `.env.example` for the new vars.

### Definition of done

- [x] All existing suites green (`smoke`, `test:socks`, `test:admin`,
      `test:share`, `test:select`, `test:paste`, `typecheck`).
      (`test:mobile` has one pre-existing failure on this machine,
      reproduced on the unmodified tree.)
- [x] `test:printer` green against the mock printer host.
- [ ] One successful end-to-end against the real IBM i: spool file printed
      on the host appears in the browser, downloads, and prints locally.
      (Needs a reachable host with a `*VRT 3812` device — not done yet.)
- [x] Display-session bytes on the wire unchanged (M1 was a pure refactor;
      M2 added no negotiation for display sessions — `sendGds` defaults its
      new flow parameter to `00 00`).

## Non-goals (v1)

- Client-side AFPDS/PCL rendering (`raw` mode delegates that to the host's
  print transform; `text` mode is plain text).
- Multiple printer devices per system (Q4), scheduled printing, email
  delivery, viewing spool *lists* (WRKSPLF stays a normal display session).
- Any file transfer on the display protocol — there isn't one.

## References

- RFC 2877 (5250 Telnet enhancements: E option, START_SESSION, print
  sessions), RFC 1205 (base), RFC 1572 (NEW-ENVIRON).
- tn5250j printer-session sources and the classic `tn5250` project's
  printer code — the byte-level ground truth to cross-check against.
- IBM docs: TN5250E printer device creation, host print transform + WSCST,
  `QAUTOVRT` auto-configuration.
