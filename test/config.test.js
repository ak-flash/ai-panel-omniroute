'use strict';

// Юнит-тесты конфигурации (src/config.js): значения по умолчанию,
// валидация переменных, пути, чтение env-файла.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ConfigError,
  ENV_VARS,
  ROOT_DIR,
  describeEnvSource,
  loadConfig,
  loadEnvFile,
  parseOriginList,
  resolveEnvFile,
} = require('../src/config');

test('по умолчанию: loopback, порт 8765, data/ и logs/ в корне проекта', () => {
  const config = loadConfig({});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8765);
  assert.equal(config.publicOrigin, '');
  assert.equal(config.remoteMode, false);
  assert.deepEqual(config.allowedOrigins, []);
  assert.equal(config.masterKey, '');
  assert.equal(config.dataDir, path.join(ROOT_DIR, 'data'));
  assert.equal(config.dbPath, path.join(ROOT_DIR, 'data', 'store.db'));
  assert.equal(config.logFile, path.join(ROOT_DIR, 'logs', 'ai-panel.log'));
  assert.equal(config.codingCachePath, path.join(ROOT_DIR, 'data', 'coding-ratings.json'));
  assert.equal(config.providerDebug, false);
  assert.deepEqual(config.agentrouterReleaseHoursUtc, [2, 11]);
  assert.ok(Object.isFrozen(config));
});

test('PUBLIC_ORIGIN включает bind на 0.0.0.0 и remote-режим', () => {
  const TOKEN = 'a'.repeat(32);
  const config = loadConfig({ PUBLIC_ORIGIN: 'https://panel.example/path', PORT: '9000', AIPANEL_AUTH_TOKEN: TOKEN });
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 9000);
  assert.equal(config.publicOrigin, 'https://panel.example');
  assert.equal(config.remoteMode, true);
  assert.equal(loadConfig({ HOST: '0.0.0.0', AIPANEL_AUTH_TOKEN: TOKEN }).remoteMode, true);
  assert.equal(loadConfig({ HOST: 'localhost' }).remoteMode, false);
});

test('remote-режим требует AIPANEL_AUTH_TOKEN, а токен — минимум 16 символов', () => {
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: 'https://panel.example' }), /AIPANEL_AUTH_TOKEN/);
  assert.throws(() => loadConfig({ HOST: '0.0.0.0' }), /AIPANEL_AUTH_TOKEN/);
  assert.throws(() => loadConfig({ AIPANEL_AUTH_TOKEN: 'short' }), /AIPANEL_AUTH_TOKEN/);
  const config = loadConfig({ PUBLIC_ORIGIN: 'https://panel.example', AIPANEL_AUTH_TOKEN: 'x'.repeat(16) });
  assert.equal(config.authToken, 'x'.repeat(16));
});

test('ALLOWED_HOSTS и TRUST_PROXY разбираются и попадают в конфигурацию', () => {
  const config = loadConfig({
    ALLOWED_HOSTS: 'panel.example, 192.168.1.10',
    TRUST_PROXY: 'true',
  });
  assert.deepEqual(config.allowedHosts, ['panel.example', '192.168.1.10']);
  assert.equal(config.trustProxy, true);
  // HOST-адреса тоже попадают в allowlist
  assert.deepEqual(loadConfig({ HOST: '10.0.0.5', AIPANEL_AUTH_TOKEN: 'y'.repeat(16) }).allowedHosts, ['10.0.0.5']);
  assert.throws(() => loadConfig({ ALLOWED_HOSTS: 'not a host' }), /ALLOWED_HOSTS/);
});

test('невалидные значения останавливают старт понятной ошибкой', () => {
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: 'not a URL' }), /PUBLIC_ORIGIN/);
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: 'ftp://panel.example' }), /PUBLIC_ORIGIN/);
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ PORT: '70000' }), /PORT/);
  assert.throws(() => loadConfig({ AIPANEL_MASTER_KEY: 'replace-with-64-hex-characters' }), /64 hexadecimal/);
  assert.throws(() => loadConfig({ AIPANEL_PROVIDER_DEBUG: 'maybe' }), /AIPANEL_PROVIDER_DEBUG/);
  assert.throws(() => loadConfig({ ALLOWED_ORIGINS: 'https://ok.example, not a url' }), ConfigError);
});

test('master key: пусто — генерируется файл, 64 hex — принимается', () => {
  assert.equal(loadConfig({ AIPANEL_MASTER_KEY: '' }).masterKey, '');
  assert.equal(loadConfig({ AIPANEL_MASTER_KEY: 'ab'.repeat(32) }).masterKey, 'ab'.repeat(32));
});

test('булевы флаги принимают true/false/1/0/yes/no', () => {
  for (const value of ['true', 'TRUE', '1', 'yes', 'on']) {
    assert.equal(loadConfig({ AIPANEL_PROVIDER_DEBUG: value }).providerDebug, true, value);
  }
  for (const value of ['false', '0', 'no', 'off', '']) {
    assert.equal(loadConfig({ AIPANEL_PROVIDER_DEBUG: value }).providerDebug, false, value);
  }
});

test('относительные пути считаются от корня проекта', () => {
  const config = loadConfig({ AIPANEL_DATA_DIR: 'var/data', AIPANEL_LOG_DIR: '/tmp/panel-logs' });
  assert.equal(config.dataDir, path.join(ROOT_DIR, 'var', 'data'));
  assert.equal(config.dbPath, path.join(ROOT_DIR, 'var', 'data', 'store.db'));
  assert.equal(config.codingCachePath, path.join(ROOT_DIR, 'var', 'data', 'coding-ratings.json'));
  assert.equal(config.logFile, path.join('/tmp/panel-logs', 'ai-panel.log'));
});

test('CORS allowlist нормализует origins', () => {
  assert.deepEqual(
    parseOriginList('ALLOWED_ORIGINS', 'https://panel.example/path, http://localhost:8765'),
    ['https://panel.example', 'http://localhost:8765']
  );
});

test('env-файл: не перезаписывает окружение, понимает кавычки и комментарии', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-panel-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(
    file,
    [
      '# комментарий',
      'PORT=9000',
      'HOST="0.0.0.0"',
      "export ALLOWED_ORIGINS='https://a.example'",
      'AIPANEL_PROVIDER_DEBUG=false # выключено',
      'not a variable line',
    ].join('\n')
  );
  const env = { PORT: '7000' };
  assert.deepEqual(loadEnvFile(file, env), ['HOST', 'ALLOWED_ORIGINS', 'AIPANEL_PROVIDER_DEBUG']);
  assert.deepEqual(env, {
    PORT: '7000',
    HOST: '0.0.0.0',
    ALLOWED_ORIGINS: 'https://a.example',
    AIPANEL_PROVIDER_DEBUG: 'false',
  });
  assert.equal(loadEnvFile(path.join(dir, 'missing.env'), env), null);
  assert.equal(describeEnvSource('HOST', env, ['HOST']), 'env-файл');
  assert.equal(describeEnvSource('PORT', env, ['HOST']), 'окружение');
  assert.equal(describeEnvSource('PUBLIC_ORIGIN', env, []), 'по умолчанию');
});

test('AIPANEL_ENV_FILE: путь к env-файлу или none', () => {
  assert.equal(resolveEnvFile({}), path.join(ROOT_DIR, '.env'));
  assert.equal(resolveEnvFile({ AIPANEL_ENV_FILE: 'config/prod.env' }), path.join(ROOT_DIR, 'config', 'prod.env'));
  assert.equal(resolveEnvFile({ AIPANEL_ENV_FILE: 'none' }), null);
});

test('.env.example проходит валидацию как есть', () => {
  const env = {};
  loadEnvFile(path.join(ROOT_DIR, '.env.example'), env);
  assert.doesNotThrow(() => loadConfig(env));
  for (const name of Object.keys(env)) assert.ok(ENV_VARS.includes(name), name);
});
