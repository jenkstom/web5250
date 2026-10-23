// Session history for the signed-in user: their own finished recordings
// (/api/recordings/mine, keyed by the edge identity the gateway stamps on
// every session), each playable in place via a freshly minted replay link.
// Requires TRUSTED_USER_HEADER on the gateway - without an edge identity
// there is no "own" to filter by, and the button stays hidden.
const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const api = (name: string): string =>
  window.location.origin + window.location.pathname.replace(/[^/]*$/, '') + name;

const fmtTime = (ts: number): string => new Date(ts).toLocaleString([], { hour12: false });

const fmtSize = (bytes: number): string =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

interface RecordingRow {
  id: string;
  systemName: string;
  devName: string | null;
  signedOnUser: string | null;
  startedAt: number;
  endedAt: number | null;
  bytes: number;
  frames: number;
}

export function historyVisible(): boolean {
  return !$('history-modal').classList.contains('hidden');
}

export function closeHistory(): void {
  $('history-modal').classList.add('hidden');
}

export async function openHistory(): Promise<void> {
  $('history-modal').classList.remove('hidden');
  const list = $('history-list');
  const err = $('history-error');
  const empty = $('history-empty');
  list.replaceChildren();
  err.classList.add('hidden');
  empty.classList.add('hidden');
  let rows: RecordingRow[] = [];
  try {
    const res = await fetch(api('api/recordings/mine'), { headers: { accept: 'application/json' } });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `request failed (${res.status})`);
    }
    const data = (await res.json()) as { recordings: RecordingRow[] };
    rows = data.recordings ?? [];
  } catch (e) {
    err.textContent = `Could not load your recordings — ${String((e as Error).message ?? e)}`;
    err.classList.remove('hidden');
    return;
  }
  if (rows.length === 0) {
    empty.textContent =
      'No recordings yet. Sessions are recorded when your administrator enables it for a system (a ● REC marker shows while one records).';
    empty.classList.remove('hidden');
    return;
  }
  for (const r of rows) {
    const li = document.createElement('li');
    li.className = 'history-row';
    const main = document.createElement('span');
    main.className = 'nm';
    const b = document.createElement('b');
    b.textContent = `${r.systemName} · ${r.devName ?? 'device'}`;
    const small = document.createElement('small');
    const dur = r.endedAt ? fmtDur(r.endedAt - r.startedAt) : 'live';
    small.textContent =
      `${fmtTime(r.startedAt)} · ${dur} · ${fmtSize(r.bytes)}` +
      (r.signedOnUser ? ` · signed on as ${r.signedOnUser}` : '');
    main.append(b, small);
    const play = document.createElement('button');
    play.type = 'button';
    play.textContent = 'Play';
    play.disabled = !r.endedAt;
    play.title = r.endedAt ? 'Open the replay player' : 'Still recording — wait for the session to end';
    play.addEventListener('click', () => void playRecording(r.id, play));
    li.append(main, play);
    list.append(li);
  }
}

async function playRecording(id: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    const res = await fetch(api('api/replay/mint'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id })
    });
    if (!res.ok) throw new Error(`mint failed (${res.status})`);
    const data = (await res.json()) as { token: string };
    const u = new URL(window.location.href);
    for (const key of [...u.searchParams.keys()]) u.searchParams.delete(key);
    u.searchParams.set('replay', data.token);
    window.open(u.href, '_blank', 'noopener');
    closeHistory();
  } catch (e) {
    window.alert(`Could not open this replay — ${String((e as Error).message ?? e)}`);
  } finally {
    btn.disabled = false;
  }
}

const fmtDur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 3600
    ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    : `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};

export function initHistory(): void {
  $('history-close').addEventListener('click', closeHistory);
  $('history-modal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeHistory();
  });
}
