import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

test('client source transformation preserves sparse syntax while replacing capability constants', async t => {
  t.mock.module('node:fs/promises', { namedExports: { readFile: async () => 'import {CLIENT_TEXT} from "./client-features.js"; export const data = [, CLIENT_TEXT];' } });
  const { hostClientPlugin } = await import('../dist/host-client-bundle.js');
  let load;
  hostClientPlugin({ text: false }).setup({ onLoad(options, callback) { load = callback; } });
  const output = await load({ path: fileURLToPath(new URL('../dist/client.js', import.meta.url)) });
  assert.equal(output.contents, ' export const data = [, false];');
});
