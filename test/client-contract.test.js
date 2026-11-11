import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { mountWidgetClient, text } from 'openui-telegram/client';
import { reconcileDOM } from '../dist/dom.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const frame = (r = 0) => ({ i: 'ui', v: 1, r, h: '<span data-oui-component="box"><button>go</button></span>',
  c: { box: { type: 'Box', props: { value: 1, old: true }, scope: 'entry', fields: [{ name: 'x', scope: 'entry', handle: '0', reactive: true }] } },
  f: { 'entry\0x': 1 }, e: { entry: { x: 'required' } }, l: {} });

test('explicit style manifests reject unavailable CSS before drawing and report asynchronous failures', async () => {
  for (const styles of [[], ['Card'], undefined]) {
    const { document, window } = parseHTML('<html><head><style>.card{color:red}</style></head><body><main></main></body></html>');
    const initial = { ...frame(), h: '<button data-oui-action="0">initial</button>', c: {} };
    const next = { ...initial, r: 1, h: '<div class="card">Card</div>', s: ['Card'] }, diagnostics = [];
    const client = mountWidgetClient(initial, {}, { root: document.querySelector('main'), request: async () => next,
      onDiagnostic: value => diagnostics.push(value) }, styles);
    try {
      if (styles?.length === 0) {
        assert.throws(() => client.apply(next), /Styles for Card.*new widget/);
        document.querySelector('button').dispatchEvent(new window.Event('click', { bubbles: true })); await tick();
        assert.equal(client.current, initial); assert.equal(document.querySelector('main').textContent, 'initial');
        assert.equal(client.errors.length, 1); assert.equal(diagnostics[0].code, 'client-error');
      } else {
        assert.equal(client.apply(next), true); assert.equal(document.querySelector('.card').textContent, 'Card');
      }
    } finally { client.dispose(); }
  }
});

test('errors thrown while applying an asynchronous response reach client errors and diagnostics', async () => {
  const { document, window } = parseHTML('<main></main>'), diagnostics = [];
  const initial = { ...frame(), h: '<button data-oui-action="0">go</button>', c: {} };
  const client = mountWidgetClient(initial, {}, { root: document.querySelector('main'),
    request: async () => ({ ...initial, r: 1, c: { new: { type: 'NotBundled', props: {} } } }),
    onDiagnostic: diagnostic => diagnostics.push(diagnostic),
  });
  try {
    document.querySelector('button').dispatchEvent(new window.Event('click', { bubbles: true }));
    await tick(); await tick();
    assert.equal(client.errors.length, 1); assert.match(String(client.errors[0]), /new widget/);
    assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0].code, 'client-error');
    assert.equal(client.current, initial); assert.equal(document.querySelector('button').textContent, 'go');
  } finally { client.dispose(); }
});

test('client fields/forms follow current descriptors, props, errors and scope without remounting', async () => {
  const { document, window } = parseHTML('<main></main>'), requests = [];
  let context, field, updates = 0;
  const initial = frame();
  const client = mountWidgetClient(initial, { Box: {
    render: () => '', mount(ctx) { context = ctx; field = ctx.field('x'); ctx.on(ctx.element, 'click', () => field.setValue(field.value + 1)); },
    update() { updates++; },
  } }, { root: document.querySelector('main'), request: async input => { requests.push(input); } });
  try {
    assert.equal(field.name, 'x'); assert.equal(field.isReactive, true); assert.equal(field.value, 1);
    assert.deepEqual(context.form(), { values: { x: 1 }, errors: { x: 'required' } });
    const next = frame(1); next.c.box.props = { value: 2 }; next.c.box.scope = 'other';
    next.c.box.fields = [{ name: 'y', scope: 'other', handle: '1', reactive: false }];
    next.f = { 'other\0y': 2, 'entry\0x': 9 }; next.e = { other: { y: 'invalid' } };
    client.apply(next);
    assert.equal(field.name, 'y'); assert.equal(field.isReactive, false); assert.equal(field.value, 2);
    assert.deepEqual(context.props, { value: 2 }); assert.deepEqual(context.form(), { values: { y: 2 }, errors: { y: 'invalid' } });
    document.querySelector('button').dispatchEvent(new window.Event('click', { bubbles: true })); await tick();
    assert.deepEqual(requests[0], ['ui', 1, 1, 'v', '1', 3]);
    assert.equal(updates, 2);
    field.setValue('x'.repeat(100)); await tick(); assert.equal(requests.length, 1); assert.match(String(client.errors.at(-1)), /limit is 64/);
  } finally { client.dispose(); }
  assert.equal(text(null), ''); assert.equal(text(undefined), ''); assert.equal(text(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

test('fields require render registration, use the default scope and reject stale handles', async () => {
  const { document } = parseHTML('<main></main>'), requests = [];
  let field, context;
  const initial = frame(); initial.c.box = { type: 'Box', props: {}, fields: [{ name: 'plain', scope: '', handle: '0', reactive: false }] }; initial.f = { '\0plain': 'default' }; initial.e = {};
  const client = mountWidgetClient(initial, { Box: { render: () => '', mount(ctx) { context = ctx; field = ctx.field('plain'); } } },
    { root: document.querySelector('main'), request: async input => { requests.push(input); } });
  try {
    assert.equal(field.name, 'plain'); assert.equal(field.isReactive, false); assert.equal(field.value, 'default');
    assert.deepEqual(context.form(), { values: { plain: 'default' }, errors: {} });
    assert.deepEqual(context.form('__proto__'), { values: {}, errors: {} });
    field.setValue('new'); await tick(); assert.deepEqual(requests[0], ['ui', 1, 0, 'v', '0', 'new']);
    assert.throws(() => context.field('missing'), /Register component fields/);
    const next = frame(1); next.c = {}; client.apply(next);
    assert.throws(() => field.value, /no longer registered/);
    assert.throws(() => context.field('plain'), /Register component fields/);
    assert.equal(client.current, next);
  } finally { client.dispose(); }
});

test('client lifecycle reports failures and disposes replaced/missing roots exactly once', () => {
  const { document } = parseHTML('<main></main>'); let mounts = 0, cleanups = 0, failUpdate = false;
  const initial = frame();
  const client = mountWidgetClient(initial, { Box: { render: () => '', mount() { mounts++; return () => { cleanups++; throw new Error('cleanup failure'); }; },
    update() { if (failUpdate) throw new Error('update failure'); } } }, { root: document.querySelector('main'), request: async () => {} });
  try {
    const replaced = frame(1); replaced.h = '<section data-oui-component="box"></section>'; client.apply(replaced);
    assert.equal(mounts, 2); assert.equal(cleanups, 1);
    failUpdate = true; const changed = { ...replaced, r: 2, c: { box: { ...replaced.c.box, props: { value: 9 } } } }; client.apply(changed);
    const missing = { ...changed, r: 3, h: '<p>missing root</p>' }; client.apply(missing);
    assert.equal(cleanups, 2);
    const wrong = { ...initial, r: 4, c: { box: { type: 'Other', props: {} } } };
    assert.throws(() => client.apply(wrong), /new widget/);
    assert.ok(client.errors.some(error => /update failure/.test(String(error))));
    assert.ok(client.errors.some(error => /cleanup failure/.test(String(error))));
    assert.ok(client.errors.some(error => /Missing lifecycle/.test(String(error))));
  } finally { client.dispose(); }
});

test('native events, responses, rejected requests and links preserve errors and clean up', async t => {
  const { document, window } = parseHTML('<div id="openui-root"></div>'), callbacks = new Map();
  const previous = { document: globalThis.document, TelegramWidget: globalThis.TelegramWidget, OpenUIHost: globalThis.OpenUIHost };
  const env = { chatData: '{bad', ready() {}, onEvent(name, callback) { callbacks.set(name, callback); }, offEvent(name) { callbacks.delete(name); },
    request() { throw new Error('sync request failure'); }, openLink() { throw new Error('link failure'); } };
  Object.assign(globalThis, { document, TelegramWidget: env, OpenUIHost: undefined });
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; });
  const initial = frame(); initial.h = '<button data-oui-action="0"><b>go</b></button>'; initial.c = {};
  const client = mountWidgetClient(initial, {});
  const click = () => document.querySelector('b').dispatchEvent(new window.Event('click', { bubbles: true }));
  try {
    assert.ok(client.errors.length); env.chatData = null; callbacks.get('chatDataChanged')();
    click(); assert.match(String(client.errors.at(-1)), /sync request failure/);
    env.request = () => Promise.reject(new Error('async request failure')); click(); await tick(); assert.match(String(client.errors.at(-1)), /async request/);
    env.request = async () => ({ result: '{invalid' }); click(); await tick(); assert.ok(client.errors.at(-1) instanceof SyntaxError);
    env.request = async () => ({ result: null }); click(); await tick();
    const next = { ...initial, r: 1, l: { 0: 'https://example.com' } }; env.chatData = JSON.stringify(next); callbacks.get('chatDataChanged')();
    click(); assert.match(String(client.errors.at(-1)), /link failure/);
    assert.equal(client.apply({ ...next, i: 'foreign', r: 2 }), false);
    assert.equal(client.apply({ ...next, v: 0, r: 2 }), false);
    assert.equal(client.apply(next), false);
  } finally { client.dispose(); }
  assert.equal(callbacks.size, 0); assert.equal(client.apply({ ...initial, r: 99 }), false);
});

test('DOM reconciliation removes old attributes, replaces incompatible keys and forwards SVG attribute namespaces', () => {
  const { document } = parseHTML('<main><span id="same" old="yes" title="old">old</span><span id="duplicate"></span><span id="duplicate"></span></main>');
  const root = document.querySelector('main');
  reconcileDOM(root, '<span id="same" title="new">new</span><div id="duplicate">different</div>');
  assert.equal(root.querySelector('#same').hasAttribute('old'), false); assert.equal(root.querySelector('#same').getAttribute('title'), 'new');
  assert.equal(root.querySelectorAll('#duplicate').length, 1); assert.equal(root.querySelector('#duplicate').tagName, 'DIV');
  // Linkedom does not attach namespaces to parsed attributes; model that native DOM contract explicitly.
  const create = document.createElement.bind(document), calls = [];
  document.createElement = name => { const element = create(name); if (name === 'div') {
    // Use a proxy around the detached parse container, leaving the target DOM real.
    return new Proxy(element, { set(target, key, value) { target[key] = value; if (key === 'innerHTML') {
      for (const node of target.querySelectorAll('[href]')) Object.defineProperty(node.getAttributeNode('href'), 'namespaceURI', { value: 'urn:link' });
    } return true; } });
  } return element; };
  const span = root.querySelector('#same'); span.setAttributeNS = (...args) => calls.push(args);
  reconcileDOM(root, '<span id="same" href="new">new</span>');
  assert.deepEqual(calls, [['urn:link', 'href', 'new']]);
});
