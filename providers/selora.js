'use strict';

// ============================================================
// Провайдер Selora (selora.lol, «AI API Gateway») — фабрика адаптера.
//
// Окружение не используется: адрес API вшит (DEFAULT_URL), ключ
// всегда присылает клиент. config нужен тестам (подмена адреса на
// mock-upstream).
//
// Эндпоинты:
//   GET /v1/me          → профиль: план, кошелёк, окна (план, fallback)
//   GET /v1/me/windows  → окна расхода: session (4 ч) и week (7 д)
//   GET /v1/models      → каталог моделей с ценами за 1M токенов
//
// Авторизация: x-api-key <sk-gw-…> (принимается и Bearer).
// Ответы нормализуются в формат панели (как у xKiro):
//   usage → { plan, wallet: { balance_usd }, windows: [{ kind, … }] }
//   models → { data: [{ id, display_name, pricing: { input, output } }] }
// ============================================================

const { fetchJson } = require('../src/fetch-utils');
const { normalizeLog } = require('../src/file-logger');

const DEFAULT_NAME = 'Selora';
const DEFAULT_URL = 'https://api.selora.lol'; // вшит в фабрику — не выносится в настройки

// Таймаут запросов к API провайдера
const REQUEST_TIMEOUT_MS = 20000;

// Длительности окон Selora: короткое — 4-часовая сессия,
// длинное — скользящая неделя
const SHORT_WINDOW_SEC = 4 * 3600;
const LONG_WINDOW_SEC = 7 * 24 * 3600;

/**
 * Создаёт адаптер провайдера Selora.
 *
 * config:
 *   name   — отображаемое имя
 *   url    — базовый адрес API (тесты подменяют на mock-upstream)
 *   apiKey — ключ адаптера; по умолчанию пуст — ключ присылает клиент
 *
 * Каждый метод возвращает { status, data }: код ответа upstream и
 * нормализованный JSON в формате панели. Ключ из аргумента
 * приоритетнее ключа из config.
 */
function createSeloraProvider(config = {}) {
    const name = config.name || DEFAULT_NAME;
    const upstream = String(config.url || DEFAULT_URL).replace(/\/+$/, '');
    const apiKey = config.apiKey || '';
    const log = normalizeLog(config.log);
    const debug = config.debug === true;

    // Selora авторизует запросы заголовком x-api-key (Bearer тоже принимается)
    const authScheme = 'x-api-key';
    const buildHeaders = (key) => (key ? { 'x-api-key': key } : {});

    async function apiGet(pathname, key = '') {
        const headers = { accept: 'application/json', ...buildHeaders(key || apiKey) };
        const startedAt = Date.now();
        if (debug) {
            const safeHeaders = { ...headers };
            if (safeHeaders['x-api-key']) safeHeaders['x-api-key'] = '***';
            log.info(`[Selora] ${pathname}`, { headers: safeHeaders });
        }
        try {
            const { response, data } = await fetchJson(upstream + pathname, { headers }, REQUEST_TIMEOUT_MS);
            if (debug) {
                log.info(`[Selora] ${pathname} → ${response.status} (${Date.now() - startedAt} ms)`);
            }
            return { status: response.status, data: data || {} };
        } catch (error) {
            if (error.code === 'upstream_invalid_json') {
                const { status, contentType, snippet } = error.details;
                log(
                    `[Selora] ${pathname}: не-JSON ответ (HTTP ${status}, ${contentType}):`,
                    snippet || '(пустое тело)',
                );
                return {
                    status: 502,
                    data: {
                        error: 'bad_response',
                        message: `Провайдер вернул не-JSON ответ (HTTP ${status}, ${contentType})`,
                    },
                };
            }
            const msg = error.message || 'Ошибка запроса';
            const cause = error.cause instanceof Error ? error.cause.message : '';
            log(`[Selora] ${pathname}: сеть/таймаут — ${msg}${cause ? ' (причина: ' + cause + ')' : ''}`);
            return {
                status: 502,
                data: {
                    error: 'provider_error',
                    message: msg,
                },
            };
        }
    }

    const toNum = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    };

    // Первое непустое поле из списка (окна приходят camelCase из
    // /v1/me/windows и snake_case из user.windows в /v1/me)
    const pick = (obj, fields) => {
        for (const f of fields) {
            const v = obj && obj[f];
            if (v != null && v !== '') return v;
        }
        return null;
    };

    /**
     * Окно расхода Selora → формат панели. Секунды до сброса берутся
     * из resetsInMs (число) или resetsAt (ISO-строка).
     */
    function normalizeWindow(raw, kind, windowSec) {
        const spent = pick(raw, ['usedUsd', 'used_usd']);
        const cap = pick(raw, ['limitUsd', 'limit_usd']);
        let resetsInSec = 0;
        const ms = pick(raw, ['resetsInMs', 'resets_in_ms']);
        if (ms != null) {
            resetsInSec = Math.max(0, Math.floor(toNum(ms) / 1000));
        } else {
            const at = Date.parse(String(pick(raw, ['resetsAt', 'resets_at']) || ''));
            if (Number.isFinite(at)) resetsInSec = Math.max(0, Math.floor((at - Date.now()) / 1000));
        }
        return {
            kind,
            spent_usd: spent == null ? 0 : toNum(spent),
            // limitUsd "0" — окно без лимита: фронтенд не показывает процент
            cap_usd: cap == null ? 0 : toNum(cap),
            window_sec: windowSec,
            resets_in_sec: resetsInSec,
        };
    }

    // GET /v1/me + /v1/me/windows → статистика в формате панели
    async function getUsage(key = '') {
        const [meRes, winRes] = await Promise.all([apiGet('/v1/me', key), apiGet('/v1/me/windows', key)]);

        // 401 от любого эндпоинта — ключ не принят
        if (meRes.status === 401 || winRes.status === 401) {
            return {
                status: 401,
                data: {
                    error: 'unauthorized',
                    message: 'Selora не принял ключ — проверьте его в Настройках → Провайдер → Selora',
                },
            };
        }
        if (meRes.status !== 200) return meRes;

        const me = meRes.data && typeof meRes.data === 'object' ? meRes.data : {};
        const user = me.user && typeof me.user === 'object' ? me.user : {};
        const plan = me.plan && typeof me.plan === 'object' ? me.plan : {};
        const wallet = me.wallet && typeof me.wallet === 'object' ? me.wallet : {};

        const balanceRaw = wallet.balance != null ? wallet.balance : user.balance_usd;
        const balance = balanceRaw != null ? toNum(balanceRaw) : 0;

        // Окна: приоритет — /v1/me/windows (использование/лимит/сброс);
        // 404 или сбой — фолбэк на краткие окна из профиля (used_usd/limit_usd)
        let sessionRaw;
        let weekRaw;
        if (winRes.status === 200) {
            const w = winRes.data && typeof winRes.data === 'object' ? winRes.data : {};
            sessionRaw = w.session || null;
            weekRaw = w.week || null;
        } else {
            const uw = user.windows && typeof user.windows === 'object' ? user.windows : {};
            sessionRaw = uw.session || null;
            weekRaw = uw.week || null;
        }

        const windows = [];
        if (sessionRaw) windows.push(normalizeWindow(sessionRaw, 'short', SHORT_WINDOW_SEC));
        if (weekRaw) windows.push(normalizeWindow(weekRaw, 'long', LONG_WINDOW_SEC));

        return {
            status: 200,
            data: {
                plan: plan.name || user.plan_id || '',
                wallet: { balance_usd: balance },
                windows,
                free_tokens: null,
            },
        };
    }

    // GET /v1/models → { models: […] } → каталог в формате панели
    async function getModels(key = '') {
        const { status, data } = await apiGet('/v1/models', key);
        if (status === 401) {
            return {
                status: 401,
                data: {
                    error: 'unauthorized',
                    message: 'Selora не принял ключ — проверьте его в Настройках → Провайдер → Selora',
                },
            };
        }
        if (status !== 200) return { status, data };

        const raw = Array.isArray(data.models) ? data.models : Array.isArray(data.data) ? data.data : null;
        if (!raw) {
            return {
                status: 502,
                data: {
                    error: 'bad_response',
                    message: 'В ответе /v1/models нет списка моделей',
                },
            };
        }
        const models = raw
            .filter((m) => m && typeof m.id === 'string' && m.id)
            .map((m) => {
                const pricing = m.pricing || {};
                const input = Number(pricing.input_per_1m);
                const output = Number(pricing.output_per_1m);
                return {
                    id: m.id,
                    display_name: m.display_name || m.id,
                    access_tier: 'paid',
                    // У Selora нет поля контекста — только признак 1M-контекста
                    context_length: m.supports_1m_context === true ? 1000000 : null,
                    pricing: {
                        input: Number.isFinite(input) ? input : 0,
                        output: Number.isFinite(output) ? output : 0,
                    },
                };
            });
        return { status: 200, data: { data: models } };
    }

    return {
        id: 'selora',
        name,
        site: 'https://selora.lol',
        upstream,
        apiKey,
        authScheme,
        buildHeaders,
        getUsage,
        getModels,
    };
}

module.exports = { createSeloraProvider };
