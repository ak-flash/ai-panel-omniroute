/* ============================================================
   AI Panel — страница «Шпаргалка»: копирование команды
   обновления opencode.
   ============================================================ */

import { $id, on } from '../dom.js';
import { setStatus } from '../topbar.js';
import { start } from '../boot.js';

const $btnCopy = $id('btn-copy-cmd');
const $copyStatus = $id('copy-status');
const $cmdText = $id('manage-cmd-text');

async function copyCommand() {
  const cmd = $cmdText ? $cmdText.textContent : 'opencode upgrade';
  try {
    await navigator.clipboard.writeText(cmd);
    if ($copyStatus) $copyStatus.textContent = 'Скопировано!';
    setTimeout(() => { if ($copyStatus) $copyStatus.textContent = ''; }, 2000);
  } catch {
    if ($copyStatus) $copyStatus.textContent = 'Не удалось скопировать';
  }
}

export async function init() {
  setStatus('ok', 'Готово');
}

on($btnCopy, 'click', copyCommand);

start();
