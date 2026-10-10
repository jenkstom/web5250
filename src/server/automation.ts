// Automated data-entry launches (?auto=1): the gateway signs on with the
// configured assumed-identity account, waits for the user profile's initial
// program to present its screen, types the caller-supplied input string, then
// gets out of the way. The host drops the connection when the user exits the
// program; the gateway's existing teardown handles the rest.
//
// All keystrokes are injected server-side through the normal Tn5250Client
// primitives (the same path browser keys take), so field editing, MDT and
// AID semantics match a human typist exactly.
import * as C from './tn5250/constants.ts';
import type { Tn5250Client } from './tn5250/client.ts';

export interface AutoOptions {
  /** AS/400 user profile (from AUTO_SIGNON_USER — never from the URL). */
  user: string;
  /** Its password (from AUTO_SIGNON_PASSWORD). Never leaves the server. */
  password: string;
  /** String typed into the initial program's screen; absent = just sign on. */
  input?: string;
  /** Press Enter after typing `input` (default true). */
  inputEnter: boolean;
  /** Minimum wait (ms) after the program screen is ready before typing. */
  inputDelayMs: number;
}

export interface AutoHooks {
  /** Terminal outcome of the automation itself (sign-on rejected, timeout). */
  onEnd: (reason: 'signon-failed' | 'timeout', detail: string) => void;
  /** Screen content changed by injected keys (gateway flushes to browser). */
  onChange: () => void;
}

/** Header on QDSIGNON-family screens; still showing after our Enter = rejected. */
const SIGNON_MARKER = 'sign on';
/** How long to wait for each screen (sign-on display, then program screen). */
const SCREEN_TIMEOUT_MS = 30_000;

export class Automation {
  private phase: 'await-signon' | 'await-program' | 'armed' | 'done' = 'await-signon';
  private timer: NodeJS.Timeout | null = null;
  private readyAt = 0;
  private inputPending = false;

  /** True while injected keystrokes may be in flight: browser keys must wait. */
  get suppressUserKeys(): boolean {
    return this.phase === 'await-signon' || this.phase === 'await-program';
  }

  constructor(
    private readonly client: Tn5250Client,
    private readonly opts: AutoOptions,
    private readonly hooks: AutoHooks
  ) {}

  start(): void {
    this.armTimer('sign-on screen');
  }

  /** Called on every parsed host record (gateway chains this before flushing). */
  onScreen(): void {
    if (this.phase === 'done' || this.phase === 'armed') return;
    // Some hosts report a rejected sign-on as WRITE ERROR CODE (X II) rather
    // than redrawing the sign-on screen: clear it so the screen state (and
    // the marker check below) can proceed.
    if (this.client.screen.errorCodeActive) {
      this.client.localKey('reset');
      this.hooks.onChange();
    }
    if (!this.client.screen.canAcceptKeys()) return;

    if (this.phase === 'await-signon') {
      // First read invite: the sign-on display. Type the stored credentials
      // and submit - exactly the sequence a user performs (user, Tab,
      // password, Enter), relying on the cursor homing into the User field.
      this.type(this.opts.user);
      this.client.localKey('tab');
      this.type(this.opts.password);
      this.client.sendAid(C.AID_ENTER);
      this.phase = 'await-program';
      this.armTimer('initial program screen');
      this.hooks.onChange();
      return;
    }

    // await-program: the screen after the sign-on Enter.
    if (this.readyAt === 0) {
      if (this.screenText().includes(SIGNON_MARKER)) {
        this.finish(
          'signon-failed',
          'the host rejected the configured sign-on (screen returned to sign-on)'
        );
        return;
      }
      this.readyAt = Date.now();
      // The program screen arrived: the screen timeout has done its job.
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }

    if (!this.opts.input) {
      this.arm();
      return;
    }
    const elapsed = Date.now() - this.readyAt;
    if (elapsed >= this.opts.inputDelayMs || this.inputPending) this.typeInput();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.typeInput();
      }, this.opts.inputDelayMs - elapsed);
    }
  }

  /** Timer + state cleanup on session teardown; never reports (host already did). */
  destroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.phase = 'done';
  }

  private typeInput(): void {
    // The delay elapsed but the host locked the keyboard again (e.g. it
    // rewrote the screen): retry on the next read invite.
    if (!this.client.screen.canAcceptKeys()) {
      this.inputPending = true;
      return;
    }
    this.inputPending = false;
    this.type(this.opts.input!);
    if (this.opts.inputEnter) this.client.sendAid(C.AID_ENTER);
    this.arm();
    this.hooks.onChange();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.phase = 'armed';
  }

  private finish(reason: 'signon-failed' | 'timeout', detail: string): void {
    this.destroy();
    this.hooks.onEnd(reason, detail);
  }

  private armTimer(what: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.finish('timeout', `no ${what} within ${SCREEN_TIMEOUT_MS / 1000}s`);
    }, SCREEN_TIMEOUT_MS);
  }

  private type(s: string): void {
    for (const ch of s) this.client.localKey('char', ch);
  }

  /** Visible screen text, lowercased, for marker matching. */
  private screenText(): string {
    const s = this.client.screen;
    let out = '';
    for (let r = 0; r < s.rows; r++) {
      out += s.chars.slice(r * s.cols, (r + 1) * s.cols).join('');
      out += '\n';
    }
    return out.toLowerCase();
  }
}
