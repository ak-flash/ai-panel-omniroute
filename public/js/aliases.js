/* ============================================================
   AI Panel — сопоставление имён (алиасы провайдеров OmniRoute).
   Хранится как JSON-массив пар [id, name] под одним ключом
   'aliases' серверного хранилища. Рендер и сбор строк — часть
   диалога настроек.
   ============================================================ */

import { $id } from './dom.js';
import { icon } from '../icons.js';
import { vaultGet, vaultSet } from './settings.js';

export function loadAliases() {
  try {
    const raw = (vaultGet('aliases') || '');
    const arr = raw ? JSON.parse(raw) : [];
    const map = {};
    if (Array.isArray(arr)) for (const [id, name] of arr) if (id && name) map[id] = name;
    return map;
  } catch { return {}; }
}

export function saveAliasesMap(map) {
  try {
    const arr = Object.entries(map).filter(([id, name]) => id && name);
    vaultSet('aliases', JSON.stringify(arr));
  } catch { /* JSON.stringify не должен падать на простых значениях */ }
}

// Рендер списка alias-строк в #dlg-aliases-list
export function renderAliasRows() {
  const list = $id('dlg-aliases-list');
  if (!list) return;
  const map = loadAliases();
  list.replaceChildren();
  const entries = Object.entries(map);
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.style.marginTop = '0';
    empty.textContent = 'Пока нет сопоставлений.';
    list.appendChild(empty);
    return;
  }
  for (const [id, name] of entries) {
    const row = document.createElement('div');
    row.className = 'alias-row';
    const inId = document.createElement('input');
    inId.type = 'text';
    inId.placeholder = 'ID из OmniRoute';
    inId.value = id;
    inId.dataset.aliasId = id;
    const inName = document.createElement('input');
    inName.type = 'text';
    inName.placeholder = 'Имя';
    inName.value = name;
    inName.dataset.aliasId = id;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-ghost';
    del.innerHTML = icon('x-mark');
    del.setAttribute('aria-label', 'Удалить');
    del.addEventListener('click', () => {
      const m = loadAliases();
      delete m[id];
      saveAliasesMap(m);
      renderAliasRows();
    });
    row.append(inId, inName, del);
    list.appendChild(row);
  }
}

// Собирает map из текущих строк ввода (с учётом несохранённых правок)
export function collectAliasesFromUI() {
  const list = $id('dlg-aliases-list');
  const map = {};
  if (!list) return map;
  list.querySelectorAll('.alias-row').forEach((row) => {
    const inputs = row.querySelectorAll('input');
    if (inputs.length < 2) return;
    const id = (inputs[0].value || '').trim();
    const name = (inputs[1].value || '').trim();
    if (id && name) map[id] = name;
  });
  return map;
}
