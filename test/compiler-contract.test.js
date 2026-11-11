import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLibrary } from '@openuidev/lang-core';
import { z } from 'zod';
import { compileWidget, defineWidgetComponent } from 'openui-telegram';
import { library } from '../dist-test/fixtures/library.js';

test('compiler rejects invalid identifiers, unsafe CSS and exposes parser/render diagnostics', async () => {
  await assert.rejects(compileWidget({ mode: 'static', library, source: '', instanceId: 'bad id' }), /instanceId/);
  await assert.rejects(compileWidget({ mode: 'static', library, source: '', css: '</style>' }), /CSS/);
  const Broken = defineWidgetComponent({ name: 'Broken', description: '', props: z.object({}), render() { throw new Error('broken renderer'); } });
  const broken = await compileWidget({ mode: 'static', library: createLibrary({ components: [Broken] }), source: 'root = Broken()' });
  assert.ok(broken.diagnostics.some(d => d.code === 'render-error'));
  const incomplete = await compileWidget({ mode: 'static', library, source: 'root = Stack([' });
  assert.ok(incomplete.diagnostics.some(d => d.code === 'incomplete'));
  const unresolved = await compileWidget({ mode: 'static', library, source: 'root = missing' });
  assert.ok(unresolved.diagnostics.some(d => d.code === 'unresolved'));
  for (const html of ['\0', '<img src="https://example.com/a.png">']) {
    const Raw = defineWidgetComponent({ name: 'Raw', description: '', props: z.object({}), render: () => html });
    const result = await compileWidget({ mode: 'static', library: createLibrary({ components: [Raw] }), source: 'root = Raw()' });
    assert.ok(result.diagnostics.some(d => d.code === (html === '\0' ? 'invalid-html' : 'network-resource')));
  }
});

test('unsupported markup is diagnosed without treating comments, attributes or script/style strings as elements', async () => {
  for (const [markup, expected] of [
    ['<input value="hello"><iframe></iframe><INPUT>', ['input', 'iframe']],
    ['<select><option>one</option></select><video></video><template></template>', ['select', 'option', 'video', 'template']],
    [`<!-- <input> --><p title='<iframe>'>&lt;input&gt;</p><script>const text = '<select>'; const closing = '</div>';</script><style>p:after{content:'<textarea>'}</style><button>OK</button>`, []],
    [`<script>const comment = '<!--';</script><input><style>p:after{content:'<iframe>'}</style>`, ['input']],
    [`<script>const text = '<input>'`, []],
  ]) {
    const Raw = defineWidgetComponent({ name: 'Raw', description: '', props: z.object({}), render: () => markup });
    const result = await compileWidget({ mode: 'static', library: createLibrary({ components: [Raw] }), source: 'root = Raw()' });
    assert.deepEqual(result.diagnostics.filter(d => d.code === 'unsupported-element').map(d => d.path), expected);
    assert.equal(result.fits, true);
  }
});

test('component CSS follows reachability, conditional branches and explicit future reservations', async () => {
  const Text = defineWidgetComponent({ name: 'Text', description: '', props: z.object({ value: z.string() }), render: ({ props }) => `<p>${props.value}</p>` });
  const Card = defineWidgetComponent({ name: 'Card', description: '', props: z.object({}), css: '.future{color:red}', render: () => '<p class="future">Card</p>' });
  const Huge = defineWidgetComponent({ name: 'Huge', description: '', props: z.object({}), css: '/*' + 'unused'.repeat(6500) + '*/', render: () => '<div>unused</div>' });
  const library = createLibrary({ components: [Text, Card, Huge] });
  const small = await compileWidget({ mode: 'static', library, source: 'root = Text("Hello")', css: 'p{margin:0}' });
  assert.equal(small.fits, true); assert.ok(small.html.length < 300); assert.ok(small.html.includes('p{margin:0}'));
  assert.equal(small.html.includes('unused'), false); assert.equal(small.html.includes('.future'), false);
  for (const options of [
    { source: '$show = false\nroot = $show ? Card() : Text("Hello")' },
    { source: 'root = Text("Hello")', clientComponents: ['Card'] },
  ]) {
    const compiled = await compileWidget({ mode: 'updatable', instanceId: 'css', library, ...options });
    assert.equal(compiled.fits, true); assert.ok(compiled.html.includes('.future'));
    assert.equal(compiled.html.includes('unused'), false); assert.deepEqual(compiled.initialData.clientFeatures.styles, ['Card']);
  }
  const full = await compileWidget({ mode: 'updatable', instanceId: 'css', library, source: 'root = Text("Hello")', clientSpecialization: false });
  assert.equal(full.fits, false); assert.ok(full.html.includes('unused'));
});
