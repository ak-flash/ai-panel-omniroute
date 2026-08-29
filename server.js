// AI Панель — точка входа для обратной совместимости.
// Логика приложения переехала в src/ (этап 3 плана рефакторинга):
// сборка — src/app.js, CLI-запуск — src/main.js. Файл оставлен,
// чтобы деплой и тесты продолжали запускать `node server.js`.
module.exports = require('./src/app');
if (require.main === module) require('./src/main').main();
