// Replay player (?replay=<token>): renders a finished session recording in
// the same canvas terminal a live session uses, fed from recorded frames
// instead of a WebSocket. The frame types are the wire protocol's own
// ('screen', 'update', 'oia', plus lifecycle events), which is the point: a
// replay contains exactly what a view-only mirror would have seen.
//
// Seeking lands on the latest 'screen' snapshot at or before the target
// frame (snapshots happen on every structure change, i.e. roughly every
// host screen) and fast-applies forward from there.
import { Terminal } from './term.ts';

interface Frame {
  ts: number;
  t: string;
  [k: string]: unknown;
}

const api = (name: string): string =>
  window.location.origin + window.location.pathname.replace(/[^/]*$/, '') + name;

const fmtClock = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour12: false });
const fmtDur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 3600
    ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    : `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export class ReplayPlayer {
  private readonly el: HTMLDivElement;
  private readonly term: Terminal;
  private frames: Frame[] = [];
  private snapshots: number[] = []; // frame indexes seekable to
  private pos = 0;
  private playing = false;
  private speed = 1;
  private timer: number | undefined;

  private readonly scrub: HTMLInputElement;
  private readonly timeEl: HTMLSpanElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly speedSel: HTMLSelectElement;
  private readonly lane: HTMLDivElement;
  private readonly oiaText: HTMLSpanElement;

  constructor(container: HTMLElement, token: string) {
    this.el = document.createElement('div');
    this.el.className = 'pane player-pane';
    const bar = document.createElement('div');
    bar.className = 'pane-bar';
    const label = document.createElement('span');
    label.className = 'pane-label';
    label.textContent = 'Session replay';
    bar.append(label);

    const screenEl = document.createElement('div');
    screenEl.className = 'pane-screen';
    const canvas = document.createElement('canvas');
    canvas.className = 'screen-canvas';
    screenEl.append(canvas);

    const oia = document.createElement('div');
    oia.className = 'oia';
    this.oiaText = document.createElement('span');
    this.oiaText.className = 'oia-msg';
    const pos = document.createElement('span');
    pos.className = 'oia-pos';
    oia.append(this.oiaText, pos);

    const controls = document.createElement('div');
    controls.className = 'player-bar';
    this.playBtn = document.createElement('button');
    this.playBtn.type = 'button';
    this.playBtn.className = 'primary';
    this.playBtn.textContent = '▶ Play';
    this.playBtn.addEventListener('click', () => this.togglePlay());
    this.speedSel = document.createElement('select');
    for (const s of [1, 2, 4, 8, 16]) {
      this.speedSel.add(new Option(`${s}×`, String(s)));
    }
    this.speedSel.addEventListener('change', () => {
      this.speed = Number(this.speedSel.value) || 1;
      if (this.playing) this.schedule();
    });
    this.scrub = document.createElement('input');
    this.scrub.type = 'range';
    this.scrub.min = '0';
    this.scrub.value = '0';
    this.scrub.addEventListener('input', () => this.seekTo(Number(this.scrub.value)));
    this.timeEl = document.createElement('span');
    this.timeEl.className = 'player-time';
    controls.append(this.playBtn, this.speedSel, this.scrub, this.timeEl);

    this.lane = document.createElement('div');
    this.lane.className = 'player-lane';

    this.el.append(bar, screenEl, oia, controls, this.lane);
    container.append(this.el);
    this.term = new Terminal(canvas);
    this.term.resizeGrid(24, 80);

    const fit = (): void => {
      const availW = this.el.clientWidth - 2;
      const availH = screenEl.clientHeight - 2;
      if (availW > 0 && availH > 0) this.term.fit(availW, availH);
    };
    new ResizeObserver(fit).observe(screenEl);
    document.fonts?.ready.then(fit);

    void this.load(token);
  }

  private async load(token: string): Promise<void> {
    let doc: { recording?: { startedAt?: number; devName?: string | null; systemName?: string }; frames?: string };
    try {
      const res = await fetch(api(`api/replay/${token}`), { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`replay fetch failed (${res.status})`);
      doc = (await res.json()) as typeof doc;
    } catch (e) {
      this.lane.textContent = `Could not load this replay — ${String((e as Error).message ?? e)}`;
      return;
    }
    const rec = doc.recording ?? {};
    const label = this.el.querySelector('.pane-label');
    if (label) {
      label.textContent = `Replay · ${rec.systemName ?? ''} ${rec.devName ?? ''} · ${rec.startedAt ? fmtClock(rec.startedAt) : ''}`;
    }
    this.frames = [];
    for (const line of String(doc.frames ?? '').split('\n')) {
      if (!line.trim()) continue;
      try {
        this.frames.push(JSON.parse(line) as Frame);
      } catch {
        break; // truncated tail after a crash: keep what parsed
      }
    }
    this.snapshots = this.frames
      .map((f, i) => (f.t === 'screen' ? i : -1))
      .filter((i) => i >= 0);
    this.scrub.max = String(Math.max(0, this.frames.length - 1));
    if (this.frames.length > 0) this.applyFrame(this.frames[0], 0);
    this.syncChrome();
    // Start paused on the first frame: replay is a document, not a stream.
  }

  // ------------------------------------------------------------ playback
  private togglePlay(): void {
    this.playing = !this.playing;
    if (this.playing && this.pos >= this.frames.length - 1) this.seekTo(0);
    this.playBtn.textContent = this.playing ? '❚❚ Pause' : '▶ Play';
    if (this.playing) this.schedule();
    else window.clearTimeout(this.timer);
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    if (!this.playing) return;
    const cur = this.frames[this.pos];
    const next = this.frames[this.pos + 1];
    if (!next) {
      this.playing = false;
      this.playBtn.textContent = '▶ Play';
      return;
    }
    // Wall-clock pacing between frames, compressed by the speed factor and
    // capped so a long idle gap does not stall the player for minutes.
    const gap = Math.min(2000, Math.max(8, (next.ts - cur.ts) / this.speed));
    this.timer = window.setTimeout(() => {
      this.pos++;
      this.applyFrame(this.frames[this.pos], this.pos);
      this.syncChrome();
      this.schedule();
    }, gap);
  }

  /** Jump to a frame index: nearest snapshot, then fast-apply forward. */
  private seekTo(index: number): void {
    window.clearTimeout(this.timer);
    const target = Math.max(0, Math.min(index, this.frames.length - 1));
    let start = 0;
    for (const s of this.snapshots) {
      if (s <= target) start = s;
      else break;
    }
    for (let i = start; i <= target; i++) this.applyFrame(this.frames[i], i, true);
    this.pos = target;
    this.syncChrome();
    if (this.playing) this.schedule();
  }

  private syncChrome(): void {
    this.scrub.value = String(this.pos);
    const first = this.frames[0];
    const cur = this.frames[this.pos];
    const last = this.frames[this.frames.length - 1];
    if (!first || !cur || !last) {
      this.timeEl.textContent = '';
      return;
    }
    const elapsed = cur.ts - first.ts;
    const total = last.ts - first.ts;
    this.timeEl.textContent = `${fmtClock(cur.ts)} · +${fmtDur(elapsed)} / ${fmtDur(total)}`;
  }

  // ------------------------------------------------------------- rendering
  private applyFrame(f: Frame, index: number, seeking = false): void {
    switch (f.t) {
      case 'screen': {
        this.term.resizeGrid(Number(f.rows) || 24, Number(f.cols) || 80);
        this.term.applyCells(f.cells as (number | string)[][]);
        if (Array.isArray(f.fields)) this.term.setFields(f.fields as number[][]);
        const cur = f.cursor as number[] | undefined;
        if (cur) this.term.setCursor(cur[0], cur[1]);
        break;
      }
      case 'update': {
        if (Array.isArray(f.cells)) this.term.applyCells(f.cells as (number | string)[][]);
        const cur = f.cursor as number[] | undefined;
        if (cur) this.term.setCursor(cur[0], cur[1]);
        break;
      }
      case 'oia': {
        const bits = [
          f.lock === 'system' ? 'X SYSTEM' : f.lock === 'ii' ? 'X II' : f.lock === 'prog' ? 'X PROG' : '',
          f.insert ? '^' : '',
          f.messageWait ? 'MW' : ''
        ].filter(Boolean);
        this.oiaText.textContent = bits.join('  ');
        break;
      }
      case 'key': {
        this.addLane(index, `${fmtClock(f.ts)} · ${String(f.k)}${f.by ? ` · by ${f.by}` : ''}`, 'key');
        break;
      }
      case 'notice': {
        this.addLane(index, `${fmtClock(f.ts)} · ${String(f.message)}`, String(f.level));
        break;
      }
      case 'ctrl': {
        const holder = f.holder ? String(f.holder) : null;
        this.addLane(
          index,
          `${fmtClock(f.ts)} · assist: ${holder ? `${holder} got control` : `control ended (${String(f.reason)})`}`,
          'assist'
        );
        break;
      }
      case 'status': {
        this.addLane(index, `${fmtClock(f.ts)} · status: ${String(f.status)}`, 'status');
        break;
      }
      case 'recstate': {
        this.addLane(index, `${fmtClock(f.ts)} · recording ${f.paused ? 'paused' : 'resumed'}`, 'status');
        break;
      }
      default:
        break;
    }
    void seeking;
  }

  /** Append a clickable event to the lane (seeks to that frame). */
  private addLane(index: number, text: string, cls: string): void {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `player-lane-row ${cls}`;
    row.textContent = text;
    row.addEventListener('click', () => this.seekTo(index));
    this.lane.append(row);
    this.lane.scrollTop = this.lane.scrollHeight;
    // The lane is an index of the session, not an unbounded log: trim from
    // the top once it dwarfs the screen.
    while (this.lane.children.length > 400) this.lane.firstElementChild?.remove();
  }
}

/** Boot hook for main.ts: ?replay=<token> renders a player, not a session. */
export function initPlayer(container: HTMLElement, token: string): ReplayPlayer {
  return new ReplayPlayer(container, token);
}
