/* ============================================================
   AI Panel — разбор объектов combo из OmniRoute API.
   Общий код для страницы «Combo», «Модели» (метки Combo) и
   главной (первые модели маршрутов).
   ============================================================ */

import { loadAliases } from './aliases.js';

// Список combo приходит в разных обёртках: массив, { combos }, { data }
export function combosFromResponse(data) {
  return Array.isArray(data) ? data
    : Array.isArray(data.combos) ? data.combos
    : Array.isArray(data.data) ? data.data
    : [];
}

// Заменяет префикс провайдера «<id>/rest» на его алиас
export function applyAliases(model, aliases) {
  const i = String(model || '').indexOf('/');
  if (i < 0) return model;
  const prov = model.slice(0, i);
  const rest = model.slice(i + 1);
  return (aliases && aliases[prov] ? aliases[prov] : prov) + '/' + rest;
}

/** Извлекает models из combo-объекта OmniRoute */
export function extractComboTargets(combo) {
  // Поле models: каждый элемент { model, providerId, label, weight, … }.
  // На всякий случай понимаем также targets и candidatePool.
  let raw = null;
  if (Array.isArray(combo.models)) raw = combo.models;
  else if (Array.isArray(combo.targets)) raw = combo.targets;
  else if (combo.config && Array.isArray(combo.config.auto && combo.config.auto.candidatePool)) {
    raw = combo.config.auto.candidatePool;
  }
  if (!raw) return [];

  return raw.map((t) => {
    if (typeof t === 'string') {
      return { key: t, display: t, _raw: t };
    }
    const model = t.model || '';
    // «provider/model» без длинного префикса провайдера вида openai-compatible-chat-…
    const shortModel = model.includes('/')
      ? model.slice(model.indexOf('/') + 1)
      : model;
    return {
      key: t.id || model || shortModel,
      display: applyAliases(model, loadAliases()) + (t.label ? '  [' + t.label + ']' : ''),
      modelId: model || shortModel,
      weight: t.weight,
      _raw: t,
    };
  });
}
