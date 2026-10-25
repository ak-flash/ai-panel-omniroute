'use strict';

// Юнит-тесты ежедневного снимка баланса AgentRouter
// (src/agentrouter-tracker.js): граница суток по UTC, перезапуск днём
// не переснимает баланс, без адаптера трекер не запускается.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentRouterTracker } = require('../../src/agentrouter-tracker');
const { fingerprint } = require('../../src/ttl-cache');
const { registerProviderRoutes } = require('../../src/routes/providers');

const KEYS = { storeKey: 'agentrouterKey', userField: 'agentrouterUserId' };
const OWNER = fingerprint('token:42');

function savedSnapshot(store, owner = OWNER) {
  return JSON.parse(store.data.agentrouterDayBalance).snapshots[owner];
}

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
    getCredential: async () => null,
    ...KEYS,
    now: () => new Date(iso),
  });
}

test('usage создаёт снимок сразу и учитывает расход даже после пополнения', async () => {
  const store = fakeStore();
  const provider = fakeProvider(100);
  const t = tracker(store, provider, '2026-09-25T12:00:00Z');

  assert.deepEqual(
    await t.recordUsage({ wallet: { balance_usd: 100 }, used_usd: 20 }, 'token', '42'),
    { day_balance_usd: 100, today_usd: 0 }
  );
  assert.deepEqual(
    await t.recordUsage({ wallet: { balance_usd: 98.75 }, used_usd: 21.25 }, 'token', '42'),
    { day_balance_usd: 100, today_usd: 1.25 }
  );
  assert.deepEqual(
    await t.recordUsage({ wallet: { balance_usd: 150 }, used_usd: 22 }, 'token', '42'),
    { day_balance_usd: 100, today_usd: 2 }
  );
  assert.equal(provider.calls, 0);
  assert.equal(savedSnapshot(store).used_usd, 20);
  assert.equal(store.data.agentrouterDayBalance.includes('token'), false);
});

test('расход меньше цента сохраняется без округления баланса', async () => {
  const t = tracker(fakeStore(), fakeProvider(10), '2026-09-25T12:00:00Z');
  await t.recordUsage({ wallet: { balance_usd: 10 }, used_usd: 1 }, 'token', '42');
  assert.deepEqual(
    await t.recordUsage({ wallet: { balance_usd: 10 }, used_usd: 1.001 }, 'token', '42'),
    { day_balance_usd: 10, today_usd: 0.001 }
  );
});

test('старый снимок без счётчика сохраняет расход по разнице балансов', async () => {
  const store = fakeStore({
    agentrouterDayBalance: JSON.stringify({ date: '2026-09-25', balance_usd: 10 }),
  });
  const t = tracker(store, fakeProvider(7), '2026-09-25T12:00:00Z');
  assert.deepEqual(
    await t.recordUsage({ wallet: { balance_usd: 7 }, used_usd: 50 }, 'token', '42'),
    { day_balance_usd: 10, today_usd: 3 }
  );
  assert.equal(savedSnapshot(store).balance_usd, 10);
});

test('без счётчика расход вычисляется и при нулевом начальном балансе', async () => {
  const t = tracker(fakeStore(), fakeProvider(0), '2026-09-25T12:00:00Z');
  assert.deepEqual(await t.recordUsage({ wallet: { balance_usd: 0 } }, 'token', '42'), {
    day_balance_usd: 0,
    today_usd: 0,
  });
  assert.deepEqual(await t.recordUsage({ wallet: { balance_usd: -2 } }, 'token', '42'), {
    day_balance_usd: 0,
    today_usd: 2,
  });
});

test('при уменьшении счётчика расхода используется разница балансов', async () => {
  const t = tracker(fakeStore(), fakeProvider(10), '2026-09-25T12:00:00Z');
  await t.recordUsage({ wallet: { balance_usd: 10 }, used_usd: 50 }, 'token', '42');
  assert.deepEqual(
    await t.recordUsage({ wallet: { balance_usd: 7 }, used_usd: 49 }, 'token', '42'),
    { day_balance_usd: 10, today_usd: 3 }
  );
});

test('неизвестный или сброшенный счётчик дополняется разницей балансов', async () => {
  const t = tracker(fakeStore(), fakeProvider(10), '2026-09-25T12:00:00Z');
  await t.recordUsage({ wallet: { balance_usd: 10 }, used_usd: 50 }, 'token', '42');
  for (const used of [undefined, null, '', ' ', false, 'invalid', Infinity, -1, 49]) {
    assert.deepEqual(
      await t.recordUsage({ wallet: { balance_usd: 5 }, used_usd: used }, 'token', '42'),
      { day_balance_usd: 10, today_usd: 5 }
    );
  }
  assert.deepEqual(
    await t.recordUsage({ wallet: { balance_usd: 5 }, used_usd: 51 }, 'token', '42'),
    { day_balance_usd: 10, today_usd: 5 }
  );
});

test('числовые строки допустимы, нулевой счётчик не считается отсутствующим', async () => {
  const t = tracker(fakeStore(), fakeProvider(10), '2026-09-25T12:00:00Z');
  await t.recordUsage({ wallet: { balance_usd: '10' }, used_usd: '0' }, 'token', '42');
  assert.deepEqual(
    await t.recordUsage({ wallet: { balance_usd: '20' }, used_usd: '0.5' }, 'token', '42'),
    { day_balance_usd: 10, today_usd: 0.5 }
  );
});

test('активный аккаунт дополняется отсутствующими полями из KV', async () => {
  for (const active of [{ api_key: 'active-token' }, { key: 'active-token' }, { user_id: '99' }]) {
    const store = fakeStore();
    const seen = [];
    const t = createAgentRouterTracker({
      getStore: async () => store,
      getCredential: async () => active,
      provider: {
        getUsage: async (key, uid) => {
          seen.push([key, uid]);
          return { status: 200, data: { wallet: { balance_usd: 10 } } };
        },
      },
      ...KEYS,
      now: () => new Date('2026-09-25T12:00:00Z'),
    });
    await t.snapshotDayBalance();
    assert.deepEqual(seen, [[active.api_key || active.key || 'token', active.user_id || '42']]);
    assert.equal(await t.getDayBalanceUsd(), 10);
  }
});

test('переключение аккаунтов и поздний ответ не смешивают и не сбрасывают снимки', async () => {
  const t = tracker(fakeStore(), fakeProvider(100), '2026-09-25T12:00:00Z');
  await t.recordUsage({ wallet: { balance_usd: 100 }, used_usd: 50 }, 'first-token', '42');
  assert.deepEqual(
    await t.recordUsage({ wallet: { balance_usd: 2 }, used_usd: 1 }, 'second-token', '99'),
    { day_balance_usd: 2, today_usd: 0 }
  );
  assert.deepEqual(
    await t.recordUsage({ wallet: { balance_usd: 99 }, used_usd: 51 }, 'first-token', '42'),
    { day_balance_usd: 100, today_usd: 1 }
  );
  assert.deepEqual(
    await t.recordUsage({ wallet: { balance_usd: 1 }, used_usd: 2 }, 'second-token', '99'),
    { day_balance_usd: 2, today_usd: 1 }
  );
});

test('старый снимок не присваивается аккаунту из заголовков', async () => {
  const store = fakeStore({
    agentrouterDayBalance: JSON.stringify({ date: '2026-09-25', balance_usd: 100 }),
  });
  const t = tracker(store, fakeProvider(100), '2026-09-25T12:00:00Z');
  assert.deepEqual(
    await t.recordUsage({ wallet: { balance_usd: 20 }, used_usd: 2 }, 'another-token', '99'),
    { day_balance_usd: 20, today_usd: 0 }
  );
  assert.deepEqual(
    await t.recordUsage({ wallet: { balance_usd: 90 }, used_usd: 50 }, 'token', '42'),
    { day_balance_usd: 100, today_usd: 10 }
  );
});

test('старый снимок привязывается до смены активного аккаунта', async () => {
  const store = fakeStore({
    agentrouterDayBalance: JSON.stringify({ date: '2026-09-25', balance_usd: 100 }),
  });
  let active = { api_key: 'token', user_id: '42' };
  const provider = fakeProvider(100);
  const t = createAgentRouterTracker({
    getStore: async () => store,
    getCredential: async () => active,
    provider,
    ...KEYS,
    now: () => new Date('2026-09-25T12:00:00Z'),
  });
  await t.start();
  t.stop();
  assert.equal(provider.calls, 0);
  active = { api_key: 'another-token', user_id: '99' };
  assert.deepEqual(
    await t.recordUsage({ wallet: { balance_usd: 20 }, used_usd: 2 }, 'another-token', '99'),
    { day_balance_usd: 20, today_usd: 0 }
  );
  assert.equal(savedSnapshot(store).balance_usd, 100);
});

test('снимок предыдущего формата с владельцем мигрирует без сброса расхода', async () => {
  const store = fakeStore({
    agentrouterDayBalance: JSON.stringify({
      date: '2026-09-25',
      owner: OWNER,
      balance_usd: 10,
      used_usd: 2,
    }),
  });
  const t = tracker(store, fakeProvider(10), '2026-09-25T12:00:00Z');
  assert.deepEqual(
    await t.recordUsage({ wallet: { balance_usd: 9 }, used_usd: 3 }, 'token', '42'),
    { day_balance_usd: 10, today_usd: 1 }
  );
  await t.recordUsage({ wallet: { balance_usd: 1 }, used_usd: 0 }, 'another-token', '99');
  assert.equal(savedSnapshot(store).used_usd, 2);
});

test('некорректный сегодняшний снимок заменяется пригодным', async () => {
  for (const saved of [
    'invalid json',
    'null',
    '{}',
    ...[undefined, null, '', false, 'invalid'].map(balance_usd =>
      JSON.stringify({ date: '2026-09-25', balance_usd })
    ),
  ]) {
    const store = fakeStore({ agentrouterDayBalance: saved });
    const t = tracker(store, fakeProvider(5), '2026-09-25T12:00:00Z');
    assert.equal(await t.getDayBalanceUsd(), null);
    await t.start();
    t.stop();
    assert.equal(await t.getDayBalanceUsd(), 5);
  }
});

test('некорректный баланс и отсутствие credentials не создают снимок', async () => {
  const store = fakeStore();
  const t = tracker(store, fakeProvider(5), '2026-09-25T12:00:00Z');
  for (const balance of [undefined, null, '', ' ', false, 'invalid', Infinity]) {
    assert.equal(await t.recordUsage({ wallet: { balance_usd: balance } }, 'token', '42'), null);
  }
  assert.equal(await t.recordUsage(null, 'token', '42'), null);
  assert.equal(await t.recordUsage({ wallet: { balance_usd: 5 } }, '', '42'), null);
  assert.equal(await t.recordUsage({ wallet: { balance_usd: 5 } }, 'token', ''), null);
  assert.equal(store.data.agentrouterDayBalance, undefined);
});

test('параллельные ответы не перезаписывают первый снимок дня', async () => {
  const store = fakeStore();
  const t = tracker(store, fakeProvider(10), '2026-09-25T12:00:00Z');
  const results = await Promise.all([
    t.recordUsage({ wallet: { balance_usd: 10 }, used_usd: 1 }, 'token', '42'),
    t.recordUsage({ wallet: { balance_usd: 9 }, used_usd: 2 }, 'token', '42'),
  ]);
  assert.deepEqual(results, [
    { day_balance_usd: 10, today_usd: 0 },
    { day_balance_usd: 10, today_usd: 1 },
  ]);
  await t.snapshotDayBalance();
  assert.equal(savedSnapshot(store).balance_usd, 10);
});

test('поздний ответ вчерашнего дня не становится сегодняшним снимком', async () => {
  let iso = '2026-09-25T23:59:59Z';
  const store = fakeStore();
  const t = createAgentRouterTracker({
    getStore: async () => store,
    ...KEYS,
    getCredential: async () => null,
    now: () => new Date(iso),
    provider: {
      getUsage: async () => {
        iso = '2026-09-26T00:00:01Z';
        return { status: 200, data: { wallet: { balance_usd: 5 }, used_usd: 1 } };
      },
    },
  });
  await t.snapshotDayBalance();
  assert.equal(store.data.agentrouterDayBalance, undefined);
  assert.deepEqual(
    await t.recordUsage({ wallet: { balance_usd: 5 }, used_usd: 1 }, 'token', '42'),
    { day_balance_usd: 5, today_usd: 0 }
  );
  assert.equal(JSON.parse(store.data.agentrouterDayBalance).date, '2026-09-26');
});

for (const crossesMidnight of [false, true]) {
  test(`usage ${crossesMidnight ? 'в полёте' : 'в кеше'} не загрязняет снимок новых суток`, async () => {
    let time = Date.parse('2026-09-25T23:59:59Z');
    let calls = 0;
    const store = fakeStore();
    const provider = {
      id: 'agentrouter',
      getUsage: async () => {
        calls += 1;
        if (crossesMidnight && calls === 1) time += 2000;
        return {
          status: 200,
          data: { wallet: { balance_usd: 11 - calls }, used_usd: calls },
        };
      },
      getModels: async () => ({ status: 200, data: { data: [] } }),
    };
    const t = createAgentRouterTracker({
      getStore: async () => store,
      getCredential: async () => null,
      provider,
      ...KEYS,
      now: () => new Date(time),
    });
    const handlers = {};
    registerProviderRoutes(
      { add: (_methods, path, handler) => (handlers[path] = handler) },
      {
        providers: [provider],
        getStore: async () => store,
        storeKeys: { agentrouter: KEYS.storeKey },
        userFields: { agentrouter: KEYS.userField },
        recordAgentRouterUsage: t.recordUsage,
        now: () => time,
      }
    );
    async function request(resource = 'usage') {
      let data;
      await handlers['/api/providers/:id/' + resource]({
        req: { headers: { 'x-api-key': 'token', 'x-agentrouter-user-id': '42' } },
        params: { id: 'agentrouter' },
        res: {
          writeHead: status => assert.equal(status, 200),
          end: body => (data = JSON.parse(body)),
        },
      });
      return data;
    }

    const first = await request();
    if (crossesMidnight) {
      assert.equal(first.today_usd, undefined);
      assert.equal(store.data.agentrouterDayBalance, undefined);
    } else {
      assert.equal(first.day_balance_usd, 10);
      assert.equal(first.today_usd, 0);
      time += 2000;
    }
    const second = await request();
    assert.equal(calls, 2);
    assert.equal(second.day_balance_usd, 9);
    assert.equal(second.today_usd, 0);
    assert.equal(JSON.parse(store.data.agentrouterDayBalance).date, '2026-09-26');
    assert.deepEqual(await request(), second);
    assert.equal(calls, 2);
    const beforeModels = store.data.agentrouterDayBalance;
    assert.deepEqual(await request('models'), { data: [] });
    assert.equal(store.data.agentrouterDayBalance, beforeModels);
  });
}

test('ошибка записи не блокирует повторную попытку', async () => {
  const store = fakeStore();
  const set = store.set;
  const t = tracker(store, fakeProvider(5), '2026-09-25T12:00:00Z');
  store.set = async () => {
    throw new Error('write failed');
  };
  assert.equal(await t.recordUsage({ wallet: { balance_usd: 5 } }, 'token', '42'), null);
  store.set = set;
  assert.deepEqual(await t.recordUsage({ wallet: { balance_usd: 4 } }, 'token', '42'), {
    day_balance_usd: 4,
    today_usd: 0,
  });
});

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
  assert.deepEqual(JSON.parse(store.data.agentrouterDayBalance), {
    date: '2026-09-25',
    snapshots: { [OWNER]: { balance_usd: 7.5, used_usd: null } },
  });
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

test('сбой снимка при переданном logger пишет событие tracker_snapshot_failed', async () => {
  const events = [];
  const logger = () => {};
  logger.warn = (...args) => events.push(args[args.length - 1]);
  const store = fakeStore();
  store.set = async () => {
    throw new Error('disk full');
  };
  const t = createAgentRouterTracker({
    getStore: async () => store,
    provider: fakeProvider(5),
    getCredential: async () => null,
    ...KEYS,
    now: () => new Date('2026-09-25T10:00:00Z'),
    logger,
  });
  await t.start();
  t.stop();
  const event = events.find(e => e && e.event === 'tracker_snapshot_failed');
  assert.ok(event, 'событие tracker_snapshot_failed записано');
  assert.equal(event.reason, 'disk full');
});

test('без logger события не пишутся и не падают', async () => {
  const store = fakeStore();
  store.set = async () => {
    throw new Error('disk full');
  };
  const t = createAgentRouterTracker({
    getStore: async () => store,
    provider: fakeProvider(5),
    getCredential: async () => null,
    ...KEYS,
    now: () => new Date('2026-09-25T10:00:00Z'),
  });
  await t.start();
  t.stop();
});
