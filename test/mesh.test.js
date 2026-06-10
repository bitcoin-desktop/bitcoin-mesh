// Mesh PoC tests, CI-safe: no network, no RTCPeerConnection.
// - the tracker client against a mock JSS implementing the documented
//   resource protocol (the WS server comes from the schema package)
// - two LightNodes syncing through PeerChannels over an in-memory duplex:
//   the full browser-to-browser conversation, verify-on-receipt included.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { P2pEngine } from '@bitcoin-desktop/schema/codec/p2p.js';
import { HeaderEngine } from '@bitcoin-desktop/schema/codec/headers.js';
import { LightNode, MemoryStorage } from '@bitcoin-desktop/schema/codec/node.js';
import { attachWsServer } from '@bitcoin-desktop/schema/codec/ws.js';
import { TrackerClient, swarmId, normalizeSignalingUrl } from '../src/tracker.js';
import { PeerChannel, HeaderServer } from '../src/peer.js';

const load = async (p) =>
  JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));

const p2pSchema = await load('schema/p2p.jsonld');
const chainSchema = await load('schema/chain.jsonld');
const validateSchema = await load('schema/validate.jsonld');
const codec = new Codec(await load('schema/core.jsonld'), await load('schema/proof.jsonld'), p2pSchema);
const engine = P2pEngine.fromSchemas(codec, p2pSchema, chainSchema, 'btc:testnet4');
const headerEngine = HeaderEngine.fromSchemas(codec, chainSchema, validateSchema, 'btc:testnet4');
const t4 = await load('test/vectors/testnet4.json');

// ---- a mock JSS /.webrtc implementing the documented resource protocol ----

function startMockTracker() {
  const server = http.createServer();
  const resources = new Map(); // resource -> Map<peerId, client>
  let nextId = 1;
  attachWsServer(server, (client) => {
    const peerId = String(nextId++);
    client.onMessage((bytes) => {
      const msg = JSON.parse(new TextDecoder().decode(bytes));
      if (msg.type === 'announce') {
        if (!resources.has(msg.resource)) resources.set(msg.resource, new Map());
        const room = resources.get(msg.resource);
        for (const [otherId, other] of room) {
          for (const offer of msg.offers.slice(0, 1)) {
            other.send(new TextEncoder().encode(JSON.stringify({
              type: 'offer', resource: msg.resource, from: peerId,
              offer_id: offer.offer_id, sdp: offer.sdp,
            })));
          }
        }
        room.set(peerId, client);
        client.send(new TextEncoder().encode(JSON.stringify({
          type: 'resource-peers', resource: msg.resource, count: room.size - 1,
        })));
      } else if (msg.type === 'answer') {
        resources.get(msg.resource)?.get(msg.to)?.send(new TextEncoder().encode(JSON.stringify({
          type: 'answer', resource: msg.resource, from: peerId,
          offer_id: msg.offer_id, sdp: msg.sdp,
        })));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ port: server.address().port, close: () => server.close() })));
}

test('swarm ids are chain-derived and distinct per network', async () => {
  const a = await swarmId('00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043');
  const b = await swarmId('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
  assert.match(a, /^[0-9a-f]{40}$/);
  assert.notEqual(a, b);
});

test('tracker clients meet at a mock JSS and exchange offer/answer', async () => {
  const tracker = await startMockTracker();
  const resource = await swarmId(t4.genesisHash);
  try {
    const got = {};
    // JSS relays the ANNOUNCER's offers to peers already in the room:
    // alice joins first, bob's announce delivers bob's offer to alice.
    const alice = new TrackerClient(`ws://127.0.0.1:${tracker.port}`, resource, {
      makeOffers: async () => [{ offer_id: 'a1', sdp: 'ALICE-OFFER' }],
      onOffer: async (from, offerId, sdp) => {
        got.offer = { from, offerId, sdp };
        return 'ALICE-ANSWER';
      },
      onAnswer: () => {},
    }, { offersPerAnnounce: 1 });
    const bob = new TrackerClient(`ws://127.0.0.1:${tracker.port}`, resource, {
      makeOffers: async () => [{ offer_id: 'b1', sdp: 'BOB-OFFER' }],
      onOffer: async () => null,
      onAnswer: (offerId, sdp) => { got.answer = { offerId, sdp }; },
    }, { offersPerAnnounce: 1 });

    await alice.connect(); // joins the empty room
    await bob.connect();   // announce relayed to alice, who answers
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(got.offer.sdp, 'BOB-OFFER', 'alice received the relayed offer');
    assert.equal(got.answer.sdp, 'ALICE-ANSWER', 'bob received the routed answer');
    assert.equal(got.answer.offerId, 'b1', 'answer carries the offer id');
    alice.close(); bob.close();
  } finally {
    tracker.close();
  }
});

// ---- browser-to-browser sync, minus the RTC plumbing ----

function channelPair() {
  const make = () => ({ onmessage: null, send: null, close() {} });
  const a = make(), b = make();
  a.send = (bytes) => queueMicrotask(() => b.onmessage?.({ data: Uint8Array.from(bytes).buffer }));
  b.send = (bytes) => queueMicrotask(() => a.onmessage?.({ data: Uint8Array.from(bytes).buffer }));
  return [a, b];
}

const checkpoint = {
  height: t4.run.startHeight,
  rawHeader: t4.run.headers[0],
  hash: codec.blockHash(codec.decode('BlockHeader', t4.run.headers[0])),
};

test('peer B syncs the chain from peer A over a data channel, verifying every header', async () => {
  // A has the chain (seeded directly into its store)
  const nodeA = new LightNode({
    codec, headerEngine, storage: new MemoryStorage(), sources: [], checkpoint,
  });
  await nodeA.init();
  for (const [i, hex] of t4.run.headers.slice(1).entries()) {
    await nodeA.storage.set(`h:${t4.run.startHeight + 1 + i}`, hex);
  }
  nodeA.meta.tipHeight = t4.run.startHeight + t4.run.headers.length - 1;
  nodeA.meta.tipHash = codec.blockHash(codec.decode('BlockHeader', t4.run.headers.at(-1)));
  await nodeA.storage.set('meta', nodeA.meta);

  // B starts at the checkpoint with NO source but the peer
  const nodeB = new LightNode({
    codec, headerEngine, storage: new MemoryStorage(), sources: [], checkpoint,
  });
  await nodeB.init();

  const [chanA, chanB] = channelPair();
  const peerAtA = new PeerChannel(chanA, codec, engine); // A's view of B
  const peerAtB = new PeerChannel(chanB, codec, engine); // B's view of A
  const serverA = new HeaderServer(nodeA, codec);
  serverA.attach(peerAtA);

  const status = await nodeB.syncP2p(peerAtB);
  assert.equal(status.tipHeight, nodeA.meta.tipHeight, 'B reached A\'s tip');
  assert.equal(status.tipHash, nodeA.meta.tipHash);
  assert.equal(serverA.served, t4.run.headers.length - 1, 'A served the whole run');

  // and B can now serve C: the swarm grows
  const nodeC = new LightNode({
    codec, headerEngine, storage: new MemoryStorage(), sources: [], checkpoint,
  });
  await nodeC.init();
  const [chanB2, chanC] = channelPair();
  const serverB = new HeaderServer(nodeB, codec);
  serverB.attach(new PeerChannel(chanB2, codec, engine));
  const statusC = await nodeC.syncP2p(new PeerChannel(chanC, codec, engine));
  assert.equal(statusC.tipHash, nodeA.meta.tipHash, 'C reached the tip through B');
});

test('a lying peer is caught on receipt', async () => {
  const nodeA = new LightNode({
    codec, headerEngine, storage: new MemoryStorage(), sources: [], checkpoint,
  });
  await nodeA.init();
  const tampered = t4.run.headers.map((hex, i) =>
    i === 5 ? hex.slice(0, 8) + 'deadbeef' + hex.slice(16) : hex);
  for (const [i, hex] of tampered.slice(1).entries()) {
    await nodeA.storage.set(`h:${t4.run.startHeight + 1 + i}`, hex);
  }
  nodeA.meta.tipHeight = t4.run.startHeight + tampered.length - 1;
  await nodeA.storage.set('meta', nodeA.meta);

  const nodeB = new LightNode({
    codec, headerEngine, storage: new MemoryStorage(), sources: [], checkpoint,
  });
  await nodeB.init();
  const [chanA, chanB] = channelPair();
  const serverA = new HeaderServer(nodeA, codec);
  serverA.attach(new PeerChannel(chanA, codec, engine));
  await assert.rejects(() => nodeB.syncP2p(new PeerChannel(chanB, codec, engine)), /rejected/);
  assert.ok(nodeB.meta.tipHeight < t4.run.startHeight + 5, 'B kept only what verified');
});

test('observability hooks fire: wire, serve, and they do not disturb the sync', async () => {
  const nodeA = new LightNode({
    codec, headerEngine, storage: new MemoryStorage(), sources: [], checkpoint,
  });
  await nodeA.init();
  for (const [i, hex] of t4.run.headers.slice(1).entries()) {
    await nodeA.storage.set(`h:${t4.run.startHeight + 1 + i}`, hex);
  }
  nodeA.meta.tipHeight = t4.run.startHeight + t4.run.headers.length - 1;
  await nodeA.storage.set('meta', nodeA.meta);

  const nodeB = new LightNode({
    codec, headerEngine, storage: new MemoryStorage(), sources: [], checkpoint,
  });
  await nodeB.init();

  const [chanA, chanB] = channelPair();
  const events = [];
  const peerAtA = new PeerChannel(chanA, codec, engine);
  const peerAtB = new PeerChannel(chanB, codec, engine);
  peerAtA.onWire = (dir, command) => events.push(`A:${dir}:${command}`);
  peerAtB.onWire = (dir, command) => events.push(`B:${dir}:${command}`);
  const serverA = new HeaderServer(nodeA, codec);
  serverA.onServe = (count) => events.push(`A:served:${count}`);
  serverA.attach(peerAtA);

  await nodeB.syncP2p(peerAtB);
  assert.ok(events.includes('B:out:getheaders'));
  assert.ok(events.includes('A:in:getheaders'));
  assert.ok(events.includes('B:in:headers'));
  assert.ok(events.some((e) => e.startsWith('A:served:')));
});

test('signaling input normalizes like a human expects', () => {
  assert.equal(normalizeSignalingUrl('melvin.me'), 'wss://melvin.me/.webrtc');
  assert.equal(normalizeSignalingUrl('localhost:4443'), 'ws://localhost:4443/.webrtc');
  assert.equal(normalizeSignalingUrl('ws://localhost:4443'), 'ws://localhost:4443/.webrtc');
  assert.equal(normalizeSignalingUrl('wss://melvin.me/custom'), 'wss://melvin.me/custom');
  assert.equal(normalizeSignalingUrl('  '), null);
});

test('empty-offers announce is a pure keepalive; closed sockets reconnect via hook', async () => {
  const tracker = await startMockTracker();
  const resource = await swarmId(t4.genesisHash);
  try {
    let closes = 0;
    const client = new TrackerClient(`ws://127.0.0.1:${tracker.port}`, resource, {
      makeOffers: async () => [{ offer_id: 'k1', sdp: 'OFFER' }],
      onOffer: async () => null,
      onAnswer: () => {},
      onClose: () => { closes++; },
    }, { offersPerAnnounce: 1 });
    await client.connect();
    await client.announce([]); // keepalive ping: must be accepted
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(client.connected, true);

    client.ws.close(); // simulate the proxy dropping us
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(closes, 1, 'onClose hook fired');

    client.close(); // explicit leave must NOT fire the hook again
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(closes, 1);
  } finally {
    tracker.close();
  }
});
