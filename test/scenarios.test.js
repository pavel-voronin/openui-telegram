import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileScenario, createScenario, scenes } from '../dist-test/fixtures/scenarios.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
async function press(demo, label) {
  const frame = await demo.frame();
  const button = [...frame.h.matchAll(/<button data-oui-action="(\d+)">([^<]+)<\/button>/g)].find(match => match[2] === label);
  assert.ok(button, `Missing button ${label}`);
  const data = JSON.stringify([frame.i, frame.v, frame.r, 'a', button[1]]);
  assert.ok(Buffer.byteLength(data) <= 64);
  await demo.handle(data);
  const result = await demo.frame();
  assert.ok(Buffer.byteLength(demo.encode(result)) <= 1024);
  return result;
}
test('every showcase compiles and all displayed frames fit Telegram', async () => {
  for (const name of Object.keys(scenes)) {
    const compiled = await compileScenario(name, 'test');
    assert.equal(compiled.fits, true);
    assert.deepEqual(compiled.diagnostics, []);
    const demo = createScenario(name, 'test', () => {}, async () => {});
    try { assert.ok(Buffer.byteLength(demo.encode(await demo.frame())) <= 1024); }
    finally { demo.dispose(); }
  }
});
test('state showcase keeps number and both chart representations synchronized', async () => {
  const demo = createScenario('state', 'test', () => {});
  try {
    let frame = await press(demo, '+1');
    assert.match(frame.h, /Число: 2/);
    assert.match(frame.h, /Canvas/);
    frame = await press(demo, 'Вид');
    assert.match(frame.h, /Число: 2/); assert.match(frame.h, /SVG/); assert.match(frame.h, /<svg/);
  } finally { demo.dispose(); }
});
test('query showcase notifies delivery when delayed result or failure arrives without a tap', async () => {
  const releases = []; let notifications = 0;
  const demo = createScenario('query', 'test', () => notifications++, () => new Promise(resolve => releases.push(resolve)));
  try {
    assert.match((await demo.frame()).h, /Загрузка/);
    const before = notifications; releases.shift()(); await settle();
    let frame = await demo.frame();
    assert.match(frame.h, /Результат: 100/); assert.ok(notifications > before);
    frame = await press(demo, 'Фильтр'); assert.match(frame.h, /Загрузка/);
    releases.shift()(); await settle();
    assert.match((await demo.frame()).h, /Результат: 200/);
    await press(demo, 'Ошибка'); releases.shift()(); await settle();
    assert.match((await demo.frame()).h, /Ошибка запроса/);
    await press(demo, 'Фильтр'); releases.shift()(); await settle();
    const recovered = await demo.frame();
    assert.match(recovered.h, /Запрос завершён/); assert.match(recovered.h, /Результат: 400/);
  } finally { demo.dispose(); }
});
test('mutation failure skips reset; success resets and delivers the application event', async () => {
  const demo = createScenario('save', 'test', () => {}, async () => {});
  try {
    await press(demo, '+1'); await press(demo, '+1');
    let frame = await press(demo, 'Сбой');
    assert.match(frame.h, /Число: 3/); assert.match(frame.h, /Сбой: сброс не выполнен/);
    frame = await press(demo, 'Сохранить');
    assert.match(frame.h, /Число: 1/); assert.match(frame.h, /Записано; число сброшено/);
    assert.doesNotMatch(frame.h, /Сбой: сброс не выполнен/);
  } finally { demo.dispose(); }
});
test('stream, patch and recreation preserve or restore the expected count', async () => {
  const demo = createScenario('edit', 'test', () => {});
  try {
    await press(demo, '+1');
    let frame = await press(demo, 'Запомнить');
    assert.match(frame.h, /Поток завершён; сохранено: 2/);
    await press(demo, '+1');
    frame = await press(demo, 'Patch');
    assert.match(frame.h, /Программа после patch/); assert.match(frame.h, /Число: 3/);
    const version = frame.v;
    frame = await press(demo, 'Вернуть');
    assert.match(frame.h, /Число: 2/); assert.match(frame.h, /Восстановлено в новом runtime/);
    assert.ok(frame.v > version);
    assert.match(frame.h, /Программа после patch/);
    frame = await press(demo, '+1'); assert.match(frame.h, /Число: 3/);
  } finally { demo.dispose(); }
});
