'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let PROVIDER_KEY_CHECKS;
let successLine;
let failureLine;
let emptyLine;
let errorText;
let runProviderKeyCheck;

test.before(async () => {
  ({ PROVIDER_KEY_CHECKS, successLine, failureLine, emptyLine, errorText, runProviderKeyCheck } =
    await import('../../public/js/provider-key-check.js'));
});

test('таблица покрывает всех провайдеров с проверяемым ключом', () => {
  assert.deepEqual(Object.keys(PROVIDER_KEY_CHECKS).sort(), [
    'agentrouter',
    'experiential',
    'openrouter',
    'selora',
    'xkiro',
  ]);
});

test('errorText берёт message, иначе строковое представление', () => {
  assert.equal(errorText(new Error('boom')), 'boom');
  assert.equal(errorText({ message: 'нет' }), 'нет');
  assert.equal(errorText('строка'), 'строка');
});

test('successLine: баланс и план только там, где заявлены', () => {
  const xkiro = PROVIDER_KEY_CHECKS.xkiro;
  assert.equal(
    successLine(xkiro, { wallet: { balance_usd: 12.5 }, plan: 'Pro' }),
    'xKiro [[ok]] ключ работает — баланс: $12.50 · план: Pro'
  );
  const ar = PROVIDER_KEY_CHECKS.agentrouter;
  assert.equal(
    successLine(ar, { wallet: { balance: 3 } }),
    'AgentRouter [[ok]] токен работает — баланс: $3.00'
  );
  // Experiential не показывает баланс, даже если он пришёл
  const exp = PROVIDER_KEY_CHECKS.experiential;
  assert.equal(
    successLine(exp, { wallet: { balance_usd: 99 } }),
    'Experiential Labs [[ok]] ключ работает'
  );
});

test('successLine: отсутствие баланса считается нулём', () => {
  assert.equal(
    successLine(PROVIDER_KEY_CHECKS.openrouter, {}),
    'OpenRouter [[ok]] ключ работает — баланс: $0.00'
  );
});

test('failureLine добавляет подсказку при 401 только у xKiro и Selora', () => {
  const unauth = { message: 'unauthorized', status: 401 };
  assert.match(failureLine(PROVIDER_KEY_CHECKS.xkiro, unauth), /— проверьте ключ$/);
  assert.match(failureLine(PROVIDER_KEY_CHECKS.selora, unauth), /— проверьте ключ$/);
  assert.doesNotMatch(failureLine(PROVIDER_KEY_CHECKS.openrouter, unauth), /проверьте ключ/);
  assert.doesNotMatch(failureLine(PROVIDER_KEY_CHECKS.agentrouter, unauth), /проверьте ключ/);
});

test('failureLine: подсказка не появляется при другой ошибке', () => {
  assert.doesNotMatch(
    failureLine(PROVIDER_KEY_CHECKS.xkiro, { message: 'timeout', status: 502 }),
    /проверьте ключ/
  );
});

test('emptyLine различает «сохранён ранее» и «не задан»', () => {
  assert.equal(
    emptyLine(PROVIDER_KEY_CHECKS.agentrouter, true),
    'AgentRouter [[ok]] токен сохранён ранее — пустое поле его не меняет'
  );
  assert.equal(emptyLine(PROVIDER_KEY_CHECKS.agentrouter, false), 'AgentRouter: токен не задан');
});

test('runProviderKeyCheck: неизвестный провайдер ничего не делает', async () => {
  const lines = [];
  await runProviderKeyCheck({
    id: 'antigravity',
    candidate: 'x',
    request: () => assert.fail('запрос не должен уходить'),
    readFlag: () => assert.fail('флаг не должен читаться'),
    setLine: line => lines.push(line),
  });
  assert.deepEqual(lines, []);
});

test('runProviderKeyCheck: пустое поле читает флаг и не шлёт запрос', async () => {
  const lines = [];
  const flags = [];
  await runProviderKeyCheck({
    id: 'xkiro',
    candidate: '',
    request: () => assert.fail('запрос не должен уходить'),
    readFlag: flag => {
      flags.push(flag);
      return true;
    },
    setLine: (line, isErr) => lines.push([line, isErr]),
  });
  assert.deepEqual(flags, ['hasXkiroKey']);
  assert.deepEqual(lines, [
    ['xKiro [[ok]] ключ сохранён ранее — пустое поле его не меняет', false],
  ]);
});

test('runProviderKeyCheck: успех печатает баланс и не помечает ошибкой', async () => {
  const lines = [];
  const calls = [];
  await runProviderKeyCheck({
    id: 'selora',
    candidate: 'sk-test',
    request: (path, payload) => {
      calls.push([path, payload]);
      return Promise.resolve({ wallet: { balance_usd: 7 }, plan: 'Team' });
    },
    readFlag: () => false,
    setLine: (line, isErr) => lines.push([line, isErr]),
  });
  assert.deepEqual(calls, [
    ['usage', { key: 'sk-test', provider: { id: 'selora', name: 'Selora' } }],
  ]);
  assert.deepEqual(lines[0], ['Selora: проверяю ключ…', false]);
  assert.match(lines[1][0], /Selora \[\[ok\]\] ключ работает — баланс: \$7\.00 · план: Team/);
  assert.equal(lines[1][1], false);
});

test('runProviderKeyCheck: AgentRouter получает userId в запросе', async () => {
  const calls = [];
  await runProviderKeyCheck({
    id: 'agentrouter',
    candidate: 'tok',
    userId: '42',
    request: (path, payload) => {
      calls.push(payload);
      return Promise.resolve({});
    },
    readFlag: () => false,
    setLine: () => {},
  });
  assert.deepEqual(calls[0], {
    key: 'tok',
    provider: { id: 'agentrouter', name: 'AgentRouter' },
    userId: '42',
  });
});

test('runProviderKeyCheck: ошибка помечается как ошибка', async () => {
  const lines = [];
  const infos = [];
  const warns = [];
  const origInfo = console.info;
  const origWarn = console.warn;
  console.info = msg => infos.push(msg);
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    await runProviderKeyCheck({
      id: 'xkiro',
      candidate: 'bad',
      request: () => Promise.reject(Object.assign(new Error('unauthorized'), { status: 401 })),
      readFlag: () => false,
      setLine: (line, isErr) => lines.push([line, isErr]),
    });
  } finally {
    console.info = origInfo;
    console.warn = origWarn;
  }
  assert.equal(lines.at(-1)[1], true);
  assert.match(lines.at(-1)[0], /— проверьте ключ$/);
  assert.ok(warns.some(line => /проверка не прошла/.test(line)));
  assert.ok(infos.length > 0);
});
