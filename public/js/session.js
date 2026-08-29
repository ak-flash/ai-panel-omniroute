/* ============================================================
   AI Panel — общее состояние приложения (без DOM).
   session хранит то, что нужно нескольким модулям: список
   провайдеров с сервера, выбранных провайдеров и каталог
   моделей. Страничное состояние (usage, combo, квоты) живёт
   в модулях страниц.
   ============================================================ */

// Текущая страница: index (Статистика) | combo | models | cheatsheet.
// Панель состоит из отдельных HTML-страниц с общими модулями.
export const PAGE = (document.body.dataset.page || 'index').toLowerCase();

// Провайдер по умолчанию — когда /api/config недоступен (режим file://).
// Список провайдеров и активный приходят с сервера (/api/config).
export const PROVIDER_FALLBACK = {
  id: 'xkiro',
  name: 'xKiro',
  site: 'https://xkiro.com/dashboard',
  hasKey: false,
};

export const session = {
  providers: [],                    // список с сервера (/api/config)
  activeProvider: PROVIDER_FALLBACK, // провайдер блока статистики
  modelsProvider: PROVIDER_FALLBACK, // провайдер каталога моделей
  models: [],                       // каталог моделей выбранного провайдера
  comboModelKeys: new Set(),        // norm id моделей, которые есть в любом Combo
  comboTargetIds: [],               // сырые id target'ов всех Combo (provider/model)
};
