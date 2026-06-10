// A client for JSS's content-addressed WebRTC signaling (`/.webrtc`,
// anonymous tracker mode) — the protocol JSS models on WebTorrent trackers:
//
//   → { type: "announce", resource: "<hash>", offers: [{ offer_id, sdp }] }
//   → { type: "answer",   resource: "<hash>", to: "<peer_id>", offer_id, sdp }
//   ← { type: "offer",    resource: "<hash>", from: "<peer_id>", offer_id, sdp }
//   ← { type: "answer",   resource: "<hash>", from: "<peer_id>", offer_id, sdp }
//   ← { type: "resource-peers", resource: "<hash>", count }
//
// Transport-agnostic by design: the WebRTC side is injected as callbacks,
// so this logic is testable without an RTCPeerConnection.

// Accept human input: "melvin.me" -> "wss://melvin.me/.webrtc",
// "ws://localhost:4443" -> "ws://localhost:4443/.webrtc".
export function normalizeSignalingUrl(input) {
  let url = input.trim();
  if (!url) return null;
  if (!/^wss?:\/\//i.test(url)) {
    const local = /^(localhost|127\.|\[?::1)/.test(url);
    url = (local ? 'ws://' : 'wss://') + url;
  }
  try {
    const u = new URL(url);
    if (u.pathname === '/' || u.pathname === '') u.pathname = '/.webrtc';
    return u.toString();
  } catch {
    return null;
  }
}

// Diagnose a FAILED WebSocket connect. Run only after the socket refused:
// JSS's websocket-only route 404s plain GETs even when signaling works,
// so an HTTP probe can only distinguish dead host from live-but-refusing.
export async function diagnoseSignaling(wsUrl) {
  const httpUrl = wsUrl.replace(/^ws/, 'http');
  try {
    await fetch(httpUrl, { method: 'GET' });
    return `host is up but the WebSocket was refused — is the server started with --webrtc (JSS_WEBRTC=true)?`;
  } catch {
    return `signaling unreachable: ${wsUrl}`;
  }
}

export class TrackerClient {
  /**
   * @param url       wss://pod/.webrtc
   * @param resource  hex resource hash (the swarm id)
   * @param hooks {
   *   makeOffers(n) -> Promise<[{offer_id, sdp}]>   // pre-gathered (non-trickle)
   *   onOffer(from, offer_id, sdp) -> Promise<answerSdp|null>
   *   onAnswer(offer_id, sdp) -> void               // a peer took one of our offers
   * }
   */
  constructor(url, resource, hooks, { offersPerAnnounce = 3 } = {}) {
    this.url = url;
    this.resource = resource;
    this.hooks = hooks;
    this.offersPerAnnounce = offersPerAnnounce;
    this.peerCount = 0;
    this.onPeerCount = null;
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`signaling connect timeout: ${this.url}`)), 8000);
      this.ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.ws.onerror = () => { clearTimeout(timer); reject(new Error(`signaling unreachable: ${this.url}`)); };
    });
    this.hooks.onOpen?.();
    // JSS sends text frames; be robust to binary-framed relays too
    this.ws.onmessage = (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
      this.#onMessage(JSON.parse(text));
    };
    await this.announce();
  }

  async announce() {
    const offers = await this.hooks.makeOffers(this.offersPerAnnounce);
    this.ws.send(JSON.stringify({ type: 'announce', resource: this.resource, offers }));
  }

  async #onMessage(msg) {
    if (msg.resource && msg.resource !== this.resource) return;
    if (msg.type === 'offer') {
      const sdp = await this.hooks.onOffer(msg.from, msg.offer_id, msg.sdp);
      if (sdp) {
        this.ws.send(JSON.stringify({
          type: 'answer', resource: this.resource,
          to: msg.from, offer_id: msg.offer_id, sdp,
        }));
      }
    } else if (msg.type === 'answer') {
      this.hooks.onAnswer(msg.offer_id, msg.sdp);
    } else if (msg.type === 'resource-peers') {
      this.peerCount = msg.count;
      this.onPeerCount?.(msg.count);
    }
  }

  close() {
    try { this.ws?.send(JSON.stringify({ type: 'leave', resource: this.resource })); } catch {}
    this.ws?.close();
  }
}

// One swarm per chain: the resource hash is derived from the network's
// genesis hash, so peers on different networks can never collide.
export async function swarmId(genesisHash) {
  const data = new TextEncoder().encode(`bitcoin-mesh:v0:${genesisHash}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  let hex = '';
  for (const b of digest.subarray(0, 20)) hex += b.toString(16).padStart(2, '0');
  return hex; // 20 bytes, the WebTorrent info_hash convention
}
