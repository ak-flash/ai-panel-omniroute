'use strict';

const { AppError, sendNoContent } = require('./http');

function compilePath(path) {
  if (path instanceof RegExp) return path;
  const keys = [];
  const source = String(path)
    .split('/')
    .map((part) => {
      if (!part) return '';
      if (part === '*') { keys.push('wildcard'); return '(.*)'; }
      if (part.startsWith(':')) { keys.push(part.slice(1)); return '([^/]+)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp('^' + source + '$'), keys };
}

class Router {
  constructor() {
    this.routes = [];
  }

  add(methods, path, handler) {
    const allowed = (Array.isArray(methods) ? methods : [methods]).map((method) => method.toUpperCase());
    const compiled = compilePath(path);
    this.routes.push({ allowed, compiled, handler });
    return this;
  }

  async dispatch(req, res, context) {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const pathMatches = [];
    for (const route of this.routes) {
      const regex = route.compiled instanceof RegExp ? route.compiled : route.compiled.regex;
      const match = pathname.match(regex);
      if (!match) continue;
      pathMatches.push(route);
      if (req.method === 'OPTIONS') return sendNoContent(res);
      if (!route.allowed.includes(req.method)) continue;
      const params = {};
      if (!(route.compiled instanceof RegExp)) {
        route.compiled.keys.forEach((key, index) => { params[key] = decodeURIComponent(match[index + 1]); });
      }
      return route.handler({ req, res, context, params, url: new URL(req.url, 'http://localhost') });
    }
    if (pathMatches.length) throw new AppError(405, 'method_not_allowed', 'Метод не поддерживается', { headers: { allow: [...new Set(pathMatches.flatMap((route) => route.allowed))].join(', ') } });
    throw new AppError(404, 'not_found', 'Маршрут не найден');
  }
}

module.exports = { Router, compilePath };
