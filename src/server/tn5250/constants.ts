/**
 * TN5250 protocol constants.
 *
 * Values verified against RFC 1205 (5250 Telnet Interface), RFC 2877
 * (5250 Telnet Interface enhancements - DEVNAME via NEW-ENVIRON) and the
 * battle-tested open-source emulators tn5250j / tn5250, which interoperate
 * with real IBM i hosts.
 */

// ---------------------------------------------------------------------------
// Telnet (RFC 854) framing
// ---------------------------------------------------------------------------
export const IAC = 0xff;
export const DONT = 0xfe;
export const DO = 0xfd;
export const WONT = 0xfc;
export const WILL = 0xfb;
export const SB = 0xfa; // sub-negotiation begin
export const SE = 0xf0; // sub-negotiation end
export const EOR = 0xef; // end of record (RFC 885)
export const NOP = 0xf1;

export const OPT_TRANSMIT_BINARY = 0x00;
export const OPT_ECHO = 0x01;
export const OPT_TIMING_MARK = 0x06;
export const OPT_TERMINAL_TYPE = 24; // 0x18
export const OPT_END_OF_RECORD = 25; // 0x19
export const OPT_NEW_ENVIRONMENT = 39; // 0x27 (RFC 1572)

export const TTYPE_IS = 0x00;
export const TTYPE_SEND = 0x01;

export const NEWENV_IS = 0x00;
export const NEWENV_SEND = 0x01;
export const NEWENV_VAR = 0x00;
export const NEWENV_VALUE = 0x01;
export const NEWENV_USERVAR = 0x03;

// ---------------------------------------------------------------------------
// GDS record framing (RFC 1205)
//
// Every 5250 record (both directions, after binary+EOR negotiation) is:
//   <len:2 BE> 12 A0 00 00 04 <flags> <b8> <opcode> <payload...> <IAC EOR>
// where <len> counts itself and every byte after it, computed BEFORE
// IAC-doubling of 0xFF bytes and excluding the trailing IAC EOR - the form
// live hosts and ACS both send. <opcode> is 0x03 for a normal data stream;
// GUI-capable hosts also use 0x04 (save screen + device image request) and
// 0x05 (restore screen replaying the device's image cookie).
// ---------------------------------------------------------------------------
export const GDS_ID = 0x12a0;

export const GDS_FLAG_ERR = 0x80; // negative response follows
export const GDS_FLAG_ATN = 0x40; // attention key
export const GDS_FLAG_SRQ = 0x04; // system request
export const GDS_FLAG_TRQ = 0x02; // test request key
export const GDS_FLAG_HLP = 0x01; // help key

// ---------------------------------------------------------------------------
// 5250 data stream commands (record payload, after GDS header)
// ---------------------------------------------------------------------------
export const CMD_NOP = 0x00;
export const CMD_INVITE = 0x01;
export const CMD_SAVE_SCREEN = 0x02;
export const CMD_SAVE_PARTIAL_SCREEN = 0x03;
export const CMD_ESCAPE = 0x04;
export const CMD_SIGNAL = 0x07; // audible bell, 2 following bytes skipped
export const CMD_WRITE_TO_DISPLAY = 0x11;
export const CMD_RESTORE_SCREEN = 0x12;
export const CMD_RESTORE_PARTIAL_SCREEN = 0x13;
export const CMD_CLEAR_UNIT_ALTERNATE = 0x20; // -> 27x132
export const CMD_WRITE_ERROR_CODE = 0x21;
export const CMD_WRITE_ERROR_CODE_TO_WINDOW = 0x22;
export const CMD_ROLL = 0x23;
export const CMD_CLEAR_UNIT = 0x40; // -> 24x80
export const CMD_READ_INPUT_FIELDS = 0x42; // RIF: all input fields
export const CMD_CLEAR_FORMAT_TABLE = 0x50;
export const CMD_READ_MDT_FIELDS = 0x52; // RMD: modified fields only
export const CMD_READ_MDT_FIELDS_ALT = 0x82; // like RMD; raw nulls on reply
export const CMD_READ_SCREEN_IMMEDIATE = 0x62;
export const CMD_READ_SCREEN_EXTENDED = 0x64;
export const CMD_READ_SCREEN_TO_PRINT = 0x66;
export const CMD_READ_SCREEN_PRINT_EXTENDED = 0x68;
export const CMD_READ_SCREEN_PRINT_GRID = 0x6a;
export const CMD_READ_SCREEN_PRINT_EXT_GRID = 0x6c;
export const CMD_READ_IMMEDIATE = 0x72; // reply now, all fields, no SBA
export const CMD_READ_IMMEDIATE_ALT = 0x83; // reply now, SBA + MDT fields
export const CMD_WRITE_STRUCTURED_FIELD = 0xf3;
export const CMD_WRITE_SINGLE_STRUCTURED_FIELD = 0xf4; // one SF, GUI hosts

// ---------------------------------------------------------------------------
// Write To Display orders (inside CMD_WRITE_TO_DISPLAY)
// ---------------------------------------------------------------------------
export const ORDER_SOH = 0x01; // start of header (S/36 EE support bits)
export const ORDER_RA = 0x02; // repeat to address
export const ORDER_EA = 0x03; // erase to address
export const ORDER_TD = 0x10; // transparent data
export const ORDER_SBA = 0x11; // set buffer address
export const ORDER_WEA = 0x12; // extended attribute (skipped)
export const ORDER_IC = 0x13; // insert cursor
export const ORDER_MC = 0x14; // move cursor

// STRPCCMD carrier (tn5250j TFX.006253): order X'80' followed by this
// 9-byte "PCO" magic flags a Write To Display as carrying a PC command.
// The bytes still flow onto the screen as characters - the command is read
// back from fixed plane offsets once the write completes (flag at 11,
// command at 12..134; 'a' as the flag means WAIT(*NO)). Length limit of
// the PCCMD parameter until OS V7R1.
export const ORDER_PC_CMD = 0x80;
export const PC_CMD_MAGIC = [0xfc, 0xd7, 0xc3, 0xd6, 0x40, 0x83, 0x80, 0xa1, 0x80];
export const PC_CMD_MAX_LENGTH = 123;
export const ORDER_WTDSF = 0x15; // write to display structured field
export const ORDER_SF = 0x1d; // start of field

// ---------------------------------------------------------------------------
// AID generation codes
// ---------------------------------------------------------------------------
export const AID_PF1 = 0x31;
// PF1..PF12 are 0x31..0x3C, PF13..PF24 are 0xB1..0xBC.
export const AID_ENTER = 0xf1;
export const AID_HELP = 0xf3;
export const AID_ROLL_UP = 0xf4;
export const AID_ROLL_DOWN = 0xf5;
export const AID_PRINT = 0xf6;
export const AID_CLEAR = 0xbd;

export const aidForPF = (n: number): number => {
  if (n >= 1 && n <= 12) return 0x31 + (n - 1);
  if (n >= 13 && n <= 24) return 0xb1 + (n - 13);
  throw new Error(`invalid PF key ${n}`);
};

// ---------------------------------------------------------------------------
// Printer sessions (TN5250E, RFC 4777 section 11). A printer session is a
// normal RFC 1205 negotiation answered with terminal type IBM-3812-1; no
// extra telnet option is needed. Bytes 4-5 of the GDS header - 00 00 on
// display records - become the record flow type, byte 6 the pass-through
// header length (LL), bytes 7-8 flags, byte 9 the opcode; data follows at
// LL+1. Byte-level sources: docs/printer-session-notes.md.
// ---------------------------------------------------------------------------
export const TERM_TYPE_SCS_PRINTER = 'IBM-3812-1';

export const FLOW_DISPLAY = 0x0000; // display data stream (RFC 1205)
export const FLOW_STARTUP_RESPONSE = 0x9000; // host -> client: session start result
export const FLOW_PRINT_DATA = 0x0101; // host -> client: print record
export const FLOW_PRINT_RESPONSE = 0x0102; // client -> host: print-complete ACK

// Byte 7 of a print record (the RFC writes the pair as 1800/0800 - these
// bits live in the high byte; record.h reads data[7]).
export const PRINT_FLAG_ERROR = 0x80;
export const PRINT_FLAG_PRINTER_READY = 0x20;
export const PRINT_FLAG_FIRST_OF_CHAIN = 0x10;
export const PRINT_FLAG_LAST_OF_CHAIN = 0x08;

export const PRINT_OPCODE_PRINT = 0x01; // print data (host) / print complete (client)
export const PRINT_OPCODE_CLEAR = 0x02; // clear print buffers (host, never ACKed)

// Startup response record (flow 9000): the 4-char EBCDIC code sits at
// offset 6+LL+5 (LL = byte 6 = 5 on startup records -> offset 16).
export const PRINT_STARTUP_CODE_OFFSET = 16;

// Codes the printer client accepts as "session started" (printsession.c);
// everything else is a fatal, admin-visible error.
export const PRINT_STARTUP_OK = new Set(['I901', 'I902', 'I906']);

/** Human text for the startup response codes that matter in practice. */
export const PRINT_STARTUP_MESSAGES: Record<string, string> = {
  I901: 'session started (device has less function than requested)',
  I902: 'session started',
  I906: 'session started (sign-on screen follows)',
  '2702': 'device description not found on the host',
  '2703': 'controller description not found on the host',
  '2777': 'device description damaged',
  '8901': 'device not varied on',
  '8902': 'device not available (already in use?)',
  '8903': 'device not valid for this session',
  '8906': 'session initiation failed',
  '8907': 'session failure',
  '8910': 'controller not valid for this session',
  '8916': 'no matching device found',
  '8917': 'not authorized to the device',
  '8923': 'start-up record built incorrectly',
  '8929': 'vary on or vary off failed',
  '8930': 'message queue does not exist',
  '8934': 'start up for S/36 WSF received',
  '8935': 'session rejected',
  '8936': 'security failure on session attempt',
  '8940': 'automatic configuration failed or not allowed',
  I904: 'source system at incompatible release'
};

// ---------------------------------------------------------------------------
// SCS control codes (IPDS & SCS Technical Reference ch.16; the subset that
// occurs on *SCS spool output - scs.c). Text bytes are EBCDIC 0x40-0xFE;
// these codes select the text-mode extractor's behaviour.
// ---------------------------------------------------------------------------
export const SCS_TRANSPARENT = 0x03; // 1 length byte, then that many raw bytes
export const SCS_HT = 0x05;
export const SCS_RNL = 0x06;
export const SCS_RPT = 0x0a; // 2 params: count, char
export const SCS_FF = 0x0c;
export const SCS_CR = 0x0d;
export const SCS_NOOP = 0x00;
export const SCS_NL = 0x15;
export const SCS_IRS = 0x1e;
export const SCS_LF = 0x25;
export const SCS_SSA = 0x2b; // sub-coded presentation blocks follow
export const SCS_BEL = 0x2f;
export const SCS_SPS = 0x09;
export const SCS_SBS = 0x38;
export const SCS_PP = 0x34; // 2 param bytes
export const SCS_RFF = 0x3a;
export const SCS_AHPP = 0xc0; // 2 param bytes
export const SCS_AVPP = 0xc4; // 2 param bytes
export const SCS_RRPP = 0xc8; // 2 param bytes

// Negative-response categories (5250 Functions Reference 12.4)
export const NR_REQUEST_REJECT = 0x08;
export const NR_REQUEST_ERROR = 0x10;
export const NR_STATE_ERROR = 0x20;
export const NR_USAGE_ERROR = 0x40;
export const NR_PATH_ERROR = 0x80;

// ---------------------------------------------------------------------------
// Attribute bytes (0x20-0x3F). (attr & 0xE0) == 0x20 identifies an attribute.
// Color mapping per 5494 Functions Reference (SC30-3533-04, Table 15-10):
//   0x20-0x27 green base (bit 0x02 -> white)   0x28-0x2F red base
//   0x30-0x37 turquoise base (bit 0x02 -> yellow)
//   0x38-0x3F pink base (bit 0x02 -> blue)
//   bit 0x01 -> reverse video, bit 0x04 -> underscore (NOT non-display!)
// NON-DISPLAY is only X'27', X'2F', X'37', X'3F' — exactly the values whose
// low three bits are all 1. (IBM i prompt screens use 0x25 green/underscore/
// reverse and 0x26 white/underscore for visible value fields.)
// ---------------------------------------------------------------------------
export const isAttributeByte = (b: number): boolean => (b & 0xe0) === 0x20;

/** True for the four hidden attribute bytes (passwords etc.). */
export const isNonDisplayAttr = (attr: number): boolean => (attr & 0x07) === 0x07;

// Field Format Word bits (first byte of extended SF order)
export const FFW1_EXTEND = 0x40; // FFW second byte follows
export const FFW1_BYPASS = 0x20; // cursor never enters the field
export const FFW1_DUP_ENABLED = 0x10;
export const FFW1_MDT = 0x08; // MDT set on write
export const FFW1_SHIFT_MASK = 0x07; // 3 = numeric, 4 = RTL, 7 = signed numeric

// Field Format Word bits (second byte)
export const FFW2_AUTO_ENTER = 0x80; // Enter automatically when field fills
export const FFW2_FIELD_EXIT_REQUIRED = 0x40;
export const FFW2_TO_UPPER = 0x20; // monocase
export const FFW2_MANDATORY_ENTER = 0x08;
export const FFW2_ADJUST_MASK = 0x07; // 7 = mandatory fill; 5/6 right adjust

// Field Control Word types seen in extended SF
export const FCW_CONTINUED = 0x81; // continued-entry field
export const FCW_CURSOR_PROGRESSION = 0x88;
export const FCW_HIGHLIGHTED_ENTRY = 0x89;

// Terminal types we advertise. FC models are 27x132 color capable.
export const TERM_TYPES = [
  'IBM-3477-FC',
  'IBM-3477-FG',
  'IBM-3179-2',
  'IBM-3180-2',
  'IBM-3196-A1',
  'IBM-5251-11',
  'IBM-5291-1',
  'IBM-5292-2'
] as const;

export const isTermType132 = (t: string): boolean => t.toUpperCase().includes('3477');
