import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { javascriptData } from '../dist/javascript-data.js';

test('bootstrap literals preserve special values, sparse arrays and own prototype keys', () => {
  const data = JSON.parse('{"__proto__":{"polluted":true}}');
  data.values = [undefined, NaN, Infinity, -Infinity, -0, , ];
  data.text = '</script>\u2028\u2029';
  const code = javascriptData(data);
  assert.equal(code.includes('</script>'), false);
  const restored = runInNewContext('(' + code + ')');
  assert.equal(Object.hasOwn(restored, '__proto__'), true);
  assert.equal(restored.polluted, undefined);
  assert.equal(restored.__proto__.polluted, true);
  assert.equal(restored.values.length, data.values.length);
  for (let i = 0; i < data.values.length; i++) {
    assert.equal(Object.hasOwn(restored.values, i), Object.hasOwn(data.values, i));
    assert.ok(Object.is(restored.values[i], data.values[i]));
  }
  assert.equal(restored.text, data.text);
  assert.equal(Object.getPrototypeOf(runInNewContext('(' + javascriptData(Object.create(null)) + ')')), null);
});

test('bootstrap serialization rejects executable accessors and cyclic objects', () => {
  let invoked = false;
  const object = { get value() { invoked = true; return 'secret'; } };
  assert.throws(() => javascriptData(object), /Accessor/);
  assert.equal(invoked, false);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => javascriptData(cycle), /acyclic/);
  assert.throws(() => javascriptData(new Date()), /plain data/);
  assert.throws(() => javascriptData({ [Symbol('key')]: true }), /Symbol/);
  assert.throws(() => javascriptData(1n), /acyclic data/);
  assert.equal(javascriptData([]), '[]');
  assert.equal(javascriptData([, 1]), '[,1]');
  assert.equal(javascriptData('plain'), '"plain"');
  assert.equal(javascriptData(null), 'null');
});
