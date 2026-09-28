// ============================================================
// Реестр провайдеров: FACTORIES (id → фабрика) + loadProviders().
//
// Список провайдеров и их ключи хранилища описаны в
// src/provider-descriptors.js — оттуда же берётся контракт:
// каждый адаптер обязан совпадать со своим дескриптором (проверяет
// test/unit/provider-contract.test.js).
//
// opts в loadProviders(): адрес и ключ (тесты подменяют upstream),
// log (диагностика), debug (подробный лог запросов), fetchImpl.
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
 * Создаёт все адаптеры реестра. opts прокидываются в каждую фабрику:
 * адрес и ключ (тесты — mock-upstream), log, debug, fetchImpl.
 */
function loadProviders(opts = {}) {
  const providerOpts = { ...opts };
  return Object.keys(FACTORIES).map(id => FACTORIES[id](providerOpts));
}

module.exports = { loadProviders, FACTORIES };
