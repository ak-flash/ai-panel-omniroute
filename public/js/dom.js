/* ============================================================
   AI Panel — DOM-хелперы и мелкие инлайн-иконки статуса
   ============================================================ */

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
