/**
 * SLCAN (Lawicel ASCII) codec for USB-CAN adapters that appear as a serial port (USBtin, Lawicel
 * CANUSB and compatible adapters). Adapters must answer commands with CR or BEL; the stock
 * CANable slcan firmware does not.
 *
 * The adapter speaks text lines terminated by CR (0x0D):
 * - frames: `t` iii l dd.. (11-bit id), `T` iiiiiiii l dd.. (29-bit id), `r` / `R` remote frames;
 *   received frames may carry a 4 hex digit time stamp (ms, 0..0xEA5F) when the adapter has `Z1`
 *   enabled;
 * - commands: `S0`..`S8` bit rate, `O` open, `L` open listen only, `C` close, `V` version,
 *   `N` serial number, `F` status flags, `Z0` / `Z1` time stamps;
 * - replies: CR alone (accepted), BEL 0x07 (rejected), `z` CR / `Z` CR (frame queued for
 *   transmission), `V`hhhh, `N`hhhh, `F`hh.
 *
 * Only the codec lives here: it never opens a port and never decides to transmit. Opening the
 * channel with `O` makes the adapter acknowledge frames on the bus (a node in listen only mode
 * does not acknowledge, so a single sender on the bus would repeat its first frame forever).
 */

import { hex } from './bytes.js';

/** Bit rate commands of the Lawicel protocol (bit/s → command). */
export const SLCAN_BITRATES = Object.freeze({
  10000: 'S0',
  20000: 'S1',
  50000: 'S2',
  100000: 'S3',
  125000: 'S4',
  250000: 'S5',
  500000: 'S6',
  800000: 'S7',
  1000000: 'S8',
});

export const SLCAN_CR = 0x0d;
export const SLCAN_BEL = 0x07;
/** Longest valid line: `T` + 8 id digits + DLC + 16 data digits + 4 time stamp digits. */
export const SLCAN_MAX_LINE = 30;

/**
 * @typedef {Object} CanFrame
 * @property {number} id 11-bit or 29-bit identifier
 * @property {boolean} extended 29-bit identifier
 * @property {boolean} remote remote transmission request (no data)
 * @property {number} dlc data length code 0..8
 * @property {Uint8Array} data data bytes (empty for remote frames)
 * @property {number} [timestamp] adapter time stamp in ms when the adapter sends one
 */

/**
 * @typedef {{ type: 'frame', frame: CanFrame }
 *   | { type: 'ok' }
 *   | { type: 'error' }
 *   | { type: 'sent', extended: boolean }
 *   | { type: 'version' | 'serial' | 'status', value: string }
 *   | { type: 'unknown', text: string }} SlcanMessage
 */

const encoder = new TextEncoder();

/**
 * Bytes of one command line, CR appended.
 * @param {string} text for example 'O' or 'S6'
 * @returns {Uint8Array}
 */
export function slcanCommand(text) {
  if (!/^[\x20-\x7e]*$/.test(text) || text.length > SLCAN_MAX_LINE) throw new Error(`Invalid SLCAN command: ${text}`);
  return encoder.encode(`${text}\r`);
}

/**
 * Bit rate command line for a standard rate.
 * @param {number} bitrate bit/s, one of the keys of SLCAN_BITRATES
 * @returns {Uint8Array}
 */
export function slcanBitrateCommand(bitrate) {
  const cmd = SLCAN_BITRATES[/** @type {keyof typeof SLCAN_BITRATES} */ (bitrate)];
  if (!cmd) throw new Error(`Unsupported SLCAN bit rate: ${bitrate}`);
  return slcanCommand(cmd);
}

/**
 * Text of a frame line without the CR.
 * @param {{ id: number, extended?: boolean, remote?: boolean, data?: ArrayLike<number>, dlc?: number }} frame
 * @returns {string}
 */
export function formatSlcanFrame({ id, extended = false, remote = false, data = [], dlc }) {
  const max = extended ? 0x1fffffff : 0x7ff;
  if (!Number.isInteger(id) || id < 0 || id > max) throw new Error(`CAN id out of range: ${id}`);
  const length = remote ? (dlc ?? 0) : data.length;
  if (!Number.isInteger(length) || length < 0 || length > 8) throw new Error(`CAN data length out of range: ${length}`);
  const letter = remote ? (extended ? 'R' : 'r') : extended ? 'T' : 't';
  const idText = id.toString(16).toUpperCase().padStart(extended ? 8 : 3, '0');
  const bytes = remote ? new Uint8Array(0) : Uint8Array.from(data);
  if (!remote && Array.from(data).some((v) => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error('CAN data bytes must be integers 0..255');
  return `${letter}${idText}${length}${hex(bytes)}`;
}

/**
 * Bytes of a frame line, CR appended (what a host writes to transmit a frame).
 * @param {Parameters<typeof formatSlcanFrame>[0]} frame
 * @returns {Uint8Array}
 */
export function encodeSlcanFrame(frame) {
  return encoder.encode(`${formatSlcanFrame(frame)}\r`);
}

const HEX = /^[0-9A-Fa-f]*$/;

/**
 * Parses one line received from the adapter (without its CR or BEL terminator).
 * @param {string} line
 * @returns {SlcanMessage}
 */
export function parseSlcanLine(line) {
  if (line === '') return { type: 'ok' };
  const kind = line[0];
  if (kind === 't' || kind === 'T' || kind === 'r' || kind === 'R') {
    const extended = kind === 'T' || kind === 'R';
    const remote = kind === 'r' || kind === 'R';
    const idLen = extended ? 8 : 3;
    const idText = line.slice(1, 1 + idLen);
    const dlcText = line.slice(1 + idLen, 2 + idLen);
    if (idText.length !== idLen || !HEX.test(idText) || !/^[0-8]$/.test(dlcText)) return { type: 'unknown', text: line };
    const id = parseInt(idText, 16);
    if (id > (extended ? 0x1fffffff : 0x7ff)) return { type: 'unknown', text: line };
    const dlc = Number(dlcText);
    const dataLen = remote ? 0 : dlc;
    const rest = line.slice(2 + idLen);
    if (!HEX.test(rest) || (rest.length !== 2 * dataLen && rest.length !== 2 * dataLen + 4)) return { type: 'unknown', text: line };
    const data = new Uint8Array(dataLen);
    for (let i = 0; i < dataLen; i++) data[i] = parseInt(rest.slice(2 * i, 2 * i + 2), 16);
    /** @type {CanFrame} */
    const frame = { id, extended, remote, dlc, data };
    if (rest.length === 2 * dataLen + 4) frame.timestamp = parseInt(rest.slice(2 * dataLen), 16);
    return { type: 'frame', frame };
  }
  if (line === 'z' || line === 'Z') return { type: 'sent', extended: line === 'Z' };
  if (kind === 'V' && line.length > 1) return { type: 'version', value: line.slice(1) };
  if (kind === 'N' && line.length > 1) return { type: 'serial', value: line.slice(1) };
  if (kind === 'F' && line.length === 3 && HEX.test(line.slice(1))) return { type: 'status', value: line.slice(1) };
  return { type: 'unknown', text: line };
}

/**
 * Splits the byte stream of an adapter into lines and parses them. Lines end with CR; BEL ends
 * a rejected command. LF and NUL bytes are ignored. Overlong lines and non ASCII bytes are
 * discarded up to the next terminator.
 */
export class SlcanDecoder {
  /**
   * @param {Object} opts
   * @param {(frame: CanFrame) => void} [opts.onFrame]
   * @param {(message: SlcanMessage) => void} [opts.onMessage] every parsed line, frames included
   * @param {(bytes: Uint8Array, reason: string) => void} [opts.onDiscard]
   */
  constructor(opts = {}) {
    this.onFrame = opts.onFrame;
    this.onMessage = opts.onMessage;
    this.onDiscard = opts.onDiscard;
    /** @type {number[]} */
    this.line = [];
    this.broken = false;
  }

  /** Drops a partial line (for example after reopening the port). */
  reset() {
    if (this.line.length) this.onDiscard?.(Uint8Array.from(this.line), 'reset');
    this.line = [];
    this.broken = false;
  }

  /** @param {Uint8Array} chunk */
  push(chunk) {
    for (const byte of chunk) {
      if (byte === SLCAN_CR || byte === SLCAN_BEL) {
        if (this.broken) {
          this.onDiscard?.(Uint8Array.from(this.line), 'invalid line');
        } else if (byte === SLCAN_BEL) {
          if (this.line.length) this.onDiscard?.(Uint8Array.from(this.line), 'text before BEL');
          this.#emit({ type: 'error' });
        } else {
          this.#emit(parseSlcanLine(String.fromCharCode(...this.line)));
        }
        this.line = [];
        this.broken = false;
      } else if (byte === 0x0a || byte === 0x00) {
        // Some adapters send CR LF or pad with NUL; neither is part of a line.
      } else {
        if (byte < 0x20 || byte > 0x7e || this.line.length >= SLCAN_MAX_LINE) this.broken = true;
        if (this.broken && this.line.length >= 256) {
          // A stream without terminators (wrong baud rate, not an SLCAN adapter): report in batches.
          this.onDiscard?.(Uint8Array.from(this.line), 'invalid line');
          this.line = [];
        }
        this.line.push(byte);
      }
    }
  }

  /** @param {SlcanMessage} message */
  #emit(message) {
    if (message.type === 'frame') this.onFrame?.(message.frame);
    else if (message.type === 'unknown') this.onDiscard?.(encoder.encode(message.text), 'unknown line');
    this.onMessage?.(message);
  }
}
