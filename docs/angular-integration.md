# Embedding web5250 data-entry sessions in Angular

This guide is for Angular developers embedding a web5250 automated
data-entry terminal in your app. It covers the launch URL, the
end-of-session signal, a ready-to-adapt component, and local development
without an IBM i.

## What the integration does

```
Angular app                 web5250 (iframe)                  IBM i
   |                             |                              |
   |  <iframe src="...?auto=1">  |                              |
   |---------------------------> |  telnet connect              |
   |                             |---- sign-on (server-held --->|
   |                             |     user/password)           |
   |                             |<--- initial program (INLPGM) |
   |                             |     data-entry screen        |
   |                             |---- type input string ------>|
   |                             |     (+ Enter), then done     |
   |        user types in the iframe, works the screen          |
   |<==== keyboard through iframe ==== 5250 session ===========>|
   |                             |                              |
   |                             |<=== user exits program ======|
   |                             |      host signs off, drops   |
   |  postMessage session-end    |<--- connection closed -------|
   |<----------------------------|                              |
   |  remove the iframe          |                              |
```

- The end user never sees a sign-on screen. The gateway signs on with a
  server-held identity (`AUTO_SIGNON_USER` / `AUTO_SIGNON_PASSWORD` env
  vars on the web5250 server — ops configuration, not yours).
- The IBM i user profile's **initial program** must open the data-entry
  screen and sign the session off when it exits. That is AS/400-side
  setup (INLPGM); nothing about it lives in the Angular code.
- The optional `input` string is typed into whatever field the cursor
  starts in (the screen's first input field), after the screen becomes
  ready plus a delay. Pass what that first prompt expects — e.g. a
  customer or order number.

## Building the launch URL

```
https://<gateway>/?system=<id>&auto=1&input=<value>&parentorigin=<your-origin>
```

| Param | Required | Default | Meaning |
| :--- | :--- | :--- | :--- |
| `auto=1` | yes | — | Activates the automated launch |
| `system=<id>` | no | env default | Which configured system to connect to (from the gateway's admin menu) |
| `input=<string>` | no | — | Typed into the first input field (≤ 256 printable ASCII) |
| `inputenter=0` | no | `1` | `0` = type the string without pressing Enter |
| `inputdelay=<ms>` | no | `500` | Minimum wait after the screen is ready before typing (0–10000) |
| `parentorigin=<origin>` | no | `*` | Restricts where the end-of-session `postMessage` may be delivered. **Set it to your Angular origin in production.** |

You can also pass the usual web5250 params, e.g. `devname=ORDERENT` to
request a specific 5250 device name (uniqueness suffixes are appended
automatically when several windows are open).

## The end-of-session signal

When the session ends for any reason, the page inside the iframe sends
**one** message to its parent window:

```ts
window.parent.postMessage(
  { source: 'web5250', type: 'session-end', reason: string, detail: string },
  parentOrigin   // the value of ?parentorigin, '*' if not set
);
```

| `reason` | Meaning | Your action |
| :--- | :--- | :--- |
| `closed` | Session ended normally — the user exited the program, the IBM i signed off and dropped the connection (also sent if the gateway refuses the connection outright) | Close/remove the iframe |
| `error` | Connection failed (host unreachable, TLS problem…); `detail` has the message | Remove the iframe, show an error |
| `signon-failed` | The IBM i rejected the gateway's configured sign-on | Remove the iframe; page shows "Sign-on failed" — tell ops to check `AUTO_SIGNON_*` |
| `timeout` | The initial-program screen never appeared within 30 s | Remove the iframe; investigate the IBM i side |

Until the message arrives, the iframe is live — treat it as an input
surface owned by the user. Do not remove or re-create it on route
changes unless you intend to end the session.

> **Contract note:** `?auto=1` launches always use strict session lifetime —
> removing the iframe (or the user closing the browser tab) tears the host
> session down, and the `session-end` reasons above are unchanged. The
> detach/grace behaviour described in the README's *Sessions outlive their
> window* section applies to interactive sessions only, so this contract is
> unaffected. (One new reason can appear in theory: `detached`, if another
> window attaches to the session's token — treat it like `closed`.)

Minimal listener:

```ts
@HostListener('window:message', ['$event'])
onMessage(event: MessageEvent): void {
  if (event.origin !== 'https://gateway.example') return;          // verify the source
  const d = event.data as { source?: string; type?: string; reason?: string };
  if (d?.source === 'web5250' && d?.type === 'session-end') {
    // d.reason: 'closed' | 'error' | 'signon-failed' | 'timeout'
    this.closeTerminal();
  }
}
```

## Ready-to-adapt Angular component

Standalone component, Angular 17+ syntax (on older versions swap `@if`
for `*ngIf`):

```ts
import {
  Component, EventEmitter, HostListener, Input, Output,
  OnChanges, ViewChild, ElementRef,
} from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';

export interface Web5250SessionEnd {
  reason: 'closed' | 'error' | 'signon-failed' | 'timeout';
  detail: string;
}

@Component({
  selector: 'web5250-terminal',
  standalone: true,
  template: `
    @if (active) {
      <iframe
        #frame
        [src]="safeUrl"
        title="Terminal"
        class="web5250-frame">
      </iframe>
    }
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; }
    .web5250-frame { width: 100%; height: 100%; border: 0; }
  `],
})
export class Web5250TerminalComponent implements OnChanges {
  /** web5250 base URL, e.g. https://gateway.internal/ */
  @Input() gatewayUrl = 'https://gateway.example/';
  /** Configured system id; leave undefined for the gateway's default host. */
  @Input() systemId?: number;
  /** String typed into the data-entry screen's first field. */
  @Input() input?: string;
  /** Press Enter after typing input. */
  @Input() inputEnter = true;
  /** ms to wait after the screen is ready before typing. */
  @Input() inputDelay = 500;
  /** Your origin — restricts the postMessage target. */
  @Input() parentOrigin = window.location.origin;

  @Output() sessionEnded = new EventEmitter<Web5250SessionEnd>();

  active = true;
  safeUrl?: SafeResourceUrl;

  @ViewChild('frame', { read: ElementRef }) frame?: ElementRef<HTMLIFrameElement>;

  constructor(private sanitizer: DomSanitizer) {}

  ngOnChanges(): void {
    const params = new URLSearchParams({ auto: '1' });
    if (this.systemId) params.set('system', String(this.systemId));
    if (this.input) params.set('input', this.input);
    if (!this.inputEnter) params.set('inputenter', '0');
    if (this.inputDelay !== 500) params.set('inputdelay', String(this.inputDelay));
    params.set('parentorigin', this.parentOrigin);

    const base = this.gatewayUrl.endsWith('/') ? this.gatewayUrl : this.gatewayUrl + '/';
    const url = new URL(base);
    url.search = params.toString();
    // iframe [src] bindings require an explicitly trusted resource URL.
    this.safeUrl = this.sanitizer.bypassSecurityTrustResourceUrl(url.toString());
    this.active = true;
  }

  @HostListener('window:message', ['$event'])
  onMessage(event: MessageEvent): void {
    if (event.origin !== new URL(this.gatewayUrl).origin) return;
    const d = event.data as Partial<Web5250SessionEnd> & { source?: string; type?: string };
    if (d?.source !== 'web5250' || d?.type !== 'session-end') return;
    this.active = false;                       // removes the iframe from the DOM
    this.sessionEnded.emit({ reason: d.reason!, detail: d.detail ?? '' });
  }

  /** End the session programmatically (optional). */
  close(): void {
    this.active = false;
    this.frame?.nativeElement.remove();        // dropping the iframe drops the WS + 5250 session
  }
}
```

Usage:

```html
<web5250-terminal
  gatewayUrl="https://gateway.example/"
  systemId="3"
  input="CUST123"
  (sessionEnded)="onTerminalDone($event)">
</web5250-terminal>
```

## Keyboard focus — the one UX gotcha

Browser iframes do not forward keyboard events until they have focus,
and a cross-origin parent cannot focus elements *inside* the iframe. In
practice: **the user's first click inside the terminal focuses it**, and
from then on all typing, F-keys and the on-screen keypad work normally.
Two patterns that work well:

- Simply let the user click (usually they click the first field anyway).
- Or overlay a transparent "Click to start" layer on the iframe that you
  remove on the first click, so the intent is obvious.

Also make sure nothing in your app steals focus (tooltips, toast
notifications) while the terminal is open.

## Operational notes

- **Prerequisites (ops)**: the gateway needs `AUTO_SIGNON_USER` /
  `AUTO_SIGNON_PASSWORD` set; without them, auto URLs fail fast (the
  iframe shows "Session ended" and the signal arrives with reason
  `closed` almost immediately).
- **Lock down embedding**: set `FRAME_ANCESTORS=https://your-angular-origin`
  on the gateway so only your app may embed it, and always verify
  `event.origin` in your listener.
- **The `input` value is a URL parameter** — it appears in browser
  history and proxy logs. Keep it to non-sensitive identifiers.
- **Several terminals at once** are fine: every iframe gets its own 5250
  device and session.
- **Screen size**: the canvas adapts to the iframe size; 24×80 fits
  roughly 720×450 px at default font, 27×132 screens need more width.
- **Reconnect button**: if a session ends with `error`, the iframe shows
  a small Reconnect button (no menu). Clicking it replays the automated
  sign-on. Your app can also just remove and re-create the component.

## Developing without an IBM i

web5250 ships a mock IBM i host that speaks enough 5250 to exercise the
whole flow:

```bash
git clone <web5250 repo> && cd web5250
npm ci && npm run build

# terminal 1 — mock host (its "initial program screen" is the MAIN menu;
# typing 90 as `input` signs off, which ends the session)
node scripts/mock-host.mjs 8023

# terminal 2 — gateway with auto credentials
IBM_I_HOST=127.0.0.1 IBM_I_PORT=8023 \
AUTO_SIGNON_USER=AUTOBOT AUTO_SIGNON_PASSWORD=SECRETPW \
PORT=8080 node dist/server.js
```

Then point the component at `http://127.0.0.1:8080/` (no `systemId`
needed). If your Angular dev server runs on another port, that is fine —
`parentOrigin` defaults to your dev origin and postMessage works
cross-origin.

End-to-end tests live in the web5250 repo: `npm run test:auto` covers
the happy path, the injected Enter, sign-on rejection, and the
unconfigured-gateway refusal.

## Troubleshooting

| Symptom | Likely cause |
| :--- | :--- |
| Signal arrives immediately with `closed` | Gateway has no `AUTO_SIGNON_*` configured (upgrade refused) |
| Overlay says "Sign-on failed" (`signon-failed`) | IBM i rejected the configured user/password |
| Signal arrives ~30 s after load with `timeout` | Initial program never wrote a screen — check INLPGM on the profile |
| Typing does nothing | Iframe not focused — click inside the terminal first |
| No signal on exit | The program returned to a menu instead of signing off; the AS/400 side must sign off when it exits |
| `input` lands in the wrong place | It is typed at the screen's cursor position (first input field) — pass what that field expects |
