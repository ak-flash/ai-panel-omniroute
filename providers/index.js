// ============================================================
// Реестр вшитых провайдеров: FACTORIES (id → фабрика) + loadProviders().
//
// Набор провайдеров и их настройки задаются кодом, а не окружением:
// адрес API вшит в фабрику, ключ приходит из хранилища сервера.
// Чтобы добавить провайдера — файл providers/<id>.js по образцу
// xkiro.js и строка в FACTORIES (остальные места — в README).
// Первый в списке — активный по умолчанию.
// ============================================================

const { createXKiroProvider } = require('./xkiro');
const { createAgentRouterProvider } = require('./agentrouter');
const { createOpenRouterProvider } = require('./openrouter');
const { createSeloraProvider } = require('./selora');
const { createExperientialProvider } = require('./experiential');

const FACTORIES = {
  xkiro: createXKiroProvider,
  agentrouter: createAgentRouterProvider,
  openrouter: createOpenRouterProvider,
  selora: createSeloraProvider,
  experiential: createExperientialProvider,
};

/**
 * Собирает адаптеры вшитых провайдеров в порядке FACTORIES.
 * opts пробрасываются в фабрики (сейчас — log: функция логирования).
 */
function loadProviders(opts = {}) {
  // Для обратной совместимости: если передан только log, используем его как есть,
  // но также передаём debug для детального логирования.
  const providerOpts = { ...opts };
  return Object.keys(FACTORIES).map((id) => FACTORIES[id](providerOpts));
}

module.exports = { loadProviders, FACTORIES };
