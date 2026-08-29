'use strict';

// ============================================================
// Раздача статики из public/ с защитой от path traversal.
//
// Публичный каталог приходит параметром (createStaticHandler) —
// модуль не привязан к расположению и не читает env. Ошибки —
// простые текстовые 403/404 (зафиксировано в docs/BASELINE.md).
// ============================================================

const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Разрешает pathname внутрь publicDir; null — traversal/плохой URL. */
function resolveStaticPath(publicDir, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  let decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return null;
  }
  const resolved = path.normalize(path.join(publicDir, decoded));
  if (resolved !== publicDir && !resolved.startsWith(publicDir + path.sep)) return null;
  return resolved;
}

/** Фабрика обработчика статики: (req, res, pathname). */
function createStaticHandler({ publicDir }) {
  return function serveStatic(req, res, pathname) {
    const filePath = resolveStaticPath(publicDir, pathname);
    if (!filePath) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('403 Forbidden');
    }
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('404 Not Found');
      }
      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'content-type': mime,
        'cache-control': ext === '.html' ? 'no-store' : 'max-age=3600',
      });
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
  };
}

module.exports = { createStaticHandler, resolveStaticPath, MIME };
