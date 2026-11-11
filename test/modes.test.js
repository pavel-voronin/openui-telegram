import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { runInNewContext } from 'node:vm';
import { compileWidget, createInterface, createWidgetController } from 'openui-telegram';
import { library } from '../dist-test/fixtures/library.js';
import { compileStaticCard, createUpdatableCard } from '../dist-examples/cards.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

test('static mode resolves used state and expressions without a client or required instance ID', async () => {
  const result = await compileStaticCard(1200);
  assert.equal(result.mode, 'static'); assert.match(result.html, /Сумма: 1200/);
  assert.equal(result.html.includes('<script>'), false);
  assert.equal(result.measurement.clientRuntime.bytes, 0);
  assert.equal(result.measurement.clientRuntime.compressedBytes, 0);
  assert.equal(result.measurement.transportFrame.required, false);
  assert.equal(result.initialData.clientFeatures, undefined);
  assert.deepEqual(result.diagnostics, []);
  const ignoredEntry = await compileWidget({ mode: 'static', library,
    source: '$n = 1\nroot = Text("" + ($n * 2))', initialState: { state: { $n: 21 }, forms: {} }, clientEntry: '/does-not-exist.mjs' });
  assert.match(ignoredEntry.html, />42</); assert.equal(ignoredEntry.html.includes('<script>'), false);
  assert.deepEqual(ignoredEntry.diagnostics, []);
});

test('updatable mode includes the client without clientEntry and applies later state and program changes', async () => {
  const demo = await createUpdatableCard('card', 1200);
  const { compiled, session, controller } = demo;
  const { document } = parseHTML(compiled.html), sandbox = { document, console, addEventListener() {}, TelegramWidget: { ready() {}, onEvent() {}, offEvent() {}, chatData: demo.chatData } };
  try {
    assert.equal(compiled.mode, 'updatable'); assert.deepEqual(compiled.diagnostics, []);
    assert.ok(compiled.html.includes('<script>')); assert.ok(compiled.measurement.clientRuntime.bytes > 0);
    assert.equal(compiled.measurement.transportFrame.required, true);
    runInNewContext(document.querySelector('script').textContent, sandbox);
    session.runtime.setState('$amount', 1500);
    assert.equal(sandbox.OpenUIWidget.apply(JSON.parse(controller.encode(await controller.frame()))), true);
    assert.match(document.getElementById('openui-root').textContent, /Сумма: 1500/);
    session.patch('root = Text("Changed " + $amount)');
    assert.equal(sandbox.OpenUIWidget.apply(JSON.parse(controller.encode(await controller.frame()))), true);
    assert.match(document.getElementById('openui-root').textContent, /Changed 1500/);
  } finally { sandbox.OpenUIWidget?.dispose(); controller.dispose(); }
  const constant = await compileWidget({ mode: 'updatable', instanceId: 'constant', library, source: 'root = Text("initial")' });
  assert.ok(constant.html.includes('<script>')); assert.deepEqual(constant.diagnostics, []);
});

test('updatable buttons execute through the host controller without any component entry module', async () => {
  const source = '$n = 1\nroot = Stack([Text("Count " + $n), Button("Add", @Set($n, $n + 1))])';
  const compiled = await compileWidget({ mode: 'updatable', instanceId: 'buttons', library, source });
  const session = createInterface(library, source, { instanceId: 'buttons' });
  const controller = createWidgetController(session.runtime, { initialFrame: compiled.initialData.frame });
  const chatData = controller.encode(await controller.frame());
  const { document, window } = parseHTML(compiled.html);
  const sandbox = { document, console, addEventListener() {}, TelegramWidget: { ready() {}, onEvent() {}, offEvent() {}, chatData,
    request: data => controller.handle(data).then(() => controller.frame()).then(frame => ({ result: controller.encode(frame) })) } };
  try {
    assert.deepEqual(compiled.diagnostics, []);
    runInNewContext(document.querySelector('script').textContent, sandbox);
    document.querySelector('button').dispatchEvent(new window.Event('click', { bubbles: true })); await settle();
    assert.equal(session.runtime.getState('$n'), 2); assert.match(document.getElementById('openui-root').textContent, /Count 2/);
    assert.equal(sandbox.OpenUIWidget.errors.length, 0);
  } finally { sandbox.OpenUIWidget?.dispose(); controller.dispose(); }
});

test('mode and the updatable instance ID are mandatory at runtime too', async () => {
  const input = { library, source: 'root = Text("Hello")' };
  await assert.rejects(compileWidget(input), /mode must/);
  await assert.rejects(compileWidget({ ...input, mode: 'auto' }), /mode must/);
  await assert.rejects(compileWidget({ ...input, mode: 'updatable' }), /requires instanceId/);
});

test('static mode diagnoses OpenUI actions, required client hooks and conflicting client options without bundling JS', async () => {
  const action = await compileWidget({ mode: 'static', library, source: '$n = 1\nroot = Button("Add", @Set($n, $n + 1))' });
  assert.ok(action.diagnostics.some(d => d.code === 'static-action' && !d.severity));
  const hook = await compileWidget({ mode: 'static', library, source: 'root = Plot(3)', clientEntry: '/does-not-exist.mjs' });
  assert.ok(hook.diagnostics.some(d => d.code === 'static-client-hook' && d.component === 'Plot'));
  const conflict = await compileWidget({ mode: 'static', library, source: 'root = Text("Hello")', clientSpecialization: false });
  assert.ok(conflict.diagnostics.some(d => d.code === 'static-client-options'));
  for (const result of [action, hook, conflict]) assert.equal(result.html.includes('<script>'), false);
  const needsEntry = await compileWidget({ mode: 'updatable', instanceId: 'plot', library, source: 'root = Plot(3)' });
  assert.ok(needsEntry.diagnostics.some(d => d.code === 'client-entry-required' && /Plot/.test(d.message)));
});

test('static Query snapshots make tool/default behaviour explicit and never execute operations', async () => {
  let calls = 0;
  const source = 'data = Query("read", {}, {value: 7})\nroot = Text("" + data.value)';
  for (const [results, expected] of [[undefined, 7], [{ data: { value: 42 } }, 42]]) {
    const result = await compileWidget({ mode: 'static', library, source, onOperation() { calls++; },
      initialState: { state: {}, forms: {}, results } });
    assert.match(result.html, new RegExp('>' + expected + '<'));
    assert.ok(result.diagnostics.some(d => d.code === 'static-query-snapshot' && d.severity === 'warning'));
    assert.equal(result.html.includes('<script>'), false);
  }
  assert.equal(calls, 0);
});
