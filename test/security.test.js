'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isAllowedHost,
  isPrivateAddress,
  isSameOrigin,
  validateUpstreamUrl,
} = require('../src/security');

test('same-origin учитывает reverse proxy headers и PUBLIC_ORIGIN', () => {
  const request = {
    headers: {
      host: 'ai-panel:8765',
      'x-forwarded-host': 'ai-panel.home.ak-vps.ru',
      'x-forwarded-proto': 'https',
    },
  };
  // X-Forwarded-* учитываются только при TRUST_PROXY (иначе их может подставить клиент)
  assert.equal(isSameOrigin(request, 'https://ai-panel.home.ak-vps.ru', '', true), true);
  assert.equal(isSameOrigin(request, 'https://ai-panel.home.ak-vps.ru'), false);
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

test('allowlist Host: loopback всегда, остальное — только из списка', () => {
  for (const host of ['127.0.0.1:8765', 'localhost:8765', '[::1]:8765']) {
    assert.equal(isAllowedHost(host, []), true, host);
  }
  assert.equal(isAllowedHost('evil.example:8765', []), false);
  assert.equal(isAllowedHost('ai-panel.home.ak-vps.ru', ['ai-panel.home.ak-vps.ru']), true);
  assert.equal(isAllowedHost('evil.example', ['panel.example']), false);
  assert.equal(isAllowedHost('', ['panel.example']), false);
  assert.equal(isAllowedHost('not a host', []), false);
});

test('X-Forwarded-Host учитывается только при TRUST_PROXY', () => {
  const request = { headers: { host: 'evil.example', 'x-forwarded-host': 'panel.example', 'x-forwarded-proto': 'https' } };
  assert.equal(isSameOrigin(request, 'https://panel.example', ''), false);
  assert.equal(isSameOrigin(request, 'https://panel.example', '', true), true);
});
