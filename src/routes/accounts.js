'use strict';

// ============================================================
// /api/accounts — multi-account credentials (RFC-0003).
//
// Все секреты write-only. Наружу отдаются только булевы has* / counts
// и активный аккаунт. Сервер сам выбирает credentials активного
// аккаунта при проксировании запросов к провайдерам.
// ============================================================

const { AppError, readJson, sendJson } = require('../http');

function pickAccountName(value) {
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(value)) {
    throw new AppError(400, 'invalid_account_name', 'Имя аккаунта: 1–32 символа из [a-z0-9_-]');
  }
  return value;
}

function mapStoreError(err) {
  if (!err) return new AppError(500, 'unknown', 'Неизвестная ошибка');
  const code = err.code || 'unknown';
  const status =
    code === 'account_not_found' ? 404 :
    code === 'account_exists' ? 409 :
    code === 'too_many_accounts' ? 409 :
    code === 'empty_credentials' ? 400 :
    400;
  return new AppError(status, code, err.message || code);
}

function registerAccountRoutes(router, { getStore }) {
  router.add(['GET', 'HEAD'], '/api/accounts', async ({ res }) => {
    const st = await getStore();
    const result = await st.accounts.listAccounts();
    return sendJson(res, 200, { ok: true, ...result }, { 'cache-control': 'no-store' });
  });

  router.add(['GET', 'HEAD'], '/api/accounts/active', async ({ res }) => {
    const st = await getStore();
    const list = await st.accounts.listAccounts();
    return sendJson(res, 200, { ok: true, active: list.active }, { 'cache-control': 'no-store' });
  });

  router.add(['PUT'], '/api/accounts/active', async ({ req, res }) => {
    const body = await readJson(req);
    if (!body || typeof body !== 'object') {
      throw new AppError(400, 'bad_json', 'Ожидается JSON-объект');
    }
    const name = pickAccountName(body.active);
    const st = await getStore();
    if (name !== 'default') {
      const list = await st.accounts.listAccounts();
      if (!list.accounts.some((a) => a.name === name)) {
        throw new AppError(404, 'account_not_found', 'Аккаунт «' + name + '» не найден');
      }
    }
    await st.set('activeAccount', name);
    return sendJson(res, 200, { ok: true, active: name }, { 'cache-control': 'no-store' });
  });

  router.add(['POST'], '/api/accounts', async ({ req, res }) => {
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError(400, 'bad_json', 'Ожидается JSON-объект');
    }
    const name = pickAccountName(body.account_name || body.name);
    const st = await getStore();
    try {
      const result = await st.accounts.createAccount(name, body.credentials || {});
      return sendJson(res, 201, { ok: true, ...result }, { 'cache-control': 'no-store' });
    } catch (err) {
      throw mapStoreError(err);
    }
  });

  router.add(['PUT'], '/api/accounts/:name', async ({ req, res, params }) => {
    const name = pickAccountName(params.name);
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError(400, 'bad_json', 'Ожидается JSON-объект');
    }
    const st = await getStore();
    try {
      const result = await st.accounts.updateAccount(name, body.credentials || {});
      return sendJson(res, 200, { ok: true, ...result }, { 'cache-control': 'no-store' });
    } catch (err) {
      throw mapStoreError(err);
    }
  });

  router.add(['DELETE'], '/api/accounts/:name', async ({ res, params }) => {
    const name = pickAccountName(params.name);
    const st = await getStore();
    try {
      const result = await st.accounts.deleteAccount(name);
      return sendJson(res, 200, { ok: true, ...result }, { 'cache-control': 'no-store' });
    } catch (err) {
      throw mapStoreError(err);
    }
  });
}

module.exports = { registerAccountRoutes };