'use strict';

const { AppError, parseRequestUrl, sendNoContent } = require('./http');

/** @param {string|RegExp} path @returns {RegExp | {regex: RegExp, keys: string[]}} */
function compilePath(path) {
  if (path instanceof RegExp) return path;
  /** @type {string[]} */
  const keys = [];
  const source = String(path)
    .split('/')
    .map(part => {
      if (!part) return '';
      if (part === '*') {
        keys.push('wildcard');
        return '(.*)';
      }
      if (part.startsWith(':')) {
        keys.push(part.slice(1));
        return '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp('^' + source + '$'), keys };
}

/** @param {string} value */
function decodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AppError(400, 'bad_request', 'Некорректная %-последовательность в пути');
  }
}

class Router {
  constructor() {
    /** @type {{allowed: string[], compiled: RegExp | {regex: RegExp, keys: string[]}, handler: Function}[]} */
    this.routes = [];
  }

  /**
   * @param {string|string[]} methods
   * @param {string|RegExp} path
   * @param {Function} handler
   */
  add(methods, path, handler) {
    const allowed = (Array.isArray(methods) ? methods : [methods]).map(method =>
      method.toUpperCase()
    );
    const compiled = compilePath(path);
    this.routes.push({ allowed, compiled, handler });
    return this;
  }

  /**
   * @param {import('http').IncomingMessage} req
   * @param {import('http').ServerResponse} res
   * @param {Record<string, unknown>} context
   */
  async dispatch(req, res, context) {
    const url = parseRequestUrl(req.url);
    const pathname = url.pathname;
    const pathMatches = [];
    for (const route of this.routes) {
      const regex = route.compiled instanceof RegExp ? route.compiled : route.compiled.regex;
      const match = pathname.match(regex);
      if (!match) continue;
      pathMatches.push(route);
      if (req.method === 'OPTIONS') return sendNoContent(res);
      if (!route.allowed.includes(/** @type {string} */ (req.method))) continue;
      /** @type {Record<string, string>} */
      const params = {};
      if (!(route.compiled instanceof RegExp)) {
        route.compiled.keys.forEach((key, index) => {
          params[/** @type {string} */ (key)] = decodeParam(
            /** @type {string} */ (match[index + 1])
          );
        });
      }
      return route.handler({ req, res, context, params, url });
    }
    if (pathMatches.length)
      throw new AppError(405, 'method_not_allowed', 'Метод не поддерживается', {
        headers: { allow: [...new Set(pathMatches.flatMap(route => route.allowed))].join(', ') },
      });
    throw new AppError(404, 'not_found', 'Маршрут не найден');
  }
}

module.exports = { Router, compilePath };
