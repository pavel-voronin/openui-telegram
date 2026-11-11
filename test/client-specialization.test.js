import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createLibrary, action } from '@openuidev/lang-core';
import { compileWidget, createInterface, createWidgetController, defineWidgetComponent } from 'openui-telegram';
import { compileScenario, createScenario } from '../dist-test/fixtures/scenarios.js';
import { library } from '../dist-test/fixtures/library.js';
import { components } from './fixtures/specialized-components.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

test('component type changes and remounts discard old local DOM while same-type updates preserve it', async () => {
  const library = createLibrary({ components: ['A', 'B'].map(name =>
    defineWidgetComponent({ name, description: '', props: z.object({}), ...components[name] })) });
  const source = '$show = true\nroot = $show ? A() : B()';
  for (const clientSpecialization of [true, false]) {
    const compiled = await compileWidget({ mode: 'updatable', library, source, instanceId: 'types', clientSpecialization,
      clientEntry: resolve('test/fixtures/specialized-components.js') });
    const session = createInterface(library, source, { instanceId: 'types' });
    const controller = createWidgetController(session.runtime, { initialFrame: compiled.initialData.frame });
    const page = client(compiled, async () => ({ result: null }));
    try {
      const old = page.document.querySelector('button');
      session.runtime.setState('$show', false); page.push(controller.encode(await controller.frame()));
      assert.deepEqual([...page.document.querySelectorAll('button')].map(b => b.textContent), ['B']);
      assert.equal(page.document.querySelector('[data-local-owner]').getAttribute('data-local-owner'), 'B');
      assert.equal(page.sandbox.lifecycleDisposals, 1);
      old.dispatchEvent(new page.window.Event('click')); assert.equal(page.sandbox.localClicks, undefined);
      const same = page.document.querySelector('button');
      page.push(controller.encode(await controller.frame())); assert.equal(page.document.querySelector('button'), same);
      session.runtime.setState('$show', true); page.push(controller.encode(await controller.frame()));
      assert.equal(page.sandbox.lifecycleDisposals, 2);
      page.widget.dispose(); assert.equal(page.document.querySelectorAll('button').length, 0);
      assert.equal(page.document.querySelector('[data-local-owner]'), null);
      runInNewContext(page.document.querySelector('script').textContent, page.sandbox);
      assert.deepEqual([...page.document.querySelectorAll('button')].map(b => b.textContent), ['A']);
      assert.equal(page.sandbox.lifecycleMounts, 4);
      page.sandbox.OpenUIWidget.dispose(); assert.equal(page.sandbox.lifecycleDisposals, 4);
    } finally { page.sandbox.OpenUIWidget.dispose(); controller.dispose(); }
  }
});

test('native links use the same explicit form validation as runtime clicks and keep synchronous valid taps', async () => {
  for (const scope of ['order', '']) {
    const Link = defineWidgetComponent({ name: 'Link', description: '', props: z.object({ value: z.string(), go: action() }), reactive: ['value'],
      render({ props, field, action }) {
        field('name', props.value, { scope, rules: { required: true } });
        return `<button ${action(props.go, { form: scope })}>Open</button>`;
      } });
    const library = createLibrary({ components: [Link] }), opened = [];
    const source = '$name = ""\nroot = Link($name, @OpenUrl("https://t.me/telegram"))';
    const compiled = await compileWidget({ mode: 'updatable', library, source, instanceId: 'formlink' });
    const session = createInterface(library, source, { instanceId: 'formlink', openUrl: url => opened.push(url) });
    const controller = createWidgetController(session.runtime, { initialFrame: compiled.initialData.frame });
    let requests = 0;
    const page = client(compiled, async data => {
      requests++; assert.equal(await controller.handle(data), false);
      return { result: controller.encode(await controller.frame()) };
    });
    page.env.openTelegramLink = url => opened.push(url);
    try {
      const initial = await controller.frame(); page.push(controller.encode(initial));
      assert.deepEqual(initial.l, {}); assert.equal(await session.runtime.click('0'), false);
      await page.click('Open'); await settle(); assert.deepEqual(opened, []); assert.equal(requests, 1);
      assert.equal(session.runtime.form(scope).errors.name, 'This field is required');
      session.runtime.setState('$name', 'valid'); const next = await controller.frame();
      assert.equal(next.l['0'], 'https://t.me/telegram'); page.push(controller.encode(next));
      page.document.querySelector('button').dispatchEvent(new page.window.Event('click', { bubbles: true }));
      assert.deepEqual(opened, ['https://t.me/telegram']); assert.equal(requests, 1);
      assert.equal(await session.runtime.click('0'), true); assert.equal(opened.length, 2);
      assert.equal(page.widget.errors.length, 0);
    } finally { page.widget.dispose(); controller.dispose(); }
  }
});

test('patch CSS dependencies are checked atomically for both full frames and deltas', async () => {
  const Text = defineWidgetComponent({ name: 'Text', description: '', props: z.object({ value: z.string() }), render: ({ props }) => `<p>${props.value}</p>` });
  const Card = defineWidgetComponent({ name: 'Card', description: '', props: z.object({}), css: '.card{color:red}', render: () => '<div class="card">Card</div>' });
  const library = createLibrary({ components: [Text, Card] }), source = 'root = Text("initial")';
  for (const mode of ['unreserved', 'reserved', 'full']) {
    const compiled = await compileWidget({ mode: 'updatable', library, source, instanceId: 'styles',
      clientComponents: mode === 'reserved' ? ['Card'] : undefined, clientSpecialization: mode !== 'full' });
    const session = createInterface(library, source, { instanceId: 'styles' });
    const controller = createWidgetController(session.runtime, { initialFrame: compiled.initialData.frame });
    const page = client(compiled, async () => ({ result: null }));
    try {
      session.patch('root = Card()'); const next = await controller.frame(); assert.deepEqual(next.s, ['Card']);
      if (mode === 'unreserved') {
        assert.throws(() => page.widget.apply(next), /Styles for Card.*new widget.*clientComponents/);
        assert.equal(page.widget.current.v, 1); assert.equal(page.document.getElementById('openui-root').textContent, 'initial');
        page.push(controller.encode(next)); assert.equal(page.widget.errors.length, 1);
        assert.equal(page.widget.current.v, 1); assert.equal(page.document.querySelector('.card'), null);
      } else {
        assert.equal(page.widget.apply(next), true); assert.equal(page.document.querySelector('.card').textContent, 'Card');
        assert.match(page.document.querySelector('style').textContent, /\.card/);
        page.push(controller.encode(await controller.frame())); assert.equal(page.widget.errors.length, 0);
      }
      session.patch('root = Text("after")');
      page.push(controller.encode(await controller.frame(), mode === 'unreserved' ? compiled.initialData.frame : next));
      assert.equal(page.document.getElementById('openui-root').textContent, 'after');
      assert.equal(page.widget.current.s, undefined);
    } finally { page.widget.dispose(); controller.dispose(); }
  }
});
function client(compiled, request) {
  const { document, window } = parseHTML(compiled.html), events = new Map();
  Object.getPrototypeOf(document.createElement('canvas')).getContext = function () {
    const canvas = this;
    return { clearRect() {}, fillRect(...args) { canvas.lastDraw = args; }, fillStyle: '' };
  };
  const env = { chatData: null, ready() {}, request,
    onEvent(name, callback) { events.set(name, callback); }, offEvent(name) { events.delete(name); } };
  const sandbox = { document, console, TelegramWidget: env, lifecycleMounts: 0, lifecycleDisposals: 0, addEventListener() {} };
  runInNewContext(document.querySelector('script').textContent, sandbox);
  return { document, window, env, sandbox, widget: sandbox.OpenUIWidget,
    push(data) { env.chatData = data; events.get('chatDataChanged')(); },
    async click(label) {
      const button = [...document.querySelectorAll('button')].find(node => node.textContent === label);
      assert.ok(button, `Missing button ${label}`);
      button.dispatchEvent(new window.Event('click', { bubbles: true })); await settle();
    },
  };
}

test('specialized and full clients produce identical results in all four demo flows', async () => {
  const sequences = { state: ['+1', 'Вид', 'Вид', '+1'], query: ['Фильтр', 'Ошибка', 'Фильтр'],
    save: ['+1', '+1', 'Сбой', 'Сохранить'], edit: ['+1', 'Запомнить', '+1', 'Patch', 'Вернуть', '+1'] };
  for (const [name, sequence] of Object.entries(sequences)) {
    const runs = [];
    try {
      for (const specialized of [false, true]) {
        const compiled = await compileScenario(name, 'demo', { clientSpecialization: specialized });
        const demo = createScenario(name, 'demo', () => {}, async () => {});
        const page = client(compiled, data => demo.handle(data).then(() => demo.frame())
          .then(frame => ({ result: demo.encode(frame, compiled.initialData.frame) })));
        await settle(); page.push(demo.encode(await demo.frame(), compiled.initialData.frame));
        runs.push({ compiled, demo, page });
      }
      assert.ok(runs[1].compiled.measurement.compressedHtml.bytes < runs[0].compiled.measurement.compressedHtml.bytes, name);
      for (const label of sequence) {
        for (const { demo, page, compiled } of runs) {
          await page.click(label); await settle();
          page.push(demo.encode(await demo.frame(), compiled.initialData.frame));
          assert.equal(page.widget.errors.length, 0, name + ': ' + label);
        }
        assert.equal(runs[1].page.document.getElementById('openui-root').innerHTML,
          runs[0].page.document.getElementById('openui-root').innerHTML, name + ': ' + label);
        assert.deepEqual(runs[1].page.document.querySelector('canvas')?.lastDraw,
          runs[0].page.document.querySelector('canvas')?.lastDraw);
      }
      const features = runs[1].compiled.initialData.clientFeatures;
      assert.equal(features.fields, false); assert.equal(features.forms, false);
      assert.deepEqual(features.components, name === 'state' ? ['Plot'] : []);
    } finally { for (const { demo, page } of runs) { page.widget.dispose(); demo.dispose(); } }
  }
});

test('declared destructuring does not hide context services read through arguments', async () => {
  const component = defineWidgetComponent({ name: 'Arguments', description: '', props: z.object({}), ...components.Arguments });
  const library = createLibrary({ components: [component] });
  for (const specialized of [true, false]) {
    const compiled = await compileWidget({ mode: 'updatable', instanceId: 'arguments', library, source: 'root = Arguments()',
      clientSpecialization: specialized, clientEntry: resolve('test/fixtures/specialized-components.js') });
    assert.equal(compiled.initialData.clientFeatures.text, true); assert.deepEqual(compiled.diagnostics, []);
    const page = client(compiled, async () => ({ result: null }));
    try { assert.equal(page.document.querySelector('[data-oui-component]').textContent, '&lt;'); assert.equal(page.widget.errors.length, 0); }
    finally { page.widget.dispose(); }
  }
});

test('opaque lifecycle callbacks retain form/field services and unused client implementations disappear', async () => {
  const Input = defineWidgetComponent({ name: 'Input', description: '', props: z.object({ name: z.string(), value: z.string(), next: z.string() }), ...components.Input });
  const Unused = defineWidgetComponent({ name: 'Unused', description: '', props: z.object({}), ...components.Unused });
  const lib = createLibrary({ components: [Input, Unused] });
  const source = '$name = ""\nroot = Input("name", $name, "OK")';
  const compiled = await compileWidget({ mode: 'updatable', library: lib, source, instanceId: 'opaque', clientEntry: resolve('test/fixtures/specialized-components.js') });
  assert.equal(compiled.initialData.clientFeatures.fields, true); assert.equal(compiled.initialData.clientFeatures.forms, true);
  assert.equal(compiled.html.includes('UNUSED_'), false);
  const session = createInterface(lib, source, { instanceId: 'opaque' });
  const controller = createWidgetController(session.runtime, { initialFrame: compiled.initialData.frame });
  const page = client(compiled, data => controller.handle(data).then(() => controller.frame()).then(frame => ({ result: controller.encode(frame) })));
  try {
    page.push(controller.encode(await controller.frame()));
    assert.equal(page.document.querySelector('button').getAttribute('data-errors'), 'name');
    await page.click('Empty');
    assert.equal(session.runtime.getState('$name'), 'OK');
    assert.equal(page.document.querySelector('button').getAttribute('data-errors'), '');
    assert.equal(page.widget.errors.length, 0);
  } finally { page.widget.dispose(); controller.dispose(); }
});

test('inactive branches retain lifecycle code, and reserving a component supports a later patch', async () => {
  for (const mode of ['branch', 'reserve', 'full']) {
    const conditional = mode === 'branch';
    const source = conditional ? '$n = 1\n$show = false\nroot = Stack([$show ? Counter("n", $n) : null, Button("Show", @Set($show, true))])' : 'root = Text("initial")';
    const compiled = await compileWidget({ mode: 'updatable', library, source, instanceId: 'reserved', clientEntry: resolve('dist-test/fixtures/client-components.js'),
      clientComponents: mode === 'reserve' ? ['Counter'] : undefined, clientSpecialization: mode === 'full' ? false : undefined });
    assert.ok(compiled.initialData.clientFeatures.components.includes('Counter'));
    if (mode !== 'full') assert.deepEqual(compiled.initialData.clientFeatures.components, ['Counter']);
    const session = createInterface(library, source, { instanceId: 'reserved' });
    const controller = createWidgetController(session.runtime, { initialFrame: compiled.initialData.frame });
    const page = client(compiled, data => controller.handle(data).then(() => controller.frame()).then(frame => ({ result: controller.encode(frame) })));
    try {
      page.push(controller.encode(await controller.frame()));
      if (conditional) await page.click('Show');
      else { session.patch('$n = 1\nroot = Counter("n", $n)'); page.push(controller.encode(await controller.frame())); }
      await page.click('1');
      assert.equal(session.runtime.getState('$n'), 2);
      assert.equal(page.widget.errors.length, 0);
    } finally { page.widget.dispose(); controller.dispose(); }
  }
});

test('a patch requiring unbundled lifecycle code is rejected before changing the visible frame', async () => {
  const source = '$n = 1\nroot = Text("initial " + $n)';
  const compiled = await compileWidget({ mode: 'updatable', library, source, instanceId: 'bounded', clientEntry: resolve('dist-test/fixtures/client-components.js') });
  const session = createInterface(library, source, { instanceId: 'bounded' });
  const controller = createWidgetController(session.runtime, { initialFrame: compiled.initialData.frame });
  const page = client(compiled, async () => { throw new Error('Unexpected request'); });
  try {
    session.patch('root = Counter("n", $n)');
    const next = await controller.frame();
    assert.throws(() => page.widget.apply(next), /new widget.*clientComponents/);
    assert.match(page.document.getElementById('openui-root').textContent, /initial 1/);
    assert.equal(page.widget.current.v, 1);
  } finally { page.widget.dispose(); controller.dispose(); }
});

test('specialized mount-only components keep returned disposers without adding field/form/event helpers', async () => {
  const Disposable = defineWidgetComponent({ name: 'Disposable', description: '', props: z.object({}), ...components.Disposable });
  const lib = createLibrary({ components: [Disposable, library.components.Text] });
  const source = '$show = true\nroot = $show ? Disposable() : Text("gone")';
  const compiled = await compileWidget({ mode: 'updatable', library: lib, source, instanceId: 'cleanup', clientEntry: resolve('test/fixtures/specialized-components.js') });
  const features = compiled.initialData.clientFeatures;
  assert.equal(features.mount, true); assert.equal(features.events, false); assert.equal(features.fields, false); assert.equal(features.forms, false);
  const session = createInterface(lib, source, { instanceId: 'cleanup' });
  const controller = createWidgetController(session.runtime, { initialFrame: compiled.initialData.frame });
  const page = client(compiled, async () => { throw new Error('Unexpected request'); });
  try {
    assert.equal(page.sandbox.lifecycleMounts, 1);
    session.runtime.setState('$show', false); page.push(controller.encode(await controller.frame()));
    assert.equal(page.sandbox.lifecycleDisposals, 1);
    session.runtime.setState('$show', true); page.push(controller.encode(await controller.frame()));
    assert.equal(page.sandbox.lifecycleMounts, 2);
    page.widget.dispose(); assert.equal(page.sandbox.lifecycleDisposals, 2);
  } finally { page.widget.dispose(); controller.dispose(); }
});

test('lifecycle receiver dependencies keep their render helper instead of stripping live code', async () => {
  const Dependent = defineWidgetComponent({ name: 'Dependent', description: '', props: z.object({}), ...components.Dependent });
  const compiled = await compileWidget({ mode: 'updatable', library: createLibrary({ components: [Dependent] }), source: 'root = Dependent()',
    instanceId: 'dependency', clientEntry: resolve('test/fixtures/specialized-components.js') });
  const page = client(compiled, async () => { throw new Error('Unexpected request'); });
  try {
    assert.equal(page.document.querySelector('[data-oui-component]').getAttribute('data-helper'), 'present');
    assert.equal(page.widget.errors.length, 0);
  } finally { page.widget.dispose(); }
});
