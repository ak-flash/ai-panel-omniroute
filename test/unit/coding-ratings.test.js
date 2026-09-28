'use strict';

// Онлайн-рейтинг моделей для кодинга (src/coding-ratings.js):
// разбор ответа benchmarks, файловое кэширование и обновление.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  createCodingRatings,
  fetchFromOpenRouter,
  normModelName,
  tierFromScore,
} = require('../../src/coding-ratings');

function tmpCachePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-panel-ratings-'));
  return path.join(dir, 'coding-ratings.json');
}

test('normModelName приводит имя к каноническому виду', () => {
  // Дефис и пробел не входят в разрешённый набор [a-z0-9.:/] — убираются
  assert.equal(normModelName('OpenAI/GPT-4o Mini'), 'openai/gpt4omini');
  assert.equal(normModelName('Claude-3.5 Haiku:free'), 'claude3.5haiku:free');
  assert.equal(normModelName(null), '');
});

test('tierFromScore раскладывает оценки по тирам', () => {
  assert.equal(tierFromScore(85), 'top');
  assert.equal(tierFromScore(70), 'top');
  assert.equal(tierFromScore(69), 'good');
  assert.equal(tierFromScore(40), 'good');
  assert.equal(tierFromScore(39), 'low');
  assert.equal(tierFromScore(null), 'low');
  assert.equal(tierFromScore('90'), 'low', 'строка не число — low');
});

test('fetchFromOpenRouter разбирает benchmarks и строит ключи', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            model_permaslug: 'openai/gpt-4o-mini',
            display_name: 'GPT-4o mini',
            coding_index: 72.4,
          },
          {
            model_permaslug: 'anthropic/claude-3.5',
            display_name: 'Claude 3.5',
            coding_index: 88.6,
          },
          { model_permaslug: 'broken/entry', coding_index: null },
        ],
        meta: { as_of: '2026-09-01T00:00:00Z', citation: 'AA', source_url: 'https://aa.example' },
      }),
    };
  };

  const result = await fetchFromOpenRouter('sk-or-test', { fetch: fetchImpl });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /openrouter\.ai\/api\/v1\/benchmarks/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-or-test');
  assert.equal(result.updatedAt, '2026-09-01T00:00:00Z');
  assert.equal(result.ratings['openai/gpt4omini'].score, 72);
  assert.equal(result.ratings['openai/gpt4omini'].tier, 'top');
  assert.equal(result.ratings['gpt4omini'].score, 72, 'ключ без префикса провайдера');
  assert.equal(result.ratings['gpt4omini'].displayName, 'GPT-4o mini');
  assert.equal(result.ratings['anthropic/claude3.5'].tier, 'top');
  assert.equal(result.ratings['broken/entry'], undefined, 'запись без coding_index пропущена');
});

test('fetchFromOpenRouter: meta без полей и элементы без display_name', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ model_permaslug: 'x/y', coding_index: 10.2 }] }),
  });
  const result = await fetchFromOpenRouter('k', { fetch: fetchImpl });
  assert.equal(result.updatedAt, new Date().toISOString().slice(0, 4) + result.updatedAt.slice(4));
  assert.equal(result.citation, 'Artificial Analysis via OpenRouter');
  assert.equal(result.sourceUrl, 'https://artificialanalysis.ai');
  assert.equal(result.meta, null);
  assert.equal(result.ratings['x/y'].displayName, 'x/y', 'имя берётся из permaslug');
});

test('fetchFromOpenRouter: HTTP-ошибка и пустой список', async () => {
  const failing = async () => ({
    ok: false,
    status: 429,
    text: async () => 'rate limited',
  });
  await assert.rejects(() => fetchFromOpenRouter('k', { fetch: failing }), /HTTP 429/);

  const empty = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  await assert.rejects(() => fetchFromOpenRouter('k', { fetch: empty }), /Пустой ответ/);
});

test('рейтинг без кэша на диске — пустой, с пояснением', async () => {
  const service = createCodingRatings({ cachePath: tmpCachePath() });
  const data = await service.getCodingRatings();
  assert.equal(data.source, 'none');
  assert.equal(data.updatedAt, null);
  assert.deepEqual(data.ratings, {});
  assert.match(data.citation, /OpenRouter/);
});

test('refresh без ключа — понятная ошибка 400', async () => {
  const service = createCodingRatings({ cachePath: tmpCachePath() });
  await assert.rejects(
    () => service.refreshCodingRatings({}),
    err => err.code === 'missing_api_key' && err.status === 400
  );
});

test('refresh сохраняет кэш в файл, следующий get читает его', async () => {
  const cachePath = tmpCachePath();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ model_permaslug: 'a/b', coding_index: 55 }] }),
    };
  };
  const service = createCodingRatings({ cachePath, fetch: fetchImpl });
  const fresh = await service.refreshCodingRatings({ apiKey: 'sk-or-x' });
  assert.equal(calls, 1);
  assert.equal(fresh.ratings['a/b'].tier, 'good');
  assert.ok(fresh.cachedAt);

  const saved = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(saved.ratings['a/b'].score, 55);

  // Новый экземпляр читает кэш с диска и не ходит в сеть
  const restarted = createCodingRatings({ cachePath, fetch: fetchImpl });
  const data = await restarted.getCodingRatings();
  assert.equal(data.ratings['a/b'].score, 55);
  assert.equal(calls, 1);
});

test('повреждённый и устаревший по форме кэш игнорируются', async () => {
  const brokenPath = tmpCachePath();
  fs.mkdirSync(path.dirname(brokenPath), { recursive: true });
  fs.writeFileSync(brokenPath, '{не json');
  const broken = createCodingRatings({ cachePath: brokenPath });
  assert.equal((await broken.getCodingRatings()).source, 'none');

  const legacyPath = tmpCachePath();
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, JSON.stringify({ source: 'curated-fallback', ratings: { a: 1 } }));
  const legacy = createCodingRatings({ cachePath: legacyPath });
  assert.equal(
    (await legacy.getCodingRatings()).source,
    'none',
    'curated-fallback больше не источник правды'
  );
});

test('кеш без cachePath и без файла не падает', async () => {
  const service = createCodingRatings({});
  assert.equal((await service.getCodingRatings()).source, 'none');
  assert.deepEqual(
    await service.getCodingRatings({ allowStale: false }),
    await service.getCodingRatings({ allowStale: false })
  );
});

test('недоступный для записи кэш не ломает обновление', async () => {
  const logger = { warn: () => {} };
  // Каталог-файл на месте файла кэша: mkdir/writeFile упадёт
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-panel-ratings-bad-'));
  const cachePath = path.join(dir, 'blocker');
  fs.writeFileSync(cachePath, 'x');
  const service = createCodingRatings({
    cachePath: path.join(cachePath, 'sub', 'cache.json'),
    logger,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ model_permaslug: 'a/b', coding_index: 55 }] }),
    }),
  });
  const data = await service.refreshCodingRatings({ apiKey: 'k' });
  assert.equal(data.ratings['a/b'].score, 55, 'рейтинг остаётся в памяти');
});
