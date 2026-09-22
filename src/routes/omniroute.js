'use strict';

// ============================================================
// Прокси до OmniRoute. Адреса берутся ТОЛЬКО из серверного
// хранилища (Настройки) — клиентский заголовок x-omniroute-url
// игнорируется. Сохранённый URL может быть приватным (LAN): это
// осознанно настроенный пользователем upstream.
//
// Поддерживается несколько адресов (omniUrls — по одному в строке,
// запятая тоже допустима): каждый кандидат проверяется коротким
// запросом (любой HTTP-ответ, даже 401/404 — адрес жив), первый
// доступный обслуживает запрос. Рабочий адрес кешируется на
// CACHE_TTL_MS, чтобы не пробовать список на каждый вызов; при
// обрыве кеш сбрасывается и запрос один раз повторяется на
// следующем доступном адресе. Одиночный legacy-omniUrl остаётся
// фолбэком и работает без probe — как раньше.
// Логи доступности — по событиям: повторные проверки того же адреса
// не создают одинаковых WARN/INFO в логе.
// ============================================================

const { AppError, readBody } = require('../http');
const { handleProxy } = require('../proxy');

const PROXY_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
const PROBE_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 30000;

// Последний рабочий адрес мульти-режима: { raw, url, ts }
let lastGood = null;

// Последнее записанное в лог состояние каждого адреса:
// 'up' | 'down' — чтобы не дублировать WARN/INFO.
const loggedProbeState = new Map();

function logProbeState(log, raw, url, state) {
  if (loggedProbeState.get(raw) === state) return;
  loggedProbeState.set(raw, state);
  if (state === 'up') log.info('[omniroute] выбран доступный адрес: ' + url);
  else log.warn('[omniroute] адрес недоступен: ' + raw);
}

function parseOmniUrls(raw) {
  const urls = String(raw || '')
    .split(/[\n,]+/)
    .map((u) => u.trim())
    .filter(Boolean);
  // Дедупликация с сохранением порядка
  return [...new Set(urls)];
}

function collectCandidates(s) {
  const candidates = parseOmniUrls(s.omniUrls);
  const legacy = String(s.omniUrl || '').trim();
  if (legacy && !candidates.includes(legacy)) candidates.push(legacy);
  return candidates;
}

/** Любой HTTP-ответ (включая 401/404 и редиректы) — адрес жив;
 * ошибка сети или таймаут — недоступен. */
async function probeUrl(candidate, validateUpstreamUrl) {
  let upstream;
  try {
    upstream = await validateUpstreamUrl(candidate, { allowPrivate: true });
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(upstream + '/', { signal: controller.signal });
    return upstream;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function validateCandidate(candidate, validateUpstreamUrl) {
  try {
    return await validateUpstreamUrl(candidate, { allowPrivate: true });
  } catch {
    throw new AppError(400, 'invalid_omniroute_url', 'Некорректный или запрещённый OmniRoute URL');
  }
}

/**
 * Выбирает upstream для запроса.
 * @returns {{ raw: string, url: string } | null} — null, когда кандидатов нет
 */
async function resolveUpstream(candidates, validateUpstreamUrl, log) {
  if (!candidates.length) return null;

  // Одиночный адрес — без probe, как раньше
  if (candidates.length === 1) {
    const url = await validateCandidate(candidates[0], validateUpstreamUrl);
    return { raw: candidates[0], url };
  }

  // Свежий кеш последнего рабочего адреса — без probe
  if (lastGood && Date.now() - lastGood.ts < CACHE_TTL_MS && candidates.includes(lastGood.raw)) {
    return lastGood;
  }

  for (const raw of candidates) {
    const url = await probeUrl(raw, validateUpstreamUrl);
    if (url) {
      lastGood = { raw, url, ts: Date.now() };
      logProbeState(log, raw, url, 'up');
      return lastGood;
    }
    logProbeState(log, raw, raw, 'down');
  }
  throw new AppError(
    502,
    'omniroute_unreachable',
    'Ни один из адресов OmniRoute не отвечает (' + candidates.join(', ') + ')',
  );
}

function registerOmnirouteRoutes(router, { getStore, validateUpstreamUrl, logger }) {
  async function handle({ req, res, url }) {
    const s = await (await getStore()).snapshot();
    const candidates = collectCandidates(s);
    if (!candidates.length) {
      throw new AppError(400, 'no_omniroute_url', 'Укажите OmniRoute URL в Настройках');
    }

    // Ключ OmniRoute хранится на сервере: авторизуем запрос сами.
    // Тело читаем заранее — иначе повторная попытка на другом
    // адресе после обрыва upstream невозможна (поток уже прочитан).
    const body = await readBody(req);
    const headers = { ...req.headers };
    if (s.omniKey) headers.authorization = 'Bearer ' + s.omniKey;
    delete headers['x-omniroute-url'];
    req.headers = headers;

    const log = logger || console;
    const attempt = (upstream) =>
      handleProxy(req, res, url, { prefix: '/omniroute', upstream, logger, body });

    const chosen = await resolveUpstream(candidates, validateUpstreamUrl, log);
    if (!chosen) return; // недостижимо: кандидатов нет проверено выше
    try {
      return await attempt(chosen.url);
    } catch (err) {
      // Повтор возможен только до отправки заголовков клиенту:
      // handleProxy при headersSent уничтожает соединение без AppError
      if (!(err instanceof AppError) || err.code !== 'proxy_error') throw err;
      if (lastGood && lastGood.raw === chosen.raw) lastGood = null;
      const rest = candidates.filter((c) => c !== chosen.raw);
      const fallback = await resolveUpstream(rest, validateUpstreamUrl, log);
      if (!fallback) throw err;
      log.warn('[omniroute] ' + chosen.url + ' не ответил — повтор на ' + fallback.url);
      return attempt(fallback.url);
    }
  }

  router.add(PROXY_METHODS, '/omniroute', handle);
  router.add(PROXY_METHODS, '/omniroute/*', handle);
}

module.exports = { registerOmnirouteRoutes, parseOmniUrls, collectCandidates, probeUrl };
