// Browser entry point: WebSocket transport + UI glue.
import './styles.css';
import { Terminal, type OiaState } from './term.ts';
import { attachKeyboard, type SendKey } from './keyboard.ts';
import { buildKeypad } from './keypad.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const term = new Terminal($('screen-canvas'));
const mobileInput = $<HTMLInputElement>('mobile-input');

// ---------------------------------------------------------------- transport
function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Derive the WS endpoint from the page URL so sub-path deployments
  // (https://host/as400/ -> service) resolve to .../as400/ws automatically.
  const path = window.location.pathname.replace(/[^/]*$/, '');
  return `${proto}//${window.location.host}${path}ws${window.location.search}`;
}

let ws: WebSocket | null = null;
let lastUrl = wsUrl();

function sendKey(k: string, ch?: string): void {
  if (k === 'char' && ch !== undefined) {
    send({ t: 'key', k: 'char', ch });
    return;
  }
  send({ t: 'key', k });
}

function send(msg: Record<string, unknown>): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect(): void {
  lastUrl = wsUrl();
  const sock = new WebSocket(lastUrl);
  ws = sock;

  sock.addEventListener('open', () => {
    setConnState('connecting');
    hideOverlay();
  });
  sock.addEventListener('message', (ev) => handleMessage(String(ev.data)));
  sock.addEventListener('close', () => {
    if (ws !== sock) return;
    setConnState('closed');
    showOverlay('Disconnected', 'The session ended. Press Reconnect to open a new one.', true);
  });
  sock.addEventListener('error', () => {
    if (ws !== sock) return;
    setConnState('error');
  });
}

// ------------------------------------------------------------------ messages
function handleMessage(data: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }
  switch (msg.t) {
    case 'hello': {
      const parts = [String(msg.devName ?? ''), String(msg.host ?? ''), String(msg.termType ?? '')];
      $('dev-info').textContent = parts.filter(Boolean).join(' · ');
      setConnState('connecting');
      break;
    }
    case 'status': {
      const status = String(msg.status);
      setConnState(status);
      if (status === 'connected') {
        hideOverlay();
      } else if (status === 'error' || status === 'closed') {
        showOverlay(
          status === 'error' ? 'Connection failed' : 'Session ended',
          typeof msg.detail === 'string' ? msg.detail : '',
          true
        );
      } else {
        showOverlay(status === 'negotiating' ? 'Negotiating with host…' : 'Connecting…', '', false);
      }
      break;
    }
    case 'screen': {
      term.resizeGrid(msg.rows as number, msg.cols as number);
      term.applyCells(msg.cells as (number | string)[][]);
      const cur = msg.cursor as number[];
      term.setCursor(cur[0], cur[1]);
      break;
    }
    case 'update': {
      if (Array.isArray(msg.cells)) term.applyCells(msg.cells as (number | string)[][]);
      if (Array.isArray(msg.cursor)) term.setCursor((msg.cursor as number[])[0], (msg.cursor as number[])[1]);
      $('oia-pos').textContent = `${term.cursor[0]},${term.cursor[1]}`;
      if (msg.beep === true) flash();
      break;
    }
    case 'oia': {
      renderOia(msg as unknown as OiaState & { t: string });
      break;
    }
  }
}

// ---------------------------------------------------------------------- OIA
let flashTimer: number | undefined;
function flash(): void {
  const lock = $('oia-lock');
  lock.classList.add('busy');
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => lock.classList.remove('busy'), 220);
  beepAudio();
}

let audioCtx: AudioContext | null = null;
function beepAudio(): void {
  try {
    audioCtx ??= new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.04;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.09);
  } catch {
    /* autoplay policy: silent until first interaction */
  }
}

function renderOia(oia: OiaState): void {
  const lockEl = $('oia-lock');
  const insertEl = $('oia-insert');
  const mwEl = $('oia-mw');
  const msgEl = $('oia-msg');

  const lockText: Record<string, string> = {
    system: 'X SYSTEM',
    ii: 'X II',
    prog: 'X PROG',
    comm: 'X COMM'
  };
  lockEl.textContent = lockText[oia.lock] ?? '';
  lockEl.classList.toggle('busy', oia.lock === 'system' || oia.lock === 'ii');
  insertEl.textContent = oia.insert ? '^' : '';
  mwEl.textContent = oia.messageWait ? 'MW' : '';
  msgEl.textContent = oia.errorCode ? 'Keyboard error - press Reset (Ctrl+R) to continue' : '';
  $('oia-pos').textContent = `${term.cursor[0]},${term.cursor[1]}`;
}

function setConnState(state: string): void {
  const el = $('conn-state');
  el.dataset.state = state;
  el.textContent =
    state === 'connected'
      ? 'connected'
      : state === 'negotiating'
        ? 'negotiating'
        : state === 'connecting'
          ? 'connecting…'
          : state === 'closed'
            ? 'disconnected'
            : 'error';
}

function showOverlay(title: string, detail: string, showAction: boolean): void {
  $('overlay-title').textContent = title;
  $('overlay-detail').textContent = detail;
  $('overlay-action').classList.toggle('hidden', !showAction);
  $('overlay').classList.remove('hidden');
}
function hideOverlay(): void {
  $('overlay').classList.add('hidden');
}

// ---------------------------------------------------------------------- UI
attachKeyboard(sendKey, flash);
buildKeypad(sendKey);

$('overlay-action').addEventListener('click', () => connect());

$('btn-keys').addEventListener('click', () => $('keys-modal').classList.toggle('hidden'));
$('keys-close').addEventListener('click', () => $('keys-modal').classList.add('hidden'));

const keypad = $('keypad');
if (window.matchMedia('(pointer: coarse)').matches) keypad.classList.remove('hidden');
$('btn-keypad').addEventListener('click', () => keypad.classList.toggle('hidden'));

const terminal = $('terminal');
terminal.addEventListener('mousedown', (e) => {
  const rect = termHit(e);
  if (!rect) return;
  send({ t: 'key', k: 'click', r: rect.r, c: rect.c });
  terminal.focus();
});
function termHit(e: MouseEvent): { r: number; c: number } | null {
  const canvas = $('screen-canvas');
  const bounds = canvas.getBoundingClientRect();
  return term.clickToMessage(e.clientX - bounds.left, e.clientY - bounds.top);
}

// Keep focus on the terminal so keyboard events flow; the hidden input is
// what mobile soft keyboards type into.
terminal.addEventListener('focusout', () => {
  term.focused = false;
});
terminal.addEventListener('focusin', () => {
  term.focused = true;
});
mobileInput.addEventListener('input', () => {
  // Soft keyboards deliver whole runs of text here.
  for (const ch of mobileInput.value) sendKey('char', ch);
  mobileInput.value = '';
});
mobileInput.addEventListener('keydown', (e) => {
  // Enter/Backspace from soft keyboards arrive as keydown on the input.
  const mapped = e.key === 'Enter' || e.key === 'Backspace';
  if (mapped) {
    e.preventDefault();
    sendKey(e.key === 'Enter' ? 'enter' : 'backspace');
  }
});

document.addEventListener('click', () => {
  audioCtx?.resume().catch(() => {});
});

connect();
