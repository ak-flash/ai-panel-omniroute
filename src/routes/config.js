'use strict';

// ============================================================
// /api/config — публичная конфигурация панели (GET) и запись
// настроек (PUT). Секреты write-only: наружу отдаются только
// булевы has*; сохранённые значения обратно не читаются.
// ============================================================

const { AppError, readJson, sendJson } = require('../http');

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
  'xkiroKey', 'agentrouterKey', 'openrouterKey', 'agentrouterUserId', 'omniUrl', 'omniUrls', 'omniKey',
  'agRefreshToken', 'agProject', 'aliases', 'comboActive', 'dlgProvider',
  'dlgTab', 'modelsProvider', 'statsProvider', 'notificationThresholds',
];

function registerConfigRoutes(router, {
  getStore,
  providers,
  activeProvider,
  antigravityService,
  storeKeys,
  validateUpstreamUrl,
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
    const data = {
      aliases: s.aliases || '',
      comboActive: s.comboActive || '',
      dlgProvider: s.dlgProvider || '',
      dlgTab: s.dlgTab || '',
      modelsProvider: s.modelsProvider || '',
      statsProvider: s.statsProvider || '',
      notificationThresholds: s.notificationThresholds || '',
      agentrouterUserId: s.agentrouterUserId || '',
      omniUrl: s.omniUrl || '',
      omniUrls: s.omniUrls || '',
      hasXkiroKey: Boolean(s.xkiroKey),
      hasAgentrouterKey: Boolean(s.agentrouterKey),
      hasOpenrouterKey: Boolean(s.openrouterKey),
      hasOmniRoute: Boolean(s.omniUrl) || Boolean(String(s.omniUrls || '').trim()),
      hasOmniKey: Boolean(s.omniKey),
      hasGoogleToken: Boolean(agStatus.hasToken) || agStatus.hasRefresh,
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
