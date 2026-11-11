import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { registerHooks } from 'node:module';

export async function checkClientProfile(lifecycle) {
  const flags = Object.fromEntries(['LIFECYCLE', 'FIELDS', 'FORMS', 'MOUNT', 'CLEANUPS', 'EVENTS', 'TEXT']
    .map(name => ['CLIENT_' + name, name === 'LIFECYCLE' && lifecycle]));
  const profileURL = new URL('../../dist/client-features.js', import.meta.url).href;
  const hook = registerHooks({ load(url, context, next) {
    return url === profileURL ? { format: 'module', shortCircuit: true, source: Object.entries(flags).map(([name, value]) => 'export const ' + name + '=' + value + ';').join('') } : next(url, context);
  } });
  const { mountWidgetClient } = await import('../../dist/client.js');
  const { document } = parseHTML('<main></main>'); let context, updates = 0;
  const initial = { i: 'profile', v: 1, r: 0, h: lifecycle ? '<p data-oui-component="x">one</p>' : '<p>one</p>',
    c: lifecycle ? { x: { type: 'X', props: {} } } : {}, f: {}, e: {}, l: {} };
  const client = mountWidgetClient(initial, { X: { update(ctx) { context = ctx; updates++; } } },
    { root: document.querySelector('main'), request: async () => {} });
  try {
    assert.equal(client.current, initial);
    if (lifecycle) {
      for (const service of ['field', 'form', 'on', 'text']) assert.equal(service in context, false);
      assert.equal(updates, 1);
    }
    client.apply({ ...initial, r: 1, h: initial.h.replace('>one<', '>two<') });
    assert.equal(document.querySelector('p').textContent, 'two');
    client.apply({ ...initial, r: 2, h: '', c: {} });
    if (!lifecycle) assert.throws(() => client.apply({ ...initial, r: 3, c: { x: { type: 'X', props: {} } } }), /new widget/);
  } finally { client.dispose(); hook.deregister(); }
}
