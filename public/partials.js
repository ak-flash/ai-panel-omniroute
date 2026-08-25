'use strict';

/* ============================================================
   AI Panel — shared HTML partials (single source of truth)
   ============================================================ */

const _NAV = [
  { href: 'index.html', label: 'Статистика', page: 'index' },
  { href: 'combo.html', label: 'Маршруты', page: 'combo' },
  { href: 'models.html', label: 'Модели', page: 'models' },
  { href: 'manage.html', label: 'Управление', page: 'manage' },
];

const _STATUS_DEFAULTS = {
  index: 'Нужен ключ',
  combo: 'Загружаю…',
  models: 'Загружаю…',
  manage: 'Готово',
};

function topbarHTML(page) {
  const statusText = _STATUS_DEFAULTS[page] || '';
  const nav = _NAV.map((n) => {
    const cur = n.page === page ? ' aria-current="page"' : '';
    return `<a href="${n.href}"${cur}>${n.label}</a>`;
  }).join('\n    ');

  const refreshBtn = page === 'index'
    ? '\n    <button id="btn-refresh" class="btn" disabled title="Обновить сейчас"><span class="icon">⟳</span> Обновить</button>'
    : '';

  return `<header class="topbar">
  <div class="brand"><span class="logo" aria-hidden="true">◈</span> AI Панель</div>
  <div class="topbar-collapse" id="topbar-collapse">
    <nav class="topnav" aria-label="Разделы панели">
      ${nav}
    </nav>
    <div class="topbar-actions"><span id="status-dot" class="dot"></span><span id="status-text" class="status-label">${statusText}</span><span id="updated-wrap" class="updated"><time id="updated" hidden></time></span>${refreshBtn}
      <button id="btn-settings" class="btn btn-primary" aria-haspopup="dialog">⚙ Настройки</button>
    </div>
  </div>
  <div class="topbar-end">
    <button id="btn-topbar-toggle" class="topbar-toggle" aria-expanded="false" aria-controls="topbar-collapse" aria-label="Меню">☰</button>
  </div>
</header>`;
}

const _BANNER_HTML = `<div id="banner" class="banner" role="alert" hidden>
    <span id="banner-text"></span>
    <button id="banner-close" class="banner-close" aria-label="Закрыть">×</button>
  </div>`;

function bannerHTML() { return _BANNER_HTML; }

const _DIALOG_HTML = `<dialog id="dlg">
  <form method="dialog" class="dlg-form">
    <div class="dlg-header">
      <h2>Настройки</h2>
      <button type="submit" class="dlg-close" aria-label="Закрыть настройки" title="Закрыть">✕</button>
    </div>
    <div class="dlg-card">
      <div class="dlg-card-head">
        <span class="dlg-card-icon" aria-hidden="true">🔌</span>
        <div>
          <h3 class="dlg-card-title">Провайдер</h3>
          <p class="dlg-card-sub">API-ключи хранятся локально, обфусцированно</p>
        </div>
      </div>
      <label for="dlg-provider">Провайдер</label>
      <select id="dlg-provider" class="select"><option value="xkiro">xKiro</option></select>
      <label for="dlg-key">API-ключ</label>
      <div class="input-group">
        <input type="password" id="dlg-key" placeholder="sk-xt-…" autocomplete="off">
        <button type="button" id="dlg-toggle" class="btn btn-ghost" aria-label="Показать/скрыть ключ">👁</button>
      </div>
    </div>
    <div class="dlg-card">
      <div class="dlg-card-head">
        <span class="dlg-card-icon" aria-hidden="true">🔀</span>
        <div>
          <h3 class="dlg-card-title">OmniRoute (Combo)</h3>
          <p class="dlg-card-sub">Адрес и ключ Combo-панели</p>
        </div>
      </div>
      <label for="dlg-omni-url">URL</label>
      <input type="text" id="dlg-omni-url" placeholder="http://192.168.1.30:20128" autocomplete="off">
      <label for="dlg-omni-key">API Key</label>
      <input type="password" id="dlg-omni-key" placeholder="sk-…" autocomplete="off">
    </div>
    <div class="dlg-card">
      <div class="dlg-card-head">
        <span class="dlg-card-icon" aria-hidden="true">🏷️</span>
        <div>
          <h3 class="dlg-card-title">Сопоставление имён</h3>
          <p class="dlg-card-sub">ID из OmniRoute → отображаемое имя</p>
        </div>
        <button type="button" id="dlg-alias-add" class="btn btn-ghost dlg-card-action">+ Добавить</button>
      </div>
      <p class="hint" style="margin-top:0">Напр. <code>openai-compatible-chat-…</code> → <code>xKiro</code></p>
      <div id="dlg-aliases-list"></div>
    </div>
    <div id="dlg-result" class="dlg-result" role="status"></div>
    <div class="dlg-actions">
      <button type="button" id="dlg-save" class="btn btn-primary">Проверить и сохранить</button>
      <button type="button" id="dlg-remove" class="btn btn-danger">Удалить ключ</button>
      <button type="submit" class="btn">Закрыть</button>
    </div>
  </form>
</dialog>`;

function dialogHTML() { return _DIALOG_HTML; }

function liveRegionHTML() {
  return '<div aria-live="polite" class="visually-hidden" id="live"></div>';
}

/**
 * Inject all shared partials into placeholder elements.
 * Call once on DOMContentLoaded before app.js init.
 * @param {string} page — current page id (index|combo|models|manage)
 */
function injectPartials(page) {
  const topbar = document.getElementById('tpl-topbar');
  if (topbar) topbar.outerHTML = topbarHTML(page);

  const banner = document.getElementById('tpl-banner');
  if (banner) banner.outerHTML = bannerHTML();

  const dialog = document.getElementById('tpl-dialog');
  if (dialog) dialog.outerHTML = dialogHTML();

  const live = document.getElementById('tpl-live');
  if (live) live.outerHTML = liveRegionHTML();
}
