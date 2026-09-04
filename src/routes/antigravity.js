'use strict';

// ============================================================
// Маршруты Antigravity: OAuth (start/callback/paste), учётные
// данные Google и квоты. Вся логика — в src/antigravity-service.js.
// ============================================================

const { AppError, readJson, sendJson } = require('../http');

/** Страница-подсказка callback: код остаётся в адресной строке. */
const page = (title, msg) =>
  '<html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
  title + '</title><body style="font-family:system-ui,sans-serif;text-align:center;padding:40px 16px"><h2 style="margin-top:0">' +
  title + '</h2><p style="max-width:36em;margin:0 auto;line-height:1.5">' + msg + '</p></body></html>';

function registerAntigravityRoutes(router, { service, googleOauth, defaultPort = '8765' }) {
  // Единственный flow: пользователь входит в Google, браузер уходит на
  // loopback-redirect_uri, пользователь копирует адрес из адресной строки
  // и применяет через POST /api/antigravity-auth/paste.
  router.add(['GET'], '/api/antigravity-auth/start', ({ req, res }) => {
    const host = req.headers.host || '';
    const hostPort = host.match(/:(\d+)$/);
    const listenPort = hostPort ? hostPort[1] : String(defaultPort);
    const hostname = hostPort ? host.slice(0, -hostPort[0].length) : host;
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(hostname);
    // Локально: callback придёт на эту же панель → покажем страницу-подсказку.
    // Удалённо: редирект на произвольный loopback-порт, где у пользователя
    // скорее всего никто не слушает. Иначе браузер попадает на локальный
    // сервер панели (если он запущен на том же порту), и его страница
    // закрывает окно раньше, чем адрес будет скопирован. При connection
    // refused адрес остаётся в адресной строке — его и копируем.
    const redirectUri = isLocal
      ? 'http://127.0.0.1:' + listenPort + '/api/antigravity-auth/callback'
      : 'http://127.0.0.1:44127/callback';
    const state = service.issueState();
    return sendJson(res, 200, { url: googleOauth.buildAuthUrl({ redirectUri, state }) }, { 'cache-control': 'no-store' });
  });

  // Страница-подсказка после входа в Google: код остаётся в адресе,
  // пользователь копирует адрес из адресной строки и вставляет в панель.
  // Без обмена кода, без проверки state и без авто-закрытия.
  router.add(['GET', 'HEAD'], '/api/antigravity-auth/callback', ({ res, url }) => {
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (error) {
      return res.end(page('Авторизация не выполнена', 'Google вернул ошибку: ' + String(error).replace(/[^\w.-]/g, '') + '. Закройте это окно и попробуйте ещё раз.'));
    }
    if (!code) {
      return res.end(page('AI Панель', 'Это служебная страница: сюда браузер попадает после входа через Google. Если вы здесь случайно — просто закройте её.'));
    }
    return res.end(page('Остался один шаг', 'Скопируйте адрес этой страницы из адресной строки браузера (начинается с <b>http://127.0.0.1</b> и содержит <b>code=</b>) и вставьте его в поле «Ссылка после входа» в настройках панели. Потом окно можно закрыть.'));
  });

  // Основной flow: пользователь вставляет ссылку, на которую ушёл браузер
  // после входа в Google (loopback-redirect). Код привязан к redirect_uri
  // из этой ссылки — обмен выполняем с тем же origin+path.
  router.add(['POST'], '/api/antigravity-auth/paste', async ({ req, res }) => {
    const body = await readJson(req);
    let pasted = '';
    try { pasted = new URL(String(body.url || '').trim()); } catch {}
    const code = pasted ? pasted.searchParams.get('code') : null;
    const state = pasted ? pasted.searchParams.get('state') : null;
    if (!pasted || !code) throw new AppError(400, 'bad_callback_url', 'Нужна ссылка вида http://127.0.0.1:…/callback?code=…');
    service.consumeState(state);
    pasted.hash = '';
    pasted.searchParams.delete('hash');
    const redirectUri = pasted.origin + pasted.pathname;
    const result = await service.exchangeCallback({ code, redirectUri });
    return sendJson(res, 200, result, { 'cache-control': 'no-store' });
  });

  // Учётные данные Google: статус / частичное обновление / сброс
  router.add(['GET', 'POST', 'DELETE'], '/api/settings/google-token', async ({ req, res }) => {
    if (req.method === 'GET') {
      return sendJson(res, 200, service.status(), { 'cache-control': 'no-store' });
    }
    if (req.method === 'DELETE') {
      await service.clearCredentials();
      return sendJson(res, 200, { ok: true, hasToken: false, hasRefresh: false }, { 'cache-control': 'no-store' });
    }
    const body = await readJson(req);
    await service.applyCredentials(body);
    const status = service.status();
    return sendJson(res, 200, { ok: true, hasToken: status.hasToken, hasRefresh: status.hasRefresh }, { 'cache-control': 'no-store' });
  });

  router.add(['GET'], '/api/antigravity-quota', async ({ res, url }) => {
    // project: приоритет у query-параметра клиента, иначе сохранённое значение
    const project = (url.searchParams.get('project') || '').trim() || service.getProject();
    const result = await service.getQuota(project);
    return sendJson(res, result.status, result.data, { 'cache-control': 'no-store' });
  });
}

module.exports = { registerAntigravityRoutes };
