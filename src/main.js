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

const { getServerConfig, validateMasterKey } = require('../security');
const { loadProviders } = require('../providers');
const { createApp } = require('./app');
const { createStore } = require('./store');

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
    if (!(name in process.env)) process.env[name] = value;
  }
}

async function main() {
  loadEnvFile('.env');
  let serverConfig;
  try {
    serverConfig = getServerConfig();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const { port: PORT, host: HOST, publicOrigin } = serverConfig;
  try {
    validateMasterKey(process.env.AIPANEL_MASTER_KEY);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const providers = loadProviders();

  // Хранилище открываем до старта сервера: неверный master key или
  // повреждённая база видны сразу в логе, а не на первом запросе
  let store;
  try {
    store = await createStore({});
  } catch (err) {
    console.error('Хранилище: ' + (err && err.message ? err.message : err));
    process.exit(1);
  }

  const app = createApp({ providers, publicOrigin, store });
  if (typeof app.startDailyAgentRouterTracker === 'function') app.startDailyAgentRouterTracker();

  app.on('error', (err) => {
    console.error('Не удалось запустить сервер:', err.message);
    process.exit(1);
  });
  app.listen(PORT, HOST, () => {
    console.log(`AI Панель · http://${HOST}:${PORT}`);
    for (const p of providers) console.log('  провайдер ' + p.name + ' (' + p.id + '): ' + p.upstream);
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
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
