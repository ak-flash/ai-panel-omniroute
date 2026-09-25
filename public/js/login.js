/* ============================================================
   Страница входа (remote-режим): форма токена AIPANEL_AUTH_TOKEN.
   Маршруты /api/auth/* — публичные, сервер сессии сам не отдаёт.
   ============================================================ */

import { $id } from './dom.js';

const $form = $id('login-form');
const $token = $id('auth-token');
const $err = $id('login-error');
const $btn = $id('login-submit');
const next = new URLSearchParams(location.search).get('next') || '/';

async function status() {
  try {
    const r = await fetch('/api/auth/status');
    return await r.json();
  } catch {
    return { authEnabled: true, authenticated: false };
  }
}

async function redirectIfDone() {
  const s = await status();
  if (!s.authEnabled || s.authenticated) {
    location.replace(next);
    return true;
  }
  return false;
}

async function start() {
  document.body.classList.remove('is-booting');
  if (await redirectIfDone()) return;
  $form.addEventListener('submit', onSubmit);
}

async function onSubmit(event) {
  event.preventDefault();
  $err.hidden = true;
  $btn.disabled = true;
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: $token.value }),
    });
    if (r.ok) {
      location.replace(next);
      return;
    }
    const j = await r.json().catch(() => ({}));
    $err.textContent = (j && j.message) || 'Неверный токен доступа';
    $err.hidden = false;
  } catch {
    $err.textContent = 'Нет доступа к серверу — проверьте, что панель запущена';
    $err.hidden = false;
  } finally {
    $btn.disabled = false;
  }
}

start();
