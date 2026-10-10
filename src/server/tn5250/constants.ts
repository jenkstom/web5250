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
//   <len:2 BE> 12 A0 00 00 04 <flags> 00 <opcode> <payload...> <IAC EOR>
// where <len> counts every byte after the length field itself, computed
// BEFORE IAC-doubling of 0xFF bytes, and excluding the trailing IAC EOR.
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

// Negative-response categories (5250 Functions Reference 12.4)
export const NR_REQUEST_REJECT = 0x08;
export const NR_REQUEST_ERROR = 0x10;
export const NR_STATE_ERROR = 0x20;
export const NR_USAGE_ERROR = 0x40;
export const NR_PATH_ERROR = 0x80;

// ---------------------------------------------------------------------------
// Attribute bytes (0x20-0x3F). (attr & 0xE0) == 0x20 identifies an attribute.
// Visual mapping mirrors tn5250j:
//   0x20-0x27 green base (bit 0x02 -> white)   0x28-0x2F red base
//   0x30-0x37 turquoise base (bit 0x02 -> yellow)
//   0x38-0x3F pink base (bit 0x02 -> blue)
//   bit 0x01 -> reverse video, bit 0x04 -> non-display (passwords)
// ---------------------------------------------------------------------------
export const isAttributeByte = (b: number): boolean => (b & 0xe0) === 0x20;

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
