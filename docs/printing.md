# Spool printing

*TN5250E printer sessions and the browser spool*

The 5250 display protocol has no file transfer — the only channel a host
can push bytes down is a **TN5250E printer session** (the mechanism ACS and
tn5250 use for "print to local printer"). When a system has its printer
enabled, the gateway opens one printer device per **demand**: it connects
when the first display session opens to the system, stays connected while
any do (reconnected with backoff), and stops `PRINTER_IDLE_MS` (default 5
minutes) after the last one ends — like a real printer being powered on
when people arrive and off after they leave, because the device must be
there for the host's writer to send to it. Spool files released while no
session is up are not lost: the writer holds or errors them on the host
and delivers on the next connect. `PRINTER_IDLE_MS=0` restores an
always-on device. Print on the host — or move any spool file to the
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
[`docs/printer-session-notes.md`](printer-session-notes.md); the design
discussion in [`docs/printer-session.md`](printer-session.md).

Jobs live in a bounded store on the data volume next to the SQLite DB
(`<data>/printjobs/…`): newest `PRINTJOBS_MAX_COUNT` jobs / total
`PRINTJOBS_MAX_BYTES` bytes per system (drop-oldest) and a
`PRINTJOBS_TTL_MS` age limit, with the per-job download keyed by an
unguessable token under the app's usual edge-authentication trust model.
Job files never contain credentials. Anyone viewing the Spool window can
also remove individual jobs (the gateway deletes the stored file and
records the removal in the audit trail) — the shared list is readable by
every gateway user, so removal follows the same visibility.
