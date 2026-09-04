'use strict';

// ============================================================
// /api/config — публичная конфигурация панели (GET) и запись
// настроек (PUT). Секреты write-only: наружу отдаются только
// булевы has*; сохранённые значения обратно не читаются.
// ============================================================

const { AppError, readJson, sendJson } = require('../http');

// Allowlist ключей, которые клиент может писать (вместо произвольного KV)
const WRITABLE_KEYS = [
  'xkiroKey', 'agentrouterKey', 'agentrouterUserId', 'omniUrl', 'omniKey',
  'agRefreshToken', 'agProject', 'aliases', 'comboActive', 'dlgProvider',
  'modelsProvider', 'statsProvider', 'notificationThresholds',
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
      modelsProvider: s.modelsProvider || '',
      statsProvider: s.statsProvider || '',
      notificationThresholds: s.notificationThresholds || '',
      agentrouterUserId: s.agentrouterUserId || '',
      omniUrl: s.omniUrl || '',
      hasXkiroKey: Boolean(s.xkiroKey),
      hasAgentrouterKey: Boolean(s.agentrouterKey),
      hasOmniRoute: Boolean(s.omniUrl),
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

module.exports = { registerConfigRoutes };
