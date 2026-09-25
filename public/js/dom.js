/* ============================================================
   AI Panel — DOM-хелперы и мелкие инлайн-иконки статуса
   ============================================================ */

import { icon } from '../icons.js';

// getElementById, безопасный для страниц, где элемента нет
export const $id = (id) => document.getElementById(id);

// addEventListener только если элемент есть на текущей странице
export function on(el, event, handler) {
  if (el) el.addEventListener(event, handler);
}

// Small inline status icons (heroicons)
function _ico(name, cls) { return `<svg class="${cls||'ico-status'}" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">` + (name === 'check'
  ? '<path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>'
  : '<path stroke-linecap="round" stroke-linejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>'); }

export const ICO_CHECK = _ico('check');
export const ICO_X = _ico('x');

/**
 * Ставит статичную SVG-иконку из репозитория в элемент (замена
 * el.innerHTML = icon(...)). Имя иконки — литерал в коде, данные
 * пользователя сюда не попадают.
 */
export function setIcon(el, name, opts) {
  if (!el) return el;
  const span = document.createElement('span');
  span.className = 'ico-inline';
  // Только SVG-константа из icons.js по литеральному имени иконки
  // eslint-disable-next-line no-unsanitized/property -- статичная SVG-константа репозитория
  span.innerHTML = icon(name, opts);
  el.replaceChildren(span);
  return el;
}

/** <span class="cls">text</span> без сборки разметки строкой. */
export function span(cls, text) {
  const node = document.createElement('span');
  node.className = cls;
  node.textContent = text;
  return node;
}

/** Пробел-узел для строк «значение / значение». */
export const GAP = () => document.createTextNode(' ');

// Маркеры в текстах сообщений: заменяются на узлы иконки/переноса при
// выводе. Так текст (в т.ч. ответ провайдера) всегда идёт текстовым
// узлом, а разметка не собирается из данных.
export const MARK_OK = '[[ok]]';
export const MARK_X = '[[x]]';
export const MARK_BR = '[[br]]';

const MARKER_RE = /(\[\[(?:ok|x|br)\]\])/;
const ICON_MARKUP = { [MARK_OK]: ICO_CHECK, [MARK_X]: ICO_X };

/**
 * Выводит сообщение в элемент: маркеры становятся иконкой или <br>,
 * всё остальное — текстом (innerHTML для данных не используется).
 */
export function renderMessage(el, message) {
  if (!el) return el;
  const nodes = [];
  for (const part of String(message).split(MARKER_RE)) {
    if (part === MARK_BR) {
      nodes.push(document.createElement('br'));
    } else if (ICON_MARKUP[part]) {
      const span = document.createElement('span');
      span.className = 'ico-inline';
      // Только статичная SVG-константа из dom.js, пользовательские данные не попадают
      // eslint-disable-next-line no-unsanitized/property -- статичная SVG-константа репозитория
      span.innerHTML = ICON_MARKUP[part];
      nodes.push(span);
    } else if (part) {
      nodes.push(document.createTextNode(part));
    }
  }
  el.replaceChildren(...nodes);
  return el;
}
