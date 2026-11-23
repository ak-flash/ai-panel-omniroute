/* Перестановка карточек главной: мышь, тач/перо и клавиатура. */

import { $id, setIcon, span } from './dom.js';
import { normalizeProviderCardOrder } from './provider-card-order.js';
import { showToast } from './toast.js';

const ORDER_KEY = 'aipanel.provider-card-order.v1';
const DRAG_THRESHOLD = 8;
const SCROLL_EDGE = 64;
let initialized = false;

function cardName(card) {
  return card.querySelector('.provider-name-badge')?.textContent.trim() || 'провайдера';
}

export function initProviderCardSorting() {
  const container = $id('provider-cards');
  if (!container) return;

  const cards = () => [...container.children].filter(el => el.classList.contains('provider-card'));
  const visibleCards = () => cards().filter(card => !card.hidden);

  // init вызывается повторно после изменения настроек; ручки и слушатели не дублируем.
  if (initialized) {
    for (const card of cards()) {
      card
        .querySelector('.provider-drag-handle')
        ?.setAttribute('aria-label', 'Переместить карточку ' + cardName(card));
    }
    return;
  }
  initialized = true;

  const byId = new Map(cards().map(card => [card.id, card]));
  let savedOrder = null;
  try {
    savedOrder = JSON.parse(localStorage.getItem(ORDER_KEY));
  } catch {
    // Повреждённая настройка или недоступное хранилище не мешают загрузке страницы.
  }
  for (const id of normalizeProviderCardOrder([...byId.keys()], savedOrder)) {
    container.appendChild(byId.get(id));
  }

  const status = $id('provider-sort-status');
  let drag = null;
  let scrollFrame = 0;
  let storageWarningShown = false;

  function moveCard(card, target, after) {
    if (card === target || card.hidden || target.hidden) return;
    const before = cards()
      .map(el => el.id)
      .join(',');
    container.insertBefore(card, after ? target.nextElementSibling : target);
    const order = cards().map(el => el.id);
    if (order.join(',') === before) return;

    // Перемещаем исходный DOM-узел: значения, раскрытые группы и обработчики сохраняются.
    card.querySelector('.provider-drag-handle').focus({ preventScroll: true });
    const visible = visibleCards();
    if (status) {
      status.textContent = `${cardName(card)}, позиция ${visible.indexOf(card) + 1} из ${visible.length}`;
    }
    try {
      // Сохраняем также скрытые карточки, чтобы отключение провайдера не теряло его место.
      localStorage.setItem(ORDER_KEY, JSON.stringify(order));
    } catch {
      if (!storageWarningShown) {
        storageWarningShown = true;
        showToast(
          'Не удалось сохранить порядок карточек в браузере. После перезагрузки он сбросится.',
          {
            type: 'error',
            timeout: 6000,
          }
        );
      }
    }
  }

  function clearDropTarget() {
    if (drag.target) delete drag.target.dataset.sortDrop;
    drag.target = null;
  }

  function updateDropTarget() {
    clearDropTarget();
    const hit = document.elementFromPoint(drag.x, drag.y);
    if (!hit || !container.contains(hit)) return;
    const visible = visibleCards();
    let target = hit.closest('.provider-card');
    // В зазоре между карточками выбираем ближайшую, а не теряем точку вставки.
    if (!target) {
      let distance = Infinity;
      for (const card of visible) {
        const rect = card.getBoundingClientRect();
        const dx = Math.max(rect.left - drag.x, 0, drag.x - rect.right);
        const dy = Math.max(rect.top - drag.y, 0, drag.y - rect.bottom);
        if (dx * dx + dy * dy < distance) {
          distance = dx * dx + dy * dy;
          target = card;
        }
      }
    }
    if (!target || target === drag.card || target.hidden) return;

    const rect = target.getBoundingClientRect();
    const horizontal = visible.some(
      card => card !== target && Math.abs(card.getBoundingClientRect().top - rect.top) < 2
    );
    drag.after = horizontal
      ? drag.x > rect.left + rect.width / 2
      : drag.y > rect.top + rect.height / 2;
    drag.target = target;
    target.dataset.sortDrop = horizontal
      ? drag.after
        ? 'right'
        : 'left'
      : drag.after
        ? 'bottom'
        : 'top';
  }

  function movePreview() {
    const preview = drag.preview;
    preview.style.left =
      Math.max(8, Math.min(drag.x + 16, innerWidth - preview.offsetWidth - 8)) + 'px';
    preview.style.top =
      Math.max(8, Math.min(drag.y + 16, innerHeight - preview.offsetHeight - 8)) + 'px';
  }

  function finishDrag(commit) {
    if (!drag) return;
    const state = drag;
    const target = state.target;
    clearDropTarget();
    drag = null;
    cancelAnimationFrame(scrollFrame);
    state.preview?.remove();
    state.card.classList.remove('is-sorting');
    document.body.classList.remove('is-provider-sorting');
    if (state.handle.hasPointerCapture(state.pointerId)) {
      state.handle.releasePointerCapture(state.pointerId);
    }
    if (commit && state.active && target) {
      moveCard(state.card, target, state.after);
    } else if (state.active && status) {
      status.textContent = 'Перемещение отменено.';
    }
  }

  function autoScroll() {
    if (!drag?.active) return;
    if (drag.card.hidden) {
      finishDrag(false);
      return;
    }
    const top = document.querySelector('.topbar')?.getBoundingClientRect().bottom || 0;
    const delta =
      drag.y < top + SCROLL_EDGE
        ? -Math.min(18, Math.ceil((top + SCROLL_EDGE - drag.y) / 4))
        : drag.y > innerHeight - SCROLL_EDGE
          ? Math.min(18, Math.ceil((drag.y - innerHeight + SCROLL_EDGE) / 4))
          : 0;
    if (delta) {
      window.scrollBy({ top: delta, behavior: 'instant' });
      updateDropTarget();
    }
    scrollFrame = requestAnimationFrame(autoScroll);
  }

  for (const card of cards()) {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'provider-drag-handle';
    handle.title = 'Перетащить карточку или переместить стрелками';
    handle.setAttribute('aria-label', 'Переместить карточку ' + cardName(card));
    handle.setAttribute('aria-describedby', 'provider-sort-hint');
    const grip = span('');
    grip.setAttribute('aria-hidden', 'true');
    setIcon(grip, 'grip-vertical');
    handle.appendChild(grip);
    card.querySelector('.provider-name-row').prepend(handle);

    handle.addEventListener('keydown', event => {
      const delta = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[event.key];
      if (delta === undefined && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      if (drag) return;
      const visible = visibleCards();
      const from = visible.indexOf(card);
      const to = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : from + delta;
      if (from < 0 || to < 0 || to >= visible.length || to === from) return;
      moveCard(card, visible[to], to > from);
    });

    handle.addEventListener('pointerdown', event => {
      if (drag || !event.isPrimary || event.button !== 0 || visibleCards().length < 2) return;
      event.preventDefault();
      handle.focus({ preventScroll: true });
      drag = {
        card,
        handle,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        active: false,
        preview: null,
        target: null,
        after: false,
      };
      handle.setPointerCapture(event.pointerId);
    });
  }

  container.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.active) {
      if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < DRAG_THRESHOLD) return;
      drag.active = true;
      drag.card.classList.add('is-sorting');
      document.body.classList.add('is-provider-sorting');
      const preview = document.createElement('div');
      preview.className = 'provider-sort-preview';
      preview.setAttribute('aria-hidden', 'true');
      setIcon(preview, 'grip-vertical');
      preview.appendChild(span('', cardName(drag.card)));
      document.body.appendChild(preview);
      drag.preview = preview;
      scrollFrame = requestAnimationFrame(autoScroll);
    }
    event.preventDefault();
    movePreview();
    updateDropTarget();
  });

  container.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.active) {
      drag.x = event.clientX;
      drag.y = event.clientY;
      updateDropTarget();
    }
    finishDrag(true);
  });
  for (const eventName of ['pointercancel', 'lostpointercapture']) {
    container.addEventListener(eventName, event => {
      if (drag && event.pointerId === drag.pointerId) finishDrag(false);
    });
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag) {
      event.preventDefault();
      finishDrag(false);
    }
  });
  window.addEventListener('blur', () => finishDrag(false));
}
