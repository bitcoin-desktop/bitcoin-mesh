#!/usr/bin/env node
// The desktop mesh node, phase 1: a bridge — real Bitcoin P2P on one side,
// WebSocket for browser mesh peers on the other. The bridge itself lives in
// the schema package (it is the reference transport); this launcher is the
// product wrapper that later grows pod integration and filter serving.
//
//   npm run desktop -- [--network mainnet|testnet4] [--port 8334] [--peer host[:port]]

import { startBridge } from '@bitcoin-desktop/schema/bridge/bridge.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const networkName = opt('network', 'testnet4');
const network = { mainnet: 'btc:mainnet', testnet4: 'btc:testnet4' }[networkName];
if (!network) {
  console.error(`unknown network: ${networkName}`);
  process.exit(1);
}

const bridge = await startBridge({
  network,
  wsPort: parseInt(opt('port', '8334'), 10),
  peer: opt('peer', null),
});

console.log(`
  bitcoin-mesh desktop node (${networkName})
  bridge:  ws://localhost:${bridge.port}
  client:  https://bitcoin-desktop.github.io/bitcoin-mesh/
           -> set the bridge field to ws://localhost:${bridge.port}
`);
