// The in-application manuals: a user guide (front menu / any terminal pane)
// and an admin guide (admin console), rendered as AS/400-style hypertext
// panels by help.ts.
//
// Page model: blocks of prose, headings, key tables, verbatim lines and
// bullet lists. Inline links are written {{label|page-id}} inside any text
// and resolved at render time - keep them on one line.
export type HelpBlock =
  | { t: 'p'; text: string }
  | { t: 'h'; text: string }
  | { t: 'keys'; rows: [string, string][] }
  | { t: 'pre'; text: string }
  | { t: 'ul'; items: string[] };

export interface HelpPage {
  id: string;
  title: string;
  subtitle?: string;
  blocks: HelpBlock[];
}

export interface HelpBook {
  id: 'user' | 'admin';
  name: string;
  home: string;
  pages: HelpPage[];
}

const h = (text: string): HelpBlock => ({ t: 'h', text });
const p = (text: string): HelpBlock => ({ t: 'p', text });
const keys = (...rows: [string, string][]): HelpBlock => ({ t: 'keys', rows });
const pre = (text: string): HelpBlock => ({ t: 'pre', text });
const ul = (...items: string[]): HelpBlock => ({ t: 'ul', items });

// ============================================================== user guide
const userPages: HelpPage[] = [
  {
    id: 'u-home',
    title: 'User guide',
    subtitle: 'Working with 5250 sessions in the browser',
    blocks: [
      p(
        `Welcome to the 5250 terminal. This guide covers everything you can do ` +
          `from the browser: {{picking and connecting to a system|u-menu}}, the full ` +
          `{{keyboard|u-keyboard}} and {{mouse|u-mouse}} mappings, ` +
          `{{split view|u-split}}, {{sharing a session|u-share}}, the {{status line|u-oia}}, ` +
          `{{spool files|u-spool}}, {{recording and replay|u-recording}} and ` +
          `{{troubleshooting|u-trouble}}.`
      ),
      h('Getting started'),
      ul(
        `Pick a system on the selection panel with the arrow keys (or type its number) and press Enter.`,
        `Wait for the sign-on screen - or none at all, on systems marked {{auto sign-on|u-signon}}.`,
        `Work exactly as on a desktop emulator; see {{Keyboard|u-keyboard}} for the key map.`
      ),
      h('Using this help'),
      keys(
        ['Tab / Shift+Tab', 'Move to the next / previous link'],
        ['Enter', 'Follow the highlighted link'],
        ['Backspace or Alt+←', 'Go back one page (like a browser)'],
        ['Alt+→', 'Go forward again'],
        ['↑ ↓ PgUp PgDn', 'Scroll the page'],
        ['Esc', 'Leave help']
      ),
      p(`The same guide is available from every terminal pane's ? button.`)
    ]
  },
  {
    id: 'u-menu',
    title: 'The system selection panel',
    subtitle: 'Picking where to connect',
    blocks: [
      p(`The panel lists every system the administrator maintains. Each row shows its address, TLS or telnet, terminal model and code page, plus markers:`),
      keys(
        ['SOCKS5', 'The connection is tunneled through a proxy (the proxy itself stays hidden)'],
        ['printer', 'Host spool files from this system appear under {{Spool|u-spool}}'],
        ['directory', 'The row comes from the central host directory and refreshes automatically'],
        ['auto sign-on', 'Opening it signs you on by itself - see {{Automatic sign-on|u-signon}}'],
        ['MAINTENANCE', 'Blocked for now; new sessions are refused until the window ends']
      ),
      h('Keys on the panel'),
      keys(
        ['↑ ↓', 'Move the selection'],
        ['number + Enter', 'Connect to that system'],
        ['Enter', 'Connect to the selected system'],
        ['? (question mark)', 'Open this {{user guide|u-home}}'],
        ['A', 'Open the admin console (PIN required)'],
        ['Esc', 'Hide the panel while a session runs']
      ),
      h('Display name'),
      p(
        `The Display field sets your 5250 device name for every session (A-Z 0-9 #$@ _, up to 10 ` +
          `characters). It is remembered per browser. If another live session already uses the name, ` +
          `the gateway appends a number automatically. See {{Sessions and reconnects|u-session}}.`
      ),
      h('Splitting before you connect'),
      p(`The Split ↔ / Split ↕ buttons lay the window out for several sessions at once - see {{Split view|u-split}}.`)
    ]
  },
  {
    id: 'u-signon',
    title: 'Automatic sign-on',
    subtitle: 'Systems that sign you on by themselves',
    blocks: [
      p(
        `A system marked auto sign-on carries a stored account (kept by the directory service or the ` +
          `administrator). When you open it, the gateway types the user and password for you - the ` +
          `credential never reaches your browser, and password fields are always blanked on screen.`
      ),
      p(`What you see: a short Connecting phase while the sign-on is typed, then your initial program's screen.`),
      h('When something goes wrong'),
      ul(
        `Sign-on failed - the host rejected the stored account. Tell the administrator; the session closes by itself.`,
        `A banner "Automatic sign-on is unavailable" - the directory could not be reached, so the normal sign-on screen appears instead. Sign on with your own account.`,
        `No marker on the menu row - the system simply expects you to sign on manually.`
      ),
      p(`Related: {{the system selection panel|u-menu}}, {{troubleshooting|u-trouble}}.`)
    ]
  },
  {
    id: 'u-keyboard',
    title: 'Keyboard',
    subtitle: 'Every mapped key',
    blocks: [
      p(`The window behaves like a desktop emulator - browser defaults (F1 help, F5 reload, Tab focus moves, backspace navigation) are suppressed while a session is focused.`),
      h('AID keys'),
      keys(
        ['Enter', 'Enter (transmit the screen)'],
        ['F1 - F12', 'PF1 - PF12'],
        ['Shift+F1 - Shift+F12', 'PF13 - PF24'],
        ['PageUp / PageDown', 'Roll Up / Roll Down'],
        ['Esc', 'SysReq (System Request)'],
        ['Shift+Esc', 'Attn (Attention)'],
        ['Alt+H', 'Help (the host program\u2019s help)'],
        ['Alt+P', 'Print the screen to your spool']
      ),
      h('Field editing'),
      keys(
        ['Tab / Shift+Tab', 'Next / previous input field'],
        ['Numpad + or Ctrl+Enter', 'Field Exit'],
        ['Numpad -', 'Field Minus'],
        ['Insert', 'Toggle insert / overwrite (OIA shows ^)'],
        ['Delete', 'Delete character (shift left)'],
        ['Backspace', 'Cursor left (5250 non-destructive)'],
        ['Home / End', 'To field start / field end'],
        ['↑ ↓ ← →', 'Cursor movement'],
        ['Ctrl+R or Alt+R', 'Reset - clears a keyboard error (X II)']
      ),
      h('Clipboard'),
      keys(
        ['Left-drag', 'Mark text; copied on release ({{see mouse|u-mouse}})'],
        ['Ctrl+C', 'Copy the marked text again'],
        ['Ctrl+V / Cmd+V', 'Paste at the cursor']
      ),
      p(`On touch devices the {{on-screen keypad|u-touch}} provides the same keys.`)
    ]
  },
  {
    id: 'u-mouse',
    title: 'Mouse',
    subtitle: 'Selection, copy & paste, positioning',
    blocks: [
      keys(
        ['Click', 'Place the cursor on any position (like a light pen)'],
        ['Left-drag', 'Mark a region - it is on the clipboard when you release'],
        ['Alt + left-drag', 'Mark a column rectangle'],
        ['Double-click', 'Mark one word'],
        ['Right-click', 'Menu: Copy screen / Copy selection / Paste']
      ),
      p(
        `Hidden (password) fields always copy as blanks - what you copy can never contain a password. ` +
          `Paste types the text at the cursor; if the browser asks for read-permission, ` +
          `{{Ctrl+V|u-keyboard}} skips the prompt.`
      )
    ]
  },
  {
    id: 'u-touch',
    title: 'Touch and small screens',
    subtitle: 'Phones and tablets',
    blocks: [
      p(`The terminal always fits the window and re-fits when the layout changes or a soft keyboard opens.`),
      keys(
        ['Pad button (top bar)', 'Show / hide the on-screen keypad: PF keys, Enter, Roll, Field Exit, arrows, Reset and more'],
        ['Kbd button (top bar)', 'Show / hide the device keyboard'],
        ['Tap', 'Place the cursor; tap a link or button to use it'],
        ['Tap a pane', 'Make it the active session (its keys go to that host)']
      ),
      p(`On the {{selection panel|u-menu}}, tapping a row twice connects (first tap selects).`)
    ]
  },
  {
    id: 'u-split',
    title: 'Split view',
    subtitle: 'Several sessions on one page',
    blocks: [
      p(`Every pane header carries its own controls:`),
      keys(
        ['↔ / ↕', 'Split this pane side by side / top and bottom (up to 6 panes)'],
        ['☰', 'Pick a system for this pane'],
        ['?', 'Open this {{user guide|u-home}}'],
        ['(share icon)', 'Copy a {{view-only mirror link|u-share}}'],
        ['↗', 'Move the session to its own browser window - it stays connected'],
        ['×', 'Close the pane (asks before ending a live session)']
      ),
      p(
        `Drag a divider to resize the neighbours; double-click a divider to reset. Top-bar ` +
          `Tiles shows every session at once; Tabs shows one (the others stay connected). ` +
          `+ Pane splits the roomiest pane; Exit split closes the extras.`
      ),
      p(`Each pane is an independent session - its own system, its own {{keyboard|u-keyboard}} focus.`)
    ]
  },
  {
    id: 'u-share',
    title: 'Sharing and remote assist',
    subtitle: 'Letting others watch - or help',
    blocks: [
      h('View-only mirror'),
      p(
        `The pane's share button copies a link. Anyone who opens it - in any window, on any machine ` +
          `that can reach this site - watches your screen live. Viewers cannot type, cannot take the ` +
          `session over, and do not keep it alive. Any number may watch at once.`
      ),
      h('Remote assist'),
      p(
        `A viewer can request control. You get a consent prompt with the helper's name: ` +
          `Grant, Deny, or Deny + block (the requester is refused for an hour).`
      ),
      ul(
        `A granted helper can type - every helper key is named on your screen ("Enter · HELPDESK")`,
        `The lease expires on its own (and after helper inactivity); you can revoke it any time`,
        `You never lose control: your own keys always work`
      ),
      p(`Related: {{session lifetime|u-session}}.`)
    ]
  },
  {
    id: 'u-session',
    title: 'Sessions and reconnects',
    subtitle: 'Reloads, dropped tabs, takeovers',
    blocks: [
      p(
        `A host session does not die with its window. Closing the tab, reloading, or losing the ` +
          `network leaves the host session waiting (default five minutes) - the gateway gives the ` +
          `browser a token to re-bind to it.`
      ),
      ul(
        `Reload the page: the session resumes automatically`,
        `Connection failed overlay: the Reconnect button re-binds if the session is still alive`,
        `"Session opened elsewhere": another window took the session over - only one window drives it at a time`,
        `End of grace period or explicit close (×, Systems): the session ends and the device is released`
      ),
      p(`Related: {{the display name|u-menu}}, {{split view pop-out|u-split}}.`)
    ]
  },
  {
    id: 'u-oia',
    title: 'The status line',
    subtitle: 'What the bottom line is telling you',
    blocks: [
      keys(
        ['X SYSTEM', 'The host is working - wait (keyboard locked to input)'],
        ['X II', 'Keyboard error: you typed something the field or state did not accept. Press {{Reset|u-keyboard}} (Ctrl+R)'],
        ['^ (caret)', 'Insert mode is on (Insert key toggles)'],
        ['MW', 'Message Waiting - a host message wants attention (SysReq 4 or your message program)'],
        ['beep', 'The host sounded the alarm - usually an input error or a locked keyboard'],
        ['Connecting / Negotiating', 'Session starting; see {{troubleshooting|u-trouble}} if it never ends']
      ),
      p(`The left edge also shows the cursor position (row, column) and the connection state.`)
    ]
  },
  {
    id: 'u-spool',
    title: 'Spool files',
    subtitle: 'Host printouts in the browser',
    blocks: [
      p(
        `On systems with printer enabled the top bar gains a Spool button (with a count). Printouts ` +
          `the host sends to the gateway's printer device land there:`
      ),
      ul(
        `Open a job to read it; Print sends it to your browser's print dialog`,
        `Download saves it (text or the raw host format, as configured)`,
        `Delete removes it from the list (the administrator sets how long jobs are kept)`
      ),
      p(`If the Spool button never appears, the system has no printer session - mention it to the administrator.`)
    ]
  },
  {
    id: 'u-recording',
    title: 'Recording and replay',
    subtitle: 'Your sessions, on the record',
    blocks: [
      h('Recording'),
      p(
        `On systems where the administrator allowed it, the top bar shows REC. Nothing is recorded ` +
          `until you press it; press again to stop. Password fields are never captured.`
      ),
      h('Replay'),
      p(
        `The History button lists your own recordings (needs the site's single-sign-on identity). ` +
          `Play opens a replay in a new window - the recorded screen, keys and notices, exactly as they happened.`
      )
    ]
  },
  {
    id: 'u-trouble',
    title: 'Troubleshooting',
    subtitle: 'Common problems and what they mean',
    blocks: [
      keys(
        ['Connection failed', 'The host was unreachable: wrong address, host down, or the proxy path is broken. Try Reconnect once; then tell the administrator'],
        ['Sign-on failed', 'On {{auto sign-on|u-signon}} systems the stored account was rejected - report it. On manual systems: check user/password, Caps Lock'],
        ['Keyboard dead, X II', 'Input error - press Reset ({{Ctrl+R|u-keyboard}})'],
        ['Keyboard dead, X SYSTEM', 'The host is processing - wait for the status to clear'],
        ['This system is in maintenance', 'New sessions are blocked during a host maintenance window; existing ones are drained at its deadline'],
        ['Session opened elsewhere', 'Another window took over - that window now owns the session'],
        ['Screen never arrives', 'Wait 30 s, then reconnect; if it persists, ask for the Diag button to collect a bug report']
      ),
      p(`Still stuck? The administrator can watch the session console, mirror your screen (with your consent) and read the audit trail.`)
    ]
  }
];

// ============================================================== admin guide
const adminPages: HelpPage[] = [
  {
    id: 'a-home',
    title: 'Administration',
    subtitle: 'The PIN-gated console',
    blocks: [
      p(
        `The console manages the {{system list|a-systems}}, live {{sessions|a-sessions}} and ` +
          `{{maintenance windows|a-maintenance}}, {{recordings|a-recordings}} and the ` +
          `{{audit trail|a-audit}} - plus {{config transfer|a-transfer}}.`
      ),
      h('Signing on'),
      ul(
        `The PIN is set by ADMIN_PIN in the container (at least 4 characters; empty disables the console entirely)`,
        `Wrong PINs are compared in constant time and repeated failures lock the console temporarily`,
        `The session token lives in the browser for 8 hours; Sign off clears it immediately`
      ),
      p(
        `Access control is a shared-secret on top of the site's real auth: this app expects to sit ` +
          `behind the Pangolin reverse proxy, which authenticates users. See {{security notes|a-security}}.`
      )
    ]
  },
  {
    id: 'a-systems',
    title: 'The system list',
    subtitle: 'Add, edit, delete, reorder',
    blocks: [
      p(`Every user's selection panel is this list. Rows from the {{directory service|a-directory}} carry their own marker and are managed there, not here.`),
      h('Editing'),
      keys(
        ['Add system', 'Open the form on a new, empty row'],
        ['Edit', 'Open the form on that row'],
        ['Del (Sure?)', 'Two-step delete: click again within 3 s'],
        ['↑ ↓', 'Move a row within the menu (directory rows always list after manual ones)']
      ),
      h('Connection fields'),
      keys(
        ['Name', 'Menu label (max 40 characters)'],
        ['Description', 'Second line on the row (max 120)'],
        ['Host / Port', 'TN5250 address: hostname or IP; port 23 telnet or 992 TLS'],
        ['TLS', 'Encrypt the host connection (self-signed certs are accepted by default)'],
        ['Terminal model', 'IBM-3477-FC (27x132 color) or IBM-3179-2 (24x80)'],
        ['Code page', 'Must match the host CCSID (cp037 US, cp273 German, ...)'],
        ['Device prefix', 'Sessions on this system get device names from this prefix']
      ),
      p(`Per-row {{SOCKS5 proxy|a-proxy}}, {{printer session|a-printer}}, {{recording|a-recording}} and {{sign-on account|a-signon}} have their own pages.`)
    ]
  },
  {
    id: 'a-signon',
    title: 'Stored sign-on accounts',
    subtitle: 'Sign-on user / Sign-on password',
    blocks: [
      p(
        `Fill both fields and every session on the system signs on automatically with that account - ` +
          `the same behaviour as {{directory|a-directory}} systems. Leave both empty for the normal ` +
          `manual sign-on screen.`
      ),
      ul(
        `Both or neither: a user without a password is rejected`,
        `The user profile follows IBM i rules: A-Z 0-9 #$@ _, max 10 characters`,
        `Stored in the gateway's catalog like the proxy password: visible only to the authenticated editor and export files, never on the public menu (which shows just an "auto sign-on" marker)`
      ),
      p(
        `The password is typed server-side into the sign-on screen and never reaches the browser; a ` +
          `rejected sign-on ends the session with "Sign-on failed".`
      )
    ]
  },
  {
    id: 'a-proxy',
    title: 'SOCKS5 proxy',
    subtitle: 'Tunneling the host connection',
    blocks: [
      p(
        `Set a proxy host when this system's TN5250 connection must leave through a jump host - ` +
          `typical when the IBM i sits in a network the gateway reaches only indirectly. ` +
          `Port defaults to 1080; user/password authenticate to the proxy itself (RFC 1929).`
      ),
      ul(
        `The browser never sees the proxy: the public menu shows only a "SOCKS5" marker`,
        `Credentials are served to the authenticated editor only`,
        `Leave the host empty for a direct connection`
      )
    ]
  },
  {
    id: 'a-printer',
    title: 'Printer sessions',
    subtitle: 'Host spool files in the browser',
    blocks: [
      p(
        `Enable Printer and the gateway keeps an always-on TN5250E printer device for the system; ` +
          `printouts land in every user's {{Spool|a-home}} list. The device must exist on the host:`
      ),
      pre(
        `CRTCTLVDE CTLD(QVIRCD0001)                     /* once, if missing  */\n` +
          `VRYCFG CFGOBJ(QVIRCD0001) CFGTYPE(*CTL) STATUS(*ON)\n` +
          `CRTDEVPRT DEVD(WEB5250P) DEVCLS(*VRT) CTL(QVIRCD0001)\n` +
          `         TYPE(3812) MODEL(1) FONT(011) FORMFEED(*CONT)\n` +
          `VRYCFG CFGOBJ(WEB5250P) CFGTYPE(*DEV) STATUS(*ON)`
      ),
      p(`...or let QAUTOVRT auto-configure a device on first connect. A manually created controller starts varied off - vary it on or the device sits at "not yet available".`),
      h('Mode'),
      keys(
        ['text', 'Extract plain text from the SCS stream (readable everywhere)'],
        ['raw', 'Store host print transform bytes (PDF/PCL) - create the device with TRANSFORM(*YES) MFRTYPMDL(...)']
      )
    ]
  },
  {
    id: 'a-recording',
    title: 'Recording (permission)',
    subtitle: 'Letting users record sessions',
    blocks: [
      p(
        `Checking Recording is a permission, not a switch: nothing is captured until a user starts it ` +
          `with their top-bar REC control. Users replay their own recordings from History; you manage ` +
          `everything in the {{Recordings tab|a-recordings}}.`
      ),
      ul(
        `Password fields are blanked before anything is written`,
        `Retention: newest 200 recordings / 500 MB / 30 days per gateway (drop-oldest; RECORDINGS_* settings)`
      )
    ]
  },
  {
    id: 'a-directory',
    title: 'Directory systems',
    subtitle: 'Menu entries from the host directory',
    blocks: [
      p(
        `When the gateway is configured with a directory service (DIRECTORY_URL), its entries appear ` +
          `here marked "directory (re-synced)" - connection settings come from the ` +
          `DIRECTORY_TEMPLATE_* environment; the directory supplies identity, host, and the sign-on ` +
          `credential.`
      ),
      keys(
        ['Sync directory', 'Pull the entry list right now (it also re-syncs on a timer, default 5 minutes)'],
        ['Edits', 'Overwritten by the next sync - change the directory entry or the template instead'],
        ['Delete', 'Returns on the next sync - remove the entry in the directory'],
        ['Export / Import', 'Directory rows are excluded (derived data); manual rows are unaffected by them']
      ),
      p(
        `Directory credentials are never stored: each session start fetches them fresh. Rows keep ` +
          `their gateway id across syncs, so live sessions and printer devices survive. Syncs and ` +
          `failures land in the {{audit trail|a-audit}}.`
      )
    ]
  },
  {
    id: 'a-sessions',
    title: 'Sessions console',
    subtitle: 'Live sessions and what you can do',
    blocks: [
      p(`The Sessions tab lists every live host session: device name, signed-on user, origin (site identity or IP), state (active / grace countdown), viewers, assist leases and recordings. It refreshes every 5 s.`),
      keys(
        ['Mirror', `Open a view-only window of the session; control can be requested from there (with the user\u2019s consent)`],
        ['Signal', `Show a banner on the user\u2019s screen`],
        ['End (Sure?)', 'Close the host session now - banner first, then the device and message queue are released']
      ),
      p(`Ending a session is the tool for stuck sign-ons and forgotten devices; it is audited.`)
    ]
  },
  {
    id: 'a-maintenance',
    title: 'Maintenance windows',
    subtitle: 'Blocking and draining sessions',
    blocks: [
      p(
        `Per system or gateway-wide: while a window is on, new sessions are refused with the message ` +
          `you set, and the menu row is marked MAINTENANCE. Existing sessions keep running - a ` +
          `deadline (minutes) drains them: users get a banner, then the session ends at the deadline.`
      ),
      ul(
        `Stop ends the window; sessions blocked mid-drain keep running`,
        `Windows are meant for host backups and IPLs`,
        `Watch and re-attach stay allowed during a window`
      )
    ]
  },
  {
    id: 'a-recordings',
    title: 'Recordings tab',
    subtitle: 'The recording store',
    blocks: [
      keys(
        ['Play', 'Mint a replay link and open the player in a new window'],
        ['Download', 'Save the raw event stream (JSONL)'],
        ['Remove', 'Stop (if live) and delete the recording and its replay links']
      ),
      p(`Only systems with Recording enabled produce entries; users start and stop their own recordings. Deleted or expired recordings' replay links stop working.`)
    ]
  },
  {
    id: 'a-audit',
    title: 'Audit trail',
    subtitle: 'Who did what, when',
    blocks: [
      p(
        `Every exercise of power is logged: console actions (session view/end/signal, recording ` +
          `removal, replay links), assist lifecycle (request/grant/deny/break-glass), directory syncs ` +
          `and failures, spool deletions. Rows age out after 30 days (AUDIT_TTL_MS).`
      ),
      p(`Each row: timestamp, actor (site identity or "admin"), action, target and detail. Newest first, 100 per page.`)
    ]
  },
  {
    id: 'a-transfer',
    title: 'Export and import',
    subtitle: 'Moving the system list around',
    blocks: [
      ul(
        `Export downloads every manual system - including proxy, printer and sign-on settings - as a JSON file`,
        `Directory rows are excluded and the file says how many`,
        `Import replaces the whole manual list; every row is validated first, and a bad file changes nothing`,
        `Directory rows survive an import untouched`
      ),
      p(`Treat export files as secrets: they contain proxy and sign-on passwords.`)
    ]
  },
  {
    id: 'a-security',
    title: 'Security notes',
    subtitle: 'Where the trust boundaries are',
    blocks: [
      ul(
        `The app has no user accounts of its own: it must sit behind the Pangolin reverse proxy (or equivalent) which authenticates every request`,
        `ADMIN_PIN gates host-list administration on top of that; its token is stored in the browser's localStorage (so a takeover mirror can reuse it for break-glass) and expires after 8 hours`,
        `Secrets in the catalog (proxy and sign-on passwords) are served only to the authenticated editor; the public menu list sees markers only`,
        `Host passwords typed by users never reach the browser in cleartext: non-display fields are blanked server-side, on every screen update, mirror and recording`,
        `Break-glass control without consent (ADMIN_ASSIST_BREAKGLASS) is off by default; when enabled it is audited loudly`,
        `Directory-service credentials are fetched per session start and never written to disk`
      )
    ]
  }
];

export const BOOKS: Record<'user' | 'admin', HelpBook> = {
  user: { id: 'user', name: 'USER GUIDE', home: 'u-home', pages: userPages },
  admin: { id: 'admin', name: 'ADMIN GUIDE', home: 'a-home', pages: adminPages }
};

/** Split text into (text | link) parts; {{label|page-id}} marks a link. */
export type HelpSegment = { text: string } | { text: string; to: string };

export function parseSegments(text: string): HelpSegment[] {
  const out: HelpSegment[] = [];
  const re = /\{\{([^}|]+)\|([^}]+)\}\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[1], to: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
