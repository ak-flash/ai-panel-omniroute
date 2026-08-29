/* ============================================================
   AI Panel — минимальная шина событий (pub/sub) вместо
   глобальных связей между диалогом настроек, boot и страницами:
     'settings:changed'      — настройки сохранены, страницу
                               нужно перерисовать (boot.js);
     'antigravity:authorized' — привязка Google выполнена,
                               страница может перезагрузить квоты.
   emit() дожидается обработчиков и возвращает их результаты —
   это нужно диалогу, чтобы показать итог привязки Antigravity.
   ============================================================ */

const listeners = new Map();

export function onEvent(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name).delete(fn);
}

export async function emit(name, payload) {
  const fns = listeners.get(name);
  if (!fns || !fns.size) return [];
  return Promise.all(
    [...fns].map((fn) =>
      Promise.resolve()
        .then(() => fn(payload))
        .catch((e) => {
          console.error('[events] обработчик «' + name + '» упал:', e);
          return null;
        }),
    ),
  );
}
