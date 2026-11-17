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

## Mouse selection and clipboard

Right-click opens the local menu (**Copy selection** / **Copy screen** /
**Paste**). Text can also be marked directly on the screen, the way a desktop
terminal emulator does:

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
