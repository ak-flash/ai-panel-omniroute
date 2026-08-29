'use strict';

// ============================================================
// Универсальный прозрачный прокси до upstream провайдера.
//
// Используется маршрутами /proxy и /omniroute (src/routes/*).
// Пробрасывает метод, избранные заголовки и тело как есть; ответ
// upstream стримится клиенту без преобразований. Таймаут 30 с,
// редиректы запрещены (redirect: 'error').
// ============================================================

const { AppError, readBody, sendNoContent } = require('../http');

const PROXY_TIMEOUT_MS = 30000;

async function handleProxy(req, res, url, { prefix, upstream }) {
  if (req.method === 'OPTIONS') return sendNoContent(res);
  const body = await readBody(req);
  const suffix = url.pathname.replace(new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '') + url.search;
  const target = upstream + suffix;
  const fwdHeaders = {};
  for (const name of ['authorization', 'x-api-key', 'content-type', 'accept']) {
    if (req.headers[name]) fwdHeaders[name] = req.headers[name];
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  res.on('close', () => controller.abort());
  try {
    const upstreamRes = await fetch(target, {
      method: req.method,
      headers: fwdHeaders,
      body: body.length > 0 ? body : undefined,
      signal: controller.signal,
      redirect: 'error',
    });
    const responseHeaders = {};
    const contentType = upstreamRes.headers.get('content-type');
    if (contentType) responseHeaders['content-type'] = contentType;
    res.writeHead(upstreamRes.status, responseHeaders);
    if (upstreamRes.body) {
      for await (const chunk of upstreamRes.body) {
        if (!res.writable) break;
        res.write(chunk);
      }
    }
    res.end();
  } catch (error) {
    if (res.headersSent) return res.destroy();
    throw new AppError(502, 'proxy_error', 'Upstream недоступен', { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { handleProxy };
