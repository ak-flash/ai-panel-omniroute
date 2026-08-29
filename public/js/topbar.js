/* ============================================================
   AI Panel — верхняя панель: индикатор статуса, время обновления,
   сворачивание меню на мобильных.
   ============================================================ */

import { $id } from './dom.js';

let $statusDot, $statusText, $updated, $collapse, $toggle;

function isMobile() {
  return window.innerWidth <= 600;
}

export function closeTopbar() {
  if ($collapse && $toggle) {
    $collapse.removeAttribute('data-open');
    if (isMobile()) {
      $collapse.setAttribute('aria-hidden', 'true');
    } else {
      $collapse.removeAttribute('aria-hidden');
    }
    $toggle.setAttribute('aria-expanded', 'false');
  }
}

export function initTopbar() {
  $statusDot = $id('status-dot');
  $statusText = $id('status-text');
  $updated = $id('updated');
  $collapse = $id('topbar-collapse');
  $toggle = $id('btn-topbar-toggle');
  if (!$collapse || !$toggle) return;

  $toggle.addEventListener('click', () => {
    const expanded = $toggle.getAttribute('aria-expanded') === 'true';
    if (expanded) {
      closeTopbar();
    } else {
      $collapse.setAttribute('data-open', '');
      $collapse.removeAttribute('aria-hidden');
      $toggle.setAttribute('aria-expanded', 'true');
    }
  });

  // Клик мимо открытого меню закрывает его
  document.addEventListener('click', (e) => {
    if ($toggle.getAttribute('aria-expanded') !== 'true') return;
    const bar = $toggle.closest('.topbar');
    if (bar && !bar.contains(e.target)) closeTopbar();
  });

  $collapse.querySelectorAll('.topnav a').forEach((a) => {
    a.addEventListener('click', closeTopbar);
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 600) closeTopbar();
  });
}

export function setStatus(type, text) {
  if (!$statusDot || !$statusText) return;
  $statusDot.className = 'dot ' + type;
  $statusText.textContent = text;
}

// Отметка времени в шапке — на любой странице после успешной загрузки
export function touchUpdated() {
  if ($updated) {
    $updated.textContent = new Date().toLocaleTimeString('ru', {
      hour12: false,
    });
    $updated.dateTime = new Date().toISOString();
    $updated.hidden = false;
  }
}
