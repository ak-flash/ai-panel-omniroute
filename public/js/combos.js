/* ============================================================
   AI Panel — разбор объектов combo из OmniRoute API.
   Общий код для страницы «Combo», «Модели» (метки Combo) и
   главной (первые модели маршрутов).
   ============================================================ */

import { loadAliases } from './aliases.js';
import { omniFetch, COMBO_LIST_PATH, COMBO_PATH } from './api.js';

// Список combo приходит в разных обёртках: массив, { combos }, { data }
export function combosFromResponse(data) {
  return Array.isArray(data)
    ? data
    : Array.isArray(data.combos)
      ? data.combos
      : Array.isArray(data.data)
        ? data.data
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

  return raw.map(t => {
    if (typeof t === 'string') {
      return { key: t, display: t, _raw: t };
    }
    const model = t.model || '';
    // «provider/model» без длинного префикса провайдера вида openai-compatible-chat-…
    const shortModel = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
    return {
      key: t.id || model || shortModel,
      display: applyAliases(model, loadAliases()) + (t.label ? '  [' + t.label + ']' : ''),
      modelId: model || shortModel,
      weight: t.weight,
      _raw: t,
    };
  });
}

/**
 * Список combo с целями: у тех, у кого targets не пришли в списке,
 * детали грузятся параллельно (Promise.all), а не по очереди.
 * Один и тот же набор combo кешируется на время страницы.
 */
let comboListPromise = null;

export function loadComboList() {
  if (!comboListPromise) {
    comboListPromise = (async () => {
      const data = await omniFetch(COMBO_LIST_PATH);
      const combos = combosFromResponse(data);
      const needDetails = combos.filter(c => extractComboTargets(c).length === 0);
      if (needDetails.length) {
        const details = await Promise.all(
          needDetails.map(c =>
            omniFetch(COMBO_PATH(c.id)).catch(() => {
              /* нет деталей — останется пустой список целей */
            })
          )
        );
        needDetails.forEach((c, i) => {
          c._targets = extractComboTargets(details[i]);
        });
      }
      return combos;
    })();
  }
  return comboListPromise;
}

/** Цели combo: из списка, иначе из загруженных деталей. */
export function comboTargets(combo) {
  const own = extractComboTargets(combo);
  if (own.length) return own;
  return Array.isArray(combo._targets) ? combo._targets : [];
}

export function resetComboListCache() {
  comboListPromise = null;
}
