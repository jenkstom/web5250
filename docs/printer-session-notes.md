# TN5250E printer sessions — protocol notes (M0 findings)

Byte-level ground truth, extracted the same way the display protocol was:
RFC cross-check (RFC 1205 / RFC 2877 / RFC 4777 §11) against the classic
`tn5250` implementation (`lib5250/printsession.c`, `telnetstr.c`, `record.c`,
`scs.c`) — the open-source printer client that has interoperated with real
AS/400 / IBM i hosts for decades. tn5250j was checked too: it has **no**
printer device session at all (its printing is client-side rendering), so the
C implementation is the reference.

Sources: RFC 4777 §11 (print data flows), RFC 2877 §5/§7 (NEW-ENVIRON
printer variables, startup response), `tn5250` master (`telnetstr.c` =
negotiation + framing, `printsession.c` = session state machine,
`scs.c`/`scs.h` = SCS subset).

## 1. Telnet option 0x24 is NOT required

The plan assumed the TN5250E option (0x24) and a `12 A1` START_SESSION
record. Neither exists in the classic implementation, and neither RFC 2877
nor RFC 4777 defines `12 A1` — that record shape belongs to IBM's own
clients and is not needed for interop. A printer session is established by
**terminal type alone**:

- The telnet negotiation is byte-identical to a display session (DO
  NEW-ENVIRON / TERMINAL-TYPE / EOR / BINARY → WILL all; SB TTYPE SEND →
  TTYPE IS; SB NEW-ENVIRON SEND → DEVNAME). `lp5250d` sets
  `TERM = IBM-3812-1` and answers nothing else specially (`telnetstr.c`
  knows exactly four options: TTYPE 24, EOR 25, BINARY 0, NEW-ENVIRON 39).
- Answering TTYPE IS with **`IBM-3812-1`** (single-byte SCS printer; RFC 2877
  §5 also lists `IBM-5553-B01` for DBCS) makes the host attach the telnet
  session to a printer device instead of a display.
- Host print transform, when session-requested, is carried in NEW-ENVIRON
  USERVARs (RFC 2877 §7: `IBMTRANSFORM`='1', `IBMMFRTYPMDL`, `IBMFORMFEED`,
  `IBMPPRSRC1/2`, `IBMFONT`, `IBMASCII899`, `IBMWSCSTNAME/LIB`). v1 does not
  send these: `raw` mode assumes the transform is configured on the device
  description itself (CRTDEVPRT `TRANSFORM(*YES) MFRTYPMDL(...)`), which is
  the pre-created-device model the plan settled on (Q2/Q3).

Consequence for M2: no new telnet option handling. The printer client reuses
`Telnet5250` unchanged except for two opt-in tweaks (below).

## 2. Record framing (RFC 1205 header, printer flows)

All records keep the `<len:2> 12 A0 <flow:2> <LL> <flags:2> <opcode:1>
<diag:LL-7> <data…> <IAC EOR>` shape. The two length-2 fields after `12 A0`
(bytes 4–5, `00 00` on display records) become a **flow type**:

| Flow (bytes 4–5) | Meaning |
| :-- | :-- |
| `00 00` | display data (what `Tn5250Client` speaks today) |
| `90 00` | startup response (host → client, first record of the session) |
| `01 01` | print data (host → client printer) |
| `01 02` | print-complete ACK (client → host) |

Classic tn5250 numbers the last two `0x0011`/`0x0012` (`record.h`
`TN5250_RECORD_FLOW_SERVERO/CLIENTO`) — i.e. without the 0x0100 "printer
record" bit — and real hosts accept it. RFC 4777 documents `0101`/`0102`;
we send/receive the RFC values and tolerate the classic ones on receive.

After bytes 4–5: byte 6 = **LL**, the pass-through header length counting
byte 6 itself (10 for print records, 5 for startup records, 4 on the
print-complete ACK); bytes 7–8 = **flags**; byte 9 = **opcode**; bytes
10…6+LL-1 = diagnostic info (zeros); **print data starts at byte 6+LL** —
the arithmetic `printsession.c` uses (`o = 6 + rec[6]`) and what both RFC
examples byte out to.

Flags (byte 7, `record.h`): `0x10` first-of-chain, `0x08` last-of-chain,
`0x20` printer-ready, `0x80` error. A one-record print chain carries `1800`
(first+last); a multi-record chain marks only its first/last records.

Opcodes (byte 9): `0x01` Print / Print-complete, `0x02` Clear Print Buffers.

## 3. Session state machine (host → client)

1. Negotiation as above; the host may re-ask DEVNAME on a name collision
   (RFC 4777 §6: re-send SB NEW-ENVIRON SEND USERVAR DEVNAME; if the client
   repeats the same name the host disconnects). Displays auto-rename
   (`TOM` → `TOM1`); for printers renaming is wrong (the output queue lives
   on the device name), so v1 fails loudly instead — the printer client must
   disable `Telnet5250`'s auto-rename and report "device name in use".
2. **Startup response record** (flow `9000`): layout from the RFC 4777 §4
   example `0049 12A0 9000 05 60 06 0020 C0 00 3D 0000 <code:4> …`.
   LL = 5, so the 4-char EBCDIC response code sits at offset `6 + LL + 5`
   (= 16 with LL=5) — the exact arithmetic `printsession.c`
   `tn5250_print_session_get_response_code()` uses. Response codes
   (`printsession.c` table): `I902` session started (also `I901`/`I906`
   informational); errors `2702` device description not found, `2703`
   controller not found, `2777` damaged description, `8901` device not
   varied on, `8902` device not available, `8903` device not valid for
   session, `8906`/`8907` session initiation/rejected, `8910`, `8916`–`8940`
   (auto-config failed … security failure), `I904` incompatible release.
3. **Print records** (flow `0101`, opcode `01`): the client **must ACK every
   one** with the 10-byte record `000A 12A0 0102 04 0000 01` (flags `0000`
   good response, opcode `01` print complete) — RFC 4777 §11 end-to-end
   example ACKs after every data record, and `printsession.c` does the same.
   Opcode `02` (Clear Print Buffers) is **not** ACKed; the client drops the
   partially assembled job (tn5250 just logs it; we flush the buffer).
4. **End of job** = a null print record: `0011 12A0 0101 0A 0800 01
   000000000000 00` — total length 0x11, flags `0800` last-of-chain, opcode
   `01`, empty data (the trailing `00` byte is optional and sometimes
   omitted → length 0x10). tn5250's rule is `record length == 0x11`; we
   accept 0x10/0x11 plus the shape check (empty data + last-of-chain). The
   client ACKs the null record too.

## 4. SCS subset for `text` mode

The concatenated print-record data of one job is an **EBCDIC SCS data
stream** (SCS = IBM 3270 SNA Character String; codes per IPDS & SCS
Technical Reference ch. 16, mirrored in `scs.h`). EBCDIC **text bytes are
0x40–0xFE**; control codes live in 0x00–0x3F — except the presentation
codes (0xC0 AHPP, 0xC4 AVPP, 0xC8 RRPP, 0x2B-family) that overlap the
letter zone, which is why a plain "≤0x3F means control" test is not enough.

Codes that actually occur on IBM i *SCS spool output (tn5250's `scs.c`
dispatch + field experience) and v1 extractor rules:

| Code | Name | Param bytes | Extractor rule |
| :-- | :-- | :-- | :-- |
| 0x00 | NOOP | – | skip |
| 0x03 | TRANSPARENT | 1 (L) + L raw | emit the L bytes verbatim (ASCII pass-through) |
| 0x05 | HT | – | `\t` |
| 0x06 | RNL | – | `\n` |
| 0x09 / 0x38 | SPS / SBS | – | skip (super/subscript) |
| 0x0A | RPT | 2 (count, char) | emit char × count |
| 0x0C | FF | – | `\f` (page break; pages = `\f` count + 1) |
| 0x0D | CR | – | skip (column reset; virtually always paired with NL — emitting it would double-space) |
| 0x15 | NL | – | `\n` |
| 0x1E | IRS | – | `\n` |
| 0x25 | LF | – | `\n` |
| 0x2B… | SSA/2B family | sub-code dependent | skip sub-coded presentation blocks (`C1` SHF / `C2` SVF carry a length byte) |
| 0x2F | BEL | – | skip |
| 0x34 | PP | 2 | skip |
| 0x3A | RFF | – | `\f` |
| 0xC0 / 0xC4 / 0xC8 | AHPP/AVPP/RRPP | 2 each | skip |
| other 0x40–0xFE | text | – | `Ebcdic.ebcdic2uni()` |

`scs.c`'s tolerance model is the rule: anything unrecognized falls through
to the default handler and is treated as text (one odd character, never a
lost stream). The v1 extractor does the same, so an unknown control code
degrades to a stray glyph instead of desynchronizing the parser.

`raw` mode ignores all of this: bytes are stored as received and the format
sniffed from the first bytes — `%PDF` (ASCII) → `.pdf`, ESC (0x1B) or
`%-12345-X` PJL → `.pcl`, else `.txt`.

## 5. Keepalive (Q8)

Neither RFC specifies one and classic tn5250 sends none; the display
heartbeat (IAC NOP every 45 s, `telnet.ts` `heartbeat()`) is harmless on a
printer session and is reused as-is.

## 6. Host-side recipe (Q2, from RFC 2877 §7 + IBM device docs)

- Pre-created device (v1 model): a `*VRT` device must name a virtual
  controller, or VRYCFG fails with "configuration not valid, reason code
  2301" (device not attached to a controller). Create the controller once
  if it does not exist (`CRTCTLVDE CTLD(QVIRCD0001)`) and vary IT on - a
  manually created controller starts varied off, leaving the device at
  "Powered off or not yet available" in WRKCFGSTS - then:
  `CRTDEVPRT DEVD(WEB5250P) DEVCLS(*VRT) CTL(QVIRCD0001) TYPE(3812)
  MODEL(1) FONT(011) FORMFEED(*CONT) TEXT('web5250 printer')`,
  `VRYCFG CFGOBJ(QVIRCD0001) CFGTYPE(*CTL) STATUS(*ON)` and
  `VRYCFG CFGOBJ(WEB5250P) CFGTYPE(*DEV) STATUS(*ON)`. (SCS device types
  demand FONT - it has no default; there is no PAGESIZE on CRTDEVPRT,
  page size belongs to the printer file.)
  The telnet server varies the device on when the session starts (as it
  does for displays); `8901` means it could not.
- Auto-config alternative: telnet auto-creates devices only while
  `QAUTOVRT` > 0 — printer sessions with a named DEVNAME are created
  device-type 3812 model 1 automatically. If auto-config is off/failed the
  startup response says `8940` / `2702`.
- Printing to it: a printer device has no OUTQ parameter — the writer for
  `DEV(WEB5250P)` (the attached telnet session itself) prints the output
  queue **named like the device**, which CRTDEVPRT auto-created in QUSRSYS.
  Route spool files with `OVRPRTF FILE(*PRTF) OUTQ(QUSRSYS/WEB5250P)`
  before an `... OUTPUT(*PRINT)` command, or move existing files via WRKSPLF
  option 2. `WRKCFGSTS` showing the device ACTIVE (not just VARIED ON) is
  the signal that a session is attached and writing; a file sitting at
  "Not assigned to printer" means no session is attached. Files with a
  blank form type trigger the CPA3394 "Load form type" inquiry (writer
  expects *STD, blank does not match) - scoped fixes, narrowest first:
  give routed files an explicit form type (`OVRPRTF FILE(*PRTF)
  OUTQ(QUSRSYS/WEB5250P) FORMTYPE(*STD)`, or CHGSPLFA on moved files);
  `CHGWTR WTR(WEB5250P) FORMTYPE(*ALL) OPTION(*IMMED)` for the live
  writer only (*IMMED, not *FILEEND - the parked file never ends, so a
  *FILEEND change never activates; the writer is recreated picky on every
  session reconnect); or, to automate without a system-wide reply list
  entry, a break-handling CL on the device's own message queue. The blunt
  instrument `ADDRPYLE MSGID(CPA3394) RPY(I)` auto-answers the inquiry
  for EVERY printer on the system - use only where all printers are
  virtual/unattended. Wide spooled files (WRKACTJOB prints 198 columns)
  hit "attributes not supported, error code 1" on a 132-column 3812:
  reply G to print folded, or `OVRPRTF FILE(QPDSPAJB) PAGESIZE(66 132)`
  reflows the report to 132 at the source. Per-user default routing: `CHGUSRPRF USRPRF(x)
  OUTQ(QUSRSYS/WEB5250P)` (applies at next sign-on, and only when the
  sign-on job description says OUTQ(*USRPRF) - a JOBD naming a specific
  queue wins; CHGJOB OUTQ() switches a running session live).

## 7. What this changes vs. the original plan

- **M2 shrinks to nothing new on the telnet wire**: no option 0x24, no
  START_SESSION record to build. Two small opt-in tweaks to `Telnet5250`:
  send extra NEW-ENVIRON uservars (reserved), and disable the display-style
  DEVNAME auto-rename so collisions surface as errors (Q3).
- `sendGds()` learns the flow-type word (bytes 4–5) so the print-complete
  ACK can be sent; display callers keep `00 00`.
- The startup response (`9000`) is what a printer client waits for instead
  of a sign-on screen.
