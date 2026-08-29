/* ============================================================
   AI Panel — запуск страницы.

   Порядок:
     1. injectPartials — шапка, баннер, диалог, live-регион;
     2. initTopbar / initBanner / initSettingsDialog;
     3. динамический импорт модуля текущей страницы (js/pages/…);
     4. boot: загрузка хранилища и /api/config в session → page.init().

   Класс is-booting на body скрывает контент до готовности данных,
   чтобы не мигать пустыми карточками.
   ============================================================ */

import { PAGE, session, PROVIDER_FALLBACK } from './session.js';
import { injectPartials } from '../partials.js';
import { initTopbar } from './topbar.js';
import { initBanner, showBanner } from './banner.js';
import { initSettingsDialog } from './dialog.js';
import { loadVault, loadAppConfig, vaultGet } from './settings.js';
import { onEvent } from './events.js';

const KNOWN_PAGES = ['index', 'combo', 'models', 'cheatsheet'];

let currentInit = null;
let started = false;

/** Повторная инициализация страницы (после смены настроек). */
export async function rebootPage() {
  if (!currentInit) return;
  const dlg = document.getElementById('dlg');
  // Пока открыт диалог настроек — не прячем страницу (visibility:hidden
  // делал бы диалог некликабельным на время загрузки данных).
  const hide = !dlg || !dlg.open;
  if (hide) document.body.classList.add('is-booting');
  try {
    await currentInit();
  } finally {
    document.body.classList.remove('is-booting');
  }
}

export async function start() {
  if (started) return; // защита от повторного запуска
  started = true;

  injectPartials(PAGE);
  initTopbar();
  initBanner();
  initSettingsDialog();

  // Сохранение настроек в диалоге → перерисовать страницу
  onEvent('settings:changed', () => { rebootPage(); });

  if (!KNOWN_PAGES.includes(PAGE)) {
    console.error('Неизвестная страница «' + PAGE + '» — модуль не загружен');
    document.body.classList.remove('is-booting');
    return;
  }

  let page;
  try {
    page = await import('./pages/' + PAGE + '.js');
  } catch (err) {
    console.error('Не удалось загрузить модуль страницы «' + PAGE + '»:', err);
    document.body.classList.remove('is-booting');
    return;
  }
  currentInit = page.init;
  await boot();
}

async function boot() {
  await loadVault();
  if (location.protocol !== 'file:') {
    const cfg = await loadAppConfig();
    if (cfg) {
      session.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
      // Провайдер статистики: сохранённый выбор → активный от сервера → первый
      let savedStatsProviderId = '';
      try { savedStatsProviderId = vaultGet('statsProvider') || ''; } catch { /* нет хранилища */ }
      session.activeProvider =
        session.providers.find((p) => p.id === savedStatsProviderId) ||
        session.providers.find((p) => p.id === cfg.activeProvider) ||
        session.providers[0] ||
        PROVIDER_FALLBACK;
    } else {
      // Раньше ошибка загрузки конфигурации глоталась молча — показываем баннер
      showBanner('Нет доступа к панели — запустите node server.js');
    }
  }
  // Провайдер каталога на странице «Модели»: сохранённый или активный
  let savedModelsProviderId = '';
  try { savedModelsProviderId = vaultGet('modelsProvider') || ''; } catch { /* нет хранилища */ }
  session.modelsProvider =
    session.providers.find((p) => p.id === savedModelsProviderId) ||
    session.activeProvider;
  try {
    await currentInit();
  } finally {
    document.body.classList.remove('is-booting');
  }
}
