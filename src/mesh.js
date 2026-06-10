// MeshSwarm: JSS tracker signaling + RTCPeerConnections + PeerChannels.
// Browser-side glue (RTCPeerConnection lives here and only here); the
// tracker and channel logic are environment-neutral and tested in Node.

import { TrackerClient, swarmId } from './tracker.js';
import { PeerChannel, HeaderServer } from './peer.js';

const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Wait for ICE gathering to finish so the SDP carries all candidates
// (non-trickle, the WebTorrent tracker convention — the JSS resource
// protocol relays offers and answers, not candidates).
function gathered(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(resolve, 4000); // settle for what we have
  });
}

export class MeshSwarm {
  constructor({ signalingUrl, node, codec, p2pEngine, genesisHash }) {
    this.signalingUrl = signalingUrl;
    this.node = node;
    this.codec = codec;
    this.engine = p2pEngine;
    this.genesisHash = genesisHash;
    this.server = new HeaderServer(node, codec);
    this.pending = new Map(); // offer_id -> RTCPeerConnection
    this.peers = new Set();   // connected PeerChannels
    this.onChange = null;
    this.onEvent = null;      // (type, detail) => void — observability
    this.server.onServe = (count, total) => this.onEvent?.('served', { count, total });
  }

  async join() {
    const resource = await swarmId(this.genesisHash);
    this.tracker = new TrackerClient(this.signalingUrl, resource, {
      makeOffers: async (n) => {
        const offers = await this.#makeOffers(n);
        this.onEvent?.('announce', { offers: offers.length, resource });
        return offers;
      },
      onOffer: (from, offerId, sdp) => {
        this.onEvent?.('offer-in', {});
        return this.#answerOffer(sdp);
      },
      onAnswer: (offerId, sdp) => {
        this.onEvent?.('answer-in', {});
        this.pending.get(offerId)?.setRemoteDescription({ type: 'answer', sdp });
      },
    });
    this.tracker.onPeerCount = (count) => {
      this.onEvent?.('swarm-peers', { count });
      this.onChange?.();
    };
    await this.tracker.connect();
  }

  async #makeOffers(n) {
    const offers = [];
    for (let i = 0; i < n; i++) {
      const pc = new RTCPeerConnection(RTC_CONFIG);
      const dc = pc.createDataChannel('bitcoin-mesh');
      dc.binaryType = 'arraybuffer';
      this.#adopt(pc, dc);
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      const offerId = crypto.randomUUID();
      this.pending.set(offerId, pc);
      offers.push({ offer_id: offerId, sdp: pc.localDescription.sdp });
    }
    return offers;
  }

  async #answerOffer(sdp) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pc.ondatachannel = (ev) => {
      ev.channel.binaryType = 'arraybuffer';
      this.#adopt(pc, ev.channel);
    };
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    return pc.localDescription.sdp;
  }

  #adopt(pc, dc) {
    dc.onopen = () => {
      const peer = new PeerChannel(dc, this.codec, this.engine);
      peer.onWire = (dir, command, size) =>
        this.onEvent?.(dir === 'in' ? 'wire-in' : 'wire-out', { command, size });
      this.server.attach(peer); // every node serves
      this.peers.add(peer);
      this.onEvent?.('peer-open', {});
      this.onChange?.();
      dc.onclose = () => {
        this.peers.delete(peer);
        this.onEvent?.('peer-close', {});
        this.onChange?.();
      };
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.onChange?.();
    };
  }

  // Sync our LightNode from the first connected peer.
  async syncFromPeer(onProgress) {
    const peer = [...this.peers][0];
    if (!peer) throw new Error('no connected peers yet');
    return this.node.syncP2p(peer, { onProgress });
  }

  status() {
    return {
      peers: this.peers.size,
      swarmPeers: this.tracker?.peerCount ?? 0,
      served: this.server.served,
    };
  }

  leave() {
    this.tracker?.close();
    for (const p of this.peers) p.close();
    this.peers.clear();
  }
}
