import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { parseHTML } from 'linkedom';
import { runInNewContext } from 'node:vm';
import { applyWidgetUpdate, TransportSizeError } from 'openui-telegram';
import { createSimple } from '../dist-examples/simple.js';
import { createFull, scenes, staticExample } from '../dist-examples/full.js';
import { startDemo } from '../examples/demo-server.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function frame(widget) {
  const update = JSON.parse(widget.data);
  return 'd' in update ? applyWidgetUpdate(widget.save().delivery.initialFrame, update) : update;
}
async function press(widget, label) {
  await widget.idle(); const current = frame(widget);
  const { document } = parseHTML(current.h);
  const button = [...document.querySelectorAll('[data-oui-action]')].find(node => node.textContent === label);
  assert.ok(button, label);
  const result = await widget.handle(JSON.stringify([current.i, current.v, current.r, 'a', button.getAttribute('data-oui-action')]));
  await widget.idle(); return result.completed;
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Timed out waiting for demo result');
}

test('simple demo handles taps and resumes the same open document from a JSON checkpoint', async () => {
  const widget = await createSimple(); let resumed;
  try {
    await press(widget, '+1'); await press(widget, '+1');
    const before = frame(widget), saved = JSON.parse(JSON.stringify(widget.save()));
    widget.dispose(); resumed = await createSimple(undefined, saved);
    assert.ok(frame(resumed).r > before.r); assert.match(frame(resumed).h, /Count: 2/);
    await press(resumed, '+1'); assert.match(frame(resumed).h, /Count: 3/);
  } finally { widget.dispose(); resumed?.dispose(); }
});

test('a failed delivery preserves confirmed data and the next stale tap resynchronizes without replaying its action', async () => {
  let offline = false, delivered;
  const widget = await createSimple(event => {
    if (event.kind !== 'data') return;
    if (offline) throw new Error('Transport offline');
    delivered = event.data;
  });
  try {
    await press(widget, '+1');
    const visible = frame(widget), confirmed = delivered;
    const input = JSON.stringify([visible.i, visible.v, visible.r, 'a', '0']);
    offline = true;
    await assert.rejects(widget.handle(input), /Transport offline/); await widget.idle();
    assert.equal(delivered, confirmed); assert.equal(widget.data, confirmed); assert.equal(widget.save().data, confirmed);
    assert.ok(widget.save().delivery.revision > visible.r);
    offline = false;
    const recovered = await widget.handle(input); await widget.idle();
    assert.equal(recovered.completed, false); assert.ok(frame(widget).r > visible.r);
    assert.match(frame(widget).h, /Count: 2/); // First action ran once; recovery did not repeat it.
    await press(widget, '+1'); assert.match(frame(widget).h, /Count: 3/);
    for (const bad of ['bad', JSON.stringify(['wrong', 1, 0, 'a', '0']), JSON.stringify(['simple', 99, 0, 'a', '0']),
      JSON.stringify(['simple', 1, 0, 'invalid', '0']), JSON.stringify(['simple', 1, 0, 'a', '0', null]), 'x'.repeat(65)])
      await assert.rejects(widget.handle(bad));
  } finally { widget.dispose(); }
});

test('all full demo documents fit Telegram and demonstrate tools, actions, editing, errors and explicit overflow recovery', async t => {
  t.mock.method(console, 'error', () => {});
  const widgets = {};
  try {
    for (const name of Object.keys(scenes)) {
      const widget = widgets[name] = await createFull(name, undefined, undefined, 1);
      assert.ok(Buffer.byteLength(widget.html) <= 32768, name);
      assert.ok(deflateSync(widget.html, { level: 9 }).length <= 4096, name);
    }
    const card = await staticExample(); assert.equal(card.html.includes('<script>'), false); assert.match(card.html, /42/);
    await press(widgets.state, '+1'); assert.match(frame(widgets.state).h, /Number: 2; twice: 4/);
    await press(widgets.state, 'Toggle'); assert.doesNotMatch(frame(widgets.state).h, />Visible</);
    await press(widgets.state, 'Reset'); assert.match(frame(widgets.state).h, /Number: 1/);
    await until(() => frame(widgets.query).h.includes('First: 10; dependent: 20'));
    await press(widgets.query, 'Fail'); await until(() => frame(widgets.query).h.includes('Query failed'));
    await press(widgets.query, 'Recover'); await until(() => frame(widgets.query).h.includes('First: 30; dependent: 60'));
    await press(widgets.mutation, '+1'); assert.equal(await press(widgets.mutation, 'Fail'), false);
    assert.match(frame(widgets.mutation).h, /Number: 2/);
    assert.equal(await press(widgets.mutation, 'Save'), true); assert.match(frame(widgets.mutation).h, /Number: 1/);
    assert.match(frame(widgets.mutation).h, /Notify/);
    await press(widgets.editing, '+1');
    await widgets.editing.command('patch'); await widgets.editing.command('stream');
    await widgets.editing.command('restart'); assert.match(frame(widgets.editing).h, /Changed with patch/); assert.match(frame(widgets.editing).h, /Number: 2/);
    await press(widgets.editing, '+1'); await widgets.editing.command('update'); assert.match(frame(widgets.editing).h, /Number: 3/);
    await press(widgets.errors, 'Break / recover'); assert.match(frame(widgets.errors).h, /This neighbor stays/);
    assert.ok(widgets.errors.diagnostics.some(d => d.code === 'render-error'));
    await press(widgets.errors, 'Break / recover'); assert.match(frame(widgets.errors).h, /Component recovered/);
    await widgets.errors.command('parser'); await widgets.errors.command('update'); assert.match(frame(widgets.errors).h, /Component recovered/);
    await assert.rejects(widgets.limits.command('overflow'), TransportSizeError);
    assert.match(frame(widgets.limits).h, /Small update/);
    const overflow = JSON.parse(JSON.stringify(widgets.limits.save())); widgets.limits.dispose();
    widgets.limits = await createFull('limits', undefined, overflow, 1);
    assert.match(frame(widgets.limits).h, /Small update/);
    await widgets.limits.command('replace'); assert.ok(frame(widgets.limits).h.length > 1800);
  } finally { for (const widget of Object.values(widgets)) widget.dispose(); }
});

test('generated form and canvas demo clients keep mounted controls, validate and update real frames', async () => {
  for (const name of ['form', 'graphics']) {
    let page;
    const widget = await createFull(name, event => { if (page && event.kind === 'data') page.push(event.data); }, undefined, 1);
    const { document, window } = parseHTML(widget.html), callbacks = new Map(); let drawings = 0;
    Object.getPrototypeOf(document.createElement('canvas')).getContext = () => ({ clearRect() {}, fillRect() { drawings++; } });
    const sandbox = { document, console, addEventListener() {}, TelegramWidget: {
      chatData: widget.data, ready() {}, onEvent(name, callback) { callbacks.set(name, callback); }, offEvent(name) { callbacks.delete(name); },
      request: async data => ({ result: (await widget.handle(data)).data }),
    } };
    runInNewContext(document.querySelector('script').textContent, sandbox);
    page = { push(data) { sandbox.TelegramWidget.chatData = data; callbacks.get('chatDataChanged')(); } };
    const click = async label => {
      const node = [...document.querySelectorAll('button')].find(node => node.textContent === label); assert.ok(node, label);
      node.dispatchEvent(new window.Event('click', { bubbles: true })); await tick(); await widget.idle(); await tick();
    };
    try {
      if (name === 'form') {
        const local = [...document.querySelectorAll('button')].find(node => node.textContent === '+');
        await click('−'); await click('Send'); assert.doesNotMatch(frame(widget).h, /continue_conversation/);
        await click('+'); await click('Send'); assert.match(frame(widget).h, /continue_conversation/);
        assert.equal([...document.querySelectorAll('button')].find(node => node.textContent === '+'), local);
      } else {
        const canvas = document.querySelector('canvas'); await click('+1');
        assert.equal(document.querySelector('canvas'), canvas); assert.ok(drawings >= 2);
        await click('Canvas / SVG'); assert.ok(document.querySelector('svg')); assert.equal(document.querySelector('canvas'), null);
        await click('Canvas / SVG'); assert.ok(document.querySelector('canvas'));
      }
      assert.deepEqual(Array.from(sandbox.OpenUIWidget.errors), []);
    } finally { sandbox.OpenUIWidget.dispose(); widget.dispose(); }
  }
});

test('HTTP demo routes requests, reports errors and persists delivery through a complete server restart', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'openui-demo-'));
  let demo;
  try {
    demo = await startDemo({ storage });
    assert.match(await (await fetch(demo.url)).text(), /Your first widget/);
    assert.match(await (await fetch(demo.url + '/widget/simple')).text(), /TelegramWidget/);
    const current = frame(demo.widgets.get('simple'));
    const response = await fetch(demo.url + '/request/simple', { method: 'POST', body: JSON.stringify(['simple', current.v, current.r, 'a', '0']) });
    assert.equal(response.status, 200); assert.equal((await response.json()).completed, true);
    assert.equal((await fetch(demo.url + '/request/simple', { method: 'POST', body: 'bad' })).status, 400);
    const last = frame(demo.widgets.get('simple')); await demo.close();
    demo = await startDemo({ storage });
    assert.ok(frame(demo.widgets.get('simple')).r > last.r); assert.match(frame(demo.widgets.get('simple')).h, /Count: 1/);
    const events = await fetch(demo.url + '/events'), reader = events.body.getReader();
    const initialEvent = new TextDecoder().decode((await reader.read()).value);
    assert.match(initialEvent, /"kind":"data"/); assert.match(initialEvent, /"id":"simple"/);
    await reader.cancel();
    const restarted = await fetch(demo.url + '/command/simple', { method: 'POST', body: 'restart' }); assert.equal(restarted.status, 200);
    assert.equal((await fetch(demo.url + '/command/simple', { method: 'POST', body: 'unknown' })).status, 400);
  } finally {
    await demo?.close();
    assert.equal(dirname(resolve(storage)), resolve(tmpdir())); assert.ok(basename(storage).startsWith('openui-demo-'));
    await rm(storage, { recursive: true, force: true });
  }
});
