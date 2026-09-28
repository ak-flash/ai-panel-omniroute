'use strict';

// ============================================================
// CLI-запуск панели (node server.js / node src/main.js).
//
// Разделено на две части, чтобы покрыть тестами то, что реально
// ломается:
//
//   bootstrap() — читает env-файл, проверяет конфигурацию, поднимает
//     хранилище и HTTP-сервер. Не трогает process.exit и сигналы:
//     возвращает { config, app, providers, store, shutdown, log };
//   main()      — обвязка процесса: обработчики unhandledRejection/
//     uncaughtException, SIGTERM/SIGINT, коды выхода и аварийный лог.
//
// Логика приложения собирается в src/app.js.
// ============================================================

const fs = require('fs');
const path = require('path');

const {
  describeEnvSource,
  loadConfig,
  loadEnvFile,
  resolveEnvFile,
  resolveLogDir,
} = require('./config');
const { loadProviders } = require('../providers');
const { createApp } = require('./app');
const { createStore } = require('./store');
const { createFileLogger } = require('./file-logger');

const SHUTDOWN_TIMEOUT_MS = 5000;

const describeError = err => (err && err.stack ? err.stack : String(err));

/**
 * Поднимает панель в текущем процессе. Бросает ConfigError при
 * неверной конфигурации и StoreError при проблеме с хранилищем —
 * вызывающий решает, что с ними делать (CLI завершает процесс).
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] окружение (по умолчанию process.env)
 * @param {(msg: string) => void} [options.print] куда писать баннер
 * @returns {Promise<{config: object, app: import('http').Server, providers: object[], shutdown: Function, log: object}>}
 */
async function bootstrap({ env = process.env, print = msg => console.log(msg) } = {}) {
  // Имена переменных, взятых из env-файла, — для диагностики источника
  // PORT/HOST (окружение приоритетнее файла)
  const fileKeys = loadEnvFile(resolveEnvFile(env)) || [];

  // Ранний логгер: создаётся ДО проверки конфигурации, чтобы любое
  // падение на старте попадало в файл, а не только в stdout/stderr PM2.
  const bootLog = createFileLogger({ file: path.join(resolveLogDir(env), 'ai-panel.log') });

  const config = loadConfig(env);

  // Логгер для провайдеров: дублирует в консоль только при включённом debug
  const providerLogger = createFileLogger({
    file: config.logFile,
    maxBytes: config.logMaxBytes,
    mirror: config.providerDebug ? console : null,
  });

  // Откуда взят PORT/HOST. Значение из окружения при другом значении в
  // env-файле обычно означает устаревший env в PM2/docker: лечится
  // `pm2 restart ai-panel --update-env`.
  const hostSource = describeEnvSource('HOST', env, fileKeys);
  const portSource = describeEnvSource('PORT', env, fileKeys);
  bootLog.warnFile(
    `[boot] конфигурация: HOST=${config.host} (${hostSource}), PORT=${config.port} (${portSource})`
  );

  // Панель не в состоянии проверить, что порт закрыт снаружи, поэтому
  // без токена входа в remote-режиме предупреждаем явно.
  if (config.remoteMode && !config.authToken) {
    bootLog.warn(
      '[boot] AIPANEL_AUTH_TOKEN пуст: вход отключён, любой, кто достучится до порта, ' +
        'получит доступ к ключам провайдеров. Закройте порт firewall/reverse proxy ' +
        'или задайте AIPANEL_AUTH_TOKEN.'
    );
  }

  const providers = loadProviders({ log: providerLogger, debug: config.providerDebug });

  // Хранилище открываем до старта сервера: неверный master key или
  // повреждённая база видны сразу в логе, а не на первом запросе
  const store = await createStore({
    dbPath: config.dbPath,
    masterKey: config.masterKey || undefined,
    logger: bootLog,
  });

  const app = createApp({
    config,
    providers,
    store,
    logger: bootLog,
    providerLogger,
  });
  app.startDailyAgentRouterTracker();

  const listening = new Promise((resolve, reject) => {
    app.once('error', reject);
    app.listen(config.port, config.host, () => {
      const msg = `AI Панель · http://${config.host}:${app.address().port}`;
      print(msg);
      bootLog.infoFile(msg);
      for (const p of providers) {
        const line = '  провайдер ' + p.name + ' (' + p.id + '): ' + p.upstream;
        print(line);
        bootLog.infoFile(line);
      }
      resolve(app);
    });
  });

  // Graceful shutdown: дождаться закрытия соединений и сброса хранилища;
  // не уложились в таймаут — принудительный выход.
  let shuttingDown = false;
  const shutdown = signal => {
    if (shuttingDown) return Promise.resolve();
    shuttingDown = true;
    if (signal) print('Получен ' + signal + ' — останавливаю сервер');
    const guard = setTimeout(() => {
      bootLog.error(
        `[shutdown] не завершилось за ${SHUTDOWN_TIMEOUT_MS} мс — принудительный выход`
      );
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    guard.unref();
    return app.shutdown().then(
      () => {
        clearTimeout(guard);
        return undefined;
      },
      err => {
        clearTimeout(guard);
        throw err;
      }
    );
  };

  return { config, app, providers, store, log: bootLog, listening, shutdown };
}

async function main() {
  let running;
  try {
    running = await bootstrap();
  } catch (err) {
    // Ошибка конфигурации или хранилища: сообщение уже пишется
    // ранним логгером, здесь — в stderr и код выхода 1.
    console.error(err && err.message ? err.message : err);
    process.exit(1);
    return;
  }
  const { log: bootLog, app, shutdown } = running;

  // Ошибка, вылетевшая мимо обработчиков запросов, не должна пропасть
  // молча: отклонённый промис — в лог, исключение — в лог и выход
  // (состояние процесса после него не гарантировано; PM2 перезапустит).
  process.on('unhandledRejection', reason => {
    bootLog.error('[process] unhandledRejection:', describeError(reason));
  });
  process.on('uncaughtException', err => {
    bootLog.error('[process] uncaughtException:', describeError(err));
    process.exit(1);
  });

  app.on('error', err => {
    bootLog.error('[boot] Не удалось запустить сервер:', err.message);
    process.exit(1);
  });

  // Код 0 при успешной остановке, 1 — если не успели или данные не сохранены
  process.on('SIGTERM', () => stopAndExit('SIGTERM', shutdown));
  process.on('SIGINT', () => stopAndExit('SIGINT', shutdown));
}

function stopAndExit(signal, shutdown) {
  shutdown(signal).then(
    () => process.exit(0),
    err => {
      console.error(err && err.message ? err.message : err);
      process.exit(1);
    }
  );
}

module.exports = { bootstrap, main };
if (require.main === module)
  main().catch(err => {
    const msg = describeError(err);
    console.error(msg);
    // Финальный fallback: ошибка всплыла за пределами main() — пишем в файл напрямую
    try {
      const logFile = path.join(resolveLogDir(process.env), 'ai-panel.log');
      fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
      fs.appendFileSync(
        logFile,
        new Date().toISOString() + ' [ERROR] [boot] ' + msg.replace(/\r?\n/g, ' ') + '\n',
        { mode: 0o600 }
      );
    } catch {}
    process.exit(1);
  });
