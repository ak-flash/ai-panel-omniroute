'use strict';

// Юнит-тесты чистой логики уведомлений (public/js/notifications.js).
// ES-модуль тестируется через динамический import в node:test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

let N;
test.before(async () => {
  N = await import('../public/js/notifications.js');
});

test('evaluateXKiro: порог сработал — запись в массиве', () => {
  const usage = { windows: [
    { kind: 'short', spent_usd: 85, cap_usd: 100 },
    { kind: 'long',  spent_usd: 50, cap_usd: 200 },
  ]};
  const t = { short_window_pct: 80, long_window_pct: 90 };
  const out = N.evaluateXKiro(usage, t);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'xkiro.short_window_pct.80');
  assert.equal(out[0].level, 'warn');
  assert.match(out[0].message, /короткого/);
});

test('evaluateXKiro: оба порога сработали', () => {
  const usage = { windows: [
    { kind: 'short', spent_usd: 90, cap_usd: 100 },
    { kind: 'long',  spent_usd: 195, cap_usd: 200 },
  ]};
  const t = { short_window_pct: 80, long_window_pct: 80 };
  const out = N.evaluateXKiro(usage, t);
  assert.equal(out.length, 2);
  const ids = out.map((o) => o.id).sort();
  assert.deepEqual(ids, ['xkiro.long_window_pct.80', 'xkiro.short_window_pct.80']);
});

test('evaluateXKiro: ниже порога — пустой массив', () => {
  const usage = { windows: [{ kind: 'short', spent_usd: 10, cap_usd: 100 }]};
  const t = { short_window_pct: 80 };
  assert.deepEqual(N.evaluateXKiro(usage, t), []);
});

test('evaluateXKiro: thresholds = {} / null → пустой массив', () => {
  const usage = { windows: [{ kind: 'short', spent_usd: 99, cap_usd: 100 }]};
  assert.deepEqual(N.evaluateXKiro(usage, null), []);
  assert.deepEqual(N.evaluateXKiro(usage, {}), []);
});

test('evaluateXKiro: cap = 0 → порог не срабатывает', () => {
  const usage = { windows: [{ kind: 'short', spent_usd: 50, cap_usd: 0 }]};
  const t = { short_window_pct: 1 };
  assert.deepEqual(N.evaluateXKiro(usage, t), []);
});

test('evaluateXKiro: level error при p >= 95', () => {
  const usage = { windows: [{ kind: 'short', spent_usd: 100, cap_usd: 100 }]};
  const t = { short_window_pct: 80 };
  const out = N.evaluateXKiro(usage, t);
  assert.equal(out[0].level, 'error');
});

test('evaluateXKiro: некорректный порог (строка) → null → не сработает', () => {
  const usage = { windows: [{ kind: 'short', spent_usd: 99, cap_usd: 100 }]};
  const t = { short_window_pct: 'abc' };
  assert.deepEqual(N.evaluateXKiro(usage, t), []);
});

test('evaluateXKiro: запятая в пороге → парсится', () => {
  const usage = { windows: [{ kind: 'short', spent_usd: 90, cap_usd: 100 }]};
  const t = { short_window_pct: '80,0' };
  const out = N.evaluateXKiro(usage, t);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'xkiro.short_window_pct.80');
});

test('evaluateXKiro: out-of-range порог (0, 200) → null', () => {
  const usage = { windows: [{ kind: 'short', spent_usd: 99, cap_usd: 100 }]};
  assert.deepEqual(N.evaluateXKiro(usage, { short_window_pct: 0 }), []);
  assert.deepEqual(N.evaluateXKiro(usage, { short_window_pct: 200 }), []);
});

test('evaluateAgentRouter: баланс ниже порога', () => {
  const usage = { wallet: { balance_usd: 4.50 }};
  const t = { balance_below_usd: 10 };
  const out = N.evaluateAgentRouter(usage, t);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'agentrouter.balance_below_usd.10');
  assert.equal(out[0].level, 'warn');
  assert.match(out[0].message, /\$4\.50.*\$10/);
});

test('evaluateAgentRouter: balance = 0 → error', () => {
  const usage = { wallet: { balance_usd: 0 }};
  const t = { balance_below_usd: 5 };
  const out = N.evaluateAgentRouter(usage, t);
  assert.equal(out[0].level, 'error');
});

test('evaluateAgentRouter: баланс выше порога → пусто', () => {
  assert.deepEqual(
    N.evaluateAgentRouter({ wallet: { balance_usd: 20 } }, { balance_below_usd: 10 }),
    [],
  );
});

test('evaluateAgentRouter: thresholds нет → пусто', () => {
  assert.deepEqual(
    N.evaluateAgentRouter({ wallet: { balance_usd: 0 } }, null),
    [],
  );
  assert.deepEqual(
    N.evaluateAgentRouter({ wallet: { balance_usd: 0 } }, {}),
    [],
  );
});

test('evaluateAgentRouter: wallet пустой → пусто', () => {
  assert.deepEqual(
    N.evaluateAgentRouter({}, { balance_below_usd: 1 }),
    [],
  );
  assert.deepEqual(
    N.evaluateAgentRouter({ wallet: {} }, { balance_below_usd: 1 }),
    [],
  );
});

test('evaluateAgentRouter: дробный порог', () => {
  const usage = { wallet: { balance_usd: 0.5 }};
  const t = { balance_below_usd: 1.5 };
  const out = N.evaluateAgentRouter(usage, t);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'agentrouter.balance_below_usd.1.50');
});

test('evaluateAntigravity: порог сработал', () => {
  const quota = { models: [
    { id: 'gpt-4o', remainingFraction: 0.5 },
    { id: 'claude', remainingFraction: 0.15 },
  ]};
  const t = { remaining_below_pct: 20 };
  const out = N.evaluateAntigravity(quota, t);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'antigravity.remaining_below_pct.20');
  assert.equal(out[0].level, 'warn');
  assert.match(out[0].message, /15%/);
});

test('evaluateAntigravity: учитывает окна', () => {
  const quota = {
    models: [{ id: 'gpt', remainingFraction: 0.8 }],
    windows: [{ windowSize: '5h', remainingFraction: 0.1 }],
  };
  const t = { remaining_below_pct: 50 };
  const out = N.evaluateAntigravity(quota, t);
  assert.equal(out.length, 1);
  assert.match(out[0].message, /10%/);
});

test('evaluateAntigravity: level error при min < 10%', () => {
  const quota = { models: [{ id: 'gpt', remainingFraction: 0.05 }]};
  const t = { remaining_below_pct: 50 };
  const out = N.evaluateAntigravity(quota, t);
  assert.equal(out[0].level, 'error');
});

test('evaluateAntigravity: пустые models/windows → пусто', () => {
  assert.deepEqual(
    N.evaluateAntigravity({}, { remaining_below_pct: 50 }),
    [],
  );
  assert.deepEqual(
    N.evaluateAntigravity({ models: [], windows: [] }, { remaining_below_pct: 50 }),
    [],
  );
});

test('evaluateAntigravity: без порога → пусто', () => {
  const quota = { models: [{ remainingFraction: 0.01 }]};
  assert.deepEqual(N.evaluateAntigravity(quota, null), []);
  assert.deepEqual(N.evaluateAntigravity(quota, {}), []);
});

test('evaluateAll: объединяет результаты провайдеров', () => {
  const data = {
    xkiro: { windows: [{ kind: 'short', spent_usd: 90, cap_usd: 100 }] },
    agentrouter: { wallet: { balance_usd: 1 } },
    antigravity: { models: [{ remainingFraction: 0.05 }] },
  };
  const thresholds = {
    xkiro: { short_window_pct: 80 },
    agentrouter: { balance_below_usd: 5 },
    antigravity: { remaining_below_pct: 20 },
  };
  const out = N.evaluateAll(data, thresholds);
  assert.equal(out.length, 3);
  // Уровни xkiro=warn, agentrouter=warn, antigravity=error
  const byProvider = {};
  for (const o of out) byProvider[o.id.split('.')[0]] = o.level;
  assert.equal(byProvider.xkiro, 'warn');
  assert.equal(byProvider.agentrouter, 'warn');
  assert.equal(byProvider.antigravity, 'error');
});

test('evaluateAll: thresholds = null — всё тихо', () => {
  const out = N.evaluateAll({
    xkiro: { windows: [{ kind: 'short', spent_usd: 99, cap_usd: 100 }] },
  }, null);
  assert.deepEqual(out, []);
});
