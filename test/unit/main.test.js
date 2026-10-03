'use strict';

// CLI-запуск панели (src/main.js): bootstrap() поднимает сервер в
// текущем процессе, main() — обвязка процесса. Реальный API
// провайдеров не вызывается: порт свободный, хранилище во временном
// каталоге.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { bootstrap, main } = require('../../src/main');
const { getFreePort, makeTmpDir, testEnv } = require('../helpers');

/** Окружение для отдельного запуска: свободный порт + временные каталоги. */
async function bootstrapEnv(extra = {}) {
  const port = await getFreePort();
  return {
    port,
    env: testEnv({ PORT: String(port), ...extra }),
  };
}

test('bootstrap поднимает сервер, печатает баннер и корректно гасится', async () => {
  const { port, env } = await bootstrapEnv();
  const printed = [];
  const running = await bootstrap({ env, print: line => printed.push(line) });
  try {
    await running.listening;
    assert.equal(running.app.address().port, port);
    assert.match(printed[0], /AI Панель · http:\/\/127\.0\.0\.1:/);
    assert.ok(
      printed.some(line => /провайдер xKiro \(xkiro\)/.test(line)),
      'баннер перечисляет провайдеров'
    );

    const health = await fetch('http://127.0.0.1:' + port + '/api/health');
    assert.equal(health.status, 200);

    // Логгер пишет в каталог из окружения
    const logFile = path.join(env.AIPANEL_LOG_DIR, 'ai-panel.log');
    assert.ok(fs.existsSync(logFile), 'логгер создал файл лога');
    assert.match(fs.readFileSync(logFile, 'utf8'), /"event":"startup_config"/);
  } finally {
    await running.shutdown();
  }
});

test('bootstrap: предупреждение о пустом токене входа в remote-режиме', async () => {
  const { env } = await bootstrapEnv({ PUBLIC_ORIGIN: 'https://panel.example' });
  const running = await bootstrap({ env, print: () => {} });
  try {
    await running.listening;
    const logFile = path.join(env.AIPANEL_LOG_DIR, 'ai-panel.log');
    assert.match(fs.readFileSync(logFile, 'utf8'), /AIPANEL_AUTH_TOKEN пуст/);
    assert.equal(running.config.remoteMode, true);
  } finally {
    await running.shutdown();
  }
});

test('bootstrap: повторный shutdown безопасен', async () => {
  const { env } = await bootstrapEnv();
  const running = await bootstrap({ env, print: () => {} });
  await running.listening;
  const port = running.app.address().port;
  await running.shutdown('SIGTERM');
  // Второй вызов не бросает: сервер уже закрыт, данные уже сброшены
  await running.shutdown('SIGTERM');
  assert.equal(running.app.address(), null, 'порт освобождён');
  await assert.rejects(() => fetch('http://127.0.0.1:' + port + '/api/health'));
});

test('bootstrap: ошибка конфигурации выходит из функции, а не из процесса', async () => {
  const { env } = await bootstrapEnv({ PORT: 'не-порт' });
  await assert.rejects(
    () => bootstrap({ env, print: () => {} }),
    err => err.name === 'ConfigError' && /PORT/.test(err.message)
  );
});

test('bootstrap: неверный master key не даёт подняться', async () => {
  const dir = makeTmpDir('main-badkey-');
  const { env } = await bootstrapEnv({
    AIPANEL_DATA_DIR: path.join(dir, 'data'),
    AIPANEL_MASTER_KEY: 'f'.repeat(64),
  });
  // Первый запуск создаёт базу под «чужим» ключом
  const first = await bootstrap({ env, print: () => {} });
  await first.listening;
  await first.shutdown();

  const dbPath = path.join(dir, 'data', 'store.db');
  fs.writeFileSync(dbPath, fs.readFileSync(dbPath).subarray(0, 64));
  await assert.rejects(() => bootstrap({ env, print: () => {} }));
});

test('main() при сбойной конфигурации печатает ошибку и просит выйти', async () => {
  const { env } = await bootstrapEnv({ PORT: 'не-порт' });
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const originalExit = process.exit;
  const originalError = console.error;
  const errors = [];
  let exitCode = null;
  process.exit = code => {
    exitCode = code;
    throw new Error('__exit__');
  };
  console.error = message => errors.push(message);
  try {
    await main();
  } catch (err) {
    if (err.message !== '__exit__') throw err;
  } finally {
    process.exit = originalExit;
    console.error = originalError;
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
  assert.equal(exitCode, 1, 'код выхода 1 при неверной конфигурации');
  assert.ok(errors.some(line => /PORT/.test(String(line))));
});
