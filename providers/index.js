// ============================================================
// Реестр вшитых провайдеров: FACTORIES (id → фабрика) + loadProviders().
//
// Набор провайдеров и их настройки задаются кодом, а не окружением
// (в .env — только PORT, см. README): адрес API вшит в фабрику,
// ключ всегда присылает клиент. Чтобы добавить провайдера —
// файл providers/<id>.js по образцу xkiro.js и строка в FACTORIES.
// Первый в списке — активный по умолчанию.
// ============================================================

const { createXKiroProvider } = require('./xkiro');
const { createAgentRouterProvider } = require('./agentrouter');

const FACTORIES = { xkiro: createXKiroProvider, agentrouter: createAgentRouterProvider };

/**
 * Собирает адаптеры вшитых провайдеров в порядке FACTORIES.
 * opts пробрасываются в фабрики (сейчас — log: функция логирования).
 */
function loadProviders(opts = {}) {
  return Object.keys(FACTORIES).map((id) => FACTORIES[id](opts));
}

module.exports = { loadProviders, FACTORIES };
