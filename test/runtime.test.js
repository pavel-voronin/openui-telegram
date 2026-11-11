import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLibrary, createParser, evaluateRoot, createStore, action, defineFunction, defineAction, buildMessage, markReactive, isReactiveSchema } from '@openuidev/lang-core';
import { z } from 'zod';
import { createInterface, defineWidgetComponent, compileWidget, encodeTransport, TransportSizeError } from 'openui-telegram';
import { library, source, compileFixture } from '../dist-test/fixtures/library.js';
import { createWidgetController } from 'openui-telegram';
import { parseHTML } from 'linkedom';
import { runInNewContext } from 'node:vm';

const settle = () => new Promise(resolve => setImmediate(resolve));
const plain = html => html.replace(/<[^>]*>/g, '');

test('component reactive registration preserves shared schemas, defaults, refinements and explicit upstream markers', () => {
  const value = z.string().min(2).default('ok');
  const props = z.object({ value }).refine(input => input.value !== 'bad', 'Rejected');
  const reactive = defineWidgetComponent({ name: 'Reactive', description: '', props, reactive: ['value'], render: ({ props, text }) => text(props.value) });
  const plain = defineWidgetComponent({ name: 'Plain', description: '', props, render: ({ props, text }) => text(props.value) });
  assert.equal(isReactiveSchema(value), false);
  assert.equal(isReactiveSchema(plain.props.shape.value), false);
  assert.equal(isReactiveSchema(reactive.props.shape.value), true);
  assert.deepEqual(reactive.props.parse({}), { value: 'ok' });
  assert.equal(reactive.props.safeParse({ value: 'x' }).success, false);
  assert.equal(reactive.props.safeParse({ value: 'bad' }).success, false);
  const explicit = z.number(); markReactive(explicit);
  const marked = defineWidgetComponent({ name: 'Marked', description: '', props: z.object({ value: explicit }), render: () => '' });
  assert.deepEqual(marked.component.reactive, ['value']);
});

test('custom function errors retain upstream diagnostics and leave neighbouring components visible', async () => {
  const fn = () => { throw new Error('Function failed'); };
  const Explode = defineFunction({ name: 'Explode', description: '', params: z.object({ value: z.number() }), returns: z.number(), fn });
  const lib = createLibrary({ components: Object.values(library.components), functions: [Explode] });
  const session = createInterface(lib, '$n = 1\nroot = Stack([Text("working"), Text("" + @Explode($n))])', { instanceId: 'function-error' });
  try {
    const errors = [];
    const expected = evaluateRoot(session.runtime.parsed, { library: lib, store: session.runtime.store, errors,
      ctx: { getState: name => session.runtime.getState(name), resolveRef: () => null,
        functions: { Explode: { ...lib.toJSONSchema().functions.Explode, fn } } } });
    assert.equal(expected.props.children[0].props.value, 'working');
    assert.match(await session.runtime.render(), /working/);
    assert.ok(errors.length > 0);
    assert.deepEqual(session.runtime.diagnostics, errors);
  } finally { session.dispose(); }
});

test('reactive root, nested arrays and functions agree with upstream evaluation', async () => {
  const Text = defineWidgetComponent({ name: 'Text', description: '', props: z.object({ value: z.string() }), render: ({ props, text }) => text(props.value) });
  const lib = createLibrary({ components: [Text], functions: [defineFunction({ name: 'Twice', description: '', params: z.object({ value: z.number() }), returns: z.number(), fn: ({ value }) => value * 2 })] });
  for (const expression of ['$n + 1', '@Twice($n)', '@Count([1, 2, 3])', '@Count(null)', '@First([])', '@Last([1, 2])',
    '@Sum([1, 2, 3])', '@Avg([])', '@Avg([1, 2])', '@Min([-2, 3])', '@Max([])',
    '@Sort([{n: 2}, {n: 1}], "n")', '@Filter([{n: 2}, {n: 1}], "n", ">", 1)',
    '@Round([1.234, 2.345], 2)', '@Abs([-1, 2])', '@Floor([1.8, -1.2])', '@Ceil([1.2, -1.8])',
    '@Each([1, 2, 3], item, item * $n)', '@Each(null, item, item)', '$n == 0 ? "zero" : "other"']) {
    const source = `$n = 1\nroot = Text("" + (${expression}))`;
    const session = createInterface(lib, source, { instanceId: 'differential' });
    try {
      for (const n of [0, 3, -1]) {
        session.runtime.setState('$n', n);
        const parsed = createParser(lib.toJSONSchema(), lib.root).parse(source);
        const store = createStore(); store.initialize(parsed.stateDeclarations, { $n: n });
        const schema = lib.toJSONSchema();
        const expected = evaluateRoot(parsed, { library: lib, store, ctx: { getState: key => store.get(key), resolveRef: () => null,
          functions: Object.fromEntries(Object.entries(lib.functions).map(([name, f]) => [name, { ...schema.functions[name], fn: f.fn }])) } });
        assert.equal(plain(await session.runtime.render()), expected.props.value);
        store.dispose();
      }
    } finally { session.dispose(); }
  }
});

test('query dependencies, mutation order, failure, custom events and restoration', async () => {
  const calls = [], events = [];
  let fail = false;
  const options = { instanceId: 'flows', onAction: event => events.push(event), onOperation: async operation => {
    calls.push(operation);
    if (operation.type === 'mutation' && fail) throw new Error('rejected');
    return { value: operation.args.count };
  } };
  const session = createInterface(library, source, options);
  try {
    await settle();
    assert.equal(calls[0].type, 'query');
    assert.equal(calls.filter(c => c.type === 'mutation').length, 0);
    assert.match(await session.runtime.render(), /Count: 1/);
    session.runtime.setState('$count', 3); await settle();
    assert.equal(calls.at(-1).args.count, 3);
    assert.match(await session.runtime.render(), /Count: 3/);
    assert.equal(await session.runtime.click('0'), true); // toggle
    assert.equal(session.runtime.getState('$visible'), false);
    assert.match(await session.runtime.render(), /<svg/);
    assert.equal(await session.runtime.click('1'), true); // save
    await settle();
    assert.equal(calls.filter(c => c.type === 'mutation').length, 1);
    assert.equal(session.runtime.getState('$count'), 1);
    assert.equal(events[0].type, 'Notify');
    session.runtime.setState('$count', 5); fail = true;
    await session.runtime.render();
    assert.equal(await session.runtime.click('1'), false);
    assert.equal(session.runtime.getState('$count'), 5);
    assert.equal(events.length, 1);
    assert.equal(session.runtime.queries.getMutationResult('save').status, 'error');
    const saved = session.runtime.snapshot();
    const before = calls.filter(c => c.type === 'mutation').length;
    const restored = createInterface(library, source, { ...options, instanceId: 'restored', initialState: saved });
    try { assert.match(await restored.runtime.render(), /Count: 5/); await settle(); assert.equal(calls.filter(c => c.type === 'mutation').length, before); }
    finally { restored.dispose(); }
  } finally { session.dispose(); }
});

test('streaming, stored messages, patch deletion and state preservation use upstream rules', async () => {
  const session = createInterface(library, '', { instanceId: 'stream', onOperation: async () => ({ value: 1 }) });
  try {
    for (let i = 0; i < source.length; i += 7) session.push(source.slice(i, i + 7), i + 7 >= source.length);
    assert.deepEqual(session.runtime.parsed, createParser(library.toJSONSchema(), library.root).parse(source));
    session.runtime.setState('$count', 7);
    session.patch('title = Text("patched " + $count)\nchart = null');
    assert.equal(session.runtime.getState('$count'), 7);
    assert.match(await session.runtime.render(), /patched 7/);
    const stored = buildMessage({ content: source, context: { formState: { state: { $count: 9 }, forms: {} } }, end: true });
    session.update(stored);
    assert.equal(session.message.end, true);
    assert.equal(session.runtime.getState('$count'), 7);
    session.restoreContext(context => context.formState);
    assert.equal(session.runtime.getState('$count'), 9);
  } finally { session.dispose(); }
});

test('forms work with reactive controls, independent scopes and upstream validation', async () => {
  const session = createInterface(library, source, { instanceId: 'forms', onOperation: async () => ({ value: 0 }) });
  try {
    await session.runtime.render();
    assert.equal(session.runtime.form('entry').values.count, 1);
    session.runtime.setState('$count', -1);
    assert.ok(session.runtime.form('entry').errors.count);
    session.runtime.field('title', 'initial', { scope: 'a', rules: { required: true } }).setValue('');
    session.runtime.field('title', 'other', { scope: 'b' });
    assert.ok(session.runtime.form('a').errors.title);
    assert.equal(session.runtime.form('b').values.title, 'other');
  } finally { session.dispose(); }
});

test('transport size checks reject oversized data without truncation', () => {
  assert.throws(() => encodeTransport({value: 'x'.repeat(100)}, 'request'), TransportSizeError);
});

test('compiler is offline, bundles resources, reports whole-document sizes and separates tool errors', async () => {
  const result = await compileFixture();
  assert.ok(result.html.includes('<script>'));
  assert.equal(result.measurement.html.bytes, Buffer.byteLength(result.html));
  assert.ok(result.measurement.clientRuntime.bytes > 0);
  assert.ok(result.measurement.clientRuntime.compressedBytes > 0);
  assert.equal(result.measurement.clientRuntime.containsLanguageRuntime, false);
  assert.equal(result.measurement.headroom.htmlBytes, 32768 - Buffer.byteLength(result.html));
  assert.equal(result.measurement.headroom.compressedHtmlBytes, 4096 - result.measurement.compressedHtml.bytes);
  assert.ok(result.measurement.compressedHtml.bytes > 0);
  assert.equal(result.measurement.fullFrame.bytes, Buffer.byteLength(JSON.stringify(result.initialData.frame)));
  assert.ok(result.measurement.transportFrame.bytes < result.measurement.fullFrame.bytes);
  assert.equal(result.profile.openui, '1.1.0');
  assert.ok(!result.diagnostics.some(d => d.source === 'transport'));
  assert.equal(result.fits, true);
  const oversized = await compileWidget({ mode: 'static', library, source: 'root = Text("x")', instanceId: 'big', css: 'x'.repeat(33000) });
  assert.equal(oversized.fits, false);
  assert.ok(oversized.diagnostics.some(d => d.code === 'size-limit'));
  const invalid = await compileWidget({ mode: 'static', library, source: 'root = Unknown()', instanceId: 'bad' });
  assert.ok(invalid.diagnostics.some(d => d.source === 'parser'));
});

test('restoring an existing application runtime displays saved mutation results until explicitly run again', async () => {
  let value = 7, calls = 0;
  const session = createInterface(library, 'save = Mutation("save", {})\nroot = Stack([Text("" + save.status + ":" + save.data.value), Button("Save", @Run(save))])', {
    instanceId: 'restore-result', onOperation: () => { calls++; return { value }; },
  });
  try {
    await session.runtime.render(); await session.runtime.click('0');
    const saved = session.runtime.snapshot();
    value = 9; await session.runtime.click('0');
    assert.match(await session.runtime.render(), /success:9/);
    session.runtime.restore(saved);
    assert.match(await session.runtime.render(), /success:7/);
    assert.equal(calls, 2);
    await session.runtime.click('0');
    assert.match(await session.runtime.render(), /success:9/);
    assert.equal(calls, 3);
  } finally { session.dispose(); }
});

test('compiled Telegram document handles state, SVG/canvas, versions and cleanup through the public controller', async () => {
  const compiled = await compileFixture();
  const session = createInterface(library, source, { instanceId: 'demo', onOperation: async op => ({ value: op.args.count }) });
  const controller = createWidgetController(session.runtime);
  const initial = await controller.frame();
  const { document, window } = parseHTML(compiled.html);
  const draws = [], events = new Map(), requests = [];
  const prototype = Object.getPrototypeOf(document.querySelector('canvas'));
  prototype.getContext = () => ({ clearRect() {}, fillRect(...args) { draws.push(args); }, fillStyle: '' });
  const env = {
    chatData: JSON.stringify(initial), ready() {},
    onEvent: (name, callback) => events.set(name, callback),
    offEvent: name => events.delete(name),
    request(data) {
      requests.push(data);
      return controller.handle(data).then(() => controller.frame()).then(frame => ({ result: controller.encode(frame) }));
    },
  };
  const sandbox = { document, TelegramWidget: env, console, addEventListener() {} };
  try {
    runInNewContext(document.querySelector('script').textContent, sandbox);
    const widget = sandbox.OpenUIWidget;
    assert.ok(draws.length > 0);
    document.querySelector('button').dispatchEvent(new window.Event('click', { bubbles: true }));
    await settle();
    assert.equal(session.runtime.getState('$count'), 2);
    assert.match(document.body.textContent, /Count: 2/);
    assert.deepEqual(draws.at(-1), [0, 0, 16, 40]);
    const old = JSON.parse(JSON.stringify(initial));
    assert.equal(widget.apply(old), false);
    for (let i = 0; i < 6; i++) {
      document.querySelector('[data-oui-action="0"]').dispatchEvent(new window.Event('click', { bubbles: true }));
      await settle();
    }
    assert.equal(requests.length, 7);
    assert.equal(widget.errors.length, 0);
    session.patch('title = Text("Updated " + $count)');
    assert.equal(widget.apply(await controller.frame()), true);
    assert.match(document.body.textContent, /Updated 2/);
    const before = requests.length;
    widget.dispose();
    document.querySelector('button').dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.equal(requests.length, before);
    assert.equal(events.size, 0);
  } finally { controller.dispose(); }
});

test('query dependencies wait, and a failed operation remains visible to the application', async () => {
  const calls = [];
  const session = createInterface(library, 'a = Query("first", {}, {id: 0})\nb = Query("second", {id: a.id}, {value: 0})\nroot = Text("" + b.value)', {
    instanceId: 'deps', onOperation: async op => { calls.push(op); if (op.tool === 'first') return { id: 42 }; throw new Error('offline'); },
  });
  try {
    await settle(); await settle();
    assert.deepEqual(calls.map(c => c.tool), ['first', 'second']);
    assert.equal(calls[1].args.id, 42);
    assert.ok(session.runtime.diagnostics.some(d => d.source === 'transport' && d.message === 'offline'));
    assert.ok(session.runtime.querySnapshot.__openui_errors.some(d => d.source === 'query'));
  } finally { session.dispose(); }
});

test('OpenUrl preserves the gesture and rejects a link after async steps before mutation runs', async () => {
  const opened = [], calls = [];
  const session = createInterface(library, source, { instanceId: 'links', openUrl: url => opened.push(url), onOperation: op => { calls.push(op); return {}; } });
  try {
    const pending = session.runtime.trigger({ steps: [{ type: 'open_url', url: 'https://example.com' }] });
    assert.deepEqual(opened, ['https://example.com']); assert.equal(await pending, true);
    const before = calls.length;
    assert.equal(await session.runtime.trigger({ steps: [{ type: 'run', refType: 'mutation', statementId: 'save' }, { type: 'open_url', url: 'https://example.com' }] }), false);
    assert.equal(calls.length, before);
    assert.ok(session.runtime.diagnostics.some(d => d.code === 'gesture-required'));
  } finally { session.dispose(); }
});

test('root fallback, defaults and local recovery retain upstream parser diagnostics', async () => {
  const Text = defineWidgetComponent({ name: 'Text', description: '', props: z.object({ value: z.string().default('default') }), render: ({ props, text }) => text(props.value) });
  const Stack = defineWidgetComponent({ name: 'Stack', description: '', props: z.object({ children: z.array(Text.ref) }), render: ({ props, renderNode }) => renderNode(props.children) });
  const lib = createLibrary({ components: [Text, Stack], root: 'Stack' });
  for (const program of ['page = Stack([Text()])', 'root = Stack([Text("ok"), Missing()])', 'root = a\na = Text("forward")', 'root = Text("old")\nroot = Text(null)']) {
    const session = createInterface(lib, program, { instanceId: 'recovery' });
    try {
      assert.deepEqual(session.runtime.parsed, createParser(lib.toJSONSchema(), lib.root).parse(program));
      assert.ok(plain(await session.runtime.render()).length > 0);
    } finally { session.dispose(); }
  }
});

test('documented refresh is owned by upstream and stops on dispose', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const calls = [];
  const session = createInterface(library, 'q = Query("read", {}, {value: 0}, 30)\nroot = Text("" + q.value)', {
    instanceId: 'refresh', onOperation: op => { calls.push(op); return { value: calls.length }; },
  });
  await settle();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(30000); await settle();
  assert.equal(calls.length, 2);
  session.dispose(); t.mock.timers.tick(30000); await settle();
  assert.equal(calls.length, 2);
});

test('form scope, validation and ToAssistant preserve state at action time', async () => {
  const events = [];
  const Control = defineWidgetComponent({ name: 'Control', description: '', props: z.object({ value: z.string() }), reactive: ['value'],
    render: ({ props, field, text }) => text(field('name', props.value, { rules: { required: true } }).value) });
  const Button = defineWidgetComponent({ name: 'Button', description: '', props: z.object({ action: action() }),
    render: ({ props, action }) => `<button ${action(props.action)}>Send</button>` });
  const Form = defineWidgetComponent({ name: 'Form', description: '', props: z.object({ name: z.string(), children: z.array(z.union([Control.ref, Button.ref])) }),
    render: ({ props, renderNode }) => renderNode(props.children, { scope: props.name }) });
  const lib = createLibrary({ components: [Control, Button, Form] });
  const session = createInterface(lib, '$name = ""\nroot = Form("entry", [Control($name), Button(@ToAssistant("Send", {id: 42}))])', {
    instanceId: 'formScope', onAction: event => events.push(event),
  });
  try {
    await session.runtime.render();
    assert.equal(await session.runtime.click('0'), false);
    session.runtime.setState('$name', 'Pavel');
    await session.runtime.render();
    assert.equal(await session.runtime.click('0'), true);
    assert.deepEqual(events[0], { type: 'continue_conversation', humanFriendlyMessage: 'Send',
      params: { context: { id: 42 } }, formState: { name: 'Pavel' }, formName: 'entry' });
    const saved = session.runtime.snapshot();
    const restored = createInterface(lib, session.source, { instanceId: 'formRestored', initialState: saved });
    try { assert.equal(plain(await restored.runtime.render()), 'PavelSend'); }
    finally { restored.dispose(); }
  } finally { session.dispose(); }
});

test('stream diagnostics wait for completion, and prose/fences/stored context remain available', () => {
  const session = createInterface(library, '', { instanceId: 'parts' });
  try {
    session.push('Explanation\n```openui-lang\nroot = Missing(');
    assert.equal(session.diagnostics.filter(d => d.source === 'parser').length, 0);
    assert.equal(session.parts[0].content, 'Explanation\n');
    assert.equal(session.parts[1].kind, 'code');
    session.push(')\n```', true);
    assert.ok(session.diagnostics.some(d => d.source === 'parser'));
    assert.equal(session.parts.map(part => part.raw).join(''), session.message.content);
  } finally { session.dispose(); }
});
