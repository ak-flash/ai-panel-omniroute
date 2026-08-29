// AI Панель — прокси без секретов из env (ключи в localStorage).
if (typeof globalThis.fetch === 'undefined') { console.error('Node 18+ is required'); process.exit(1); }
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function loadEnvFile(fileName){
  const filePath=path.join(__dirname,fileName);
  if(!fs.existsSync(filePath)) return;
  for(const rawLine of fs.readFileSync(filePath,'utf8').split(/\r?\n/)){
    const line=rawLine.trim(); if(!line||line.startsWith('#')) continue;
    const eq=line.indexOf('='); if(eq===-1) continue;
    const name=line.slice(0,eq).trim().replace(/^export\s+/,''); if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value=line.slice(eq+1).trim();
    const q=(value.startsWith('"')&&value.endsWith('"')&&value.length>=2)||(value.startsWith("'")&&value.endsWith("'")&&value.length>=2);
    if(q) value=value.slice(1,-1); else{ const h=value.indexOf(' #'); if(h!==-1) value=value.slice(0,h).trim(); }
    if(!(name in process.env)) process.env[name]=value;
  }
}
const { loadProviders } = require('./providers');
const { createAntigravityProvider } = require('./providers/antigravity');
const { createGoogleOauth, getBuiltinClientId, getBuiltinClientSecret } = require('./providers/google-oauth');
const { createStore } = require('./store');
const {
  AppError,
  createRequestContext,
  handleError,
  readBody,
  readJson,
  sendError,
  sendJson,
  sendNoContent,
} = require('./http');
const { Router } = require('./router');
const {
  applyRequestSecurity,
  getServerConfig,
  parseAllowedOrigins,
  validateMasterKey,
  validateUpstreamUrl,
} = require('./security');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Поле серверного хранилища с ключом провайдера (клиент секреты не
// хранит): hasKey в /api/config и фолбэк ключа для
// /api/providers/<id>/usage, если клиент не прислал x-api-key.
// PROVIDER_STORE_USER_FIELDS — то же для доп. полей авторизации
// (у AgentRouter это числовой ID пользователя для New-Api-User).
const PROVIDER_STORE_KEYS = { xkiro: 'xkiroKey', agentrouter: 'agentrouterKey' };
const PROVIDER_STORE_USER_FIELDS = { agentrouter: 'agentrouterUserId' };
// Ключ ежедневного снимка баланса AgentRouter в хранилище. храним JSON
// { date: 'YYYY-MM-DD', balance_usd } — только последний (больше суток не нужно).
const AGENTROUTER_DAY_BALANCE_KEY = 'agentrouterDayBalance';

const MIME = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8' };
const CORS = {};
function resolveStaticPath(pathname){ const relative=pathname==='/'?'index.html':pathname.slice(1); let decoded; try{decoded=decodeURIComponent(relative)}catch{return null} const resolved=path.normalize(path.join(PUBLIC_DIR,decoded)); if(resolved!==PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR+path.sep)) return null; return resolved; }
function serveStatic(req,res,pathname){ const filePath=resolveStaticPath(pathname); if(!filePath){res.writeHead(403,{'content-type':'text/plain; charset=utf-8'});return res.end('403 Forbidden')} fs.stat(filePath,(err,stats)=>{ if(err||!stats.isFile()){res.writeHead(404,{'content-type':'text/plain; charset=utf-8'});return res.end('404 Not Found')} const ext=path.extname(filePath).toLowerCase(); const mime=MIME[ext]||'application/octet-stream'; res.writeHead(200,{'content-type':mime,'cache-control':ext==='.html'?'no-store':'max-age=3600'}); const s=fs.createReadStream(filePath); s.on('error',()=>res.destroy()); s.pipe(res); });}

async function handleProxy(req,res,url,{prefix,upstream}){
  if(req.method==='OPTIONS') return sendNoContent(res);
  const body=await readBody(req);
  const suffix=url.pathname.replace(new RegExp('^'+prefix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),'')+url.search;
  const target=upstream+suffix;
  const fwdHeaders={};
  for(const name of ['authorization','x-api-key','content-type','accept']) if(req.headers[name]) fwdHeaders[name]=req.headers[name];
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),30000);
  res.on('close',()=>controller.abort());
  try{
    const upstreamRes=await fetch(target,{method:req.method,headers:fwdHeaders,body:body.length>0?body:undefined,signal:controller.signal,redirect:'error'});
    const responseHeaders={};
    const contentType=upstreamRes.headers.get('content-type');
    if(contentType) responseHeaders['content-type']=contentType;
    res.writeHead(upstreamRes.status,responseHeaders);
    if(upstreamRes.body) for await(const chunk of upstreamRes.body){if(!res.writable) break;res.write(chunk)}
    res.end();
  }catch(error){
    if(res.headersSent) return res.destroy();
    throw new AppError(502,'proxy_error','Upstream недоступен',{cause:error});
  }finally{
    clearTimeout(timeout);
  }
}
// createApp собирает HTTP-сервер панели с переданным списком провайдеров
// (по умолчанию — вшитые из loadProviders()). Тесты инжектят сюда
// адаптеры с mock-upstream; CLI-блок ниже запускает то же самое на PORT.
function createApp({ providers = loadProviders(), antigravity = createAntigravityProvider(), googleOauth = createGoogleOauth(), store, allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS), remoteMode = false, logger = console, requestTimeoutMs = 30000 } = {}){
  const activeProvider = providers[0] || null;
  // Хранилище ключей/настроек: SQLite на сервере (зашифровано AES-256-GCM).
  // Если не передано (CLI/тесты передают напрямую), создаётся лениво —
  // обработчики запросов async, поэтому await в них безопасен.
  if (!store) store = createStore({});
  // createStore — async, пока это Promise. Нормализуем лениво в обработчиках.
  async function getStore(){ if(store && typeof store.then==='function') store = await store; return store; }
  let agLoaded = false; // refresh-связка из хранилища загружается один раз
  // Google OAuth antigravity. Access-токен живёт в памяти процесса; refresh-
  // связка и project_id — в серверном хранилище (SQLite, зашифровано) и
  // загружаются в память при старте (loadAgFromStore), поэтому перезапуск
  // сервера не сбрасывает вход: сервер сам обновит access-токен по связке.
  const googleAuth = { token: '', refreshToken: '', clientId: '', clientSecret: '', project: '', tokenExpiresAt: 0, email: '' };
  let agCache = { ts: 0, result: null, project: null }; // серверный кеш квот, 60 с
  const AG_CACHE_TTL_MS = 60000;
  const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
  const oauthStates = new Map();
  const router = new Router();
  router.add(['GET','HEAD'],'/api/health',({res})=>sendJson(res,200,{ok:true},{'cache-control':'no-store'}));

  /** Сохраняет токены после успешного обмена кода (paste) или refresh. */
  function storeExchangedTokens(r) {
    googleAuth.token = r.accessToken;
    googleAuth.tokenExpiresAt = r.expiresIn ? Date.now() + r.expiresIn * 1000 : 0;
    if (r.refreshToken) googleAuth.refreshToken = r.refreshToken;
    googleAuth.clientId = getBuiltinClientId();
    googleAuth.clientSecret = getBuiltinClientSecret();
    agCache = { ts: 0, result: null, project: null };
  }

  const hasRefreshCreds = () =>
    Boolean(googleAuth.refreshToken && googleAuth.clientId && googleAuth.clientSecret);

  /** Применяет сохранённые Antigravity-данные к состоянию в памяти. */
  function syncAgFromStore(entries = []) {
    for (const [k, v] of entries) {
      if (k === 'agRefreshToken') googleAuth.refreshToken = String(v || '');
      if (k === 'agProject') googleAuth.project = String(v || '');
      if (k === 'agEmail') googleAuth.email = String(v || '');
    }
    if (googleAuth.refreshToken) {
      googleAuth.clientId = getBuiltinClientId();
      googleAuth.clientSecret = getBuiltinClientSecret();
    }
    agCache = { ts: 0, result: null, project: null };
  }

  /** Загружает сохранённую Antigravity refresh-связку при старте. */
  async function loadAgFromStore() {
    try {
      if(googleAuth.refreshToken) return; // уже установлено через POST/paste
      const s = await (await getStore()).snapshot();
      if(s.agRefreshToken) syncAgFromStore([['agRefreshToken', s.agRefreshToken]]);
      if(s.agProject) syncAgFromStore([['agProject', s.agProject]]);
      if(s.agEmail) syncAgFromStore([['agEmail', s.agEmail]]);
    } catch {}
  }

  /** Обновляет access-token по refresh-связке. Возвращает true при успехе. */
  async function refreshGoogleToken() {
    if (!hasRefreshCreds()) return false;
    const r = await googleOauth.refresh({
      refreshToken: googleAuth.refreshToken,
      clientId: googleAuth.clientId,
      clientSecret: googleAuth.clientSecret,
    });
    if (r.ok) {
      googleAuth.token = r.accessToken;
      googleAuth.tokenExpiresAt = r.expiresIn ? Date.now() + r.expiresIn * 1000 : 0;
      agCache = { ts: 0, result: null, project: null };
      return true;
    }
    if (r.error === 'invalid_grant') {
      // Refresh-токен отозван — связка больше не поможет
      googleAuth.token = '';
    }
    return false;
  }

  // ---------- Ежедневный снимок баланса AgentRouter ----------
  // Раз в сутки (как только наступили новые сутки, ~00:00) делаем
  // запрос баланса ключом из хранилища и сохраняем его как стартовый
  // баланс дня. Карточка вычитает из него текущий баланс и показывает
  // «потребление за сутки». Храним только последний снимок — при смене
  // суток он перезаписывается, больше дня в БД не держим.
  const todayStr = () => {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + String(d.getDate()).padStart(2, '0');
  };

  async function snapshotAgentRouterDayBalance() {
    try {
      const s = await (await getStore()).snapshot();
      const key = String(s[PROVIDER_STORE_KEYS.agentrouter] || '').trim();
      const uid = String(s[PROVIDER_STORE_USER_FIELDS.agentrouter] || '').trim();
      const provider = providers.find((p) => p.id === 'agentrouter');
      if (!key || !uid || !provider) return;
      const result = await provider.getUsage(key, uid);
      if (result.status !== 200) return;
      const bal = Number((result.data && result.data.wallet || {}).balance_usd);
      if (!Number.isFinite(bal)) return;
      await (await getStore()).set(
        AGENTROUTER_DAY_BALANCE_KEY,
        JSON.stringify({ date: todayStr(), balance_usd: bal }),
      );
    } catch {}
  }

  /**
   * Планировщик снимка: проверяет раз в минуту, не сменились ли сутки,
   * и если для сегодняшнего дня снимка ещё нет — делает его (один раз).
   * Реальный снимок берётся в 00:00; перезапуск сервера днём не
   * переснимает баланс. Возвращает функцию остановки интервала.
   */
  function startDailyAgentRouterTracker() {
    let busy = false;
    const interval = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const s = await (await getStore()).snapshot();
        const saved = s[AGENTROUTER_DAY_BALANCE_KEY];
        let savedDate = null;
        if (saved) { try { savedDate = JSON.parse(saved).date; } catch {} }
        if (savedDate !== todayStr()) await snapshotAgentRouterDayBalance();
      } catch {} finally {
        busy = false;
      }
    }, 60000);
    snapshotAgentRouterDayBalance();
    return () => clearInterval(interval);
  }

  /** Достаёт снимок баланса дня для карточки AgentRouter (если он за сегодня). */
  async function getAgentRouterDayBalanceUsd() {
    try {
      const s = await (await getStore()).snapshot();
      const saved = s[AGENTROUTER_DAY_BALANCE_KEY];
      if (!saved) return null;
      const parsed = JSON.parse(saved);
      if (parsed.date !== todayStr()) return null;
      const bal = Number(parsed.balance_usd);
      return Number.isFinite(bal) ? bal : null;
    } catch {
      return null;
    }
  }

  async function handleRequest(req,res){
    if(!applyRequestSecurity(req,res,allowedOrigins)) return;
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/api/health') return router.dispatch(req,res,{});
    if(url.pathname==='/proxy'||url.pathname.startsWith('/proxy/')){
      if(!activeProvider){res.writeHead(503,{...CORS,'content-type':'application/json; charset=utf-8'});return res.end(JSON.stringify({error:'no_provider',message:'Провайдер не настроен'}))}
      let provider=activeProvider; let prefix='/proxy'; const m=url.pathname.match(/^\/proxy\/([a-z0-9-]+)(?:\/|$)/); if(m&&providers.some(p=>p.id===m[1])){provider=providers.find(p=>p.id===m[1]); prefix='/proxy/'+m[1]}
      return handleProxy(req,res,url,{prefix,upstream:provider.upstream});
    }
    const apiMatch=url.pathname.match(/^\/api\/providers\/([a-z0-9-]+)\/(usage|models)$/);
    if(apiMatch){
      if(req.method==='OPTIONS'){res.writeHead(204,{...CORS});return res.end()}
      const provider=providers.find(p=>p.id===apiMatch[1]); if(!provider){res.writeHead(404,{...CORS,'content-type':'application/json; charset=utf-8'});return res.end(JSON.stringify({error:'unknown_provider',message:'Провайдер не найден'}))}
      let clientKey=req.headers['x-api-key']||''; let clientUserId=req.headers['x-agentrouter-user-id']||''; if(!clientKey||!clientUserId){ try{ const s=await (await getStore()).snapshot(); const storeField=PROVIDER_STORE_KEYS[apiMatch[1]]; if(!clientKey&&storeField&&s[storeField]) clientKey=s[storeField]; const userField=PROVIDER_STORE_USER_FIELDS[apiMatch[1]]; if(!clientUserId&&userField&&s[userField]) clientUserId=s[userField]; }catch{} }       const fn=apiMatch[2]==='usage'?provider.getUsage:provider.getModels; const result=await fn(clientKey,clientUserId);
      if(result.status===200 && apiMatch[1]==='agentrouter' && result.data){
        const dayBal=await getAgentRouterDayBalanceUsd();
        if(dayBal!==null) result.data.day_balance_usd=dayBal;
      }
      res.writeHead(result.status,{...CORS,'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); return res.end(JSON.stringify(result.data));
    }
    if(url.pathname==='/omniroute'||url.pathname.startsWith('/omniroute/')){
      const s=await (await getStore()).snapshot();
      const omniUrl=String(s.omniUrl||'').trim();
      if(!omniUrl){ res.writeHead(400,{...CORS,'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:'no_omniroute_url',message:'Укажите OmniRoute URL в Настройках'})); }
      let upstream;
      try{ upstream=await validateUpstreamUrl(omniUrl,{allowPrivate:!remoteMode}); }
      catch{ res.writeHead(400,{...CORS,'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:'invalid_omniroute_url',message:'Некорректный или запрещённый OmniRoute URL'})); }
      const headers={...req.headers};
      if(s.omniKey) headers.authorization='Bearer '+s.omniKey;
      delete headers['x-omniroute-url'];
      req.headers=headers;
      return handleProxy(req,res,url,{prefix:'/omniroute',upstream});
    }
    if(url.pathname==='/api/antigravity-auth/start'){
      if(req.method==='OPTIONS'){res.writeHead(204,{...CORS});return res.end()}
      // Единственный flow: пользователь входит в Google, браузер уходит на
      // loopback-redirect_uri, пользователь копирует адрес из адресной строки
      // и применяет через POST /api/antigravity-auth/paste.
      const host=req.headers.host||'';
      const hostPort=host.match(/:(\d+)$/);
      const listenPort=hostPort?hostPort[1]:String(process.env.PORT||'8765');
      const hostname=hostPort?host.slice(0,-hostPort[0].length):host;
      const isLocal=/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(hostname);
      // Локально: callback придёт на эту же панель → покажем страницу-подсказку.
      // Удалённо: редирект на произвольный loopback-порт, где у пользователя
      // скорее всего никто не слушает. Иначе браузер попадает на локальный
      // сервер панели (если он запущен на том же порту), и его страница
      // закрывает окно раньше, чем адрес будет скопирован. При connection
      // refused адрес остаётся в адресной строке — его и копируем.
      const redirectUri = isLocal
        ? 'http://127.0.0.1:'+listenPort+'/api/antigravity-auth/callback'
        : 'http://127.0.0.1:44127/callback';
      const state=crypto.randomUUID();
      oauthStates.set(state,Date.now()+OAUTH_STATE_TTL_MS);
      for(const [key,expiresAt] of oauthStates) if(expiresAt<Date.now()) oauthStates.delete(key);
      res.writeHead(200,{...CORS,'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      return res.end(JSON.stringify({url:googleOauth.buildAuthUrl({redirectUri,state})}));
    }
    if(url.pathname==='/api/antigravity-auth/callback'){
      // Страница-подсказка после входа в Google: код остаётся в адресе,
      // пользователь копирует адрес из адресной строки и вставляет в панель.
      // Без обмена кода, без проверки state и без авто-закрытия.
      const page=(title,msg)=>'<html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+'</title><body style="font-family:system-ui,sans-serif;text-align:center;padding:40px 16px"><h2 style="margin-top:0">'+title+'</h2><p style="max-width:36em;margin:0 auto;line-height:1.5">'+msg+'</p></body></html>';
      const error=url.searchParams.get('error');
      const code=url.searchParams.get('code');
      res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
      if(error){
        return res.end(page('Авторизация не выполнена','Google вернул ошибку: '+String(error).replace(/[^\w.-]/g,'')+'. Закройте это окно и попробуйте ещё раз.'));
      }
      if(!code){
        return res.end(page('AI Панель','Это служебная страница: сюда браузер попадает после входа через Google. Если вы здесь случайно — просто закройте её.'));
      }
      return res.end(page('Остался один шаг','Скопируйте адрес этой страницы из адресной строки браузера (начинается с <b>http://127.0.0.1</b> и содержит <b>code=</b>) и вставьте его в поле «Ссылка после входа» в настройках панели. Потом окно можно закрыть.'));
    }
    if(url.pathname==='/api/antigravity-auth/paste'){
      // Основной flow: пользователь вставляет ссылку, на которую ушёл браузер
      // после входа в Google (loopback-redirect). Код привязан к redirect_uri
      // из этой ссылки — обмен выполняем с тем же origin+path.
      if(req.method==='OPTIONS'){res.writeHead(204,{...CORS});return res.end()}
      if(req.method!=='POST'){res.writeHead(405,{...CORS,'content-type':'application/json; charset=utf-8'});return res.end(JSON.stringify({error:'method_not_allowed'}))}
      const body=await readJson(req);
      let pasted='';
      try{pasted=new URL(String(body.url||'').trim())}catch{}
      const code=pasted?pasted.searchParams.get('code'):null;
      const state=pasted?pasted.searchParams.get('state'):null;
      if(!pasted||!code){
        res.writeHead(400,{...CORS,'content-type':'application/json; charset=utf-8'});
        return res.end(JSON.stringify({error:'bad_callback_url',message:'Нужна ссылка вида http://127.0.0.1:…/callback?code=…'}));
      }
      const stateExpiresAt=state?oauthStates.get(state):null;
      if(!stateExpiresAt||stateExpiresAt<Date.now()){
        if(state) oauthStates.delete(state);
        res.writeHead(400,{...CORS,'content-type':'application/json; charset=utf-8'});
        return res.end(JSON.stringify({error:'invalid_oauth_state',message:'OAuth state отсутствует, истёк или уже использован'}));
      }
      oauthStates.delete(state);
      pasted.hash=''; pasted.searchParams.delete('hash');
      const redirectUri=pasted.origin+pasted.pathname;
      const r=await googleOauth.exchangeCode({code,redirectUri});
      if(!r.ok){
        res.writeHead(502,{...CORS,'content-type':'application/json; charset=utf-8'});
        return res.end(JSON.stringify({error:r.error,message:'Не удалось обменять код авторизации'}));
      }
      storeExchangedTokens(r);
      // Refresh-связку сохраняем на сервере (SQLite, зашифровано), чтобы
      // вход переживал перезапуск — клиенту её возвращать не обязательно.
      if (googleAuth.refreshToken) await (await getStore()).set('agRefreshToken', googleAuth.refreshToken);
      // Email аккаунта — best-effort из Google userinfo (не ломает вход при ошибке);
      // сохраняем в хранилище, чтобы email переживал перезапуск сервера
      if (typeof googleOauth.getUserInfo === 'function') {
        try {
          const ui = await googleOauth.getUserInfo({ accessToken: googleAuth.token });
          if (ui.ok) googleAuth.email = ui.email || '';
          if (googleAuth.email) { try{ await (await getStore()).set('agEmail', googleAuth.email); }catch{} }
        } catch {}
      }
      res.writeHead(200,{...CORS,'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      return res.end(JSON.stringify({ok:true,hasToken:true,hasRefresh:Boolean(googleAuth.refreshToken),refreshToken:googleAuth.refreshToken||null}));
    }
    if(url.pathname==='/api/settings/google-token'){
      if(req.method==='OPTIONS'){res.writeHead(204,{...CORS});return res.end()}
      if(req.method==='GET'){
        res.writeHead(200,{...CORS,'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
        return res.end(JSON.stringify({hasToken:Boolean(googleAuth.token),hasRefresh:hasRefreshCreds(),tokenExpiresAt:googleAuth.tokenExpiresAt||null,email:googleAuth.email||null}));
      }
      if(req.method==='DELETE'){
        googleAuth.token=''; googleAuth.refreshToken=''; googleAuth.clientId=''; googleAuth.clientSecret=''; googleAuth.project=''; googleAuth.tokenExpiresAt=0; googleAuth.email=''; agCache={ts:0,result:null,project:null};
        await (await getStore()).set('agRefreshToken','');
        await (await getStore()).set('agProject','');
        await (await getStore()).set('agEmail','');
        res.writeHead(200,{...CORS,'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
        return res.end(JSON.stringify({ok:true,hasToken:false,hasRefresh:false}));
      }
      if(req.method!=='POST'){res.writeHead(405,{...CORS,'content-type':'application/json; charset=utf-8'});return res.end(JSON.stringify({error:'method_not_allowed'}))}
      let raw; try{raw=await readBody(req)}catch{raw=null}
      let body={}; try{body=JSON.parse(raw&&raw.toString()||'{}')}catch{}
      const str=(v)=>typeof v==='string'?v.trim():'';
      // Пустая строка очищает соответствующее поле (частичная замена)
      if('token' in body) googleAuth.token=str(body.token);
      if('refreshToken' in body) googleAuth.refreshToken=str(body.refreshToken);
      if('clientId' in body) googleAuth.clientId=str(body.clientId);
      if('clientSecret' in body) googleAuth.clientSecret=str(body.clientSecret);
      if('project' in body) googleAuth.project=str(body.project);
      // Самые важные поля персистим в хранилище (зашифровано на диске)
      if('refreshToken' in body) await (await getStore()).set('agRefreshToken', googleAuth.refreshToken);
      if('project' in body) await (await getStore()).set('agProject', googleAuth.project);
      if(!googleAuth.token && !hasRefreshCreds()){
        res.writeHead(400,{...CORS,'content-type':'application/json; charset=utf-8'});
        return res.end(JSON.stringify({error:'no_token',message:'Нужен access-token или связка refresh-token + client_id + client_secret'}));
      }
      agCache={ts:0,result:null,project:null}; // новые данные — сбрасываем кеш
      res.writeHead(200,{...CORS,'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      return res.end(JSON.stringify({ok:true,hasToken:Boolean(googleAuth.token),hasRefresh:hasRefreshCreds()}));
    }
    if(url.pathname==='/api/antigravity-quota'){
      if(req.method==='OPTIONS'){res.writeHead(204,{...CORS});return res.end()}
      if(!agLoaded){ agLoaded=true; await loadAgFromStore(); }
      if(!googleAuth.token && !hasRefreshCreds()){
        res.writeHead(400,{...CORS,'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
        return res.end(JSON.stringify({error:'no_token',message:'Задайте Antigravity OAuth-токен или refresh-связку в настройках'}));
      }
      // project: приоритет у query-параметра клиента, иначе сохранённое значение
      const project=(url.searchParams.get('project')||'').trim()||googleAuth.project;
      if(agCache.result && agCache.project===project && Date.now()-agCache.ts<AG_CACHE_TTL_MS){
        res.writeHead(agCache.result.status,{...CORS,'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
        return res.end(JSON.stringify(agCache.result.data));
      }
      // Нет access-token, но есть refresh-связка — обновляем заранее
      if(!googleAuth.token){ await refreshGoogleToken(); }
      // Email: разовый backfill после перезапуска — связка жива, а email в
      // памяти пуст. Успешный результат сохраняется в хранилище.
      if(!googleAuth.email && googleAuth.token && typeof googleOauth.getUserInfo==='function'){
        try{
          const ui=await googleOauth.getUserInfo({accessToken:googleAuth.token});
          if(ui.ok&&ui.email){
            googleAuth.email=ui.email;
            try{ await (await getStore()).set('agEmail', googleAuth.email); }catch{}
          }
        }catch{}
      }
      let result = googleAuth.token
        ? await antigravity.getQuota({token:googleAuth.token,project})
        : { status:401, data:{error:'token_expired'} }; // refresh не удался
      // Access-token истёк — обновляем и повторяем один раз
      if(result.status===401 && hasRefreshCreds()){
        if(await refreshGoogleToken()){
          result = await antigravity.getQuota({token:googleAuth.token,project});
        }
      }
      // Успех → дополняем групповыми окнами (weekly/5h); ошибка окон не ломает ответ
      if(result.status===200 && googleAuth.token){
        try{
          const summary=await antigravity.getQuotaSummary({token:googleAuth.token,project});
          if(summary && summary.status===200 && summary.data) result.data.windows=summary.data.windows;
        }catch{}
      }
      agCache={ts:Date.now(),result,project};
      res.writeHead(result.status,{...CORS,'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      return res.end(JSON.stringify(result.data));
    }

    if(url.pathname==='/api/config'){
      if(req.method==='OPTIONS') return sendNoContent(res);
      if(!agLoaded){ agLoaded=true; await loadAgFromStore(); }
      const st=await getStore();
      if(req.method==='PUT'){
        const body=await readJson(req);
        if(!body||typeof body!=='object'||Array.isArray(body)) throw new AppError(400,'bad_json','Ожидается JSON-объект');
        const writable=['xkiroKey','agentrouterKey','agentrouterUserId','omniUrl','omniKey','agRefreshToken','agProject','aliases','comboActive','dlgProvider','modelsProvider','statsProvider'];
        if(Object.hasOwn(body,'omniUrl')&&body.omniUrl){
          try{body.omniUrl=await validateUpstreamUrl(body.omniUrl,{allowPrivate:!remoteMode});}
          catch{throw new AppError(400,'invalid_omniroute_url','Некорректный или запрещённый OmniRoute URL');}
        }
        const entries=[];
        for(const key of writable) if(Object.hasOwn(body,key)){const value=body[key]==null?'':String(body[key]);await st.set(key,value);entries.push([key,value]);}
        syncAgFromStore(entries);
        return sendJson(res,200,{ok:true},{'cache-control':'no-store'});
      }
      if(req.method!=='GET') throw new AppError(405,'method_not_allowed','Метод не поддерживается',{headers:{allow:'GET, PUT'}});
      const s=await st.snapshot();
      const providerInfo=providers.map(p=>{const storeField=PROVIDER_STORE_KEYS[p.id];return {id:p.id,name:p.name,site:p.site||'',hasKey:storeField?Boolean(s[storeField]):Boolean(p.apiKey)};});
      const data={aliases:s.aliases||'',comboActive:s.comboActive||'',dlgProvider:s.dlgProvider||'',modelsProvider:s.modelsProvider||'',statsProvider:s.statsProvider||'',agentrouterUserId:s.agentrouterUserId||'',omniUrl:s.omniUrl||'',hasXkiroKey:Boolean(s.xkiroKey),hasAgentrouterKey:Boolean(s.agentrouterKey),hasOmniRoute:Boolean(s.omniUrl),hasOmniKey:Boolean(s.omniKey),hasGoogleToken:Boolean(googleAuth.token)||hasRefreshCreds()};
      return sendJson(res,200,{ok:true,data,providers:providerInfo,activeProvider:activeProvider?activeProvider.id:null,...data},{'cache-control':'no-store'});
    }
    serveStatic(req,res,url.pathname);
  }
  const server = http.createServer((req,res)=>{
    const context=createRequestContext(req,res,{timeoutMs:requestTimeoutMs});
    handleRequest(req,res).catch(err=>handleError(err,req,res,context,logger));
  });
  server.startDailyAgentRouterTracker = startDailyAgentRouterTracker;
  server.snapshotAgentRouterDayBalance = snapshotAgentRouterDayBalance;
  return server;
}
module.exports = { createApp };
// CLI-запуск (node server.js): порт — единственная переменная окружения
if (require.main === module) {
  loadEnvFile('.env');
  const {port:PORT,host:HOST,remoteMode}=getServerConfig();
  try{validateMasterKey(process.env.AIPANEL_MASTER_KEY)}catch(err){console.error(err.message);process.exit(1)}
  const providers = loadProviders();
  const app = createApp({ providers, remoteMode });
  if (typeof app.startDailyAgentRouterTracker === 'function') app.startDailyAgentRouterTracker();
  app.on('error',err=>{console.error('Не удалось запустить сервер:',err.message);process.exit(1)});
  app.listen(PORT,HOST,()=>{console.log(`AI Панель · http://${HOST}:${PORT}`); for(const p of providers) console.log('  провайдер '+p.name+' ('+p.id+'): '+p.upstream)});
}
