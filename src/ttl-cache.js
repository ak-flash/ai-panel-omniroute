'use strict';

// ============================================================
// Кеш с TTL и объединением одинаковых запросов.
//
// Зачем: браузер и трекер дёргают /api/providers/:id/usage и
// /models часто, а провайдеры (особенно AgentRouter) защищены от
// антибот-файрвола и начинают отвечать 429 на частые запросы.
// Поэтому ответы провайдера кешируются на сервере, а параллельные
// одинаковые запросы объединяются в один поход в upstream.
//
// Свойства:
//   * успешный ответ живёт ttlMs;
//   * ошибка кешируется коротко (errorTtlMs), чтобы не превратить
//     недоступность провайдера в поток запросов, но и не залипать;
//   * loader, который бросил, не кешируется вообще — следующий
//     запрос пробует снова;
//   * ключ хешируется, в памяти не остаются секреты;
//   * размер ограничен: старые записи вытесняются (FIFO по порядку
//     добавления), устаревшие подчищаются при каждой записи;
//   * now внедряется — тесты не ждут реального времени.
// ============================================================

const crypto = require('crypto');

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_ERROR_TTL_MS = 5_000;
const DEFAULT_MAX_ENTRIES = 256;

/** Прячет секрет: в ключах кеша и в отладке его быть не должно. */
function fingerprint(value) {
  if (!value) return '';
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

/**
 * @param {object} options
 * @param {number} [options.ttlMs]         время жизни успешного ответа
 * @param {number} [options.errorTtlMs]    время жизни кешированной ошибки
 * @param {number} [options.maxEntries]    предел числа записей
 * @param {() => number} [options.now]     часы (внедряются в тестах)
 */
function createTtlCache({
  ttlMs = DEFAULT_TTL_MS,
  errorTtlMs = DEFAULT_ERROR_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => Date.now(),
} = {}) {
  // key → { value, expiresAt, ok }
  const entries = new Map();
  // key → Promise: объединение параллельных одинаковых загрузок
  const inFlight = new Map();

  function evictIfNeeded() {
    // Сначала убираем протухшее, потом — лишнее по порядку добавления
    const ts = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= ts) entries.delete(key);
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  function store(key, value, ok) {
    const ttl = ok ? ttlMs : errorTtlMs;
    if (ttl <= 0) return value;
    // Повторная запись того же ключа удаляет старую позицию в порядке Map,
    // поэтому «самый старый» всегда означает «самый давно записанный».
    entries.delete(key);
    entries.set(key, { value, expiresAt: now() + ttl, ok });
    evictIfNeeded();
    return value;
  }

  /**
   * Отдаёт значение из кеша либо вызывает loader. Параллельные вызовы
   * с одинаковым ключом разделяют один промис.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} loader
   * @param {(value: T) => boolean} [isOk] признак «ответ удачный»
   * @returns {Promise<T>}
   */
  function get(key, loader, isOk = () => true) {
    const hit = entries.get(key);
    if (hit && hit.expiresAt > now()) return Promise.resolve(hit.value);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const promise = (async () => {
      try {
        const value = await loader();
        return store(key, value, isOk(value) !== false);
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, promise);
    return promise;
  }

  /** Сброс одной записи или всего кеша (новые ключи, смена учётных данных). */
  function invalidate(key) {
    if (key === undefined) entries.clear();
    else entries.delete(key);
  }

  /** Диагностика для /api/ready и логов; секретов не содержит. */
  function stats() {
    const ts = now();
    let fresh = 0;
    for (const entry of entries.values()) if (entry.expiresAt > ts) fresh += 1;
    return { entries: entries.size, fresh, inFlight: inFlight.size, ttlMs };
  }

  return { get, invalidate, keys: () => [...entries.keys()], stats, fingerprint };
}

module.exports = {
  DEFAULT_ERROR_TTL_MS,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
  createTtlCache,
  fingerprint,
};
