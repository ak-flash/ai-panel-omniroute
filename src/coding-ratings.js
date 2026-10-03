'use strict';

/* ============================================================
   AI Panel — онлайн-рейтинг моделей для кодинга (только онлайн).

   Кэширует оценки из внешних бенчмарков (Artificial Analysis
   Coding Index via OpenRouter Benchmarks API) и отдаёт их
   фронту. Эвристика удалена — если модель не покрыта
   бенчмарком, рейтинг отсутствует (score:null).

   Источник:
     GET https://openrouter.ai/api/v1/benchmarks
       ?source=artificial-analysis&task_type=coding
   Ключ берётся у провайдера OpenRouter (Настройки → Провайдер →
   OpenRouter): маршрут /api/coding-ratings/refresh достаёт его из
   серверного хранилища или принимает от клиента. Без ключа —
   только кэш; без кэша — пустой рейтинг.

   Нормализация ключей — та же, что в public/model-match.js:
   lower-case, оставить [a-z0-9.:/].

   Путь файлового кэша приходит параметром (config.codingCachePath,
   по умолчанию data/coding-ratings.json).
   ============================================================ */

const fs = require('fs/promises');
const path = require('path');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24ч

/** @param {unknown} s */
function normModelName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9.:/]/g, '');
}

/** @param {unknown} score */
function tierFromScore(score) {
  if (score == null || typeof score !== 'number') return 'low';
  if (score >= 70) return 'top';
  if (score >= 40) return 'good';
  return 'low';
}

/** @param {string} apiKey @param {{fetch?: typeof fetch}} [options] */
async function fetchFromOpenRouter(apiKey, { fetch: fetchImpl = fetch } = {}) {
  const url =
    'https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis&task_type=coding&max_results=100';
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = /** @type {Error & { status?: number }} */ (
      new Error(`OpenRouter benchmarks HTTP ${res.status}: ${body.slice(0, 500)}`)
    );
    err.status = res.status;
    throw err;
  }
  const json = /** @type {any} */ (await res.json());
  const items = Array.isArray(json.data) ? json.data : [];
  if (!items.length) throw new Error('Пустой ответ benchmarks API');

  /** @type {Record<string, any>} */
  const ratings = {};
  const asOf = json.meta && json.meta.as_of ? json.meta.as_of : new Date().toISOString();
  const citation =
    json.meta && json.meta.citation ? json.meta.citation : 'Artificial Analysis via OpenRouter';
  const sourceUrl =
    json.meta && json.meta.source_url ? json.meta.source_url : 'https://artificialanalysis.ai';
  for (const item of items) {
    const idx = item.coding_index;
    if (idx == null || typeof idx !== 'number') continue;
    const score = Math.round(idx);
    const tier = tierFromScore(score);
    const reasons = [`Artificial Analysis Coding Index: ${score}/100`];
    if (item.display_name) reasons.push(item.display_name);
    const base = {
      score,
      tier,
      reasons,
      source: 'artificial-analysis via openrouter',
      displayName: item.display_name || item.model_permaslug,
      modelPermaslug: item.model_permaslug,
      citation,
      sourceUrl,
    };
    const keys = new Set();
    if (item.model_permaslug) {
      keys.add(normModelName(item.model_permaslug));
      const bare = String(item.model_permaslug).split('/').pop();
      if (bare) keys.add(normModelName(bare));
    }
    if (item.display_name) keys.add(normModelName(item.display_name));
    for (const k of keys) {
      if (!k) continue;
      // не перетирать более конкретный ключ
      if (!ratings[k]) ratings[k] = { ...base };
    }
  }
  return {
    updatedAt: asOf,
    source: 'artificial-analysis via openrouter',
    sourceUrl,
    citation,
    ratings,
    meta: json.meta || null,
  };
}

/**
 * Рейтинг с кэшем: в памяти (TTL 24 ч) и в JSON-файле cachePath.
 * Возвращает { getCodingRatings, refreshCodingRatings }.
 * @param {{ cachePath?: string, logger?: Console, fetch?: typeof fetch }} [options]
 */
function createCodingRatings({ cachePath, logger = console, fetch: fetchImpl } = {}) {
  /** @type {null | {updatedAt: string|null, source: string, sourceUrl: string|null, citation: string, ratings: Record<string, unknown>, cachedAt?: string, meta?: unknown}} */
  let memoryCache = null;
  let memoryCacheAt = 0;

  async function loadCache() {
    if (!cachePath) return null;
    try {
      const raw = await fs.readFile(cachePath, 'utf8');
      const data = JSON.parse(raw);
      if (
        data &&
        typeof data.ratings === 'object' &&
        data.source &&
        data.source !== 'curated-fallback'
      )
        return data;
    } catch {}
    return null;
  }

  /**
   * @param {{updatedAt: string|null, source: string, sourceUrl: string|null, citation: string, ratings: Record<string, unknown>, cachedAt?: string, meta?: unknown}} data
   */
  async function saveCache(data) {
    if (!cachePath) return;
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify(data, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (e) {
      // не критично — рейтинг остаётся в памяти
      if (logger && typeof logger.warn === 'function')
        logger.warn('[coding-ratings] saveCache failed', /** @type {Error} */ (e).message);
    }
  }

  async function getCodingRatings({ allowStale = true } = {}) {
    const now = Date.now();
    if (memoryCache && now - memoryCacheAt < DEFAULT_TTL_MS && allowStale) {
      return memoryCache;
    }
    const data = await loadCache();
    if (data) {
      memoryCache = data;
      memoryCacheAt = now;
      return data;
    }
    // нет кэша — пустой онлайн-рейтинг (эвристика удалена)
    /** @type {{updatedAt: string|null, source: string, sourceUrl: string|null, citation: string, ratings: Record<string, unknown>}} */
    const empty = {
      updatedAt: null,
      source: 'none',
      sourceUrl: null,
      citation:
        'Нет онлайн-данных. Введите ключ OpenRouter в Настройках → Провайдер → OpenRouter и нажмите «Обновить рейтинг» для загрузки Artificial Analysis Coding Index.',
      ratings: {},
    };
    memoryCache = empty;
    memoryCacheAt = now;
    return empty;
  }

  /**
   * @param {{ apiKey?: string }} [options]
   */
  async function refreshCodingRatings({ apiKey } = {}) {
    const key = apiKey || '';
    if (!key) {
      const err = /** @type {Error & { code?: string, status?: number }} */ (
        new Error(
          'Ключ OpenRouter не задан. Введите его в Настройках → Провайдер → OpenRouter и нажмите «Обновить рейтинг».'
        )
      );
      err.code = 'missing_api_key';
      err.status = 400;
      throw err;
    }
    const fresh = /** @type {any} */ (await fetchFromOpenRouter(key, { fetch: fetchImpl }));
    fresh.cachedAt = new Date().toISOString();
    await saveCache(fresh);
    memoryCache = fresh;
    memoryCacheAt = Date.now();
    return fresh;
  }

  return { getCodingRatings, refreshCodingRatings };
}

module.exports = {
  createCodingRatings,
  fetchFromOpenRouter,
  normModelName,
  tierFromScore,
};
