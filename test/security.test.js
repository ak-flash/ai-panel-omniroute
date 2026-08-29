'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getServerConfig,
  isPrivateAddress,
  parseAllowedOrigins,
  validateMasterKey,
  validateUpstreamUrl,
} = require('../security');

test('server config использует loopback по умолчанию', () => {
  assert.deepEqual(getServerConfig({}), { host: '127.0.0.1', port: 8765, remoteMode: false });
  assert.equal(getServerConfig({ HOST: '0.0.0.0', PORT: '9000' }).remoteMode, true);
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
