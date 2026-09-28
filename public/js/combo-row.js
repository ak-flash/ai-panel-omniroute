/* ============================================================
   AI Panel — построение строки списка targets на странице «Combo».

   Раньше разметка строки жила внутри renderComboList (P2-2).
   Обработчики перетаскивания остаются на странице: здесь только
   содержимое строки — ранг, бейджи, кнопка проверки и переключатель включения.
   ============================================================ */

import { setIcon } from './dom.js';

/**
 * @typedef {object} ComboRowHandlers
 * @property {() => void} onCheck  запустить проверку модели

 * @property {() => void} onToggle  включить/выключить модель
 */

/**
 * Собирает `<li>` для одного target. Слушатели перетаскивания
 * навешивает вызывающая сторона: здесь только содержимое строки.
 *
 * @param {object} opts
 * @param {object} opts.target       target combo (display, weight, …)
 * @param {string} opts.key          ключ строки (comboTargetKey)
 * @param {number} opts.index        позиция в общем списке (вкл. + выкл.)
 * @param {boolean} opts.disabled    target выключен
 * @param {object} [opts.model]      каталог провайдера для бейджа тарифа
 * @param {object} [opts.testState]  состояние проверки ({ state, ms, detail })
 * @param {ComboRowHandlers} opts.handlers
 * @returns {{el: HTMLLIElement, dragHandle: HTMLSpanElement}}
 */
export function buildComboRow(opts) {
  const { target: t, key, index: i, disabled: isDisabled, model: m, testState, handlers } = opts;

  const li = document.createElement('li');
  if (i === 0 && !isDisabled) li.classList.add('top');
  if (isDisabled) li.classList.add('is-disabled');
  li.draggable = !isDisabled;
  li.dataset.idx = String(i);
  li.dataset.key = key;

  const dragHandle = document.createElement('span');
  dragHandle.className = 'combo-drag-handle';
  dragHandle.title = 'Перетащить модель';
  dragHandle.setAttribute('role', 'button');
  dragHandle.setAttribute('tabindex', isDisabled ? '-1' : '0');
  dragHandle.setAttribute('aria-label', 'Переместить модель ' + t.display);
  setIcon(dragHandle, 'grip-vertical');

  const rank = document.createElement('span');
  rank.className = 'combo-rank num';
  rank.textContent = String(i + 1);

  const name = document.createElement('code');
  name.className = 'combo-model-id';
  name.textContent = t.display;
  if (m && m.display_name) name.title = m.display_name;

  li.append(dragHandle, rank, name);

  if (m) {
    const tier = m.access_tier || 'paid';
    const tierBadge = document.createElement('span');
    tierBadge.className = 'badge ' + tier;
    tierBadge.textContent = tier;
    li.appendChild(tierBadge);
  }

  if (t.weight != null && t.weight !== 0) {
    const wBadge = document.createElement('span');
    wBadge.className = 'badge';
    wBadge.textContent = 'w:' + t.weight;
    li.appendChild(wBadge);
  }

  // Кнопка проверки (иконка check-circle) всегда в DOM — иначе
  // высота ряда прыгает. Во время проверки скрыта, при ошибке
  // становится красным x-circle, при успехе рядом цифры «N мс».
  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'btn-icon combo-test-btn';
  testBtn.setAttribute('aria-label', 'Проверить модель ' + t.display);
  testBtn.title = 'Проверить модель тестовым запросом';
  if (testState && testState.state === 'loading') {
    testBtn.classList.add('combo-test-btn-hidden');
    testBtn.tabIndex = -1;
    testBtn.disabled = true;
  } else if (testState && testState.state === 'err') {
    setIcon(testBtn, 'x-circle');
    testBtn.classList.add('combo-test-err');
    testBtn.title = (testState.detail || 'Модель не ответила') + ' — проверить снова';
    testBtn.addEventListener('click', () => handlers.onCheck());
  } else {
    setIcon(testBtn, 'check-circle');
    if (testState && testState.state === 'ok') {
      testBtn.title = 'Модель ответила за ' + testState.ms + ' мс — проверить снова';
    }
    testBtn.addEventListener('click', () => handlers.onCheck());
  }
  li.appendChild(testBtn);

  if (testState && testState.state === 'loading') {
    const testBadge = document.createElement('span');
    testBadge.className = 'badge combo-test-badge combo-test-loading';
    testBadge.textContent = 'проверяю…';
    testBadge.title = 'Идёт проверка модели…';
    li.appendChild(testBadge);
  } else if (testState && testState.state === 'ok') {
    const msSpan = document.createElement('span');
    msSpan.className = 'combo-test-ms num combo-test-ok';
    msSpan.textContent = testState.ms + ' мс';
    msSpan.title = 'Модель ответила за ' + testState.ms + ' мс';
    li.appendChild(msSpan);
  }

  // У первой включённой модели переключателя нет — она всегда активна
  if (!(i === 0 && !isDisabled)) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'combo-switch';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(!isDisabled));
    toggle.setAttribute(
      'aria-label',
      (isDisabled ? 'Включить модель ' : 'Выключить модель ') + t.display
    );
    toggle.title = isDisabled ? 'Включить модель' : 'Выключить модель';
    toggle.addEventListener('click', () => handlers.onToggle());
    li.appendChild(toggle);
  }

  if (isDisabled) {
    dragHandle.hidden = true;
  }

  return { el: li, dragHandle };
}
