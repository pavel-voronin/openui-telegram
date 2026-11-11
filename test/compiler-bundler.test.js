import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLibrary } from '@openuidev/lang-core';

test('compiler rejects a bundler result containing external imports', async t => {
  t.mock.module('esbuild', { namedExports: { build: async () => ({ outputFiles: [{ text: 'void 0;' }],
    metafile: { inputs: { '@openuidev/lang-core': {} }, outputs: { out: { imports: [{ path: 'external' }] } } } }), transform() {} } });
  const { compileWidget } = await import('../dist/compiler.js');
  await assert.rejects(compileWidget({ mode: 'updatable', library: createLibrary({ components: [] }), source: '', instanceId: 'external' }), /external imports/);
});
