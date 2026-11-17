// IBM .kmp keyboard files (the "Keyboard Remap" export of Personal
// Communications and IBM i Access Client Solutions), translated to and from
// the gateway's canonical key binding overlay. The format is plain INI: one
// [KeyRemap] section of lines like "B112=[pf1]" — a modifier prefix (B base,
// S shift, C ctrl, A alt) plus a virtual key code on the left, a bracketed
// host-function mnemonic, a "|<codepoint>" character insert, or another key
// code on the right. ACS is a Java app, so the key codes are Java AWT VK
// codes, sometimes with location bits packed above 0x1000000 (numpad variants
// arrive as 0x2000000 + vk). Entries the emulator cannot express are skipped,
// not guessed at, and reported back so the admin sees what did not translate.
import type { KeyBinding } from './keymaps.ts';

/** Modifier prefixes seen in [KeyRemap] entries. */
const PREFIXES: Record<string, { shift: boolean; ctrl: boolean; alt: boolean }> = {
  B: { shift: false, ctrl: false, alt: false },
  S: { shift: true, ctrl: false, alt: false },
  C: { shift: false, ctrl: true, alt: false },
  A: { shift: false, ctrl: false, alt: true }
};

/** Java/Windows virtual key codes -> browser KeyboardEvent.code names.
 *  Modifier keys themselves (Shift/Ctrl/Alt lock) are deliberately absent:
 *  they are the state, not bindable targets. */
const VK_TO_CODE: Record<number, string> = {
  8: 'Backspace',
  9: 'Tab',
  10: 'Enter',
  27: 'Escape',
  32: 'Space',
  33: 'PageUp',
  34: 'PageDown',
  35: 'End',
  36: 'Home',
  37: 'ArrowLeft',
  38: 'ArrowUp',
  39: 'ArrowRight',
  40: 'ArrowDown',
  44: 'Comma',
  45: 'Minus',
  46: 'Period',
  47: 'Slash',
  48: 'Digit0', 49: 'Digit1', 50: 'Digit2', 51: 'Digit3', 52: 'Digit4',
  53: 'Digit5', 54: 'Digit6', 55: 'Digit7', 56: 'Digit8', 57: 'Digit9',
  59: 'Semicolon',
  61: 'Equal',
  65: 'KeyA', 66: 'KeyB', 67: 'KeyC', 68: 'KeyD', 69: 'KeyE', 70: 'KeyF',
  71: 'KeyG', 72: 'KeyH', 73: 'KeyI', 74: 'KeyJ', 75: 'KeyK', 76: 'KeyL',
  77: 'KeyM', 78: 'KeyN', 79: 'KeyO', 80: 'KeyP', 81: 'KeyQ', 82: 'KeyR',
  83: 'KeyS', 84: 'KeyT', 85: 'KeyU', 86: 'KeyV', 87: 'KeyW', 88: 'KeyX',
  89: 'KeyY', 90: 'KeyZ',
  91: 'BracketLeft',
  92: 'Backslash',
  93: 'BracketRight',
  96: 'Numpad0', 97: 'Numpad1', 98: 'Numpad2', 99: 'Numpad3', 100: 'Numpad4',
  101: 'Numpad5', 102: 'Numpad6', 103: 'Numpad7', 104: 'Numpad8', 105: 'Numpad9',
  106: 'NumpadMultiply',
  107: 'NumpadAdd',
  109: 'NumpadSubtract',
  110: 'NumpadDecimal',
  111: 'NumpadDivide',
  112: 'F1', 113: 'F2', 114: 'F3', 115: 'F4', 116: 'F5', 117: 'F6',
  118: 'F7', 119: 'F8', 120: 'F9', 121: 'F10', 122: 'F11', 123: 'F12',
  // F13-F24: Java VK codes (ACS is a Java app - the .kmp producer we target).
  // The Windows VK range for them collides with VK_DELETE (127), and the
  // sample files pin the numbering to Java's, so only that range is accepted.
  240: 'F13', 241: 'F14', 242: 'F15', 243: 'F16', 244: 'F17', 245: 'F18',
  246: 'F19', 247: 'F20', 248: 'F21', 249: 'F22', 250: 'F23', 251: 'F24',
  127: 'Delete',
  155: 'Insert',
  192: 'Backquote',
  222: 'Quote'
};

/** PCOMM/ACS host-function mnemonics -> gateway logical key names. Anything
 *  outside this table has no equivalent in the emulator's vocabulary. */
const MNEMONICS: Record<string, string> = {
  enter: 'enter',
  clear: 'clear',
  tab: 'tab',
  backtab: 'btab',
  fldext: 'fieldexit',
  fieldexit: 'fieldexit',
  'field+': 'fieldplus',
  'field-': 'fieldminus',
  backspace: 'backspace',
  bsdelete: 'bsdelete',
  destructivebackspace: 'bsdelete',
  destbackspace: 'bsdelete',
  delete: 'delete',
  del: 'delete',
  insert: 'insert',
  ins: 'insert',
  sysreq: 'sysreq',
  attn: 'attn',
  reset: 'reset',
  help: 'help',
  print: 'print',
  printhost: 'print',
  hostprint: 'print',
  pageup: 'rollup',
  rollup: 'rollup',
  pagedn: 'rolldown',
  pagedown: 'rolldown',
  rolldown: 'rolldown',
  up: 'up',
  arrowup: 'up',
  down: 'down',
  arrowdown: 'down',
  left: 'left',
  arrowleft: 'left',
  right: 'right',
  arrowright: 'right',
  home: 'home',
  end: 'end'
};
// PF keys are regular: [pf1]..[pf24] need no table entries.
const PF_RE = /^pf([1-9]|1[0-9]|2[0-4])$/;

/** [KeyRemap] metadata that describes the file, not a binding. */
const META_KEYS = new Set(['keyVersion', 'codePage', 'sessionType', 'autoApply']);

const locOf = (vk: number): number => Math.floor(vk / 0x1000000);

/** A VK code (possibly with location bits) to a browser code name. */
function vkToCode(raw: number): string | null {
  const loc = locOf(raw);
  const vk = raw % 0x1000000;
  const code = VK_TO_CODE[vk];
  if (!code) return null;
  // Location >= 2 marks the numeric keypad in ACS exports; fold it onto the
  // Numpad sibling when one exists (Enter, digits, operators).
  if (loc >= 2 && code === 'Enter') return 'NumpadEnter';
  if (loc >= 2 && /^Digit\d$/.test(code)) return code.replace('Digit', 'Numpad');
  return code;
}

/** Browser code name back to a plain VK code (numpad variants encoded with
 *  ACS's 0x2000000 location bits so a round-trip keeps them separate). */
function codeToVk(code: string): number | null {
  const numpad = code.startsWith('Numpad');
  const plain = numpad ? code.replace('Numpad', '') : code;
  let vk: number | null = null;
  if (numpad && plain === 'Enter') vk = 10;
  else if (numpad && /^Multiply|Add|Subtract|Decimal|Divide$/.test(plain)) {
    const ops: Record<string, number> = {
      Multiply: 106, Add: 107, Subtract: 109, Decimal: 110, Divide: 111
    };
    vk = ops[plain] ?? null;
  } else if (numpad && /^\d$/.test(plain)) vk = 96 + Number(plain);
  if (vk !== null) return 0x2000000 + vk;
  for (const [k, v] of Object.entries(VK_TO_CODE)) {
    if (v === code) return Number(k);
  }
  return null;
}

export interface KmpParseResult {
  ok: true;
  bindings: KeyBinding[];
  /** Human-readable notes for entries that could not be translated. */
  skipped: string[];
}

export type KmpResult = KmpParseResult | { ok: false; error: string };

/** Parse the text of a .kmp file into overlay bindings. */
export function parseKmp(text: string): KmpResult {
  const bindings: KeyBinding[] = [];
  const skipped: string[] = [];
  let inSection = false;
  let sawSection = false;
  // Later lines win, as in PCOMM (a re-mapped key keeps only its last entry).
  const bySlot = new Map<string, KeyBinding>();

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      sawSection = true;
      inSection = line.replace(/\].*$/, ']').toLowerCase() === '[keyremap]';
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const left = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (META_KEYS.has(left)) continue;
    // XF:/XM: pairs are display/mouse metadata, never key bindings.
    if (left.includes(':')) continue;

    const m = /^([A-Z])(\d+)$/.exec(left);
    if (!m) {
      skipped.push(`${left}=… (not a key entry)`);
      continue;
    }
    const mods = PREFIXES[m[1]];
    if (!mods) {
      skipped.push(`${left}=… (unknown modifier "${m[1]}")`);
      continue;
    }
    const code = vkToCode(Number(m[2]));
    if (!code) {
      skipped.push(`${left}=… (no equivalent key on this keyboard)`);
      continue;
    }

    let binding: KeyBinding | null = null;
    if (value.startsWith('[') && value.endsWith(']')) {
      if (value.includes(',')) {
        skipped.push(`${left}=${value} (key macros are not supported)`);
        continue;
      }
      const mnemonic = value.slice(1, -1).toLowerCase();
      const action = PF_RE.test(mnemonic)
        ? mnemonic
        : MNEMONICS[mnemonic];
      if (!action) {
        skipped.push(`${left}=${value} (no equivalent 5250 function)`);
        continue;
      }
      binding = { code, ...mods, action };
    } else if (/^\|\d+$/.test(value)) {
      const cp = Number(value.slice(1));
      const okCp = cp >= 32 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
      if (!okCp) {
        skipped.push(`${left}=${value} (not a printable character)`);
        continue;
      }
      const ch = String.fromCodePoint(cp);
      binding = { code, ...mods, action: 'char', ch };
    } else {
      skipped.push(`${left}=${value} (key-to-key translation is not supported)`);
      continue;
    }
    bySlot.set(`${code}|${mods.shift ? 1 : 0}${mods.ctrl ? 1 : 0}${mods.alt ? 1 : 0}`, binding);
  }

  if (!sawSection) return { ok: false, error: 'Not a keyboard file: no [KeyRemap] section' };
  bindings.push(...bySlot.values());
  return { ok: true, bindings, skipped };
}

/** Serialize overlay bindings back into a .kmp document (CRLF, metadata
 *  included), so downloads open in ACS / Personal Communications. */
export function serializeKmp(bindings: KeyBinding[]): string {
  const lines: string[] = ['[KeyRemap]', 'keyVersion=2', 'codePage=037', 'sessionType=2', 'autoApply=false'];
  // A .kmp state prefix names exactly one modifier; plain entries are "B".
  // Multi-modifier bindings and explicit unbinds have no .kmp representation
  // ("browser" falls through by simply not being written down).
  const prefixOf = (b: KeyBinding): string | null => {
    const n = (b.shift ? 1 : 0) + (b.ctrl ? 1 : 0) + (b.alt ? 1 : 0);
    if (n === 0) return 'B';
    if (n > 1) return null;
    return b.shift ? 'S' : b.ctrl ? 'C' : 'A';
  };
  const rank: Record<string, number> = { B: 0, S: 1, C: 2, A: 3 };
  const entries: { vk: number; prefix: string; b: KeyBinding }[] = [];
  for (const b of bindings) {
    if (b.action === 'browser') continue;
    const prefix = prefixOf(b);
    const vk = prefix === null ? null : codeToVk(b.code);
    if (prefix === null || vk === null) continue;
    entries.push({ vk, prefix, b });
  }
  entries.sort((x, y) => x.vk - y.vk || rank[x.prefix] - rank[y.prefix]);
  for (const { vk, prefix, b } of entries) {
    const value =
      b.action === 'char'
        ? `|${b.ch!.codePointAt(0)}`
        : `[${b.action}]`;
    lines.push(`${prefix}${vk}=${value}`);
  }
  lines.push(''); // trailing CRLF, like ACS writes it
  return lines.join('\r\n');
}
