'use strict';

// Кеш ответов провайдера с TTL и объединением одинаковых запросов (P3-3).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTtlCache, fingerprint } = require('../../src/ttl-cache');

/** Часы, которые двигаем вручную. */
function fakeClock(start = 1000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
}

test('повторный запрос в пределах TTL не вызывает loader', async () => {
  const clock = fakeClock();
  let calls = 0;
  const cache = createTtlCache({ ttlMs: 1000, now: clock.now });
  const load = async () => {
    calls += 1;
    return { status: 200, data: { n: calls } };
  };
  assert.deepEqual(await cache.get('k', load), { status: 200, data: { n: 1 } });
  assert.deepEqual(await cache.get('k', load), { status: 200, data: { n: 1 } });
  assert.equal(calls, 1);

  clock.advance(999);
  await cache.get('k', load);
  assert.equal(calls, 1, 'запись ещё жива');

  clock.advance(2);
  assert.deepEqual(await cache.get('k', load), { status: 200, data: { n: 2 } });
  assert.equal(calls, 2, 'после истечения TTL загружаем заново');
});

test('параллельные одинаковые запросы объединяются в один поход', async () => {
  const clock = fakeClock();
  let calls = 0;
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const cache = createTtlCache({ ttlMs: 1000, now: clock.now });
  const load = async () => {
    calls += 1;
    await gate;
    return { status: 200, data: { n: calls } };
  };
  const pending = [cache.get('k', load), cache.get('k', load), cache.get('k', load)];
  release();
  const results = await Promise.all(pending);
  assert.equal(calls, 1, 'loader вызван один раз');
  for (const value of results) assert.deepEqual(value, results[0]);
  // После завершения загрузки следующий запрос берёт кеш, а не loader
  await cache.get('k', load);
  assert.equal(calls, 1);
});

test('разные ключи не объединяются', async () => {
  const cache = createTtlCache();
  let calls = 0;
  const load = async () => ({ status: 200, data: ++calls });
  assert.equal((await cache.get('a', load)).data, 1);
  assert.equal((await cache.get('b', load)).data, 2);
  assert.equal(calls, 2);
});

test('исключение loader не кешируется', async () => {
  const clock = fakeClock();
  let calls = 0;
  const cache = createTtlCache({ ttlMs: 1000, now: clock.now });
  const boom = async () => {
    calls += 1;
    throw new Error('upstream down');
  };
  await assert.rejects(() => cache.get('e', boom), /upstream down/);
  await assert.rejects(() => cache.get('e', boom), /upstream down/);
  assert.equal(calls, 2, 'следующий запрос пробует снова');
  clock.advance(5000);
  await assert.rejects(() => cache.get('e', boom), /upstream down/);
  assert.equal(calls, 3);
});

test('неуспешный ответ (isOk = false) живёт errorTtlMs, успешный — ttlMs', async () => {
  const clock = fakeClock();
  let calls = 0;
  const cache = createTtlCache({ ttlMs: 60_000, errorTtlMs: 500, now: clock.now });
  const load = async () => {
    calls += 1;
    return { status: 429, data: { error: 'rate_limited' } };
  };
  const isOk = value => value.status === 200;

  await cache.get('k', load, isOk);
  await cache.get('k', load, isOk);
  assert.equal(calls, 1, '429 коротко кешируется — не долбим провайдера');

  clock.advance(501);
  await cache.get('k', load, isOk);
  assert.equal(calls, 2, 'после errorTtlMs пробуем снова');

  clock.advance(1000);
  await cache.get('ok', load, () => true);
  assert.equal(calls, 3);
  clock.advance(1000);
  await cache.get('ok', load, () => true);
  assert.equal(calls, 3, 'успех живёт дольше errorTtlMs');
  clock.advance(60_001);
  await cache.get('ok', load, () => true);
  assert.equal(calls, 4, 'успех истёк по ttlMs');
});

test('invalidate сбрасывает запись по ключу и целиком', async () => {
  let calls = 0;
  const cache = createTtlCache({ ttlMs: 60_000 });
  const load = async () => ({ status: 200, data: ++calls });
  await cache.get('a', load);
  await cache.get('b', load);
  assert.equal(cache.keys().length, 2);
  cache.invalidate('a');
  assert.deepEqual(cache.keys(), ['b']);
  await cache.get('a', load);
  assert.equal(calls, 3);
  cache.invalidate();
  assert.equal(cache.keys().length, 0);
});

test('кеш ограничен по размеру, протухшие записи вытесняются', async () => {
  const clock = fakeClock();
  const cache = createTtlCache({ ttlMs: 100, maxEntries: 3, now: clock.now });
  const load = async () => ({ status: 200 });
  for (let i = 0; i < 5; i += 1) await cache.get('k' + i, load);
  assert.equal(cache.keys().length, 3, 'старые записи вытеснены');
  clock.advance(101);
  await cache.get('new', load);
  assert.equal(cache.keys().length, 1, 'протухшие подчищены при записи');
});

test('ttlMs = 0 отключает кеш', async () => {
  let calls = 0;
  const cache = createTtlCache({ ttlMs: 0 });
  const load = async () => ({ status: 200, data: ++calls });
  await cache.get('k', load);
  await cache.get('k', load);
  assert.equal(calls, 2);
  assert.equal(cache.keys().length, 0);
});

test('stats() не раскрывает секреты и показывает состояние', async () => {
  const cache = createTtlCache({ ttlMs: 1000 });
  await cache.get('xkiro:' + fingerprint('sk-secret'), async () => ({ status: 200 }));
  const stats = cache.stats();
  assert.equal(stats.entries, 1);
  assert.equal(stats.fresh, 1);
  assert.equal(stats.inFlight, 0);
  assert.equal(stats.ttlMs, 1000);
  assert.ok(!JSON.stringify(stats).includes('sk-secret'));
});

test('fingerprint скрывает секрет и стабилен', () => {
  const a = fingerprint('sk-xt-abc');
  const b = fingerprint('sk-xt-abc');
  assert.equal(a, b);
  assert.notEqual(a, fingerprint('sk-xt-abd'));
  assert.notEqual(a, fingerprint(''));
  assert.ok(!a.includes('sk-xt'));
});
