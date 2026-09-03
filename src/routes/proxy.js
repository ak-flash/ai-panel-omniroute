'use strict';

// ============================================================
// Универсальный прокси до upstream вшитых провайдеров:
//   /proxy/...       — активный провайдер (первый в списке)
//   /proxy/<id>/...  — конкретный провайдер по id
// Заголовки авторизации клиента пробрасываются как есть.
// ============================================================

const { AppError } = require('../../http');
const { handleProxy } = require('../proxy');

const PROXY_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

function registerProxyRoutes(router, { providers, activeProvider, logger }) {
  function handle({ req, res, url }) {
    if (!activeProvider) throw new AppError(503, 'no_provider', 'Провайдер не настроен');
    let provider = activeProvider;
    let prefix = '/proxy';
    const m = url.pathname.match(/^\/proxy\/([a-z0-9-]+)(?:\/|$)/);
    if (m && providers.some((p) => p.id === m[1])) {
      provider = providers.find((p) => p.id === m[1]);
      prefix = '/proxy/' + m[1];
    }
    return handleProxy(req, res, url, { prefix, upstream: provider.upstream, logger });
  }

  router.add(PROXY_METHODS, '/proxy', handle);
  router.add(PROXY_METHODS, '/proxy/*', handle);
}

module.exports = { registerProxyRoutes };
