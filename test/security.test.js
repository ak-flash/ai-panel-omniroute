'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getServerConfig,
  isPrivateAddress,
  isSameOrigin,
  parseAllowedOrigins,
  validateMasterKey,
  validateUpstreamUrl,
} = require('../security');

test('server config использует loopback локально и bind all для PUBLIC_ORIGIN', () => {
  assert.deepEqual(getServerConfig({}), {
    host: '127.0.0.1', port: 8765, publicOrigin: '', remoteMode: false,
  });
  assert.deepEqual(getServerConfig({ PUBLIC_ORIGIN: 'https://panel.example/path', PORT: '9000' }), {
    host: '0.0.0.0', port: '9000', publicOrigin: 'https://panel.example', remoteMode: true,
  });
  assert.equal(getServerConfig({ HOST: '0.0.0.0' }).remoteMode, true);
  assert.throws(() => getServerConfig({ PUBLIC_ORIGIN: 'not a URL' }), /PUBLIC_ORIGIN/);
});

test('same-origin учитывает reverse proxy headers и PUBLIC_ORIGIN', () => {
  const request = {
    headers: {
      host: 'ai-panel:8765',
      'x-forwarded-host': 'ai-panel.home.ak-vps.ru',
      'x-forwarded-proto': 'https',
    },
  };
  assert.equal(isSameOrigin(request, 'https://ai-panel.home.ak-vps.ru'), true);
  assert.equal(isSameOrigin(request, 'https://evil.example'), false);
  assert.equal(isSameOrigin({ headers: { host: 'ai-panel:8765' } }, 'https://ai-panel.home.ak-vps.ru', 'https://ai-panel.home.ak-vps.ru'), true);
});

test('same-origin разрешает прямой loopback-доступ при настроенном PUBLIC_ORIGIN', () => {
  // Регрессия: локальный PUT/POST (браузер всегда шлёт Origin) к панели,
  // развёрнутой за reverse proxy, не должен отбиваться как origin_forbidden
  assert.equal(isSameOrigin({ headers: { host: 'localhost:8765' } }, 'http://localhost:8765', 'https://panel.example'), true);
  assert.equal(isSameOrigin({ headers: { host: '127.0.0.1:8765' } }, 'http://127.0.0.1:8765', 'https://panel.example'), true);
  assert.equal(isSameOrigin({ headers: { host: '[::1]:8765' } }, 'http://[::1]:8765', 'https://panel.example'), true);
  // Локальный режим без PUBLIC_ORIGIN: Origin сравнивается с Host напрямую
  assert.equal(isSameOrigin({ headers: { host: 'localhost:8765' } }, 'http://localhost:8765'), true);
});

test('same-origin отклоняет DNS rebinding при настроенном PUBLIC_ORIGIN', () => {
  // Доверяется только loopback Host: evil.com, указывающий на 127.0.0.1,
  // и LAN-адрес без allowlist не пройдут
  assert.equal(isSameOrigin({ headers: { host: 'evil.example:8765' } }, 'http://evil.example:8765', 'https://panel.example'), false);
  assert.equal(isSameOrigin({ headers: { host: '192.168.1.5:8765' } }, 'http://192.168.1.5:8765', 'https://panel.example'), false);
});

test('CORS allowlist нормализует origins', () => {
  assert.deepEqual(
    parseAllowedOrigins('https://panel.example/path, http://localhost:8765'),
    ['https://panel.example', 'http://localhost:8765'],
  );
});

test('master key принимает только 32 байта в hex', () => {
  assert.doesNotThrow(() => validateMasterKey('ab'.repeat(32)));
  assert.throws(() => validateMasterKey('weak'), /64 hexadecimal/);
});

test('private address detector покрывает loopback, private, link-local и IPv6', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.2', '169.254.169.254', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('2001:4860:4860::8888'), false);
});

test('сохранённый OmniRoute URL допускает приватный адрес', async () => {
  assert.equal(
    await validateUpstreamUrl('http://192.168.1.30:20128/api/', { allowPrivate: true }),
    'http://192.168.1.30:20128/api',
  );
});

test('remote upstream validation блокирует SSRF aliases и credentials', async () => {
  for (const url of [
    'http://127.0.0.1',
    'http://2130706433',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]',
    'http://[fd00::1]',
    'http://user:password@example.com',
    'file:///etc/passwd',
  ]) {
    await assert.rejects(validateUpstreamUrl(url, { allowPrivate: false }), undefined, url);
  }
  assert.equal(await validateUpstreamUrl('https://8.8.8.8/api/'), 'https://8.8.8.8/api');
});
