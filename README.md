# Bitcoin Mesh

**v0.0.2** · The WebTorrent of Bitcoin: light nodes for browser, desktop, and mobile that
verify everything and mesh together.

**Live client:** https://bitcoin-desktop.github.io/bitcoin-mesh/

> Independent community project; not affiliated with Bitcoin Core.

## The idea

WebTorrent worked because torrent data is self-certifying: untrusted browser peers could serve
each other, with hybrid desktop clients bridging the TCP swarm and the WebRTC mesh. Bitcoin's
light-client data has the same property — headers prove their own work, filters check against
committed filter headers, blocks check against merkle roots. **Peers don't need to be trusted,
only verified** — and the verification layer already exists.

This project is the *product* layer of a three-layer stack:

| layer | project | role |
|---|---|---|
| spec | [bitcoin-desktop/schema](https://github.com/bitcoin-desktop/schema) | the canonical JSON-LD model of the protocol: codec, validation rulesets, SPV, filters, LightNode engine, bridge — 114 byte-exact tests against official vectors and the live chain |
| transport / identity | [JavaScriptSolidServer](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer) | pods, WebRTC signaling, Nostr relay, tunnel proxy, auth, payments |
| **product** | **this repo** | the node people run: browser mesh peer, desktop node (bridge + pod), mobile |

## No registry needed

The schema is consumed directly from GitHub — same specifiers in both environments:

- **Node**: `"@bitcoin-desktop/schema": "github:bitcoin-desktop/schema#gh-pages"` (this
  package.json). `npm update @bitcoin-desktop/schema` pulls the latest.
- **Browser**: an [import map](index.html) resolves `@bitcoin-desktop/schema/` to
  `https://bitcoin-desktop.github.io/schema/`.

## Quick start

**Browser node** — open https://bitcoin-desktop.github.io/bitcoin-mesh/ : syncs testnet4
headers from a schema-defined checkpoint into IndexedDB, validating every one locally.

**Desktop node** — run a bridge so browser nodes get real P2P (2,000 headers per message):

```bash
npm install
npm run desktop -- --network testnet4    # starts a bridge on ws://localhost:8334
```

then put `ws://localhost:8334` in the browser client's bridge field.

## Roadmap

1. **Shell** ✅ (v0.0.1) — the mesh client page + desktop bridge launcher, schema consumed
   from GitHub.
2. **Mesh PoC** ✅ (v0.0.2) — browser peers serve each other headers over WebRTC data
   channels, speaking the schema's own wire messages, with JSS's anonymous tracker mode
   (`jss start --webrtc`, the protocol JSS models on WebTorrent trackers) as signaling.
   Every header is verified on receipt — a lying peer is caught by the rules, which is why
   peers need no reputation. Tab A syncs from a bridge; tab B syncs from tab A with no HTTP
   source at all; B then serves C.
3. **Neutrino layer** — the desktop node serves blocks and BIP 158 filters; the browser client
   watches an xpub via filters, privately.
4. **Pod integration** — chain data as JSON-LD pod resources; bridges reachable through the
   pod tunnel; announcements via the pod's Nostr relay.
5. **The mesh, hardened** — multi-peer download, identity-based signaling (WebID), reorg
   negotiation, desktop nodes seeding through the pod tunnel.

## License

MIT
