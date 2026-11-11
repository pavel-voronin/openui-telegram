import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { widgetClientFeatures, hostClientPlugin } from '../dist/host-client-bundle.js';

function features(callback) {
  const library = { components: { X: { component: { mount: callback } } }, toJSONSchema: () => ({}) };
  return widgetClientFeatures({}, library, ['X']);
}

test('capability analysis retains opaque function shapes and interprets literal destructuring keys', () => {
  for (const callback of [function () { return arguments[0]; }, ({ ...rest }) => rest, ({ ['text']: text }) => text,
    function () {}.bind(null)]) {
    const result = features(callback);
    for (const service of ['fields', 'forms', 'events', 'text']) assert.equal(result[service], true);
  }
  assert.equal(features(({ 'text': text }) => text).text, true);
  const library = { components: { X: { component: { update() {} } } }, functions: { Make: {} }, toJSONSchema: () => ({}) };
  assert.deepEqual(widgetClientFeatures({ rootExpression: { k: 'Comp', name: 'Make' } }, library, []).components, ['X']);
  assert.deepEqual(widgetClientFeatures({ rootExpression: { type: 'element', typeName: 'X' } }, library, []).components, ['X']);
  assert.deepEqual(widgetClientFeatures({}, library, ['missing']).components, []);
  assert.deepEqual(widgetClientFeatures({ rootExpression: { k: 'StateRef', n: '$element' } }, library, []).components, ['X']);
});

test('entry specialization preserves side effects, dynamic registries, spreads and lifecycle helpers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openui-specialization-'));
  const base = { specialized: true, components: ['Keep'], lifecycle: true, fields: false, forms: false, mount: true, events: false, text: false };
  try {
    for (const extension of ['js', 'jsx', 'ts', 'tsx']) {
      const path = join(dir, 'entry.' + extension), hooks = [];
      hostClientPlugin(base, path).setup({ onLoad(options, callback) { hooks.push(callback); } });
      assert.equal(await hooks[0]({ path: join(dir, 'client.js') }), undefined);
      assert.equal(await hooks[1]({ path: join(dir, 'other.js') }), undefined);
      await writeFile(path, `
        function effect(){ return {} }
        const helper = {}, spread = {}, key = 'dynamic';
        let variable = 1;
        export const components = {
          Remove: { render: () => '', css: 'x', reactive: ['x', ,] },
          'Keep': { 'render': () => '', 'update'({element}) { element.textContent = 'ok'; }, ...spread, [key]: 1 },
          Alias: helper, SideEffect: effect(),
          ArrayPure: [1, , {}], ArrayImpure: [effect()],
          [key]: {}, get Dynamic(){ return {} }, ...spread,
          'Literal': { render: effect() },
          Method: { mount() { return this.render(); }, render: () => '' }
        };
        export { helper };
      `);
      const result = await hooks[1]({ path });
      assert.equal(result.loader, 'js');
      assert.doesNotMatch(result.contents, /Remove:|ArrayPure:/);
      assert.match(result.contents, /SideEffect:/); assert.match(result.contents, /ArrayImpure:/);
      assert.match(result.contents, /update/); assert.match(result.contents, /get Dynamic/);
      await writeFile(path, `export const components = { Keep: { render(){ return 'keep' }, mount(){ components.Keep.render() } } };`);
      assert.match((await hooks[1]({ path })).contents, /render\(/);
      await writeFile(path, 'const registry = {}; export const components = registry;');
      assert.match((await hooks[1]({ path })).contents, /components = registry/);
    }
    const hooks = [];
    hostClientPlugin(base, join(dir, 'none.js')).setup({ onLoad(options, callback) { hooks.push(callback); } });
    const result = await hooks[0]({ path: resolve('dist/client.js') });
    assert.doesNotMatch(result.contents, /CLIENT_LIFECYCLE/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
