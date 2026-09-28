/* ============================================================
   AI Panel — состояние проверки моделей combo тестовым запросом.

   Раньше Map с результатами и переходы состояний жили прямо в
   pages/combo.js (P2-2). DOM и тосты передаются колбэками, поэтому
   модуль тестируется без браузера.
   ============================================================ */

import { comboTestModelId, testComboModel } from './combo-test.js';

/**
 * @typedef {object} ComboModelCheck
 * @property {(key: string) => ({state: string, ms?: number, detail?: string}|undefined)} get
 * @property {(target: object, key: string) => Promise<void>} run
 */

/**
 * Создаёт хранилище результатов проверки и запуск самой проверки.
 *
 * @param {object} opts
 * @param {() => void} opts.onUpdate  перерисовать список после смены состояния
 * @param {(message: string, opts?: object) => void} opts.notify  показать тост
 * @param {(id: string) => Promise<{ms: number, model: string}>} [opts.testModel]
 * @param {(target: object) => string} [opts.modelIdOf]
 * @returns {ComboModelCheck}
 */
export function createComboModelCheck({
  onUpdate,
  notify,
  testModel = testComboModel,
  modelIdOf = comboTestModelId,
}) {
  const results = new Map();
  return {
    get(key) {
      return results.get(key);
    },
    async run(target, key) {
      const prev = results.get(key);
      if (prev && prev.state === 'loading') return; // проверка уже идёт
      results.set(key, { state: 'loading' });
      onUpdate();
      try {
        const res = await testModel(modelIdOf(target));
        results.set(key, { state: 'ok', ms: res.ms });
        notify('Модель отвечает: ' + res.ms + ' мс');
      } catch (err) {
        results.set(key, { state: 'err', ms: err.ms, detail: err.message });
        notify('Проверка не удалась: ' + err.message, { type: 'error', timeout: 6000 });
      }
      onUpdate();
    },
  };
}
