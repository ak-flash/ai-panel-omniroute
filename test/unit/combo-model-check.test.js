'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let createComboModelCheck;
test.before(async () => {
  ({ createComboModelCheck } = await import('../../public/js/combo-model-check.js'));
});

function makeChecker({ testModel, onUpdate = () => {}, notify = () => {} } = {}) {
  return createComboModelCheck({
    onUpdate,
    notify,
    testModel,
    modelIdOf: target => String(target.modelId || ''),
  });
}

test('run stores ok state and notifies with latency', async () => {
  const updates = [];
  const messages = [];
  const checker = makeChecker({
    testModel: async id => ({ ms: 42, model: id }),
    onUpdate: () => updates.push('u'),
    notify: (m, o) => messages.push([m, o]),
  });
  await checker.run({ modelId: 'p/m' }, 'key');
  assert.deepEqual(checker.get('key'), { state: 'ok', ms: 42 });
  assert.equal(updates.length, 2); // loading + ok
  assert.deepEqual(messages, [['Модель отвечает: 42 мс', undefined]]);
});

test('run stores error state with detail', async () => {
  const messages = [];
  const err = new Error('нет ответа');
  err.ms = 7;
  const checker = makeChecker({
    testModel: async () => {
      throw err;
    },
    notify: (m, o) => messages.push([m, o]),
  });
  await checker.run({ modelId: 'p/m' }, 'key');
  assert.deepEqual(checker.get('key'), { state: 'err', ms: 7, detail: 'нет ответа' });
  assert.equal(messages.length, 1);
  assert.match(messages[0][0], /Проверка не удалась: нет ответа/);
  assert.deepEqual(messages[0][1], { type: 'error', timeout: 6000 });
});

test('run ignores a second check while one is loading', async () => {
  let resolve;
  let calls = 0;
  const checker = makeChecker({
    testModel: () => {
      calls++;
      return new Promise(r => {
        resolve = r;
      });
    },
  });
  const first = checker.run({ modelId: 'p/m' }, 'key');
  const second = checker.run({ modelId: 'p/m' }, 'key');
  assert.equal(calls, 1);
  resolve({ ms: 1, model: 'p/m' });
  await Promise.all([first, second]);
  assert.deepEqual(checker.get('key'), { state: 'ok', ms: 1 });
});
