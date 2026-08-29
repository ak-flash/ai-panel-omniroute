/* ============================================================
   AI Panel — shared HTML partials (single source of truth)
   ES-модуль: импортирует icon() из icons.js и экспортирует
   injectPartials() для boot.js.
   ============================================================ */

import { icon } from './icons.js';

const _NAV = [
  { href: 'index.html', label: 'Статистика', page: 'index', icon: 'bar-chart' },
  { href: 'combo.html', label: 'Маршруты', page: 'combo', icon: 'arrows-right-left' },
  { href: 'models.html', label: 'Модели', page: 'models', icon: 'brain' },
  { href: 'cheatsheet.html', label: 'Шпаргалка', page: 'cheatsheet', icon: 'clipboard-document-list' },
];

const _STATUS_DEFAULTS = {
  index: 'Нужен ключ',
  combo: 'Загружаю…',
  models: 'Загружаю…',
  cheatsheet: 'Готово',
};

export function topbarHTML(page) {
  const statusText = _STATUS_DEFAULTS[page] || '';
  const nav = _NAV.map((n) => {
    const cur = n.page === page ? ' aria-current="page"' : '';
    return `<a href="${n.href}"${cur}><span class="icon" aria-hidden="true">${icon(n.icon)}</span> ${n.label}</a>`;
  }).join('\n    ');

  const refreshBtn = page === 'index'
    ? '\n    <button id="btn-refresh" class="btn" disabled title="Обновить сейчас"><span class="icon">' + icon('arrow-path') + '</span> Обновить</button>'
    : '';

  return `<header class="topbar">
  <div class="brand"><span class="logo" aria-hidden="true">${icon('sparkles')}</span> AI Панель</div>
  <div class="topbar-collapse" id="topbar-collapse">
    <nav class="topnav" aria-label="Разделы панели">
      ${nav}
    </nav>
    <div class="topbar-actions"><span id="status-dot" class="dot"></span><span id="status-text" class="status-label">${statusText}</span><span id="updated-wrap" class="updated"><time id="updated" hidden></time></span>${refreshBtn}
      <button id="btn-theme" class="btn" aria-label="Переключить тему" title="Переключить тему">${icon('moon')}</button>
      <button id="btn-settings" class="btn btn-primary" aria-haspopup="dialog">${icon('cog')} Настройки</button>
    </div>
  </div>
  <div class="topbar-end">
    <button id="btn-topbar-toggle" class="topbar-toggle" aria-expanded="false" aria-controls="topbar-collapse" aria-label="Меню">${icon('bars-3')}</button>
  </div>
</header>`;
}

const _BANNER_HTML = `<div id="banner" class="banner" role="alert" hidden>
    <span id="banner-text"></span>
    <button id="banner-close" class="banner-close" aria-label="Закрыть">${icon('x-mark')}</button>
  </div>`;

export function bannerHTML() { return _BANNER_HTML; }

const _DIALOG_HTML = `<dialog id="dlg">
  <form method="dialog" class="dlg-form">
    <div class="dlg-header">
      <h2>Настройки</h2>
      <button type="submit" class="dlg-close" aria-label="Закрыть настройки" title="Закрыть">${icon('x-mark')}</button>
    </div>
    <div class="dlg-card">
      <div class="dlg-card-head">
        <span class="dlg-card-icon" aria-hidden="true">${icon('plug')}</span>
        <div>
          <h3 class="dlg-card-title">Провайдер</h3>
          <p class="dlg-card-sub">Хранятся на сервере в зашифрованном виде (SQLite + AES-256-GCM)</p>
        </div>
      </div>
      <label for="dlg-provider">Провайдер</label>
      <select id="dlg-provider" class="select">
        <option value="xkiro">xKiro</option>
        <option value="agentrouter">AgentRouter</option>
        <option value="antigravity">Antigravity</option>
      </select>
      <!-- Поля ключа xKiro -->
      <div id="dlg-xkiro-fields">
        <label for="dlg-key">API-ключ</label>
        <div class="input-group">
          <input type="password" id="dlg-key" placeholder="sk-xt-…" autocomplete="off">
              <button type="button" id="dlg-toggle" class="btn btn-ghost" aria-label="Показать/скрыть ключ">${icon('eye')}</button>
        </div>
      </div>
      <!-- Поля AgentRouter: access-токен + числовой ID в одной строке -->
      <div id="dlg-agentrouter-fields" hidden>
        <div class="dlg-ar-row">
          <div class="dlg-ar-token">
            <label for="dlg-agentrouter-key">Access-токен</label>
            <div class="input-group">
              <input type="password" id="dlg-agentrouter-key" placeholder="Токен из Security Settings" autocomplete="off">
              <button type="button" id="dlg-agentrouter-toggle" class="btn btn-ghost" aria-label="Показать/скрыть токен">${icon('eye')}</button>
            </div>
          </div>
          <div class="dlg-ar-user">
            <label for="dlg-agentrouter-user">User ID</label>
            <input type="text" id="dlg-agentrouter-user" inputmode="numeric" placeholder="49521" autocomplete="off">
          </div>
        </div>
        <p class="hint">
          agentrouter.org → аватар → Security Settings → System Access Token →
          Generate; числовой ID — из профиля (New-Api-User).
          API-ключ (sk-…) не подходит: сайт принимает только access-токен.
        </p>
      </div>
      <!-- Поля Antigravity (Google AI Pro): вход через Google + вставка ссылки -->
      <div id="dlg-ag-fields" hidden>
        <div class="dlg-ag-login-line">
          <button type="button" id="dlg-ag-login" class="btn btn-primary">Войти через Google</button>
          <p class="hint">
            В открывшейся вкладке войдите в аккаунт. Браузер перейдёт на адрес вида
            <code>http://127.0.0.1:…/callback?code=…</code>.
            Скопируйте адрес целиком из адресной строки и вставьте ниже.
          </p>
        </div>
        <label for="dlg-ag-paste">Ссылка после входа</label>
        <div class="input-group">
          <input type="text" id="dlg-ag-paste" placeholder="http://127.0.0.1:…/callback?code=…" autocomplete="off">
          <button type="button" id="dlg-ag-paste-btn" class="btn">Применить</button>
        </div>
        <p class="hint" id="dlg-ag-login-status" aria-live="polite"></p>
        <p class="hint" id="dlg-ag-exp" hidden></p>
      </div>
    </div>
    <div class="dlg-card">
      <div class="dlg-card-head">
        <span class="dlg-card-icon" aria-hidden="true">${icon('arrows-right-left')}</span>
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
        <span class="dlg-card-icon" aria-hidden="true">${icon('tag')}</span>
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

export function dialogHTML() { return _DIALOG_HTML; }

export function liveRegionHTML() {
  return '<div aria-live="polite" class="visually-hidden" id="live"></div>';
}

/**
 * Inject all shared partials into placeholder elements.
 * Call once on boot before page init.
 * @param {string} page — current page id (index|combo|models|cheatsheet)
 */
export function initTheme() {
  function apply(t) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    var btn = document.getElementById('btn-theme');
    if (btn) {
      var isDark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      btn.innerHTML = isDark ? icon('sun') : icon('moon');
      btn.title = isDark ? 'Светлая тема' : 'Тёмная тема';
      btn.setAttribute('aria-label', btn.title);
    }
  }
  try {
    var saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') apply(saved);
    else apply(null);
  } catch(e) { apply(null); }
  document.addEventListener('click', function(e) {
    var b = e.target.closest('#btn-theme');
    if (!b) return;
    var cur = document.documentElement.getAttribute('data-theme');
    if (!cur) cur = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    var next = cur === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('theme', next); } catch(e2) {}
    apply(next);
  });
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
      try { if (!localStorage.getItem('theme')) apply(null); } catch(e) {}
    });
  } catch(e) {}
}

export function injectPartials(page) {
  const topbar = document.getElementById('tpl-topbar');
  if (topbar) topbar.outerHTML = topbarHTML(page);

  const banner = document.getElementById('tpl-banner');
  if (banner) banner.outerHTML = bannerHTML();

  const dialog = document.getElementById('tpl-dialog');
  if (dialog) dialog.outerHTML = dialogHTML();

  const live = document.getElementById('tpl-live');
  if (live) live.outerHTML = liveRegionHTML();
  initTheme();
}
