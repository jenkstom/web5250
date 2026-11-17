# Sharing & remote assist

*View-only mirrors and consent-based control leases*

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

## Remote assist

A share-link viewer watches; with assist it can also *drive* — but only
with consent, and only for a while:

1. The viewer clicks **Request control** on the mirror. The owner's screen
   shows a modal: *"BOB requests control of this session"* with
   **Grant / Deny / Deny + block 1h**. An unanswered request waits
   `ASSIST_CONSENT_TIMEOUT_MS` (default 30 s) and then follows
   `ASSIST_CONSENT_DEFAULT`: `allow` (default) grants control automatically,
   `deny` declines it. One pending request at a time.
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
lands in the audit log, which is why the default is off. A takeover is
built for shutdown: its bar offers **End session**, which signs the host
job off and closes every viewer (the takeover included), audited like the
console End — so an unattended session the admin had to seize always ends
cleanly instead of being hard-dropped or left signed on.

Identity comes from `TRUSTED_USER_HEADER` (the header your edge sets after
authenticating — Pangolin does): requests are named with it, sessions are
stamped with it, and without it the gateway falls back to device names.
Only set it when the container is reachable solely through the edge.
