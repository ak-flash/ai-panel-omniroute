'use strict';

// Провайдер Experiential Labs — OpenAI-совместимый API.
// Базовый адрес API уже содержит /v1.

const { fetchJson } = require('../src/fetch-utils');
const { normalizeLog } = require('../src/file-logger');

const DEFAULT_NAME = 'Experiential Labs';
const DEFAULT_URL = 'https://api.experientiallabs.ai/v1';
const DEFAULT_SITE = 'https://platform.experientiallabs.ai/overview';
const REQUEST_TIMEOUT_MS = 20000;

function createExperientialProvider(config = {}) {
  const name = config.name || DEFAULT_NAME;
  const upstream = String(config.url || DEFAULT_URL).replace(/\/+$/, '');
  const apiKey = config.apiKey || '';
  const log = normalizeLog(config.log);
  const authScheme = 'authorization';
  const buildHeaders = (key) => (key ? { authorization: 'Bearer ' + key } : {});

  const management = upstream.replace(/\/v1$/, '');

  async function apiGet(pathname, key = '', base = upstream) {
    const headers = { accept: 'application/json', ...buildHeaders(key || apiKey) };
    try {
      const { response, data } = await fetchJson(base + pathname, { headers }, REQUEST_TIMEOUT_MS);

      return { status: response.status, data: data || {} };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[Experiential Labs] ${pathname}: сеть/таймаут — ${message}`);
      return { status: 502, data: { error: 'provider_error', message } };
    }
  }

  const toNumber = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };

  const rowsFrom = (data) => {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.data)) return data.data;
    if (Array.isArray(data.rows)) return data.rows;
    if (Array.isArray(data.usage)) return data.usage;
    return [];
  };

  async function getModels(key = '') {
    const result = await apiGet('/api/models', key, management);
    if (result.status === 401) {
      return { status: 401, data: { error: 'unauthorized', message: 'Experiential Labs не принял ключ' } };
    }
    if (result.status !== 200) return result;

    const models = rowsFrom(result.data)
      .filter((model) => model && typeof model.id === 'string' && model.id)
      .map((model) => {
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
            input: inputNano == null ? (input == null ? 0 : input) : inputNano / 1000000000,
            output: outputNano == null ? (output == null ? 0 : output) : outputNano / 1000000000,
          },
        };
      });
    return { status: 200, data: { data: models } };
  }

  async function getUsage(key = '') {
    const whoami = await apiGet('/api/whoami', key, management);
    if (whoami.status === 401) {
      return { status: 401, data: { error: 'unauthorized', message: 'Experiential Labs не принял ключ' } };
    }
    if (whoami.status !== 200) return whoami;

    const orgId = whoami.data.org_id || (whoami.data.data && whoami.data.data.org_id);
    if (!orgId) {
      return { status: 502, data: { error: 'bad_response', message: 'Experiential Labs не вернул org_id' } };
    }

    const query = '?org_id=' + encodeURIComponent(orgId) + '&scope=org&group_by=day';
    const [credits, daily] = await Promise.all([
      apiGet('/api/v1/credits', key, management),
      apiGet('/api/gateway/usage/daily' + query, key, management),
    ]);
    if (credits.status === 401 || daily.status === 401) {
      return { status: 401, data: { error: 'unauthorized', message: 'Experiential Labs не принял ключ' } };
    }
    if (credits.status !== 200) return credits;
    if (daily.status !== 200) return daily;

    const creditData = credits.data.data || credits.data;
    const totalCredits = toNumber(creditData.total_credits);
    const totalUsage = toNumber(creditData.total_usage);
    const balance = totalCredits == null || totalUsage == null ? null : totalCredits - totalUsage;
    const today = new Date().toISOString().slice(0, 10);
    const todayRow = rowsFrom(daily.data).find((row) => String(row.day || row.date || '') === today);
    const todayNano = todayRow && (todayRow.spend_nano_usd ?? todayRow.cost_nano_usd);
    const todayUsd = toNumber(todayNano);
    const requests = todayRow && toNumber(todayRow.requests ?? todayRow.request_count ?? todayRow.request_count_total);

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
    site: DEFAULT_SITE,
    upstream,
    apiKey,
    authScheme,
    buildHeaders,
    getUsage,
    getModels,
  };
}

module.exports = { createExperientialProvider };
