'use strict';

// ============================================================
// CLI-запуск панели (node server.js / node src/main.js).
//
// Только эксплуатация: чтение .env, проверка конфигурации и master
// key, вывод, graceful shutdown по SIGTERM/SIGINT. Логика приложения
// собирается в src/app.js.
// ============================================================

const fs = require('fs');
const path = require('path');

const { getServerConfig, validateMasterKey } = require('./security');
const { loadProviders } = require('../providers');
const { createApp } = require('./app');
const { createStore } = require('./store');
const { createFileLogger } = require('./file-logger');

/** Читает .env рядом с корнем проекта (не перезаписывает уже заданное). */
function loadEnvFile(fileName) {
  const filePath = path.join(__dirname, '..', fileName);
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const name = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) value = value.slice(1, -1);
    else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    // Не перезаписываем уже заданные переменные: окружение (PM2, docker,
    // системные) имеет приоритет над .env (стандартное поведение dotenv).
    // Если в окружении остался устаревший PORT — обновите PM2:
    // `pm2 restart ai-panel --update-env` (см. README).
    if (!(name in process.env)) process.env[name] = value;
  }
}

async function main() {
  // Диагностика источника конфигурации: было ли PORT/HOST задано в
  // окружении ДО загрузки .env (если да — окружение приоритетнее).
  const envBefore = { PORT: process.env.PORT, HOST: process.env.HOST };
  loadEnvFile('.env');
  const envFromFile = { PORT: process.env.PORT, HOST: process.env.HOST };

  // Ранний логгер: создаётся ДО проверок конфигурации, чтобы любое
  // падение на этапе старта (неверный HOST, повреждённая база, нет
  // .env) попадало в logs/ai-panel.log, а не только в stdout/stderr
  // PM2. Путь намеренно вшит — файл рядом с data/ хранилища.
  const logDir = path.join(__dirname, '..', 'logs');
  const logFile = path.join(logDir, 'ai-panel.log');
  const providerDebug = process.env.AIPANEL_PROVIDER_DEBUG === 'true';
  // Жёсткий лимит 50 МБ для ротации логов
  const LOG_MAX_BYTES = 50 * 1024 * 1024;
  // Общий логгер: пишет в файл и дублирует в консоль (для boot, ошибок, etc.)
  const bootLog = createFileLogger({ file: logFile, maxBytes: LOG_MAX_BYTES });
  // Логгер для провайдеров: дублирует в консоль только при включённом debug
  const providerLogger = createFileLogger({
    file: logFile,
    maxBytes: LOG_MAX_BYTES,
    mirror: providerDebug ? console : null,
  });

  let serverConfig;
  try {
    serverConfig = getServerConfig();
  } catch (err) {
    bootLog.error('[boot] Ошибка конфигурации:', err.message);
    process.exit(1);
  }
  const { port: PORT, host: HOST, publicOrigin } = serverConfig;

  // Откуда взят PORT/HOST: если окружение задало значение до загрузки
  // .env — оно победило. Расхождение обычно означает устаревший env в
  // PM2/docker: лечится `pm2 restart ai-panel --update-env`.
  const portSource = envFromFile.PORT !== envBefore.PORT
    ? '.env'
    : (envBefore.PORT != null ? 'окружение (pm2/docker)' : 'по умолчанию (.env/8765)');
  const hostSource = envFromFile.HOST !== envBefore.HOST
    ? '.env'
    : (envBefore.HOST != null ? 'окружение' : 'по умолчанию (127.0.0.1/0.0.0.0)');
  if (bootLog.warnFile && typeof bootLog.warnFile === 'function') {
    bootLog.warnFile(`[boot] конфигурация: HOST=${HOST} (${hostSource}), PORT=${PORT} (${portSource})`);
  }
  try {
    validateMasterKey(process.env.AIPANEL_MASTER_KEY);
  } catch (err) {
    bootLog.error('[boot] Ошибка master key:', err.message);
    process.exit(1);
  }

  // Провайдеры ждут функцию log(...args) (не-JSON ответы, отказы токенов).
  const providerLog = providerLogger.log.bind(providerLogger);

  const providers = loadProviders({ log: providerLog, debug: providerDebug });

  // Хранилище открываем до старта сервера: неверный master key или
  // повреждённая база видны сразу в логе, а не на первом запросе
  let store;
  try {
    store = await createStore({});
  } catch (err) {
    bootLog.error('[boot] Хранилище:', err && err.message ? err.message : err);
    process.exit(1);
  }

  const app = createApp({ providers, publicOrigin, store, logger: bootLog, providerLogger, providerDebug });
  if (typeof app.startDailyAgentRouterTracker === 'function') app.startDailyAgentRouterTracker();

  app.on('error', (err) => {
    bootLog.error('[boot] Не удалось запустить сервер:', err.message);
    process.exit(1);
  });
  app.listen(PORT, HOST, () => {
    const msg = `AI Панель · http://${HOST}:${PORT}`;
    console.log(msg);
    bootLog.infoFile(msg);
    for (const p of providers) {
      const line = '  провайдер ' + p.name + ' (' + p.id + '): ' + p.upstream;
      console.log(line);
      bootLog.infoFile(line);
    }
  });

  // Graceful shutdown: остановить трекер и закрыть слушатель
  const shutdown = (signal) => {
    console.log('Получен ' + signal + ' — останавливаю сервер');
    app.close(() => process.exit(0));
    // Страховка: если соединения не закрылись сами
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { main, loadEnvFile };
if (require.main === module) main().catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  console.error(msg);
  // Финальный fallback: если ошибка всплыла за пределами main()
  // (bootLog уже не доступен), пишем в файл напрямую
  try {
    const logFile = path.join(__dirname, '..', 'logs', 'ai-panel.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, new Date().toISOString() + ' [ERROR] [boot] ' + msg + '\n');
  } catch {}
  process.exit(1);
});
