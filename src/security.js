'use strict';

const dns = require('dns').promises;
const net = require('net');

const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

function firstForwardedValue(value) {
  return String(value || '').split(',')[0].trim();
}

/**
 * Внешний origin панели: PUBLIC_ORIGIN, иначе Host запроса. Заголовки
 * X-Forwarded-Host/Proto учитываются только при TRUST_PROXY: без reverse
 * proxy их может подставить любой клиент.
 */
function getExternalOrigin(req, publicOrigin = '', trustProxy = false) {
  if (publicOrigin) {
    try { return new URL(publicOrigin).origin; } catch { return ''; }
  }
  const forwardedHost = trustProxy ? firstForwardedValue(req.headers['x-forwarded-host']) : '';
  const host = forwardedHost || req.headers.host;
  if (!host) return '';
  const forwardedProto = trustProxy ? firstForwardedValue(req.headers['x-forwarded-proto']) : '';
  const protocol = forwardedProto || 'http';
  if (protocol !== 'http' && protocol !== 'https') return '';
  try { return new URL(protocol + '://' + host).origin; } catch { return ''; }
}

/**
 * Loopback-hostname (localhost / 127.0.0.0/8 / ::1) — прямой доступ
 * к серверу с той же машины. Отличать loopback от прочих Host нужно,
 * чтобы разрешение «Origin совпадает с Host» не открывало дверь
 * DNS rebinding: чужой домен, указывающий на 127.0.0.1, не пройдёт.
 */
function isLoopbackHostname(hostname) {
  // WHATWG URL не снимает скобки с IPv6-hostname ([::1])
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true;
  return net.isIPv4(hostname) && hostname.startsWith('127.');
}

/**
 * Host входит в allowlist: loopback всегда, остальное — только явно
 * разрешённые имена (PUBLIC_ORIGIN, HOST, ALLOWED_HOSTS). Чужой домен,
 * перепривязанный на 127.0.0.1 (DNS rebinding), сюда не попадёт.
 */
function isAllowedHost(hostHeader, allowedHosts = []) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false;
  let hostname;
  try {
    hostname = new URL('http://' + hostHeader).hostname;
  } catch {
    return false;
  }
  return isLoopbackHostname(hostname) || allowedHosts.includes(hostname);
}

function isSameOrigin(req, origin, publicOrigin = '', trustProxy = false) {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    // Прямой loopback-доступ: работает и когда панель развёрнута за
    // reverse proxy (задан PUBLIC_ORIGIN), — локальная разработка/админка.
    if (req.headers.host && parsed.host === req.headers.host && isLoopbackHostname(parsed.hostname)) {
      return true;
    }
    // Доступ через reverse proxy (x-forwarded-* при TRUST_PROXY) или PUBLIC_ORIGIN.
    return parsed.origin === getExternalOrigin(req, publicOrigin, trustProxy);
  } catch {
    return false;
  }
}

function rejectRequest(res, status, error, message) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error, message }));
  return false;
}

/**
 * Периметр запроса: security-заголовки на каждый ответ, allowlist Host
 * (421 для остальных) и Origin (403 для чужих). true — запрос можно
 * обрабатывать дальше.
 */
function applyRequestSecurity(
  req,
  res,
  { allowedOrigins = [], publicOrigin = '', allowedHosts = [], trustProxy = false } = {}
) {
  const origin = req.headers.origin;
  const corsOrigin = origin && allowedOrigins.includes(origin) ? origin : null;
  const originalWriteHead = res.writeHead.bind(res);

  res.writeHead = function securedWriteHead(statusCode, headers = {}) {
    const merged = { ...SECURITY_HEADERS, ...headers };
    if (corsOrigin) {
      merged['access-control-allow-origin'] = corsOrigin;
      merged.vary = merged.vary ? merged.vary + ', Origin' : 'Origin';
      merged['access-control-allow-methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
      merged['access-control-allow-headers'] = 'authorization, x-api-key, x-agentrouter-user-id, content-type, accept';
    }
    return originalWriteHead(statusCode, merged);
  };

  const forwardedHost = trustProxy ? firstForwardedValue(req.headers['x-forwarded-host']) : '';
  if (!isAllowedHost(req.headers.host, allowedHosts) || (forwardedHost && !isAllowedHost(forwardedHost, allowedHosts))) {
    return rejectRequest(res, 421, 'host_not_allowed', 'Host is not allowed');
  }
  const allowed =
    !origin || isSameOrigin(req, origin, publicOrigin, trustProxy) || allowedOrigins.includes(origin);
  if (!allowed) return rejectRequest(res, 403, 'origin_forbidden', 'Origin is not allowed');
  return true;
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168);
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') || normalized.startsWith('fea') ||
      normalized.startsWith('feb');
  }
  return true;
}

async function validateUpstreamUrl(value, { allowPrivate = true } = {}) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error('invalid_url');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('invalid_url');
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  if (!parsed.hostname) throw new Error('invalid_url');

  if (!allowPrivate) {
    const addresses = net.isIP(parsed.hostname)
      ? [{ address: parsed.hostname }]
      : await dns.lookup(parsed.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new Error('private_address');
    }
  }
  return parsed.toString().replace(/\/$/, '');
}

module.exports = {
  SECURITY_HEADERS,
  applyRequestSecurity,
  getExternalOrigin,
  isAllowedHost,
  isLoopbackHostname,
  isPrivateAddress,
  isSameOrigin,
  validateUpstreamUrl,
};
