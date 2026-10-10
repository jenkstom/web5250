// On-screen keypad - essential on touch devices, handy with the mouse.
import type { SendKey } from './keyboard.ts';

interface PadKey {
  label: string;
  k: string;
  ch?: string;
  title?: string;
}

export function buildKeypad(send: SendKey): void {
  const fn1 = document.getElementById('kp-fn1')!;
  const fn2 = document.getElementById('kp-fn2')!;
  const edit = document.getElementById('kp-edit')!;

  const mk = (row: HTMLElement, key: PadKey): void => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = key.label;
    if (key.title) btn.title = key.title;
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      send(key.k, key.ch);
    });
    row.appendChild(btn);
  };

  for (let i = 1; i <= 6; i++) mk(fn1, { label: `F${i}`, k: `pf${i}`, title: `PF${i}` });
  for (let i = 7; i <= 12; i++) mk(fn2, { label: `F${i}`, k: `pf${i}`, title: `PF${i}` });

  const editKeys: PadKey[] = [
    { label: 'Enter', k: 'enter' },
    { label: 'Fld+', k: 'fieldexit', title: 'Field Exit' },
    { label: 'Tab', k: 'tab' },
    { label: '⇤', k: 'btab', title: 'Back-tab (previous field)' },
    { label: 'SysReq', k: 'sysreq' },
    { label: 'Attn', k: 'attn' },
    { label: 'Ins', k: 'insert', title: 'Insert / overwrite' },
    { label: 'Del', k: 'delete' },
    { label: 'Help', k: 'help' },
    { label: 'Reset', k: 'reset', title: 'Reset keyboard error (X II)' },
    { label: 'Print', k: 'print' }
  ];
  for (const k of editKeys) mk(edit, k);
}
