import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyWidgetUpdate, createWidgetUpdate, utf8Bytes, encodeTransport, TransportSizeError, responseParts, defineWidgetComponent } from 'openui-telegram';
import { z } from 'zod';

const base = () => ({ i: 'contract', v: 2, r: 3, h: 'hello world', c: {}, f: { rows: [1, 2], object: { x: 1 }, nil: null, number: 7 }, e: {}, l: {} });
const update = (d, extra = {}) => ({ i: 'contract', v: 2, r: 4, b: [2, 3], d, ...extra });

test('wire validation rejects wrong instances/bases/versions and malformed paths atomically', () => {
  const original = base();
  for (const extra of [{ i: 'other' }, { b: [1, 3] }, { b: [2, 2] }, { v: 1 }, { r: 3 }, { r: 2 }])
    assert.throws(() => applyWidgetUpdate(original, update([], extra)));
  for (const path of [[], ['unknown'], ['f', 'missing', 'x'], ['f', 'nil', 'x'], ['f', 'number', 'x'], ['f', '__proto__', 'polluted']]) {
    assert.throws(() => applyWidgetUpdate(original, update([[0, ['h'], 'changed'], [0, path, 'bad']])));
    assert.deepEqual(original, base());
  }
  assert.throws(() => createWidgetUpdate(original, { ...original, i: 'other' }), /different interface/);
});

test('text and array deltas enforce types and integer bounds without corrupting the base', () => {
  const original = base();
  assert.throws(() => applyWidgetUpdate(original, update([[3, ['f', 'object'], 0, 0, []]])), /array/);
  assert.throws(() => applyWidgetUpdate(original, update([[2, ['f', 'rows'], [[0, 1, 'x']]]])), /string/);
  for (const [start, remove] of [[-1, 0], [0, -1], [0.5, 0], [0, 0.5], [2, 1], [0, 3]])
    assert.throws(() => applyWidgetUpdate(original, update([[3, ['f', 'rows'], start, remove, [9]]])), /range/);
  for (const [offset, remove] of [[-1, 0], [0, -1], [0.5, 0], [0, 0.5], [11, 1]])
    assert.throws(() => applyWidgetUpdate(original, update([[2, ['h'], [[offset, remove, 'x']]]])), /range/);
  const result = applyWidgetUpdate(original, update([[2, ['h'], [[0, 5, 'goodbye'], [6, 5, 'all']]], [3, ['f', 'rows'], 1, 1, [3, 4]], [1, ['f', 'object']]]));
  assert.equal(result.h, 'goodbye all'); assert.deepEqual(result.f.rows, [1, 3, 4]); assert.equal(Object.hasOwn(result.f, 'object'), false);
  assert.deepEqual(original, base());
});

test('wire updates preserve own prototype-named keys as data', () => {
  const result = applyWidgetUpdate(base(), update([[0, ['f', '__proto__'], { safe: true }]]));
  assert.equal(Object.hasOwn(result.f, '__proto__'), true);
  assert.equal(result.f.__proto__.safe, true); assert.equal(result.f.safe, undefined);
  assert.equal(Object.getPrototypeOf(result.f), Object.prototype);
  const next = structuredClone(result); next.r++; next.f.rows = []; next.f.number = { nested: true }; next.h = '';
  assert.deepEqual(applyWidgetUpdate(result, createWidgetUpdate(result, next)), next);
});

test('UTF-8 transport boundaries count bytes, retain content and expose measured errors', () => {
  assert.equal(utf8Bytes('Aя中🦊'), 10); assert.equal(utf8Bytes(''), 0);
  assert.equal(encodeTransport('x'.repeat(62), 'request'), JSON.stringify('x'.repeat(62)));
  assert.equal(encodeTransport('x'.repeat(1022), 'response').length, 1024);
  assert.equal(encodeTransport('x'.repeat(1022), 'state').length, 1024);
  assert.throws(() => encodeTransport(undefined, 'request'), /serializable/);
  assert.throws(() => encodeTransport('x'.repeat(1023), 'state'), error => error instanceof TransportSizeError && error.field === 'state' && error.bytes === 1025 && error.limit === 1024);
});

test('response segments retain empty, inline, unfinished and quoted fences exactly', () => {
  assert.deepEqual(responseParts(''), []);
  for (const source of ['plain text', '```\n```', '```openui-lang root = Text("inline")\n```\nafter', 'prose\n```openui-lang\nroot = Text("first\n```\nlast \\"quoted\\"\")\n```', '```js\n"unfinished\\']) {
    const parts = responseParts(source);
    assert.equal(parts.map(part => part.raw).join(''), source);
    assert.ok(parts.length);
  }
  assert.equal(responseParts('```openui-lang root = Text("inline")\n```')[0].content, 'root = Text("inline")\n');
  assert.equal(responseParts('```js\n"unfinished\\')[0].complete, false);
  assert.throws(() => defineWidgetComponent({ name: 'Bad', description: '', props: z.object({ value: z.string() }), reactive: ['missing'], render: () => '' }), /Unknown reactive prop/);
});
