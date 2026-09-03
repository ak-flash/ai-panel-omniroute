'use strict';

// ============================================================
// Прокси до OmniRoute. Адрес берётся ТОЛЬКО из серверного
// хранилища (Настройки) — клиентский заголовок x-omniroute-url
// игнорируется. Сохранённый URL может быть приватным (LAN): это
// осознанно настроенный пользователем upstream.
// ============================================================

const { AppError } = require('../../http');
const { handleProxy } = require('../proxy');

const PROXY_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

function registerOmnirouteRoutes(router, { getStore, validateUpstreamUrl, logger }) {
  async function handle({ req, res, url }) {
    const s = await (await getStore()).snapshot();
    const omniUrl = String(s.omniUrl || '').trim();
    if (!omniUrl) throw new AppError(400, 'no_omniroute_url', 'Укажите OmniRoute URL в Настройках');
    let upstream;
    try {
      upstream = await validateUpstreamUrl(omniUrl, { allowPrivate: true });
    } catch {
      throw new AppError(400, 'invalid_omniroute_url', 'Некорректный или запрещённый OmniRoute URL');
    }
    // Ключ OmniRoute хранится на сервере: авторизуем запрос сами
    const headers = { ...req.headers };
    if (s.omniKey) headers.authorization = 'Bearer ' + s.omniKey;
    delete headers['x-omniroute-url'];
    req.headers = headers;
    return handleProxy(req, res, url, { prefix: '/omniroute', upstream, logger });
  }

  router.add(PROXY_METHODS, '/omniroute', handle);
  router.add(PROXY_METHODS, '/omniroute/*', handle);
}

module.exports = { registerOmnirouteRoutes };
