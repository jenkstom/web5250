# Keyboard & mouse

*Key mapping, screen selection, clipboard and paste*

| Browser key | 5250 function |
| :--- | :--- |
| `Enter` | Enter (transmit screen) |
| `Tab` / `Shift+Tab` | Next / previous field |
| `F1`–`F12` | PF1–PF12 |
| `Shift+F1`–`Shift+F12` | PF13–PF24 |
| `Numpad +` or `Ctrl+Enter` | Field Exit |
| `Numpad -` | Field− |
| `Esc` | SysReq (`Shift+Esc` = Attn) |
| `Insert` | Insert / overwrite toggle |
| `Delete` | Delete character (shift field left) |
| `Backspace` | Cursor left (authentic non-destructive 5250 backspace) |
| `Home` / `End` | Home field / end of field |
| `PageUp` / `PageDown` | Roll Up / Roll Down |
| `Ctrl+R` or `Alt+R` | Reset (clears `X II` keyboard errors) |
| `Alt+H` / `Alt+P` | Help / host print |

While the OIA shows `X SYSTEM` or `X II`, data keys are blocked exactly like
a real terminal (SysReq, Attn and Reset still work). The on-screen keypad
(button in the top bar) mirrors everything for touch devices.

## Custom keymaps

The table above is the **built-in** mapping — what every session uses until
an administrator configures otherwise. A custom keymap (see
[Systems, admin & console](admin.md#system-selection--admin), Keymaps tab)
**overrides it key by key**: a bound key sends its configured 5250 function
(including ones the built-in map never reaches, like *Clear*, *Field+* and a
destructive *Backspace* that erases — PC5250-style; the built-in Backspace
above stays the authentic non-destructive cursor move),
a key left on `(default)` keeps its built-in meaning, and `(browser)` hands
a key back to the browser. One keymap can be the gateway default; a host
can use its own instead, or pin itself to the built-in map. If your keys
suddenly send different functions than this table, that is why — ask the
administrator which map your host uses.

## Mouse selection and clipboard

Right-click opens the local menu (**Copy selection** / **Copy screen** /
**Paste**); **Shift+right-click** reaches it even on screens where the host
programmed the right button. Text can also be marked directly on the screen,
the way a desktop terminal emulator does:

- **Left-drag** marks a text-flow selection and copies it to the clipboard on
  release. **Alt+drag** marks a column rectangle instead (handy for option
  numbers or record columns).
- **Double-click** marks the word under the mouse (unless the host programmed
  the double click itself).
- **Ctrl+C** / **Cmd+C** re-copies the standing mark; a plain click clears it
  and places the host cursor as before.
- **Ctrl+V** / **Cmd+V** pastes at the cursor with no browser prompt. The paste
  follows the screen's field layout: each line break continues on the next
  input line (a multiline SQL statement fills one row per line, a sign-on
  fills User then Password), a line longer than the field rolls into the next
  field instead of losing its tail, tabs advance one field - and on screens
  whose input is a single command line, each line is submitted with Enter and
  the next types into whatever the host answers (pasting a command script
  runs it). A trailing line break never submits; when the paste runs out of
  screen it stops and beeps.
- **Paste** (the right-click item) has to *read* the clipboard, and the
  browser answers that read with its own confirmation box (Safari and Firefox
  every time, Chrome once and then remembered). That box is the browser's
  clipboard privacy rule, not something the page can skip - use **Ctrl+V** /
  **Cmd+V** to paste in one step.
- Text in hidden (non-display) fields - e.g. the sign-on password - always
  copies as blanks.

On plain-HTTP origins without the async clipboard API the copy falls back to
`execCommand`, and to a selectable dialog box if the browser blocks that too.

### Host-programmed mouse (5494 GUI)

With `IBM_I_MOUSE_GUI=true` (see
[Configuration](configuration.md#configuration)), the gateway claims
pointer-device capability in its 5250 query reply. Hosts that speak the
dialect then program the mouse per screen, exactly like IBM ACS: right-click
opens the application's own context menu, double-click runs its action — and
on such screens **Shift+right-click** is the way back to this app's local
Copy/Paste menu. Hosts without the dialect simply keep treating the display
as mouseless.
