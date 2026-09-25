// AI Панель — точка входа: сборка приложения — src/app.js,
// CLI-запуск — src/main.js. Файл оставлен, чтобы деплой (PM2) и тесты
// продолжали запускать `node server.js`.
module.exports = require('./src/app');
if (require.main === module) require('./src/main').main();
