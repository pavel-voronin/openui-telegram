import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { compileWidget, createInterface, createWidgetController, applyWidgetUpdate } from 'openui-telegram';
import { mountWidgetClient } from 'openui-telegram/client';
import { library } from '../dist-test/fixtures/library.js';

test('form scopes and field names are own data keys, including prototype names, after save/restore', () => {
  const session = createInterface(library, 'root = Text("forms")', { instanceId: 'safe' });
  try {
    for (const scope of ['__proto__', 'constructor', 'toString', 'ordinary']) {
      for (const name of ['__proto__', 'constructor', 'toString', 'probe']) {
        const field = session.runtime.field(name, undefined, { scope });
        assert.equal(field.value, undefined);
        field.setValue('safe'); field.setValue('updated');
        assert.equal(session.runtime.field(name, undefined, { scope }).value, 'updated');
        assert.equal(Object.hasOwn(session.runtime.form(scope).values, name), true);
        assert.equal(session.runtime.form(scope).values[name], 'updated');
      }
    }
    assert.equal(Object.prototype.probe, undefined);
    assert.equal(Object.prototype.toString instanceof Function, true);
    const saved = JSON.parse(JSON.stringify(session.runtime.snapshot()));
    session.runtime.restore(saved);
    assert.equal(session.runtime.field('probe', undefined, { scope: '__proto__' }).value, 'updated');
    session.runtime.field('__proto__', undefined, { scope: '__proto__', rules: { required: true } }).setValue('');
    assert.equal(Object.hasOwn(session.runtime.form('__proto__').errors, '__proto__'), true);
    assert.equal(Object.getPrototypeOf(session.runtime.form('__proto__').values), Object.prototype);
  } finally { session.dispose(); }
});

test('lifecycle DOM survives unrelated updates while server children still update and removed roots dispose', () => {
  const { document, window } = parseHTML('<main></main>');
  const frame = (r, text = 'one') => ({ i: 'dom', v: 1, r,
    h: `<section><div data-oui-component="local"><span>${text}</span></div><p>${r}</p></section>`,
    c: { local: { type: 'Control', props: { text } } }, f: {}, e: {}, l: {} });
  let clicks = 0, mounts = 0, disposals = 0;
  const client = mountWidgetClient(frame(0), { Control: {
    mount({ element, on }) {
      mounts++; element.setAttribute('data-local', 'kept');
      const button = document.createElement('button'); button.textContent = 'local'; element.append(button);
      on(button, 'click', () => clicks++); return () => { disposals++; };
    },
  } }, { root: document.querySelector('main'), request: async () => {} });
  try {
    const button = document.querySelector('button');
    client.apply(frame(1));
    assert.equal(document.querySelector('button'), button);
    client.apply(frame(2, 'two'));
    assert.equal(document.querySelector('button'), button);
    assert.equal(document.querySelector('span').textContent, 'two');
    assert.equal(document.querySelector('[data-local]').getAttribute('data-local'), 'kept');
    button.dispatchEvent(new window.Event('click')); assert.equal(clicks, 1); assert.equal(mounts, 1);
    client.apply({ ...frame(3), h: '<p>removed</p>', c: {} });
    assert.equal(disposals, 1); button.dispatchEvent(new window.Event('click')); assert.equal(clicks, 1);
  } finally { client.dispose(); }
});

test('persisted source, state and delivery checkpoint resume an already open and a reopened widget', async () => {
  const source = '$n = 1\nroot = Text("" + $n)';
  const compiled = await compileWidget({ mode: 'updatable', library, source, instanceId: 'resume' });
  const session = createInterface(library, source, { instanceId: 'resume' });
  const controller = createWidgetController(session.runtime, { initialFrame: compiled.initialData.frame });
  const { document } = parseHTML('<main></main>');
  const client = mountWidgetClient(compiled.initialData.frame, {}, { root: document.querySelector('main'), request: async () => {} });
  let replacement;
  try {
    session.patch('root = Text("patched:" + $n)');
    for (let n = 2; n < 8; n++) {
      session.runtime.setState('$n', n); client.apply(JSON.parse(controller.encode(await controller.frame())));
    }
    const before = client.current;
    const saved = JSON.parse(JSON.stringify({ source: session.source, state: controller.save(), delivery: controller.checkpoint() }));
    controller.dispose();
    const resumed = createInterface(library, saved.source, {
      instanceId: saved.delivery.instanceId, version: saved.delivery.version, initialState: saved.state,
    });
    replacement = createWidgetController(resumed.runtime, { checkpoint: saved.delivery });
    resumed.runtime.setState('$n', 9);
    const next = await replacement.frame(), payload = JSON.parse(replacement.encode(next));
    assert.ok(next.r > before.r); assert.equal(next.v, 2);
    assert.equal(client.apply(payload), true); assert.match(document.querySelector('main').textContent, /patched:9/);
    const reopened = 'd' in payload ? applyWidgetUpdate(compiled.initialData.frame, payload) : payload;
    assert.equal(reopened.h, next.h);
    await assert.rejects(replacement.handle(JSON.stringify(['resume', before.v, before.r, 'a', '0'])), /Stale/);
    for (const delivery of [{ ...saved.delivery, instanceId: 'wrong' }, { ...saved.delivery, version: 99 },
      { ...saved.delivery, revision: NaN }, { ...saved.delivery, revision: -2 }, { ...saved.delivery, revision: -1 }])
      assert.throws(() => createWidgetController(resumed.runtime, { checkpoint: delivery }), /Checkpoint/);
    assert.throws(() => createWidgetController(resumed.runtime, { checkpoint: saved.delivery, initialFrame: compiled.initialData.frame }), /Checkpoint/);
    const empty = createWidgetController(resumed.runtime);
    assert.equal(empty.checkpoint().revision, -1);
  } finally { client.dispose(); replacement?.dispose(); session.dispose(); }
});

test('Telegram URLs use the native Telegram opener, external links use openLink and failures stay visible', t => {
  const { document, window } = parseHTML('<div id="openui-root"></div>'), opened = [];
  const before = { document: globalThis.document, TelegramWidget: globalThis.TelegramWidget };
  Object.assign(globalThis, { document, TelegramWidget: { onEvent() {}, offEvent() {},
    openLink(url) { opened.push(['external', url]); if (!url.startsWith('https://') || url.length > 256) throw new TypeError('Invalid URL'); },
    openTelegramLink(url) { opened.push(['telegram', url]); },
  } });
  t.after(() => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; });
  const frame = { i: 'links', v: 1, r: 0, h: '<button data-oui-action="0">link</button>', c: {}, f: {}, e: {}, l: {} };
  const client = mountWidgetClient(frame, {});
  try {
    let r = 0;
    for (const url of ['https://t.me/bot', 'https://telegram.me/bot', 'https://telegram.dog/bot', 'HTTPS://T.ME:443/bot',
      'https://t.me.evil.example/x', 'https://example.com', 'http://example.com', 'https://example.com/' + 'a'.repeat(256)]) {
      client.apply({ ...frame, r: ++r, l: { 0: url } });
      document.querySelector('button').dispatchEvent(new window.Event('click', { bubbles: true }));
    }
    assert.deepEqual(opened.map(([kind]) => kind), ['telegram', 'telegram', 'telegram', 'telegram', 'external', 'external', 'external', 'external']);
    assert.deepEqual(opened.slice(0, 4).map(([, url]) => url), Array(4).fill('https://t.me/bot'));
    assert.equal(client.errors.length, 2);
  } finally { client.dispose(); }
});

test('program replacement discards restored results only for changed or removed operations', async () => {
  const source = 'q = Query("read", {}, {value: 0})\na = Mutation("old", {})\nb = Mutation("kept", {})\nroot = Stack([Text("q:" + q.value), Text("a:" + a.status + ":" + a.data.value), Text("b:" + b.status + ":" + b.data.value), Button("a", @Run(a)), Button("b", @Run(b))])';
  const session = createInterface(library, source, { instanceId: 'results', onOperation: async () => ({ value: 7 }) });
  try {
    await session.runtime.render(); await session.runtime.click('0'); await session.runtime.click('1');
    const restored = createInterface(library, source, { instanceId: 'results', initialState: session.runtime.snapshot(), executeQueries: false });
    try {
      restored.patch('a = Mutation("new", {})');
      const html = await restored.runtime.render();
      assert.doesNotMatch(html, /a:success:7/); assert.match(html, /b:success:7/);
      assert.match(html, /q:7/);
      restored.patch('q = Query("different", {}, {value: 0})');
      assert.match(await restored.runtime.render(), /q:0/);
      restored.update('root = Text("removed")');
      restored.update(source);
      assert.doesNotMatch(await restored.runtime.render(), /success:7/);
    } finally { restored.dispose(); }
  } finally { session.dispose(); }
});

test('local client adapters receive links through openUrl and may omit link support', () => {
  for (const supported of [true, false]) {
    const { document, window } = parseHTML('<main></main>'), opened = [];
    const client = mountWidgetClient({ i: 'local', v: 1, r: 0, h: '<button data-oui-action="0">link</button>', c: {}, f: {}, e: {}, l: { 0: 'https://t.me/bot' } }, {}, {
      root: document.querySelector('main'), request: async () => {}, ...(supported ? { openUrl: url => opened.push(url) } : {}),
    });
    try {
      document.querySelector('button').dispatchEvent(new window.Event('click', { bubbles: true }));
      assert.deepEqual(opened, supported ? ['https://t.me/bot'] : []);
      assert.deepEqual(client.errors, []);
    } finally { client.dispose(); }
  }
});
