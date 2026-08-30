/* ============================================================
   AI Panel — всплывающие уведомления (toast) справа вверху.

   showToast('Порядок сохранён')                    — успех (по умолчанию)
   showToast('Не удалось…', { type: 'error' })      — ошибка
   showToast('…', { timeout: 5000 })                — свой срок показа

   Контейнер создаётся лениво при первом показе. Каждый тост
   сам себя объявляет скринридеру (role=status/alert), поэтому
   общий aria-live не нужен.
   ============================================================ */

import { icon } from '../icons.js';

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_TOASTS = 4;
const ENTER_EXIT_MS = 180;

let $container = null;

function getContainer() {
  if ($container && $container.isConnected) return $container;
  $container = document.createElement('div');
  $container.className = 'toasts';
  document.body.appendChild($container);
  return $container;
}

function buildToast(message, type) {
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  // status → вежливое объявление; alert → настойчивое (ошибки)
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const ico = document.createElement('span');
  ico.className = 'toast-icon';
  ico.setAttribute('aria-hidden', 'true');
  ico.innerHTML = icon(type === 'error' ? 'x-mark' : 'check-circle', { class: 'icon' });

  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;

  el.append(ico, text);
  return el;
}

function dismiss(el) {
  if (!el.isConnected || el.dataset.leaving) return;
  el.dataset.leaving = '1';
  el.classList.remove('toast-show');
  const remove = () => { if (el.isConnected) el.remove(); };
  el.addEventListener('transitionend', remove, { once: true });
  // Страховка: при prefers-reduced-motion transitionend может не прийти
  setTimeout(remove, ENTER_EXIT_MS + 120);
}

/**
 * Показывает всплывающее уведомление справа вверху.
 * @param {string} message — текст уведомления
 * @param {{type?: 'ok'|'error', timeout?: number}} [opts]
 */
export function showToast(message, opts = {}) {
  const type = opts.type === 'error' ? 'error' : 'ok';
  const timeout = Number.isFinite(opts.timeout) ? opts.timeout : DEFAULT_TIMEOUT_MS;

  const container = getContainer();
  // Не копим очередь: старейшие уходим первыми
  while (container.children.length >= MAX_TOASTS) container.firstElementChild.remove();

  const el = buildToast(message, type);
  container.appendChild(el);
  // Двойной rAF: сначала применится стартовое состояние, потом целевое
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('toast-show')));

  setTimeout(() => dismiss(el), timeout);
  return el;
}
