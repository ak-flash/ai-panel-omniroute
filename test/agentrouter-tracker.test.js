'use strict';

// Юнит-тесты ежедневного снимка баланса AgentRouter
// (src/agentrouter-tracker.js): граница суток по UTC, перезапуск днём
// не переснимает баланс, без адаптера трекер не запускается.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentRouterTracker } = require('../src/agentrouter-tracker');

const KEYS = { storeKey: 'agentrouterKey', userField: 'agentrouterUserId' };

function fakeStore(initial = {}) {
  const data = { agentrouterKey: 'token', agentrouterUserId: '42', ...initial };
  return {
    data,
    snapshot: async () => ({ ...data }),
    set: async (key, value) => {
      data[key] = value;
    },
  };
}

function fakeProvider(balance) {
  const provider = {
    calls: 0,
    getUsage: async () => {
      provider.calls += 1;
      return { status: 200, data: { wallet: { balance_usd: balance } } };
    },
  };
  return provider;
}

function tracker(store, provider, iso) {
  return createAgentRouterTracker({
    getStore: async () => store,
    provider,
    ...KEYS,
    now: () => new Date(iso),
  });
}

test('перезапуск днём не переснимает сегодняшний снимок', async () => {
  const store = fakeStore({
    agentrouterDayBalance: JSON.stringify({ date: '2026-09-25', balance_usd: 10 }),
  });
  const provider = fakeProvider(7);
  const t = tracker(store, provider, '2026-09-25T15:00:00Z');
  await t.start();
  assert.equal(t.isRunning(), true);
  t.stop();
  assert.equal(t.isRunning(), false);
  assert.equal(provider.calls, 0);
  assert.equal(await t.getDayBalanceUsd(), 10);
});

test('новые сутки по UTC — новый снимок при старте', async () => {
  const store = fakeStore({
    agentrouterDayBalance: JSON.stringify({ date: '2026-09-24', balance_usd: 10 }),
  });
  const provider = fakeProvider(7.5);
  const t = tracker(store, provider, '2026-09-25T00:30:00Z');
  await t.start();
  t.stop();
  assert.equal(provider.calls, 1);
  assert.deepEqual(JSON.parse(store.data.agentrouterDayBalance), { date: '2026-09-25', balance_usd: 7.5 });
  assert.equal(await t.getDayBalanceUsd(), 7.5);
});

test('граница суток — UTC, а не локальное время сервера', async () => {
  const store = fakeStore();
  const provider = fakeProvider(3);
  // 23:30 в UTC-5 — это уже 04:30 следующего дня по UTC
  const t = tracker(store, provider, '2026-09-25T23:30:00-05:00');
  await t.start();
  t.stop();
  assert.equal(JSON.parse(store.data.agentrouterDayBalance).date, '2026-09-26');
});

test('снимок вчерашнего дня не отдаётся как стартовый баланс', async () => {
  const store = fakeStore({
    agentrouterDayBalance: JSON.stringify({ date: '2026-09-24', balance_usd: 10 }),
  });
  const t = tracker(store, fakeProvider(1), '2026-09-25T10:00:00Z');
  assert.equal(await t.getDayBalanceUsd(), null);
});

test('без ключа снимок не делается; без адаптера трекер не запускается', async () => {
  const store = fakeStore({ agentrouterKey: '' });
  const provider = fakeProvider(1);
  const t = tracker(store, provider, '2026-09-25T10:00:00Z');
  await t.start();
  t.stop();
  assert.equal(provider.calls, 0);

  const disabled = tracker(fakeStore(), undefined, '2026-09-25T10:00:00Z');
  assert.equal(disabled.enabled, false);
  await disabled.start();
  assert.equal(disabled.isRunning(), false);
});
