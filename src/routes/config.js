'use strict';

// ============================================================
// /api/config — публичная конфигурация панели (GET) и запись
// настроек (PUT). Секреты write-only: наружу отдаются только
// булевы has*; сохранённые значения обратно не читаются.
// ============================================================

const { AppError, readJson, sendJson } = require('../http');
const { parsePoolReleaseHours, AGENTROUTER_POOL_RELEASE_HOURS_UTC, AGENTROUTER_POOL_RELEASE_TIMEZONE } = require('../../providers/agentrouter');

/** Разбирает многострочный список OmniRoute URL: каждый адрес
 * валидируется тем же validateUpstreamUrl, что и одиночный; строки
 * нормализуются и дедуплицируются. */
async function validateOmniUrls(value, validateUpstreamUrl) {
  const raw = String(value || '');
  if (!raw.trim()) return [];
  const parts = raw.split(/[\n,]+/).map((p) => p.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    let normalized;
    try {
      normalized = await validateUpstreamUrl(part, { allowPrivate: true });
    } catch {
      throw new AppError(400, 'invalid_omniroute_url', 'Некорректный или запрещённый OmniRoute URL: ' + part);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

// Allowlist ключей, которые клиент может писать (вместо произвольного KV).
// Должен быть подмножеством STORE_KEYS хранилища — это проверяет тест
// «WRITABLE_KEYS маршрута — подмножество STORE_KEYS хранилища».
const WRITABLE_KEYS = [
  'xkiroKey', 'agentrouterKey', 'openrouterKey', 'seloraKey', 'agentrouterUserId', 'omniUrl', 'omniUrls', 'omniKey',
  'agRefreshToken', 'agProject', 'aliases', 'comboActive', 'dlgProvider',
  'dlgTab', 'modelsProvider', 'statsProvider', 'notificationThresholds',
  'agentrouterReleaseHoursUtc',
];

function registerConfigRoutes(router, {
  getStore,
  providers,
  activeProvider,
  antigravityService,
  storeKeys,
  validateUpstreamUrl,
  agentrouterReleases = null,
}) {
  router.add(['GET', 'PUT'], '/api/config', async ({ req, res }) => {
    await antigravityService.ensureLoaded();
    const st = await getStore();

    if (req.method === 'PUT') {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new AppError(400, 'bad_json', 'Ожидается JSON-объект');
      }
      if (Object.hasOwn(body, 'omniUrl') && body.omniUrl) {
        try {
          body.omniUrl = await validateUpstreamUrl(body.omniUrl, { allowPrivate: true });
        } catch {
          throw new AppError(400, 'invalid_omniroute_url', 'Некорректный или запрещённый OmniRoute URL');
        }
      }
      if (Object.hasOwn(body, 'omniUrls') && body.omniUrls) {
        const urls = await validateOmniUrls(body.omniUrls, validateUpstreamUrl);
        body.omniUrls = urls.join('\n');
      }
      if (Object.hasOwn(body, 'agentrouterReleaseHoursUtc')) {
        const raw = String(body.agentrouterReleaseHoursUtc == null ? '' : body.agentrouterReleaseHoursUtc).trim();
        if (!raw) {
          body.agentrouterReleaseHoursUtc = '';
        } else {
          const parts = raw.split(',');
          const seen = new Set();
          for (const part of parts) {
            const t = part.trim();
            if (!t) continue;
            const h = Number(t);
            if (!Number.isInteger(h) || h < 0 || h > 23) {
              throw new AppError(400, 'invalid_agentrouter_releases', 'Некорректные часы AgentRouter: «' + t + '» — допустимы целые 0..23 через запятую');
            }
            seen.add(h);
          }
          if (!seen.size) {
            throw new AppError(400, 'invalid_agentrouter_releases', 'Некорректные часы AgentRouter — укажите часы 0..23 через запятую или оставьте пусто');
          }
          body.agentrouterReleaseHoursUtc = [...seen].sort((a, b) => a - b).join(',');
        }
      }
      const entries = [];
      for (const key of WRITABLE_KEYS) {
        if (Object.hasOwn(body, key)) {
          entries.push([key, body[key] == null ? '' : String(body[key])]);
        }
      }
      // Батч-транзакция: либо все ключи, либо ни один (валидация до записи)
      await st.setMany(entries);
      antigravityService.syncFromStore(entries);
      return sendJson(res, 200, { ok: true }, { 'cache-control': 'no-store' });
    }

    const s = await st.snapshot();
    const providerInfo = providers.map((p) => {
      const storeField = storeKeys[p.id];
      return {
        id: p.id,
        name: p.name,
        site: p.site || '',
        hasKey: storeField ? Boolean(s[storeField]) : Boolean(p.apiKey),
      };
    });
    const agStatus = antigravityService.status();
    // Эффективный график: приоритет — значение из хранилища (настройки
    // провайдера), затем env-дефолт из app.js. Пустая строка → дефолт.
    let effectiveReleases = agentrouterReleases;
    const storedRaw = s.agentrouterReleaseHoursUtc != null ? String(s.agentrouterReleaseHoursUtc).trim() : '';
    if (storedRaw) {
      const hours = parsePoolReleaseHours(storedRaw);
      // parse вернёт дефолт, если ввод полностью невалиден, но PUT уже
      // не дал сохранить такое — здесь считаем hours валидными.
      effectiveReleases = {
        timezone: AGENTROUTER_POOL_RELEASE_TIMEZONE,
        hoursUtc: hours,
      };
    } else if (!effectiveReleases) {
      effectiveReleases = {
        timezone: AGENTROUTER_POOL_RELEASE_TIMEZONE,
        hoursUtc: [...AGENTROUTER_POOL_RELEASE_HOURS_UTC],
      };
    }
    const data = {
      aliases: s.aliases || '',
      comboActive: s.comboActive || '',
      dlgProvider: s.dlgProvider || '',
      dlgTab: s.dlgTab || '',
      modelsProvider: s.modelsProvider || '',
      statsProvider: s.statsProvider || '',
      notificationThresholds: s.notificationThresholds || '',
      agentrouterUserId: s.agentrouterUserId || '',
      agentrouterReleaseHoursUtc: s.agentrouterReleaseHoursUtc || '',
      omniUrl: s.omniUrl || '',
      omniUrls: s.omniUrls || '',
      hasXkiroKey: Boolean(s.xkiroKey),
      hasAgentrouterKey: Boolean(s.agentrouterKey),
      hasOpenrouterKey: Boolean(s.openrouterKey),
      hasSeloraKey: Boolean(s.seloraKey),
      hasOmniRoute: Boolean(s.omniUrl) || Boolean(String(s.omniUrls || '').trim()),
      hasOmniKey: Boolean(s.omniKey),
      hasGoogleToken: Boolean(agStatus.hasToken) || agStatus.hasRefresh,
      // График высвобождения пула AgentRouter (Claude/GPT): часы в UTC
      // + якорный часовой пояс. Фронтенд считает ближайшее высвобождение
      // и переводит в локальное время браузера.
      agentrouterReleases: effectiveReleases,
    };
    return sendJson(res, 200, {
      ok: true,
      data,
      providers: providerInfo,
      activeProvider: activeProvider ? activeProvider.id : null,
      ...data,
    }, { 'cache-control': 'no-store' });
  });
}

module.exports = { registerConfigRoutes, WRITABLE_KEYS, validateOmniUrls };
