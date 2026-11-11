import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { z } from 'zod';
import { createLibrary, createParser, defineFunction } from '@openuidev/lang-core';
import { createInterface, createWidgetController, defineWidgetComponent, WidgetRuntime, runtimeLibrary, text } from 'openui-telegram';
import { library } from '../dist-test/fixtures/library.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

test('rendering escapes text, tolerates missing implementations and distinguishes repeated elements and form scopes', async () => {
  assert.equal(text(null), ''); assert.equal(text(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  const parsed = createParser(library.toJSONSchema(), library.root).parse('item = Text("x")\nroot = Stack([item, item])');
  const runtime = new WidgetRuntime(runtimeLibrary(library), parsed, { instanceId: 'repeat' });
  try {
    const html = await runtime.render();
    assert.match(html, /oui-repeat-s-item"/); assert.match(html, /oui-repeat-s-item-1"/);
    const absent = new WidgetRuntime({ components: {} }, parsed, { instanceId: 'absent' });
    assert.equal(await absent.render(), ''); absent.dispose(); absent.dispose();
    assert.equal(await runtime.trigger(null), false);
  } finally { runtime.dispose(); }
  const Form = defineWidgetComponent({ name: 'Form', description: '', props: z.object({}),
    render(ctx) { ctx.field('a', undefined, { rules: [] }); ctx.field('b'); assert.deepEqual(ctx.form(), { values: { a: undefined, b: undefined }, errors: {} });
      assert.deepEqual(ctx.form('other'), { values: {}, errors: {} }); return '<div></div>'; } });
  const form = createInterface(createLibrary({ components: [Form] }), 'root = Form()', { instanceId: 'forms' });
  try { assert.match(await form.runtime.render(), /<div/); } finally { form.dispose(); }
  const Bad = defineFunction({ name: 'Bad', description: '', params: z.object({}), returns: z.string(), fn() { throw new Error('function error'); } });
  const broken = createInterface(createLibrary({ components: [library.components.Button], functions: [Bad] }), '$x = ""\nroot = Button("bad", @Set($x, @Bad()))', { instanceId: 'fn' });
  try { await broken.runtime.render(); await broken.runtime.click('0'); assert.ok(broken.runtime.diagnostics.some(d => d.code === 'runtime-error')); } finally { broken.dispose(); }
  assert.deepEqual(runtimeLibrary({ components: {}, toJSONSchema: () => ({}) }).functions, {});
});

test('mutation patches keep unaffected registrations and cancel the rest of obsolete action sequences', async () => {
  const source = '$n = 0\na = Mutation("a", {})\nb = Mutation("b", {})\nroot = Button("run", Action([@Run(a), @Set($n, 9)]))';
  const session = createInterface(library, source, { instanceId: 'mutations', onOperation: () => new Promise(() => {}) });
  try {
    await session.runtime.render(); const running = session.runtime.click('0');
    session.patch('b = Mutation("changed", {})');
    // The unchanged in-flight mutation remains executable across the patch.
    session.patch('a = Mutation("replacement", {})');
    assert.equal(await running, false); assert.equal(session.runtime.getState('$n'), 0);
  } finally { session.dispose(); }
});

test('incomplete operation ASTs use empty defaults and obsolete replies cannot escape evaluation errors', async t => {
  t.mock.method(console, 'error', () => {});
  const parser = createParser(library.toJSONSchema(), library.root);
  const parsed = parser.parse('$cyclic = null\nq = Query("read", {}, {})\na = Mutation("write", {})\nb = Mutation("unchanged", {})\nroot = Text("ok")');
  const operations = [];
  const runtime = new WidgetRuntime(runtimeLibrary(library), parsed, { instanceId: 'partial', onOperation: op => { operations.push(op); return new Promise(() => {}); } });
  try {
    const next = structuredClone(parsed);
    delete next.queryStatements[0].argsAST;
    delete next.mutationStatements[0].toolAST;
    runtime.replace(next);
    const third = structuredClone(next); delete third.queryStatements[0].toolAST; delete third.mutationStatements[1].toolAST;
    runtime.replace(third);
    assert.equal(runtime.reply({ ...operations[0], result: {} }), false);
    const fourth = structuredClone(third);
    fourth.queryStatements[0].toolAST = parsed.queryStatements[0].toolAST;
    runtime.replace(fourth);
  } finally { runtime.dispose(); }
  const original = parser.parse('$cyclic = null\nq = Query("read", {}, {})\nroot = Text("ok")');
  let operation;
  const cyclicRuntime = new WidgetRuntime(runtimeLibrary(library), original, { instanceId: 'cyclic', onOperation: op => { operation = op; return new Promise(() => {}); } });
  try {
    const next = structuredClone(original); next.queryStatements[0].argsAST = { k: 'StateRef', n: '$missing' };
    t.mock.method(cyclicRuntime.queries, 'evaluateStatements', () => {});
    cyclicRuntime.replace(next);
    const value = {}; value.self = value; cyclicRuntime.setState('$cyclic', value);
    next.queryStatements[0].argsAST = { k: 'StateRef', n: '$cyclic' };
    cyclicRuntime.replace(next);
    assert.equal(cyclicRuntime.reply({ ...operation, result: {} }), false);
  } finally { cyclicRuntime.dispose(); }
});

test('local DOM mounting updates fields, disposes listeners, and reports an incomplete action', async () => {
  const session = createInterface(library, '$n = 1\nroot = Stack([Counter("n", $n), Text("Value " + $n), Button("Bad", @OpenUrl("https://example.com"))])', { instanceId: 'local' });
  const { document, window } = parseHTML('<main></main>');
  const root = document.querySelector('main');
  const stop = session.runtime.mount(root);
  try {
    await settle(); await settle();
    root.querySelector('[data-oui-component] button').dispatchEvent(new window.Event('click', { bubbles: true }));
    await settle(); await settle();
    assert.equal(session.runtime.getState('$n'), 2); assert.match(root.textContent, /Value 2/);
    session.runtime.setState('$n', 7); await settle(); await settle(); assert.match(root.textContent, /Value 7/);
    session.runtime.setState('$n', 8); session.runtime.setState('$n', 7); await settle(); await settle();
    root.querySelector('[data-oui-action]').dispatchEvent(new window.Event('click', { bubbles: true }));
    await settle(); await settle();
    assert.ok(session.runtime.diagnostics.some(d => /Action did not complete/.test(d.message)));
    const button = root.querySelector('[data-oui-component] button');
    session.patch('root = Button("new", @Set($n, 99))');
    root.querySelector('[data-oui-action]').dispatchEvent(new window.Event('click', { bubbles: true }));
    await settle(); await settle();
    assert.ok(session.runtime.diagnostics.some(d => /Obsolete local action/.test(d.message)));
    stop(); button.dispatchEvent(new window.Event('click', { bubbles: true })); await settle();
    assert.equal(session.runtime.getState('$n'), 7);
  } finally { session.dispose(); }
});

test('local mounting reports an asynchronous rendering failure', async t => {
  const session = createInterface(library, 'root = Text("x")', { instanceId: 'mount-error' });
  t.mock.method(session.runtime, 'render', async () => { throw new Error('render interrupted'); });
  const { document } = parseHTML('<main></main>');
  session.runtime.mount(document.querySelector('main'));
  try { await settle(); assert.ok(session.runtime.diagnostics.some(d => /render interrupted/.test(d.message))); }
  finally { session.dispose(); }
});

test('runtime input contracts reject invalid identities, stale fields, versions and disposed use', async () => {
  const source = '$n = 1\nroot = Counter("n", $n)';
  for (const options of [{ instanceId: '' }, { instanceId: 'invalid id' }, { instanceId: 'x', version: 0 }, { instanceId: 'x', version: 1.5 }])
    assert.throws(() => createInterface(library, source, options));
  const session = createInterface(library, source, { instanceId: 'c' });
  const controller = createWidgetController(session.runtime);
  try {
    const frame = await controller.frame(), id = Object.keys(frame.c)[0];
    const request = tail => controller.handle(JSON.stringify(['c', 1, frame.r, ...tail]));
    await request(['v', frame.c[id].fields[0].handle, 3]); assert.equal(session.runtime.getState('$n'), 3);
    await assert.rejects(request(['v', 'missing', 9]), /no longer present/);
    await assert.rejects(request(['f', id, 'n', 2, 'entry']), /Invalid widget/);
    await assert.rejects(request(['unknown']), /Invalid widget/);
    for (const input of ['', 'x'.repeat(65), '{}', JSON.stringify(['other', 1, frame.r, 'a', '0']), JSON.stringify(['c', 2, frame.r, 'a', '0']), JSON.stringify(['c', 1, frame.r + 1, 'a', '0'])]) await assert.rejects(controller.handle(input));
    assert.equal(await request(['a', 'missing']), false);
    assert.deepEqual(JSON.parse(controller.encode(frame)), JSON.parse(JSON.stringify(frame)));
    assert.equal(controller.save().state.$n, 3);
    assert.throws(() => createWidgetController(session.runtime, { initialFrame: { ...frame, v: 99 } }), /Bootstrap/);
    assert.throws(() => session.runtime.replace(session.runtime.parsed, 1), /increase/);
  } finally { controller.dispose(); }
  assert.throws(() => session.runtime.subscribe(() => {}), /disposed/);
  assert.throws(() => session.runtime.snapshot(), /disposed/);
  assert.throws(() => session.runtime.field('late'), /disposed/);
  await assert.rejects(session.runtime.render(), /disposed/);
});

test('controller concurrency and operation failures remain explicit to the application', async t => {
  t.mock.method(console, 'error', () => {});
  let finish;
  const session = createInterface(library, 'root = Button("Notify", @Notify("done"))', {
    instanceId: 'busy', onAction: () => new Promise(resolve => { finish = resolve; }),
  });
  const controller = createWidgetController(session.runtime);
  try {
    const frame = await controller.frame(), input = JSON.stringify([frame.i, frame.v, frame.r, 'a', '0']);
    const first = controller.handle(input);
    await assert.rejects(controller.handle(input), /already executing/);
    finish(); assert.equal(await first, true);
  } finally { controller.dispose(); }
  for (const onOperation of [undefined, () => { throw new Error('provider failed'); }, () => Promise.reject(new Error('async provider failed')), () => Promise.reject('plain error')]) {
    const instance = createInterface(library, 'q = Query("read", {}, {value: 7})\nroot = Text("" + q.value)', { instanceId: 'failure', onOperation });
    try { await settle(); assert.ok(instance.runtime.diagnostics.some(d => d.code === 'operation-error')); assert.match(await instance.runtime.render(), />7</); }
    finally { instance.dispose(); }
  }
});

test('renderer failures are local, including invalid child data and invalid lifecycle roots', async () => {
  const Bad = defineWidgetComponent({ name: 'Bad', description: '', props: z.object({}), render: ({ renderNode }) => renderNode({ invalid: true }) });
  const Rootless = defineWidgetComponent({ name: 'Rootless', description: '', props: z.object({}), render: () => 'text', mount() {} });
  const Text = library.components.Text;
  const Group = defineWidgetComponent({ name: 'Group', description: '', props: z.object({ children: z.array(z.union([Bad.ref, Rootless.ref, Text.ref])) }), render: ({ props, renderNode }) => renderNode(props.children) });
  const custom = createLibrary({ components: [Bad, Rootless, Text, Group] });
  const session = createInterface(custom, 'root = Group([Bad(), Rootless(), Text("survives")])', { instanceId: 'render-error' });
  try { assert.match(await session.runtime.render(), /survives/); assert.equal(session.runtime.diagnostics.filter(d => d.code === 'render-error').length, 2); }
  finally { session.dispose(); }
});
