'use strict';

// ============================================================
// /api/config — публичная конфигурация панели (GET) и запись
// настроек (PUT). Секреты write-only: наружу отдаются только
// булевы has*; сохранённые значения обратно не читаются.
// ============================================================

const { AppError, readJson, sendJson } = require('../http');
const {
  CREDENTIAL_FIELDS,
  PROVIDER_CREDENTIAL_STORE_KEYS,
  ADAPTER_PROVIDER_IDS,
  getDescriptor,
} = require('../provider-descriptors');
const {
  parsePoolReleaseHours,
  AGENTROUTER_POOL_RELEASE_HOURS_UTC,
  AGENTROUTER_POOL_RELEASE_TIMEZONE,
} = require('../../providers/agentrouter');

/** Разбирает многострочный список OmniRoute URL: каждый адрес
 * валидируется тем же validateUpstreamUrl, что и одиночный; строки
 * нормализуются и дедуплицируются. */
async function validateOmniUrls(value, validateUpstreamUrl) {
  const raw = String(value || '');
  if (!raw.trim()) return [];
  const parts = raw
    .split(/[\n,]+/)
    .map(p => p.trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    let normalized;
    try {
      normalized = await validateUpstreamUrl(part, { allowPrivate: true });
    } catch {
      throw new AppError(
        400,
        'invalid_omniroute_url',
        'Некорректный или запрещённый OmniRoute URL: ' + part
      );
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
  // Секреты и ID провайдеров — по дескрипторам (P2-1)
  ...PROVIDER_CREDENTIAL_STORE_KEYS,
  'omniUrl',
  'omniUrls',
  'omniKey',
  'agRefreshToken',
  'agProject',
  'aliases',
  'comboActive',
  'dlgProvider',
  'dlgTab',
  'modelsProvider',
  'notificationThresholds',
  'comboDisabled',
  'agentrouterReleaseHoursUtc',
];

// Имя секрета дескриптора → ключ KV его credentials: обратная таблица
// CREDENTIAL_FIELDS, нужна antigravityService.syncFromStore.
const CREDENTIAL_STORE_KEYS = {};
for (const [storeKey, [providerId, field]] of Object.entries(CREDENTIAL_FIELDS)) {
  if (!CREDENTIAL_STORE_KEYS[providerId]) CREDENTIAL_STORE_KEYS[providerId] = {};
  CREDENTIAL_STORE_KEYS[providerId][field] = storeKey;
}

/** Флаги has*Key по провайдерам-адаптерам: активный аккаунт, иначе
 *  legacy KV (совместимость старых баз). Флаг = has<Id>Key. */
async function credentialFlags(snapshot, st) {
  const flags = {};
  for (const id of ADAPTER_PROVIDER_IDS) {
    const descriptor = getDescriptor(id);
    const secretField = (descriptor.credentials.find(c => c.field === 'api_key') || {}).storeKey;
    if (!secretField) continue;
    let present = false;
    if (st.accounts && typeof st.accounts.getActiveCredential === 'function') {
      const credential = await st.accounts.getActiveCredential(id);
      present = Boolean(credential && (credential.api_key || credential.key));
    }
    flags['has' + id.charAt(0).toUpperCase() + id.slice(1) + 'Key'] =
      present || Boolean(snapshot[secretField]);
  }
  return flags;
}

function registerConfigRoutes(
  router,
  {
    getStore,
    providers,
    activeProvider,
    antigravityService,
    storeKeys,
    validateUpstreamUrl,
    agentrouterReleases = null,
    onCredentialsChanged = () => {},
  }
) {
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
          throw new AppError(
            400,
            'invalid_omniroute_url',
            'Некорректный или запрещённый OmniRoute URL'
          );
        }
      }
      if (Object.hasOwn(body, 'omniUrls') && body.omniUrls) {
        const urls = await validateOmniUrls(body.omniUrls, validateUpstreamUrl);
        body.omniUrls = urls.join('\n');
      }
      if (Object.hasOwn(body, 'agentrouterReleaseHoursUtc')) {
        const raw = String(
          body.agentrouterReleaseHoursUtc == null ? '' : body.agentrouterReleaseHoursUtc
        ).trim();
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
              throw new AppError(
                400,
                'invalid_agentrouter_releases',
                'Некорректные часы AgentRouter: «' + t + '» — допустимы целые 0..23 через запятую'
              );
            }
            seen.add(h);
          }
          if (!seen.size) {
            throw new AppError(
              400,
              'invalid_agentrouter_releases',
              'Некорректные часы AgentRouter — укажите часы 0..23 через запятую или оставьте пусто'
            );
          }
          body.agentrouterReleaseHoursUtc = [...seen].sort((a, b) => a - b).join(',');
        }
      }
      const entries = [];
      // Ключ KV → [id провайдера, поле credentials]; см. provider-descriptors
      const credentialFields = CREDENTIAL_FIELDS;
      const credentialWrites = [];
      for (const key of WRITABLE_KEYS) {
        if (!Object.hasOwn(body, key)) continue;
        const value = body[key] == null ? '' : String(body[key]);
        const credential = credentialFields[key];
        if (credential) {
          credentialWrites.push([credential[0], credential[1], value]);
          entries.push([key, value]);
        } else entries.push([key, value]);
      }
      await st.setMany(entries);
      if (st.accounts && typeof st.accounts.setActiveCredentialField === 'function') {
        for (const [providerId, field, value] of credentialWrites) {
          await st.accounts.setActiveCredentialField(providerId, field, value);
        }
      } else {
        await st.setMany(
          credentialWrites.map(([providerId, field, value]) => [
            Object.keys(credentialFields).find(
              key => credentialFields[key][0] === providerId && credentialFields[key][1] === field
            ),
            value,
          ])
        );
      }
      antigravityService.syncFromStore(
        entries.concat(
          credentialWrites.map(([providerId, field, value]) => [
            CREDENTIAL_STORE_KEYS[providerId][field],
            value,
          ])
        )
      );
      // Смена ключа провайдера обесценивает кеш его usage/models (P3-3)
      if (credentialWrites.length) {
        for (const [providerId] of credentialWrites) {
          try {
            onCredentialsChanged(providerId);
          } catch {}
        }
      }
      return sendJson(res, 200, { ok: true }, { 'cache-control': 'no-store' });
    }

    const s = await st.snapshot();
    const providerInfo = [];
    for (const p of providers) {
      const storeField = storeKeys[p.id];
      const credential =
        st.accounts && typeof st.accounts.getActiveCredential === 'function'
          ? await st.accounts.getActiveCredential(p.id)
          : null;
      providerInfo.push({
        id: p.id,
        name: p.name,
        site: p.site || '',
        hasKey: credential
          ? Boolean(credential.api_key || credential.key || credential.oauth_refresh)
          : storeField
            ? Boolean(s[storeField])
            : Boolean(p.apiKey),
      });
    }
    const agStatus = antigravityService.status();
    // Эффективный график: приоритет — значение из хранилища (настройки
    // провайдера), затем env-дефолт из app.js. Пустая строка → дефолт.
    let effectiveReleases = agentrouterReleases;
    const storedRaw =
      s.agentrouterReleaseHoursUtc != null ? String(s.agentrouterReleaseHoursUtc).trim() : '';
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
      notificationThresholds: s.notificationThresholds || '',
      comboDisabled: s.comboDisabled || '',
      agentrouterUserId:
        (await st.accounts.getActiveCredential('agentrouter'))?.user_id ||
        s.agentrouterUserId ||
        '',
      agentrouterReleaseHoursUtc: s.agentrouterReleaseHoursUtc || '',
      omniUrl: s.omniUrl || '',
      omniUrls: s.omniUrls || '',
      // Флаги «ключ задан» — по дескрипторам: активный аккаунт, иначе
      // legacy KV для старых баз (P2-1).
      ...(await credentialFlags(s, st)),
      hasOmniRoute:
        Boolean((await st.accounts.getActiveCredential('omniroute'))?.url) ||
        Boolean(s.omniUrl) ||
        Boolean(String(s.omniUrls || '').trim()),
      hasOmniKey: Boolean((await st.accounts.getActiveCredential('omniroute'))?.key || s.omniKey),
      hasGoogleToken: Boolean(agStatus.hasToken) || agStatus.hasRefresh,
      // График высвобождения пула AgentRouter (Claude/GPT): часы в UTC
      // + якорный часовой пояс. Фронтенд считает ближайшее высвобождение
      // и переводит в локальное время браузера.
      agentrouterReleases: effectiveReleases,
    };
    return sendJson(
      res,
      200,
      {
        ok: true,
        data,
        providers: providerInfo,
        activeProvider: activeProvider ? activeProvider.id : null,
        ...data,
      },
      { 'cache-control': 'no-store' }
    );
  });
}

module.exports = { registerConfigRoutes, WRITABLE_KEYS, validateOmniUrls };
