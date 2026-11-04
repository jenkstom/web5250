// The in-app help system: AS/400-panel-styled hypertext over the app.
//
// openHelp('user' | 'admin') shows one of the manuals from content.ts as a
// green-screen overlay: topic header, prose with highlighted links, key
// tables, and a function-key-style bottom line. Navigation is browser-like:
// links build a history you can walk with Backspace/Alt+Arrow (or the on-bar
// buttons), forward re-walks it, Esc leaves. Tab cycles the links exactly as
// the 5250 help does (arrows/PgUp/PgDn scroll), Enter follows.
//
// While the overlay is open it owns the keyboard: its capture listener runs
// unconditionally and uiSurfaceOpen() (main.ts) keeps host keys out.
import { BOOKS, parseSegments, type HelpBook, type HelpBlock, type HelpPage } from './content.ts';

let modal: HTMLDivElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let backBtn: HTMLButtonElement | null = null;
let fwdBtn: HTMLButtonElement | null = null;

let book: HelpBook = BOOKS.user;
let current = BOOKS.user.home;
const back: string[] = [];
const fwd: string[] = [];
let links: HTMLAnchorElement[] = [];
let linkIdx = -1;

export function helpVisible(): boolean {
  return modal !== null && !modal.classList.contains('hidden');
}

/** Open one of the manuals (fresh history), optionally on a specific page. */
export function openHelp(which: 'user' | 'admin', pageId?: string): void {
  build();
  book = BOOKS[which];
  back.length = 0;
  fwd.length = 0;
  modal!.classList.remove('hidden');
  navigate(pageId ?? book.home, false);
}

export function closeHelp(): void {
  if (!modal) return;
  modal.classList.add('hidden');
}

// ------------------------------------------------------------------ engine
function pageOf(id: string): HelpPage | null {
  return book.pages.find((pg) => pg.id === id) ?? null;
}

function navigate(id: string, push = true): void {
  const page = pageOf(id);
  if (!page) return;
  if (push) {
    back.push(current);
    fwd.length = 0;
  }
  current = id;
  render();
}

function goBack(): void {
  const prev = back.pop();
  if (prev === undefined) return;
  fwd.push(current);
  current = prev;
  render();
}

function goForward(): void {
  const next = fwd.pop();
  if (next === undefined) return;
  back.push(current);
  current = next;
  render();
}

// ---------------------------------------------------------------- rendering
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** One paragraph-ish container with inline links from {{label|page}} markup. */
function rich(parent: HTMLElement, text: string): void {
  for (const seg of parseSegments(text)) {
    if ('to' in seg) {
      const a = el('a', 'hlink', seg.text);
      a.href = '#';
      a.dataset.to = seg.to;
      parent.appendChild(a);
    } else if (seg.text) {
      parent.appendChild(document.createTextNode(seg.text));
    }
  }
}

function render(): void {
  const page = pageOf(current);
  if (!page || !bodyEl) return;
  bodyEl.replaceChildren();

  // Panel header, the way the 5494 draws one: topic top-left, HELP top-right.
  const head = el('div', 'help-topicbar');
  head.append(el('span', 'help-topicname', book.name), el('span', 'help-topichelp', 'HELP'));
  bodyEl.append(head, el('div', 'help-rule'));

  const title = el('div', 'help-title', page.title);
  bodyEl.append(title);
  if (page.subtitle) bodyEl.append(el('div', 'help-subtitle', page.subtitle));
  bodyEl.append(el('div', 'help-rule', '─'.repeat(72)));

  for (const b of page.blocks) {
    if (b.t === 'h') {
      bodyEl.append(el('div', 'help-h', b.text));
    } else if (b.t === 'p') {
      const p = el('p', 'help-p');
      rich(p, b.text);
      bodyEl.append(p);
    } else if (b.t === 'ul') {
      const list = el('ul', 'help-ul');
      for (const item of b.items) {
        const li = el('li');
        rich(li, item);
        list.append(li);
      }
      bodyEl.append(list);
    } else if (b.t === 'pre') {
      bodyEl.append(el('pre', 'help-pre', b.text));
    } else if (b.t === 'keys') {
      const table = el('div', 'help-keys');
      for (const [k, d] of b.rows) {
        const row = el('div', 'help-keys-row');
        row.append(el('span', 'help-key', k));
        const desc = el('span', 'help-desc');
        rich(desc, d);
        row.append(desc);
        table.append(row);
      }
      bodyEl.append(table);
    }
  }

  // Related-pages footer: the book's index of every page but the current one.
  bodyEl.append(el('div', 'help-rule', '─'.repeat(72)));
  const idx = el('p', 'help-p help-indexline');
  const label = document.createTextNode('Topics: ');
  idx.appendChild(label);
  let first = true;
  for (const pg of book.pages) {
    if (pg.id === current) continue;
    if (!first) idx.appendChild(document.createTextNode(' · '));
    first = false;
    const a = el('a', 'hlink', pg.title);
    a.href = '#';
    a.dataset.to = pg.id;
    idx.appendChild(a);
  }
  bodyEl.append(idx);

  // Collect links fresh and clear the focus cursor.
  links = [...bodyEl.querySelectorAll('a.hlink')] as HTMLAnchorElement[];
  setLinkFocus(-1);
  bodyEl.scrollTop = 0;
  updateChrome();
}

function setLinkFocus(i: number): void {
  linkIdx = i;
  links.forEach((a, n) => a.classList.toggle('focused', n === i));
  if (i >= 0 && links[i]) {
    links[i].focus({ preventScroll: true });
    links[i].scrollIntoView({ block: 'nearest' });
  }
}

function updateChrome(): void {
  if (!backBtn || !fwdBtn) return;
  backBtn.disabled = back.length === 0;
  backBtn.textContent = `Back${back.length > 0 ? ` (${back.length})` : ''}`;
  fwdBtn.disabled = fwd.length === 0;
  fwdBtn.textContent = `Fwd${fwd.length > 0 ? ` (${fwd.length})` : ''}`;
}

// ------------------------------------------------------------------ the DOM
function build(): void {
  if (modal) return;

  modal = el('div', 'hidden');
  modal.id = 'help-modal';
  const card = el('div', 'help-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Help');
  card.tabIndex = -1;

  const bar = el('div', 'help-bar');
  bar.append(
    el('span', 'help-bar-title', 'HELP'),
    el('span', 'help-bar-spacer')
  );
  const mk = (label: string, tip: string, fn: () => void): HTMLButtonElement => {
    const b = el('button', 'help-navbtn', label);
    b.type = 'button';
    b.title = tip;
    b.addEventListener('click', fn);
    return b;
  };
  backBtn = mk('Back', 'Previous page (Backspace, Alt+Left)', goBack);
  fwdBtn = mk('Fwd', 'Forward again (Alt+Right)', goForward);
  bar.append(
    backBtn,
    fwdBtn,
    mk('Index', 'The manual\'s first page', () => navigate(book.home)),
    mk('Close', 'Leave help (Esc)', closeHelp)
  );

  bodyEl = el('div', 'help-body');

  const foot = el('div', 'help-foot');
  foot.append(
    el('span', undefined, 'Tab=Next link'),
    el('span', undefined, 'Enter=Select'),
    el('span', undefined, 'Backspc=Back'),
    el('span', undefined, '↑↓=Scroll'),
    el('span', 'help-bar-spacer'),
    el('span', undefined, 'Esc=Exit')
  );

  card.append(bar, bodyEl, foot);
  modal.append(card);
  document.getElementById('app')?.append(modal);

  // Link clicks (mouse and touch): the anchor's default is suppressed.
  bodyEl.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a.hlink') as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    navigate(a.dataset.to ?? book.home);
  });

  // The overlay owns the keyboard while visible. Capture phase, always
  // registered first (module import) so it sees keys before anything else;
  // consumed keys never reach the terminal (uiSurfaceOpen gates that too).
  window.addEventListener(
    'keydown',
    (e) => {
      if (!helpVisible()) return;
      handleKey(e);
    },
    { capture: true }
  );
}

function handleKey(e: KeyboardEvent): void {
  const consume = (): void => {
    e.preventDefault();
    e.stopPropagation();
  };
  const typingTarget =
    e.target instanceof HTMLElement &&
    (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');

  if (e.key === 'Escape') {
    consume();
    closeHelp();
    return;
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowLeft') {
    consume();
    goBack();
    return;
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowRight') {
    consume();
    goForward();
    return;
  }
  if (e.key === 'Tab' && !typingTarget) {
    consume();
    if (links.length === 0) return;
    const dir = e.shiftKey ? -1 : 1;
    // From "no link focused", backwards starts at the last link.
    const from = linkIdx === -1 && dir === -1 ? links.length : linkIdx;
    setLinkFocus((from + dir + links.length) % links.length);
    return;
  }
  if (e.key === 'Enter' && !typingTarget) {
    if (linkIdx >= 0 && links[linkIdx]) {
      consume();
      navigate(links[linkIdx].dataset.to ?? book.home);
    }
    return;
  }
  if (e.key === 'Backspace' && !typingTarget && !e.ctrlKey && !e.altKey && !e.metaKey) {
    consume();
    goBack();
    return;
  }
  if (!modal) return;
  const body = modal.querySelector<HTMLElement>('.help-body');
  if (!body) return;
  const line = 28; // px, roughly one text row
  switch (e.key) {
    case 'ArrowDown':
      consume();
      body.scrollTop += line;
      break;
    case 'ArrowUp':
      consume();
      body.scrollTop -= line;
      break;
    case 'PageDown':
    case ' ':
      consume();
      body.scrollTop += body.clientHeight * 0.85;
      break;
    case 'PageUp':
      consume();
      body.scrollTop -= body.clientHeight * 0.85;
      break;
    case 'Home':
      consume();
      body.scrollTop = 0;
      break;
    case 'End':
      consume();
      body.scrollTop = body.scrollHeight;
      break;
    default:
      break;
  }
}
