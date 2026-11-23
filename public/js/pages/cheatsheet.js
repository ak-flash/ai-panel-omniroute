/* ============================================================
   AI Panel — страница «Шпаргалка»: копирование команд
   обновления Paseo и OpenCode, перезапуска службы.
   ============================================================ */

import { $id, on } from '../dom.js';
import { setStatus } from '../topbar.js';
import { start } from '../boot.js';

const $copyStatus = $id('copy-status');
let copyStatusTimeout;

async function copyCommand(commandId) {
  const cmd = $id(commandId)?.textContent?.trim();
  if (!cmd) return;
  clearTimeout(copyStatusTimeout);
  try {
    await navigator.clipboard.writeText(cmd);
    if ($copyStatus) $copyStatus.textContent = 'Скопировано!';
    copyStatusTimeout = setTimeout(() => {
      if ($copyStatus) $copyStatus.textContent = '';
    }, 2000);
  } catch {
    if ($copyStatus) $copyStatus.textContent = 'Не удалось скопировать';
  }
}

export async function init() {
  setStatus('ok', 'Готово');
}

for (const button of document.querySelectorAll('[data-copy-command]')) {
  on(button, 'click', () => copyCommand(button.getAttribute('data-copy-command')));
}

start();
