import { Link } from './link.js';

/**
 * In-memory link used by tests, the demo mode and device simulators.
 * Data written on one end is delivered to the peer asynchronously, optionally split into
 * chunks to imitate BLE notification sizes.
 */
export class MemoryLink extends Link {
  /**
   * @param {Object} opts
   * @param {string} [opts.name]
   * @param {import('./log.js').ProtocolLog} [opts.log]
   * @param {number} [opts.latencyMs]
   * @param {number} [opts.deliverChunkSize] split delivered data into chunks of this size
   * @param {string} [opts.kind]
   */
  constructor({ name, log, latencyMs = 0, deliverChunkSize = 0, kind = 'memory' } = {}) {
    super({ kind, name, log });
    this.latencyMs = latencyMs;
    this.deliverChunkSize = deliverChunkSize;
    /** @type {MemoryLink | null} */
    this.peer = null;
  }

  async _open() {}

  async _close() {}

  /** @param {Uint8Array} bytes */
  async _write(bytes) {
    const peer = this.peer;
    if (!peer) throw new Error('Memory link has no peer');
    const copy = Uint8Array.from(bytes);
    const chunks = [];
    if (this.deliverChunkSize > 0) {
      for (let i = 0; i < copy.length; i += this.deliverChunkSize) chunks.push(copy.subarray(i, i + this.deliverChunkSize));
    } else {
      chunks.push(copy);
    }
    for (const c of chunks) {
      const deliver = () => {
        if (peer.state === 'open') peer._receive(c);
      };
      if (this.latencyMs > 0) setTimeout(deliver, this.latencyMs);
      else queueMicrotask(deliver);
    }
  }

  /** Simulate the remote side dropping the connection. */
  simulateDrop(reason = 'simulated drop') {
    this._remoteClosed(reason);
    this.peer?._remoteClosed(reason);
  }
}

/**
 * Create two connected memory links. `host` is what the app uses, `device` is what a simulator uses.
 * Only the host side logs (the device side is the simulated peer).
 * @param {Object} [opts]
 * @param {import('./log.js').ProtocolLog} [opts.log]
 * @param {string} [opts.name]
 * @param {number} [opts.latencyMs]
 * @param {number} [opts.deviceChunkSize] chunk size of device-to-host delivery (BLE-like fragmentation)
 * @param {string} [opts.kind]
 */
export function createLinkPair({ log, name = 'Memory link', latencyMs = 0, deviceChunkSize = 0, kind = 'memory' } = {}) {
  const host = new MemoryLink({ name, log, latencyMs, kind });
  const device = new MemoryLink({ name: `${name} (device side)`, latencyMs, deliverChunkSize: deviceChunkSize, kind });
  host.peer = device;
  device.peer = host;
  return { host, device };
}
