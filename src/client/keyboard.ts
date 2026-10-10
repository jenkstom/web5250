// 5250 keyboard mapping. Intercepts and suppresses browser defaults
// (F1 help, F3 find, F5 reload, Tab focus moves, backspace navigation...)
// exactly as a thick-client emulator would.
export type SendKey = (k: string, ch?: string) => void;

const isTypingTarget = (e: EventTarget | null): boolean => {
  const el = e as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
};

/** Maps a KeyboardEvent to a gateway key name, or null to let the browser win. */
export function mapEvent(e: KeyboardEvent): { k: string; ch?: string } | null {
  const code = e.code;
  const key = e.key;

  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    if (code === 'KeyR') return { k: 'reset' };
    if (key === 'Enter') return { k: 'fieldexit' };
    return null;
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    if (code === 'KeyR') return { k: 'reset' };
    if (code === 'KeyH') return { k: 'help' };
    if (code === 'KeyP') return { k: 'print' };
    return null;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return null;

  switch (key) {
    case 'Enter':
      return { k: 'enter' };
    case 'Tab':
      return { k: e.shiftKey ? 'btab' : 'tab' };
    case 'Backspace':
      return { k: 'backspace' };
    case 'Delete':
      return { k: 'delete' };
    case 'Insert':
      return { k: 'insert' };
    case 'Escape':
      return { k: e.shiftKey ? 'attn' : 'sysreq' };
    case 'ArrowUp':
      return { k: 'up' };
    case 'ArrowDown':
      return { k: 'down' };
    case 'ArrowLeft':
      return { k: 'left' };
    case 'ArrowRight':
      return { k: 'right' };
    case 'Home':
      return { k: 'home' };
    case 'End':
      return { k: 'end' };
    // 5250 roll keys: PageDown pages FORWARD (Roll Up, AID F4), PageUp pages
    // BACK (Roll Down, AID F5) - the names are about the screen rolling, not
    // the paging direction.
    case 'PageUp':
      return { k: 'rolldown' };
    case 'PageDown':
      return { k: 'rollup' };
  }

  if (code === 'NumpadAdd' && !e.shiftKey) return { k: 'fieldexit' };
  if (code === 'NumpadSubtract') return { k: 'fieldminus' };
  if (code === 'NumpadEnter') return { k: 'enter' };

  // Function keys F1-F24 (physical codes). Shift+F1..F12 become PF13-PF24.
  const fnMatch = /^F(\d{1,2})$/.exec(code);
  if (fnMatch) {
    let n = Number.parseInt(fnMatch[1], 10);
    if (n >= 1 && n <= 24) {
      if (e.shiftKey && n <= 12) n += 12;
      return { k: `pf${n}` };
    }
  }
  if (/^F\d{1,2}$/.test(key)) {
    const n = Number.parseInt(key.slice(1), 10);
    if (n >= 1 && n <= 24) {
      if (e.shiftKey && n <= 12) {
        return { k: `pf${n + 12}` };
      }
      return { k: `pf${n}` };
    }
  }

  // Printable single characters (incl. space).
  if (key.length === 1) return { k: 'char', ch: key };
  return null;
}

export function attachKeyboard(send: SendKey, enabled?: () => boolean): void {
  const active = (): boolean => (enabled ? enabled() : true);
  window.addEventListener(
    'keydown',
    (e) => {
      if (!active() || isTypingTarget(e.target)) return;
      const mapped = mapEvent(e);
      if (!mapped) return;
      e.preventDefault();
      e.stopPropagation();
      send(mapped.k, mapped.ch);
    },
    { capture: true }
  );
  // Keep Tab/F-keys from doing anything on keyup after we ate the keydown.
  window.addEventListener('keyup', (e) => {
    if (!active() || isTypingTarget(e.target)) return;
    if (mapEvent(e)) e.preventDefault();
  });
}
