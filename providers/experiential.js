'use strict';

// ============================================================
// Провайдер Experiential Labs — OpenAI-совместимый API.
// Базовый адрес API уже содержит /v1; management-эндпоинты лежат
// на том же хосте без /v1, поэтому запросы идут с указанием base.
//
// Авторизация: Authorization: Bearer <ключ>.
// ============================================================

const { createProviderClient, bearerAuth } = require('../src/provider-client');
const { getDescriptor } = require('../src/provider-descriptors');

const descriptor = /** @type {import('../src/provider-descriptors').ProviderDescriptor} */ (
  getDescriptor('experiential')
);
const DEFAULT_NAME = descriptor.name;
const DEFAULT_URL = 'https://api.experientiallabs.ai/v1';
const REQUEST_TIMEOUT_MS = 20000;

const UNAUTHORIZED = {
  error: 'unauthorized',
  message: 'Experiential Labs не принял ключ',
};

function createExperientialProvider(config = {}) {
  const name = config.name || DEFAULT_NAME;
  const apiKey = config.apiKey || '';

  const client = createProviderClient({
    // В логах — каноническое имя провайдера, а не подпись из config
    name: descriptor.name,
    upstream: config.url || DEFAULT_URL,
    auth: bearerAuth(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    log: config.log,
    debug: config.debug === true,
    fetchImpl: config.fetchImpl,
  });

  const authScheme = 'authorization';
  const buildHeaders = key => bearerAuth().buildHeaders({ key });

  // Management-хост: тот же, что и API, но без суффикса /v1
  const management = client.upstream.replace(/\/v1$/, '');

  const apiGet = (pathname, key = '', base) =>
    client.get(pathname, { credential: { key: key || apiKey }, base });

  const toNumber = value => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };

  const rowsFrom = data => {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.data)) return data.data;
    if (Array.isArray(data.rows)) return data.rows;
    if (Array.isArray(data.usage)) return data.usage;
    return [];
  };

  async function getModels(key = '') {
    const result = await apiGet('/api/models', key, management);
    if (result.status === 401) {
      return { status: 401, data: { ...UNAUTHORIZED } };
    }
    if (result.status !== 200) return result;

    const models = rowsFrom(result.data)
      .filter(model => model && typeof model.id === 'string' && model.id)
      .map(model => {
        const pricing = model.pricing || {};
        const inputNano = toNumber(pricing.input_nano_usd_per_million ?? pricing.prompt);
        const outputNano = toNumber(pricing.output_nano_usd_per_million ?? pricing.completion);
        const input = toNumber(pricing.input ?? pricing.input_per_1m);
        const output = toNumber(pricing.output ?? pricing.output_per_1m);
        return {
          id: model.id,
          display_name: model.name || model.display_name || model.id,
          access_tier: 'paid',
          context_length: model.context_length || model.context_window || null,
          pricing: {
            input: inputNano != null ? inputNano / 1000000000 : input,
            output: outputNano != null ? outputNano / 1000000000 : output,
          },
        };
      });
    return { status: 200, data: { data: models } };
  }

  async function getUsage(key = '') {
    const whoami = await apiGet('/api/whoami', key, management);
    if (whoami.status === 401) {
      return { status: 401, data: { ...UNAUTHORIZED } };
    }
    if (whoami.status !== 200) return whoami;

    const orgId = whoami.data.org_id || (whoami.data.data && whoami.data.data.org_id);
    if (!orgId) {
      return {
        status: 502,
        data: { error: 'bad_response', message: 'Experiential Labs не вернул org_id' },
      };
    }

    const [credits, daily] = await Promise.all([
      apiGet('/api/v1/credits', key, management),
      client.get('/api/gateway/usage/daily', {
        credential: { key: key || apiKey },
        base: management,
        query: { org_id: orgId, scope: 'org', group_by: 'day' },
      }),
    ]);
    if (credits.status === 401 || daily.status === 401) {
      return { status: 401, data: { ...UNAUTHORIZED } };
    }
    if (credits.status !== 200) return credits;
    if (daily.status !== 200) return daily;

    const creditData = credits.data.data || credits.data;
    const totalCredits = toNumber(creditData.total_credits);
    const totalUsage = toNumber(creditData.total_usage);
    const balance = totalCredits == null || totalUsage == null ? null : totalCredits - totalUsage;
    const today = new Date().toISOString().slice(0, 10);
    const todayRow = rowsFrom(daily.data).find(row => String(row.day || row.date || '') === today);
    const todayNano = todayRow && (todayRow.spend_nano_usd ?? todayRow.cost_nano_usd);
    const todayUsd = toNumber(todayNano);
    // Строки за сегодня нет → значение неизвестно (null), а не 0 (P1-8)
    const requests = todayRow
      ? toNumber(todayRow.requests ?? todayRow.request_count ?? todayRow.request_count_total)
      : null;

    return {
      status: 200,
      data: {
        wallet: { balance_usd: balance },
        today_usd: todayUsd == null ? null : todayUsd / 1000000000,
        requests,
      },
    };
  }

  return {
    id: 'experiential',
    name,
    site: descriptor.site,
    upstream: client.upstream,
    apiKey,
    authScheme,
    buildHeaders,
    getUsage,
    getModels,
  };
}

module.exports = { createExperientialProvider };
