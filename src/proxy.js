'use strict';

// ============================================================
// Универсальный прозрачный прокси до upstream провайдера.
//
// Используется маршрутами /proxy и /omniroute (src/routes/*).
// Пробрасывает метод, избранные заголовки и тело как есть; ответ
// upstream стримится клиенту без преобразований. Таймаут 30 с,
// редиректы запрещены (redirect: 'error').
// ============================================================

const { AppError, readBody, sendNoContent } = require('./http');

const PROXY_TIMEOUT_MS = 30000;

async function handleProxy(req, res, url, { prefix, upstream, logger, debug = false }) {
  if (req.method === 'OPTIONS') return sendNoContent(res);
  // Логгер — объект с error/warn/info (файловый логгер) либо console
  const log = logger || console;
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
  const startedAt = Date.now();
  if (debug) {
    const safeHeaders = { ...fwdHeaders };
    if (safeHeaders.authorization) safeHeaders.authorization = '***';
    if (safeHeaders['x-api-key']) safeHeaders['x-api-key'] = '***';
    const bodyPreview = body.length > 0 ? body.slice(0, 500).toString() : '(empty)';
    log.info(`[proxy] ${req.method} ${target}`, { headers: safeHeaders, body: bodyPreview + (body.length > 500 ? '...' : '') });
  }
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
    if (debug) {
      log.info(`[proxy] ${req.method} ${target} → ${upstreamRes.status} (${Date.now() - startedAt} ms)`);
    }
  } catch (error) {
    if (res.headersSent) return res.destroy();
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`[proxy] fetch упал: ${req.method} ${target} — ${msg}`, { cause: error });
    throw new AppError(502, 'proxy_error', 'Upstream недоступен', { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { handleProxy };
