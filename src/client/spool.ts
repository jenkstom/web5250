// Spool viewer: the top-bar Spool button's job list modal. Jobs arrive from
// the gateway's per-system printer sessions (see docs/printer-session.md);
// this side only lists, downloads and prints them - text jobs through a
// print-formatted view (white page, monospace, one page per form feed),
// PDFs through a hidden iframe the browser prints natively. PCL/unknown
// formats are download-only: the browser cannot render them.
export interface SpoolJob {
  token: string;
  systemId: number;
  systemName: string | null;
  device: string;
  mode: 'text' | 'raw';
  format: 'txt' | 'pdf' | 'pcl';
  bytes: number;
  pages: number | null;
  createdAt: number;
}

interface SpoolPrinter {
  systemId: number;
  systemName: string;
  device: string;
  mode: 'text' | 'raw';
  state: 'connecting' | 'ready' | 'error';
  detail?: string;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

/** API base derives from the page path (sub-path deploy tolerant). */
const api = (name: string): string =>
  window.location.origin + window.location.pathname.replace(/[^/]*$/, '') + name;

let pollTimer: number | undefined;
/** One slow poll: refreshes the open modal, otherwise just the badge count. */
const POLL_MS = 15000;

export function spoolVisible(): boolean {
  return !$('spool-modal').classList.contains('hidden');
}

export function initSpool(): void {
  $('btn-spool').addEventListener('click', () => (spoolVisible() ? closeSpool() : openSpool()));
  $('spool-close').addEventListener('click', closeSpool);
  $('spool-refresh').addEventListener('click', () => void refresh());
  $('spool-modal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSpool();
  });
  recheckSpool();
}

/** (Re)decide whether the Spool button belongs in the top bar. */
export function recheckSpool(): void {
  void fetch(api('api/systems'), { headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : { systems: [] }))
    .then((d: { systems?: { printerEnabled?: boolean }[] }) => {
      if ((d.systems ?? []).some((s) => s.printerEnabled)) armBadgePoll();
    })
    .catch(() => {});
}

function armBadgePoll(): void {
  $('btn-spool').classList.remove('hidden');
  void updateBadge();
  pollTimer ??= window.setInterval(() => {
    void (spoolVisible() ? refresh() : updateBadge());
  }, POLL_MS);
}

async function updateBadge(): Promise<void> {
  try {
    const res = await fetch(api('api/printjobs'), { headers: { accept: 'application/json' } });
    if (!res.ok) return;
    const jobs = ((await res.json()) as { jobs: SpoolJob[] }).jobs ?? [];
    const badge = $('spool-count');
    if (jobs.length > 0) {
      badge.textContent = ` ${jobs.length}`;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch {
    /* gateway unreachable - the badge simply stays */
  }
}

function openSpool(): void {
  $('spool-modal').classList.remove('hidden');
  void refresh();
}

export function closeSpool(): void {
  $('spool-modal').classList.add('hidden');
}

async function refresh(): Promise<void> {
  const errEl = $('spool-error');
  try {
    const [jobsRes, printersRes] = await Promise.all([
      fetch(api('api/printjobs'), { headers: { accept: 'application/json' } }),
      fetch(api('api/printer-status'), { headers: { accept: 'application/json' } })
    ]);
    if (!jobsRes.ok) throw new Error(`jobs list failed (${jobsRes.status})`);
    const jobs = ((await jobsRes.json()) as { jobs: SpoolJob[] }).jobs ?? [];
    const printers = printersRes.ok ? (((await printersRes.json()) as { printers: SpoolPrinter[] }).printers ?? []) : [];
    renderPrinters(printers);
    renderJobs(jobs);
    errEl.classList.add('hidden');
  } catch (e) {
    $('spool-list').replaceChildren();
    $('spool-empty').classList.add('hidden');
    errEl.textContent = `Could not load the spool — ${String((e as Error).message ?? e)}`;
    errEl.classList.remove('hidden');
  }
}

function renderPrinters(printers: SpoolPrinter[]): void {
  const el = $('spool-printers');
  el.replaceChildren(
    ...printers.map((p) => {
      const row = document.createElement('div');
      row.className = `spool-printer ${p.state}`;
      const state = document.createElement('b');
      state.textContent =
        p.state === 'ready' ? '●' : p.state === 'error' ? '✗' : '…';
      const label = document.createElement('span');
      const where = p.systemName ? `${p.systemName} · ` : '';
      label.textContent = `${where}${p.device} (${p.mode}) — ${p.state}${p.detail ? `: ${p.detail}` : ''}`;
      row.append(state, label);
      return row;
    })
  );
}

function renderJobs(jobs: SpoolJob[]): void {
  const list = $('spool-list');
  const empty = $('spool-empty');
  list.replaceChildren(
    ...jobs.map((job) => {
      const li = document.createElement('li');
      li.className = 'spool-row';

      const main = document.createElement('span');
      main.className = 'spool-main';
      const time = document.createElement('b');
      time.textContent = new Date(job.createdAt).toLocaleString();
      const sub = document.createElement('small');
      const where = job.systemName ? `${job.systemName} · ` : '';
      const pages = job.pages != null ? ` · ${job.pages} page(s)` : '';
      sub.textContent = `${where}${job.device} · ${fmtBytes(job.bytes)} · ${job.format.toUpperCase()}${pages}`;
      main.append(time, sub);

      const print = document.createElement('button');
      print.type = 'button';
      print.textContent = 'Print';
      print.title = 'Print on a locally connected printer';
      if (job.format === 'pcl') {
        print.disabled = true;
        print.title = 'The browser cannot render PCL — use Download';
      }
      print.addEventListener('click', () => void printJob(job));

      const dl = document.createElement('button');
      dl.type = 'button';
      dl.textContent = 'Download';
      dl.addEventListener('click', () => {
        window.open(api(`api/printjobs/${job.token}`), '_blank', 'noopener');
      });

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'danger';
      rm.textContent = 'Remove';
      rm.title = 'Delete this job from the gateway spool';
      rm.addEventListener('click', () => void removeJob(job, rm));

      li.append(main, print, dl, rm);
      return li;
    })
  );
  if (jobs.length === 0 && $('spool-error').classList.contains('hidden')) {
    empty.textContent =
      'No spool jobs yet.\nPrint something on the host (or move a spool file to\nthe printer device\u2019s output queue) and it appears here.';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
  }
  const badge = $('spool-count');
  if (jobs.length > 0) {
    badge.textContent = ` ${jobs.length}`;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Remove one job from the gateway spool (after a confirm; audited there). */
async function removeJob(job: SpoolJob, btn: HTMLButtonElement): Promise<void> {
  if (!window.confirm('Remove this spool item? It is deleted for everyone viewing the spool.')) return;
  btn.disabled = true;
  try {
    const res = await fetch(api(`api/printjobs/${job.token}`), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(String(res.status));
  } catch {
    btn.disabled = false;
    window.alert('The spool item could not be removed.');
    return;
  }
  void refresh(); // redraws the list and the badge
}

/**
 * Text jobs print via a generated document (white page, monospace, one page
 * per form feed); PDFs print via a hidden iframe pointing at the download -
 * the browser's own PDF viewer renders and prints it.
 */
async function printJob(job: SpoolJob): Promise<void> {
  const frame = $<HTMLIFrameElement>('spool-print-frame');
  if (job.format === 'pdf') {
    frame.onload = () => {
      frame.onload = null;
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    };
    frame.src = api(`api/printjobs/${job.token}`);
    return;
  }
  try {
    const res = await fetch(api(`api/printjobs/${job.token}`));
    const text = await res.text();
    const doc = frame.contentDocument;
    if (!doc) return;
    const pages = text.split('\f');
    const esc = (s: string): string =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    doc.open();
    doc.write(
      '<!doctype html><html><head><title>Spool ' + esc(job.device) + '</title><style>' +
        '@page { size: auto; margin: 12mm; }' +
        'body { margin: 0; background: #fff; color: #000; }' +
        'pre { font: 10pt/1.25 "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace; ' +
        'white-space: pre; margin: 0; }' +
        '.page { page-break-after: always; }' +
        '.page:last-child { page-break-after: auto; }' +
        '</style></head><body>' +
        pages.map((p) => `<pre class="page">${esc(p) || ' '}</pre>`).join('') +
        '</body></html>'
    );
    doc.close();
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
  } catch {
    window.alert('The job could not be loaded for printing.');
  }
}
