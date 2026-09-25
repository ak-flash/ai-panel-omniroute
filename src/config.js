'use strict';

// ============================================================
// Конфигурация процесса — единственное место, где читаются
// переменные окружения панели. Остальные модули получают готовые
// значения параметрами. По списку ENV_VARS scripts/check-docs.js
// сверяет таблицу README и .env.example.
// ============================================================

const fs = require('fs');
const path = require('path');
const { parsePoolReleaseHours } = require('../providers/agentrouter');
const { DEFAULT_MAX_BYTES: LOG_MAX_BYTES } = require('./file-logger');

const ROOT_DIR = path.join(__dirname, '..');
const DEFAULT_PORT = 8765;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** Все переменные окружения панели (порядок — как в таблице README). */
const ENV_VARS = Object.freeze([
  'AIPANEL_ENV_FILE',
  'HOST',
  'PORT',
  'PUBLIC_ORIGIN',
  'ALLOWED_ORIGINS',
  'AIPANEL_MASTER_KEY',
  'AIPANEL_DATA_DIR',
  'AIPANEL_LOG_DIR',
  'AIPANEL_PROVIDER_DEBUG',
  'AIPANEL_CODING_CACHE_PATH',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'AGENTROUTER_RELEASE_HOURS_UTC',
]);

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['', '0', 'false', 'no', 'off']);

const text = (value) => String(value == null ? '' : value).trim();

function parseBoolean(name, raw) {
  const value = text(raw).toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  throw new ConfigError(`${name}: ожидается true или false, получено «${raw}»`);
}

function parsePort(raw) {
  const value = text(raw);
  if (!value) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError('PORT: ожидается целое число 0–65535');
  }
  return port;
}

function parseOrigin(name, raw) {
  const value = text(raw);
  if (!value) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be a valid http(s) URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${name} must use http or https`);
  }
  return url.origin;
}

function parseOriginList(name, raw) {
  return text(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => parseOrigin(name, item));
}

/** Относительные пути считаются от корня проекта, а не от cwd процесса. */
function parsePath(raw, fallback) {
  const value = text(raw);
  return value ? path.resolve(ROOT_DIR, value) : fallback;
}

function parseMasterKey(raw) {
  const value = text(raw);
  if (value && !/^[a-f0-9]{64}$/i.test(value)) {
    throw new ConfigError('AIPANEL_MASTER_KEY must be exactly 64 hexadecimal characters');
  }
  return value;
}

/** Путь к env-файлу: AIPANEL_ENV_FILE, «none» отключает чтение. */
function resolveEnvFile(env = process.env) {
  const value = text(env.AIPANEL_ENV_FILE);
  if (value.toLowerCase() === 'none') return null;
  return parsePath(value, path.join(ROOT_DIR, '.env'));
}

/** Каталог логов вычисляется отдельно: он нужен и при ошибке конфигурации. */
function resolveLogDir(env = process.env) {
  return parsePath(env.AIPANEL_LOG_DIR, path.join(ROOT_DIR, 'logs'));
}

/**
 * Читает env-файл в env, не перезаписывая уже заданные переменные:
 * окружение (PM2, docker, системное) приоритетнее файла, как в dotenv.
 * Возвращает имена переменных, взятых из файла; null — файла нет.
 */
function loadEnvFile(filePath, env = process.env) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const applied = [];
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const name = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (!(name in env)) {
      env[name] = value;
      applied.push(name);
    }
  }
  return applied;
}

/** Откуда взято значение переменной — для диагностики старта. */
function describeEnvSource(name, env, fileKeys = []) {
  if (fileKeys.includes(name)) return 'env-файл';
  return text(env[name]) ? 'окружение' : 'по умолчанию';
}

/** Разбирает и валидирует окружение; при ошибке бросает ConfigError. */
function loadConfig(env = process.env) {
  const publicOrigin = parseOrigin('PUBLIC_ORIGIN', env.PUBLIC_ORIGIN);
  const host = text(env.HOST) || (publicOrigin ? '0.0.0.0' : '127.0.0.1');
  const dataDir = parsePath(env.AIPANEL_DATA_DIR, path.join(ROOT_DIR, 'data'));
  const logDir = resolveLogDir(env);
  return Object.freeze({
    rootDir: ROOT_DIR,
    host,
    port: parsePort(env.PORT),
    publicOrigin,
    remoteMode: !LOOPBACK_HOSTS.has(host),
    allowedOrigins: parseOriginList('ALLOWED_ORIGINS', env.ALLOWED_ORIGINS),
    masterKey: parseMasterKey(env.AIPANEL_MASTER_KEY),
    dataDir,
    dbPath: path.join(dataDir, 'store.db'),
    logDir,
    logFile: path.join(logDir, 'ai-panel.log'),
    logMaxBytes: LOG_MAX_BYTES,
    providerDebug: parseBoolean('AIPANEL_PROVIDER_DEBUG', env.AIPANEL_PROVIDER_DEBUG),
    codingCachePath: parsePath(
      env.AIPANEL_CODING_CACHE_PATH,
      path.join(dataDir, 'coding-ratings.json')
    ),
    googleClientId: text(env.GOOGLE_CLIENT_ID),
    googleClientSecret: text(env.GOOGLE_CLIENT_SECRET),
    agentrouterReleaseHoursUtc: parsePoolReleaseHours(env.AGENTROUTER_RELEASE_HOURS_UTC),
  });
}

module.exports = {
  ConfigError,
  DEFAULT_PORT,
  ENV_VARS,
  ROOT_DIR,
  describeEnvSource,
  loadConfig,
  loadEnvFile,
  parseBoolean,
  parseOriginList,
  resolveEnvFile,
  resolveLogDir,
};
