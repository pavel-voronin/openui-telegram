import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createWidgetUpdate, applyWidgetUpdate, createInterface, createWidgetController } from 'openui-telegram';
import { mountWidgetClient } from '../dist/client.js';
import { library } from '../dist-test/fixtures/library.js';
import { compileWidget } from 'openui-telegram';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createLibrary } from '@openuidev/lang-core';
import { defineWidgetComponent } from 'openui-telegram';
import { z } from 'zod';

const settle = () => new Promise(resolve => setImmediate(resolve));
const frame = (h, r = 0, c = {}) => ({ i: 'updates', v: 1, r, h, c, f: {}, e: {}, l: {} });

test('nested lists and conditional controls update through the generated host client without duplicate handlers', async () => {
  const Group = defineWidgetComponent({ name: 'Group', description: 'Outer container', props: z.object({ children: z.array(library.components.Stack.ref) }),
    render: ({ props, renderNode }) => renderNode(props.children),
  });
  const nested = createLibrary({ components: [...Object.values(library.components), Group] });
  const source = '$n = 1\n$show = true\n$rows = [{name: "one"}, {name: "two"}]\ncontrol = $show ? Counter("n", $n) : null\nroot = Group([Stack([Text("Count " + $n), @Each($rows, row, Text(row.name)), control, Button("Toggle", @Set($show, !$show))])])';
  const compiled = await compileWidget({ mode: 'updatable', library: nested, source, instanceId: 'nested', clientEntry: resolve('dist-test/fixtures/client-components.js') });
  assert.deepEqual(compiled.diagnostics, []); assert.equal(compiled.fits, true);
  const session = createInterface(nested, source, { instanceId: 'nested' });
  const controller = createWidgetController(session.runtime, { initialFrame: compiled.initialData.frame });
  await controller.frame();
  const { document, window } = parseHTML(compiled.html), requests = [];
  const sandbox = { document, console, addEventListener() {}, TelegramWidget: { ready() {}, onEvent() {}, offEvent() {}, chatData: null,
    request(data) { requests.push(data); return controller.handle(data).then(() => controller.frame()).then(frame => ({ result: controller.encode(frame) })); },
  } };
  try {
    runInNewContext(document.querySelector('script').textContent, sandbox);
    assert.match(document.body.textContent, /one.*two/);
    const original = document.querySelector('[data-oui-component] button');
    session.runtime.setState('$rows', [{ name: 'three' }, { name: 'one' }, { name: 'two' }]);
    sandbox.OpenUIWidget.apply(await controller.frame());
    assert.match(document.body.textContent, /three.*one.*two/);
    assert.equal(document.querySelector('[data-oui-component] button'), original);
    const press = async selector => { document.querySelector(selector).dispatchEvent(new window.Event('click', { bubbles: true })); await settle(); };
    for (let i = 0; i < 3; i++) {
      await press('[data-oui-action]'); assert.equal(document.querySelector('[data-oui-component]'), null);
      await press('[data-oui-action]'); await press('[data-oui-component] button');
      assert.equal(session.runtime.getState('$n'), i + 2);
      assert.match(document.body.textContent, new RegExp('Count ' + (i + 2)));
    }
    assert.ok(requests.every(data => Buffer.byteLength(data) <= 64));
    assert.equal(sandbox.OpenUIWidget.errors.length, 0);
  } finally { sandbox.OpenUIWidget?.dispose(); controller.dispose(); }
});

test('query completion redraws the retained canvas through a compact native state update', async () => {
  const source = 'data = Query("plot", {}, {value: 1})\nroot = Stack([Text("Plot " + data.value), Plot(data.value)])';
  const compiled = await compileWidget({ mode: 'updatable', library, source, instanceId: 'plot', clientEntry: resolve('dist-test/fixtures/client-components.js') });
  let finish;
  const session = createInterface(library, source, { instanceId: 'plot', onOperation: () => new Promise(resolve => { finish = resolve; }) });
  const controller = createWidgetController(session.runtime, { initialFrame: compiled.initialData.frame });
  const { document } = parseHTML(compiled.html), draws = [], events = new Map();
  Object.getPrototypeOf(document.querySelector('canvas')).getContext = () => ({ clearRect() {}, fillRect(...args) { draws.push(args); }, fillStyle: '' });
  const env = { chatData: null, ready() {}, onEvent(name, handler) { events.set(name, handler); }, offEvent(name) { events.delete(name); } };
  const sandbox = { document, console, addEventListener() {}, TelegramWidget: env };
  try {
    runInNewContext(document.querySelector('script').textContent, sandbox);
    const canvas = document.querySelector('canvas');
    assert.deepEqual(draws.at(-1), [0, 0, 4, 40]);
    finish({ value: 9 }); await settle();
    env.chatData = controller.encode(await controller.frame());
    assert.ok(Buffer.byteLength(env.chatData) <= 1024); events.get('chatDataChanged')();
    assert.equal(document.querySelector('canvas'), canvas);
    assert.deepEqual(draws.at(-1), [0, 0, 36, 40]);
    assert.match(document.body.textContent, /Plot 9/);
  } finally { sandbox.OpenUIWidget?.dispose(); controller.dispose(); }
});
test('small separated changes in a large view, props and arrays travel as exact small deltas', () => {
  const pad = '<p>unchanged 🦊</p>'.repeat(200);
  const base = frame(`<h1>1</h1>${pad}<footer>1</footer>`);
  base.f.rows = Array.from({ length: 150 }, (_, n) => ({ id: n, value: 'unchanged' }));
  const next = structuredClone(base); next.r = 1;
  next.h = `<h1>2</h1>${pad}<footer>2</footer>`; next.f.rows[80].value = 'изменено';
  const update = createWidgetUpdate(base, next);
  assert.ok(Buffer.byteLength(JSON.stringify(base)) > 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(update)) < 300);
  assert.deepEqual(applyWidgetUpdate(base, update), next);
  next.r = 2; next.f.rows.splice(10, 0, { id: 'new', value: 'added' });
  assert.deepEqual(applyWidgetUpdate(base, createWidgetUpdate(base, next)), next);
  const deleted = structuredClone(next); deleted.r = 3; delete deleted.f.rows;
  assert.deepEqual(applyWidgetUpdate(next, createWidgetUpdate(next, deleted)), deleted);
  assert.throws(() => applyWidgetUpdate(next, update), /base frame/);
});
test('delta updates preserve nodes, canvas and mounted listeners; removed components are disposed once', async () => {
  const { document, window } = parseHTML('<main id="openui-root"></main>');
  const root = document.getElementById('openui-root');
  let mounts = 0, updates = 0, disposals = 0, clicks = 0;
  const component = { props: { value: 1 }, type: 'Box' };
  const base = frame('<section><span data-oui-component="box"><canvas width="120"></canvas></span><p>1</p></section>', 0, { box: component });
  const client = mountWidgetClient(base, { Box: {
    render: () => '',
    mount(context) { mounts++; context.on(context.element, 'click', () => { clicks += context.props.value; }); return () => disposals++; },
    update() { updates++; },
  } }, { root, request: async () => { throw new Error('Unexpected server call'); } });
  const canvas = root.querySelector('canvas'); canvas.localMarker = {};
  const marker = canvas.localMarker;
  try {
    const next = structuredClone(base); next.r = 10; next.c.box.props.value = 2; next.h = next.h.replace('<p>1', '<p>2');
    // A state event can skip intermediate revisions and can be replayed after reopening.
    assert.equal(client.apply(createWidgetUpdate(base, next)), true);
    assert.equal(root.querySelector('canvas'), canvas); assert.equal(canvas.localMarker, marker);
    canvas.dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.equal(clicks, 2); assert.equal(mounts, 1); assert.equal(updates, 2); assert.equal(disposals, 0);
    assert.equal(client.apply(createWidgetUpdate(base, next)), false);
    const removed = frame('<section><p>removed</p></section>', 11);
    client.apply(createWidgetUpdate(base, removed)); assert.equal(disposals, 1);
    const returned = structuredClone(next); returned.r = 12;
    client.apply(createWidgetUpdate(base, returned)); assert.equal(mounts, 2);
    client.dispose(); assert.equal(disposals, 2);
    assert.deepEqual(client.errors, []);
  } finally { client.dispose(); }
});
test('patch keeps unrelated cached and in-flight queries and accepts the unchanged original request', async () => {
  const calls = []; let waiting;
  const source = 'a = Query("cached", {}, {value: ""})\nb = Query("pending", {}, {value: ""})\nheading = Text("old")\nroot = Stack([heading, Text(a.value), Text(b.value)])';
  const session = createInterface(library, source, { instanceId: 'preserve', onOperation: op => {
    calls.push(op); return op.tool === 'cached' ? { value: 'cached-result' } : new Promise(resolve => { waiting = resolve; });
  } });
  try {
    await settle();
    const manager = session.runtime.queries, original = calls.find(op => op.tool === 'pending');
    session.patch('heading = Text("new")');
    assert.equal(session.runtime.queries, manager);
    assert.equal(calls.length, 2);
    assert.deepEqual(manager.getResult('a'), { value: 'cached-result' });
    assert.equal(session.runtime.reply({ ...original, result: { value: 'arrived' } }), true);
    await settle();
    assert.match(await session.runtime.render(), /cached-result/); assert.match(await session.runtime.render(), /arrived/);
    assert.equal(session.runtime.reply({ ...original, result: 'duplicate' }), false);
    waiting({ value: 'late-duplicate' });
  } finally { session.dispose(); }
});
test('replaced query ignores its obsolete reply without resetting other query caches', async () => {
  const operations = [];
  const session = createInterface(library, 'a = Query("cached", {}, {value: ""})\nb = Query("old", {}, {value: ""})\nroot = Stack([Text(a.value), Text(b.value)])', {
    instanceId: 'obsolete', onOperation: op => { operations.push(op); return op.tool === 'cached' ? { value: 'kept' } : new Promise(() => {}); },
  });
  try {
    await settle(); const old = operations.find(op => op.tool === 'old');
    session.patch('b = Query("replacement", {}, {value: "new-default"})');
    assert.equal(session.runtime.reply({ ...old, result: 'obsolete' }), false);
    assert.equal(operations.filter(op => op.tool === 'cached').length, 1);
    const replacement = operations.find(op => op.tool === 'replacement');
    assert.equal(session.runtime.reply({ ...replacement, result: { value: 'fresh' } }), true);
    await settle(); assert.match(await session.runtime.render(), /kept/); assert.match(await session.runtime.render(), /fresh/);
  } finally { session.dispose(); }
});
test('controller exposes action failure instead of reporting success', async () => {
  const session = createInterface(library, 'root = Button("Bad", Action([@OpenUrl("https://example.com")]))', { instanceId: 'failed' });
  const controller = createWidgetController(session.runtime);
  try {
    const current = await controller.frame();
    assert.equal(await controller.handle(JSON.stringify([current.i, current.v, current.r, 'a', '0'])), false);
    assert.ok(session.runtime.diagnostics.some(d => d.code === 'gesture-required'));
  } finally { controller.dispose(); }
});

test('a controller configured from bootstrap advances beyond it and encodes independent state updates', async () => {
  const source = '$n = 1\nroot = Text("" + $n)';
  const compiled = await compileWidget({ mode: 'updatable', library, source, instanceId: 'bootstrap', clientEntry: resolve('dist-test/fixtures/client-components.js') });
  const session = createInterface(library, source, { instanceId: 'bootstrap' });
  const controller = createWidgetController(session.runtime, { initialFrame: compiled.initialData.frame });
  try {
    session.runtime.setState('$n', 2);
    const next = await controller.frame();
    assert.ok(next.r > compiled.initialData.frame.r);
    const update = JSON.parse(controller.encode(next));
    const restored = 'd' in update ? applyWidgetUpdate(compiled.initialData.frame, update) : update;
    assert.match(restored.h, />2</);
    assert.throws(() => createWidgetController(session.runtime, { initialFrame: { ...next, i: 'other' } }), /Bootstrap/);
  } finally { controller.dispose(); }
});

test('a mounted field follows changed names and bindings without retaining an obsolete handler', async () => {
  const source = '$a = 1\n$b = 10\n$second = false\ncurrent = $second ? Counter("b", $b) : Counter("a", $a)\ntoggle = Button("switch", @Set($second, !$second))\nroot = Stack([current, toggle])';
  const compiled = await compileWidget({ mode: 'updatable', library, source, instanceId: 'fields', clientEntry: resolve('dist-test/fixtures/client-components.js') });
  const session = createInterface(library, source, { instanceId: 'fields' });
  const controller = createWidgetController(session.runtime);
  await controller.frame();
  const { document, window } = parseHTML(compiled.html), requests = [];
  const sandbox = { document, console, addEventListener() {}, TelegramWidget: { ready() {}, onEvent() {}, offEvent() {}, chatData: null,
    request(data) {
      requests.push(data);
      return controller.handle(data).then(() => controller.frame()).then(frame => ({ result: controller.encode(frame) }));
    },
  } };
  try {
    runInNewContext(document.querySelector('script').textContent, sandbox);
    const counter = document.querySelector('button');
    counter.dispatchEvent(new window.Event('click', { bubbles: true })); await settle();
    assert.equal(session.runtime.getState('$a'), 2);
    document.querySelector('[data-oui-action="0"]').dispatchEvent(new window.Event('click', { bubbles: true })); await settle();
    assert.equal(document.querySelector('button'), counter);
    counter.dispatchEvent(new window.Event('click', { bubbles: true })); await settle();
    assert.equal(session.runtime.getState('$a'), 2); assert.equal(session.runtime.getState('$b'), 11);
    assert.ok(requests.every(data => Buffer.byteLength(data) <= 64));
    assert.equal(JSON.parse(requests[0])[3], 'v');
    assert.equal(sandbox.OpenUIWidget.errors.length, 0);
    sandbox.OpenUIWidget.dispose();
  } finally { controller.dispose(); }
});
