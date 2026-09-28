/* ============================================================
   AI Panel — общий загрузчик карточек баланса провайдеров.

   AgentRouter, OpenRouter, Selora и Experiential отличаются только
   отрисовкой: у всех одна и та же структура «скрыть, если нет ключа
   или провайдер уже выбран в полосе статистики → загрузить usage →
   показать карточку или ошибку». Раньше это были четыре копии
   одинакового кода (P2-2), здесь — одна фабрика.
   ============================================================ */

import { $id } from '../dom.js';
import { providerRequest } from '../api.js';

/** Текст ошибки загрузки карточки. */
function errorText(prefix, err) {
  const detail = err && err.message ? err.message : String(err);
  return prefix + ' — ' + detail;
}

/**
 * Фабрика карточки баланса.
 *
 * @param {object} opts
 * @param {string} opts.id           id провайдера (для hasKey и запроса)
 * @param {string} opts.name         имя провайдера в запросе
 * @param {string} opts.cardId       id элемента карточки
 * @param {string} opts.errorId      id элемента с ошибкой
 * @param {string} opts.errorPrefix  начало текста ошибки
 * @param {() => boolean} opts.hasKey есть ли ключ у провайдера
 * @param {() => boolean} opts.isActive выбран ли провайдер в полосе статистики
 * @param {(data: object) => void} opts.render отрисовка ответа
 * @param {(data: object) => void} [opts.onLoaded] хук после успешной загрузки
 * @param {() => void} [opts.onSettled] хук после любого исхода
 */
export function createWalletCard(opts) {
  const $card = $id(opts.cardId);
  return function load() {
    if (!$card) return Promise.resolve();
    if (!opts.hasKey() || opts.isActive()) {
      $card.hidden = true;
      if (opts.onSettled) opts.onSettled();
      return Promise.resolve();
    }
    return providerRequest('usage', { provider: { id: opts.id, name: opts.name } })
      .then(data => {
        opts.render(data);
        if (opts.onLoaded) opts.onLoaded(data);
      })
      .catch(err => {
        $card.hidden = false;
        const $err = $id(opts.errorId);
        if ($err) {
          $err.hidden = false;
          $err.textContent = errorText(opts.errorPrefix, err);
        }
      })
      .then(() => {
        if (opts.onSettled) opts.onSettled();
      });
  };
}
