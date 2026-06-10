// Smoke test: the schema package installs from GitHub (no npm registry) and
// its engines work through the dependency boundary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Codec } from '@bitcoin-desktop/schema/codec/codec.js';
import { HeaderEngine } from '@bitcoin-desktop/schema/codec/headers.js';
import { LightNode, MemoryStorage } from '@bitcoin-desktop/schema/codec/node.js';

const load = async (p) =>
  JSON.parse(await readFile(new URL(import.meta.resolve('@bitcoin-desktop/schema/' + p)), 'utf8'));

const codec = new Codec(await load('schema/core.jsonld'), await load('schema/proof.jsonld'));
const chainSchema = await load('schema/chain.jsonld');
const validateSchema = await load('schema/validate.jsonld');

test('schema engines work through the git dependency', () => {
  const engine = HeaderEngine.fromSchemas(codec, chainSchema, validateSchema, 'btc:testnet4');
  const t4 = chainSchema['@graph'].find((n) => n['@id'] === 'btc:testnet4');
  const checkpoint = chainSchema['@graph'].find((n) => n['@id'] === 'btc:testnet4Checkpoint');
  const header = codec.decode('BlockHeader', checkpoint.rawHeader);
  assert.equal(codec.blockHash(header), checkpoint.hash);
  assert.ok(engine.checks['btc:rule-header-pow']({ header }));
  assert.equal(t4.magic, '1c163f28');
});

test('a LightNode initializes from the schema checkpoint', async () => {
  const node = LightNode.fromSchemas(codec, chainSchema, validateSchema, 'btc:testnet4',
    { storage: new MemoryStorage() });
  const meta = await node.init();
  assert.equal(meta.tipHeight, 137088);
  assert.ok(meta.startHeight < meta.tipHeight, 'checkpoint context headers seeded');
});
