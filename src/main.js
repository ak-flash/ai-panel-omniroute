'use strict';

// ============================================================
// CLI-запуск панели (node server.js / node src/main.js).
//
// Только эксплуатация: чтение env-файла, конфигурация, открытие
// хранилища, обработчики процесса и graceful shutdown по
// SIGTERM/SIGINT. Логика приложения собирается в src/app.js.
// ============================================================

const fs = require('fs');
const path = require('path');

const { describeEnvSource, loadConfig, loadEnvFile, resolveEnvFile, resolveLogDir } = require('./config');
const { loadProviders } = require('../providers');
const { createApp } = require('./app');
const { createStore } = require('./store');
const { createFileLogger } = require('./file-logger');

const SHUTDOWN_TIMEOUT_MS = 5000;

const describeError = (err) => (err && err.stack ? err.stack : String(err));

async function main() {
  // Имена переменных, взятых из env-файла, — для диагностики источника
  // PORT/HOST (окружение приоритетнее файла)
  const fileKeys = loadEnvFile(resolveEnvFile(process.env)) || [];

  // Ранний логгер: создаётся ДО проверки конфигурации, чтобы любое
  // падение на старте попадало в файл, а не только в stdout/stderr PM2.
  const bootLog = createFileLogger({ file: path.join(resolveLogDir(process.env), 'ai-panel.log') });

  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    bootLog.error('[boot] Ошибка конфигурации:', err.message);
    process.exit(1);
  }

  // Ошибка, вылетевшая мимо обработчиков запросов, не должна пропасть
  // молча: отклонённый промис — в лог, исключение — в лог и выход
  // (состояние процесса после него не гарантировано; PM2 перезапустит).
  process.on('unhandledRejection', (reason) => {
    bootLog.error('[process] unhandledRejection:', describeError(reason));
  });
  process.on('uncaughtException', (err) => {
    bootLog.error('[process] uncaughtException:', describeError(err));
    process.exit(1);
  });

  // Логгер для провайдеров: дублирует в консоль только при включённом debug
  const providerLogger = createFileLogger({
    file: config.logFile,
    maxBytes: config.logMaxBytes,
    mirror: config.providerDebug ? console : null,
  });

  // Откуда взят PORT/HOST. Значение из окружения при другом значении в
  // env-файле обычно означает устаревший env в PM2/docker: лечится
  // `pm2 restart ai-panel --update-env`.
  const hostSource = describeEnvSource('HOST', process.env, fileKeys);
  const portSource = describeEnvSource('PORT', process.env, fileKeys);
  bootLog.warnFile(`[boot] конфигурация: HOST=${config.host} (${hostSource}), PORT=${config.port} (${portSource})`);

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
  let store;
  try {
    store = await createStore({
      dbPath: config.dbPath,
      masterKey: config.masterKey || undefined,
      logger: bootLog,
    });
  } catch (err) {
    bootLog.error('[boot] Хранилище:', err && err.message ? err.message : err);
    process.exit(1);
  }

  const app = createApp({
    config,
    providers,
    store,
    logger: bootLog,
    providerLogger,
  });
  app.startDailyAgentRouterTracker();

  app.on('error', (err) => {
    bootLog.error('[boot] Не удалось запустить сервер:', err.message);
    process.exit(1);
  });
  app.listen(config.port, config.host, () => {
    const msg = `AI Панель · http://${config.host}:${app.address().port}`;
    console.log(msg);
    bootLog.infoFile(msg);
    for (const p of providers) {
      const line = '  провайдер ' + p.name + ' (' + p.id + '): ' + p.upstream;
      console.log(line);
      bootLog.infoFile(line);
    }
  });

  // Graceful shutdown: дождаться закрытия соединений и сброса хранилища;
  // не уложились в таймаут или данные не сохранились — код выхода 1.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Получен ' + signal + ' — останавливаю сервер');
    setTimeout(() => {
      bootLog.error(`[shutdown] не завершилось за ${SHUTDOWN_TIMEOUT_MS} мс — принудительный выход`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    app.shutdown().then(
      () => process.exit(0),
      (err) => {
        bootLog.error('[shutdown] ошибка при остановке:', describeError(err));
        process.exit(1);
      }
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { main };
if (require.main === module) main().catch((err) => {
  const msg = describeError(err);
  console.error(msg);
  // Финальный fallback: ошибка всплыла за пределами main() — пишем в файл напрямую
  try {
    const logFile = path.join(resolveLogDir(process.env), 'ai-panel.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    fs.appendFileSync(logFile, new Date().toISOString() + ' [ERROR] [boot] ' + msg.replace(/\r?\n/g, ' ') + '\n', { mode: 0o600 });
  } catch {}
  process.exit(1);
});
