// PeerChannel: the schema's own wire messages over any RTCDataChannel-shaped
// duplex ({send(bytes), onmessage, onclose}). The same `getheaders`/`headers`
// conversation the bridge has with a real peer, now browser-to-browser —
// and verify-on-receipt makes the peer's honesty irrelevant.

export class PeerChannel {
  constructor(channel, codec, p2pEngine) {
    this.channel = channel;
    this.codec = codec;
    this.engine = p2pEngine;
    this.waiters = [];
    this.onRequest = null; // (msg) => void — the serving side
    this.onWire = null;    // (dir, command, size) => void — observability
    this.base = 'peer://';
    channel.onmessage = (ev) => {
      const bytes = new Uint8Array(ev.data ?? ev); // RTCDataChannel event or raw
      let msg;
      try { msg = this.engine.decodeMessage(bytes); } catch { return; }
      if (!msg.checksumOk) return;
      this.onWire?.('in', msg.command, bytes.length);
      const i = this.waiters.findIndex((w) => w.commands.has(msg.command));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
      else this.onRequest?.(msg);
    };
  }

  send(command, payload = null) {
    this.onWire?.('out', command, 0);
    this.channel.send(this.engine.encodeMessage(command, payload));
  }

  #waitFor(commands, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const waiter = { commands: new Set(commands), resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) { this.waiters.splice(i, 1); reject(new Error('peer timeout')); }
      }, timeoutMs);
    });
  }

  // Source interface (same as BridgeSource): up to 2,000 headers after tipHash.
  async headersAfter(tipHash) {
    this.send('getheaders', {
      version: 70016, blockLocator: [tipHash], hashStop: '0'.repeat(64),
    });
    const reply = await this.#waitFor(['headers']);
    if (!reply.decoded) return [];
    return reply.payload.entries.map((e) => this.codec.encodeHex('BlockHeader', e.header));
  }

  close() { this.channel.close?.(); }
}

// The serving side: answer a peer's getheaders from a LightNode's own
// validated store. This is the moment a client becomes a peer.
export class HeaderServer {
  constructor(node, codec) {
    this.node = node;
    this.codec = codec;
    this.hashIndex = new Map(); // blockHash -> height
    this.indexedTo = null;
    this.served = 0;
  }

  async #index() {
    const meta = this.node.meta;
    const from = this.indexedTo == null ? meta.startHeight : this.indexedTo + 1;
    for (let h = from; h <= meta.tipHeight; h++) {
      const header = await this.node.headerAt(h);
      if (header) this.hashIndex.set(this.codec.blockHash(header), h);
    }
    this.indexedTo = meta.tipHeight;
  }

  // locator hashes -> the next ≤2000 headers after the first one we know.
  async headersAfter(locatorHashes, max = 2000) {
    await this.#index();
    let start = null;
    for (const hash of locatorHashes) {
      const h = this.hashIndex.get(hash);
      if (h != null) { start = h + 1; break; }
    }
    if (start == null) return [];
    const out = [];
    for (let h = start; h <= this.node.meta.tipHeight && out.length < max; h++) {
      out.push(await this.node.headerAt(h));
    }
    this.served += out.length;
    return out;
  }

  // Wire a PeerChannel to serve requests.
  attach(peerChannel) {
    peerChannel.onRequest = async (msg) => {
      if (msg.command !== 'getheaders' || !msg.decoded) return;
      const headers = await this.headersAfter(msg.payload.blockLocator);
      this.onServe?.(headers.length, this.served);
      peerChannel.send('headers', {
        entries: headers.map((header) => ({ header, txCount: 0 })),
      });
    };
  }
}
