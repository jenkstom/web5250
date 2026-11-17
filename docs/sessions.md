# Sessions

*Split view, tabs, pop-out windows and the detach grace period*

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
