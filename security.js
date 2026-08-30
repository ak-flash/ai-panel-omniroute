'use strict';

const dns = require('dns').promises;
const net = require('net');

const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

function parseAllowedOrigins(value = '') {
  return String(value)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => new URL(origin).origin);
}

function firstForwardedValue(value) {
  return String(value || '').split(',')[0].trim();
}

function getExternalOrigin(req, publicOrigin = '') {
  if (publicOrigin) {
    try { return new URL(publicOrigin).origin; } catch { return ''; }
  }
  const host = firstForwardedValue(req.headers['x-forwarded-host']) || req.headers.host;
  if (!host) return '';
  const protocol = firstForwardedValue(req.headers['x-forwarded-proto']) || 'http';
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

function isSameOrigin(req, origin, publicOrigin = '') {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    // Прямой loopback-доступ: работает и когда панель развёрнута за
    // reverse proxy (задан PUBLIC_ORIGIN), — локальная разработка/админка.
    if (req.headers.host && parsed.host === req.headers.host && isLoopbackHostname(parsed.hostname)) {
      return true;
    }
    // Доступ через reverse proxy (x-forwarded-*) или PUBLIC_ORIGIN.
    return parsed.origin === getExternalOrigin(req, publicOrigin);
  } catch {
    return false;
  }
}

function applyRequestSecurity(req, res, allowedOrigins = [], publicOrigin = '') {
  const origin = req.headers.origin;
  const allowed = !origin || isSameOrigin(req, origin, publicOrigin) || allowedOrigins.includes(origin);
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

  if (allowed) return true;
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'origin_forbidden', message: 'Origin is not allowed' }));
  return false;
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

function validateMasterKey(value) {
  if (value == null || value === '') return;
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error('AIPANEL_MASTER_KEY must be exactly 64 hexadecimal characters');
  }
}

function getServerConfig(env = process.env) {
  let publicOrigin = '';
  if (env.PUBLIC_ORIGIN) {
    try { publicOrigin = new URL(env.PUBLIC_ORIGIN).origin; }
    catch { throw new Error('PUBLIC_ORIGIN must be a valid http(s) URL'); }
    if (!/^https?:/.test(publicOrigin)) throw new Error('PUBLIC_ORIGIN must use http or https');
  }
  const host = env.HOST || (publicOrigin ? '0.0.0.0' : '127.0.0.1');
  return {
    host,
    port: env.PORT || 8765,
    publicOrigin,
    remoteMode: !['127.0.0.1', '::1', 'localhost'].includes(host),
  };
}

module.exports = {
  SECURITY_HEADERS,
  applyRequestSecurity,
  getExternalOrigin,
  getServerConfig,
  isPrivateAddress,
  isSameOrigin,
  parseAllowedOrigins,
  validateMasterKey,
  validateUpstreamUrl,
};
