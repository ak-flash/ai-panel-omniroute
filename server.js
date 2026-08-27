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
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 2 * 1024 * 1024;
const MIME = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8' };
const CORS = { 'access-control-allow-origin':'*','access-control-allow-methods':'GET, POST, PUT, PATCH, DELETE, OPTIONS','access-control-allow-headers':'authorization, x-api-key, content-type, accept' };
function resolveStaticPath(pathname){ const relative=pathname==='/'?'index.html':pathname.slice(1); let decoded; try{decoded=decodeURIComponent(relative)}catch{return null} const resolved=path.normalize(path.join(PUBLIC_DIR,decoded)); if(resolved!==PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR+path.sep)) return null; return resolved; }
function serveStatic(req,res,pathname){ const filePath=resolveStaticPath(pathname); if(!filePath){res.writeHead(403,{'content-type':'text/plain; charset=utf-8'});return res.end('403 Forbidden')} fs.stat(filePath,(err,stats)=>{ if(err||!stats.isFile()){res.writeHead(404,{'content-type':'text/plain; charset=utf-8'});return res.end('404 Not Found')} const ext=path.extname(filePath).toLowerCase(); const mime=MIME[ext]||'application/octet-stream'; res.writeHead(200,{'content-type':mime,'cache-control':ext==='.html'?'no-store':'max-age=3600'}); const s=fs.createReadStream(filePath); s.on('error',()=>res.destroy()); s.pipe(res); });}
function readBody(req){return new Promise((resolve,reject)=>{const chunks=[];let size=0;let done=false; req.on('data',c=>{if(done)return; size+=c.length; if(size>MAX_BODY){done=true;return resolve(null)} chunks.push(c)}); req.on('end',()=>{if(!done)resolve(Buffer.concat(chunks))}); req.on('error',e=>{if(!done)reject(e)});});}
async function handleProxy(req,res,url,{prefix,upstream}){ if(req.method==='OPTIONS'){res.writeHead(204,{...CORS});return res.end()} let body; try{body=await readBody(req)}catch{if(!res.headersSent)res.writeHead(400,{'content-type':'text/plain'});return res.end()} if(body===null){res.writeHead(413,{...CORS,'content-type':'application/json; charset=utf-8','connection':'close'});return res.end(JSON.stringify({error:'payload_too_large',message:'Тело запроса превышает лимит 2 МБ'}))} const suffix=url.pathname.replace(new RegExp('^'+prefix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),'')+url.search; const target=upstream+suffix; const fwdHeaders={}; for(const n of ['authorization','x-api-key','content-type','accept']) if(req.headers[n]) fwdHeaders[n]=req.headers[n]; const ac=new AbortController(); res.on('close',()=>ac.abort()); try{ const upstreamRes=await fetch(target,{method:req.method,headers:fwdHeaders,body:body.length>0?body:undefined,signal:ac.signal}); const resHeaders={...CORS}; const ct=upstreamRes.headers.get('content-type'); if(ct) resHeaders['content-type']=ct; res.writeHead(upstreamRes.status,resHeaders); if(upstreamRes.body){for await(const chunk of upstreamRes.body){if(!res.writable)break; res.write(chunk)}} res.end(); }catch(err){ if(res.headersSent)return res.destroy(); res.writeHead(502,{...CORS,'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'proxy_error',message:err instanceof Error?err.message:String(err)})); } }
// createApp собирает HTTP-сервер панели с переданным списком провайдеров
// (по умолчанию — вшитые из loadProviders()). Тесты инжектят сюда
// адаптеры с mock-upstream; CLI-блок ниже запускает то же самое на PORT.
function createApp({ providers = loadProviders(), antigravity = createAntigravityProvider(), googleOauth = createGoogleOauth() } = {}){
  const activeProvider = providers[0] || null;
  // Google OAuth antigravity: живёт только в памяти процесса,
  // в localStorage клиента и в логах не хранится (см. PLAN п.3).
  // refresh-связка (refreshToken + clientId + clientSecret) позволяет
  // серверу самому обновлять access-token, когда тот истёк.
  const googleAuth = { token: '', refreshToken: '', clientId: '', clientSecret: '', project: '', tokenExpiresAt: 0 };
  let agCache = { ts: 0, result: null, project: null }; // серверный кеш квот, 60 с
  const AG_CACHE_TTL_MS = 60000;

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
  async function handleRequest(req,res){
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/proxy'||url.pathname.startsWith('/proxy/')){
      if(!activeProvider){res.writeHead(503,{...CORS,'content-type':'application/json; charset=utf-8'});return res.end(JSON.stringify({error:'no_provider',message:'Провайдер не настроен'}))}
      let provider=activeProvider; let prefix='/proxy'; const m=url.pathname.match(/^\/proxy\/([a-z0-9-]+)(?:\/|$)/); if(m&&providers.some(p=>p.id===m[1])){provider=providers.find(p=>p.id===m[1]); prefix='/proxy/'+m[1]}
      return handleProxy(req,res,url,{prefix,upstream:provider.upstream});
    }
    const apiMatch=url.pathname.match(/^\/api\/providers\/([a-z0-9-]+)\/(usage|models)$/);
    if(apiMatch){
      if(req.method==='OPTIONS'){res.writeHead(204,{...CORS});return res.end()}
      const provider=providers.find(p=>p.id===apiMatch[1]); if(!provider){res.writeHead(404,{...CORS,'content-type':'application/json; charset=utf-8'});return res.end(JSON.stringify({error:'unknown_provider',message:'Провайдер не найден'}))}
      const clientKey=req.headers['x-api-key']||''; const fn=apiMatch[2]==='usage'?provider.getUsage:provider.getModels; const result=await fn(clientKey);
      res.writeHead(result.status,{...CORS,'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); return res.end(JSON.stringify(result.data));
    }
    if(url.pathname==='/omniroute'||url.pathname.startsWith('/omniroute/')){
      // OmniRoute: URL берёт клиент, но если запрос пришёл на /omniroute — требуем заголовок x-omniroute-url или пробрасываем как есть
      const omniUrl = req.headers['x-omniroute-url'] || '';
      if(!omniUrl){ res.writeHead(400,{...CORS,'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:'no_omniroute_url',message:'Укажите OmniRoute URL в Настройках'})); }
      return handleProxy(req,res,url,{prefix:'/omniroute',upstream:omniUrl.replace(/\/+$/,'')});
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
      res.writeHead(200,{...CORS,'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      return res.end(JSON.stringify({url:googleOauth.buildAuthUrl({redirectUri,state:crypto.randomUUID()})}));
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
      let raw; try{raw=await readBody(req)}catch{raw=null}
      let body={}; try{body=JSON.parse(raw&&raw.toString()||'{}')}catch{}
      let pasted='';
      try{pasted=new URL(String(body.url||'').trim())}catch{}
      const code=pasted?pasted.searchParams.get('code'):null;
      if(!pasted||!code){
        res.writeHead(400,{...CORS,'content-type':'application/json; charset=utf-8'});
        return res.end(JSON.stringify({error:'bad_callback_url',message:'Нужна ссылка вида http://127.0.0.1:…/callback?code=…'}));
      }
      pasted.hash=''; pasted.searchParams.delete('hash');
      const redirectUri=pasted.origin+pasted.pathname;
      const r=await googleOauth.exchangeCode({code,redirectUri});
      if(!r.ok){
        res.writeHead(502,{...CORS,'content-type':'application/json; charset=utf-8'});
        return res.end(JSON.stringify({error:r.error,message:'Не удалось обменять код авторизации'}));
      }
      storeExchangedTokens(r);
      res.writeHead(200,{...CORS,'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      return res.end(JSON.stringify({ok:true,hasToken:true,hasRefresh:Boolean(googleAuth.refreshToken)}));
    }
    if(url.pathname==='/api/settings/google-token'){
      if(req.method==='OPTIONS'){res.writeHead(204,{...CORS});return res.end()}
      if(req.method==='GET'){
        res.writeHead(200,{...CORS,'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
        return res.end(JSON.stringify({hasToken:Boolean(googleAuth.token),hasRefresh:hasRefreshCreds(),tokenExpiresAt:googleAuth.tokenExpiresAt||null}));
      }
      if(req.method==='DELETE'){
        googleAuth.token=''; googleAuth.refreshToken=''; googleAuth.clientId=''; googleAuth.clientSecret=''; googleAuth.project=''; googleAuth.tokenExpiresAt=0; agCache={ts:0,result:null,project:null};
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
      if(!googleAuth.token && !hasRefreshCreds()){
        res.writeHead(400,{...CORS,'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
        return res.end(JSON.stringify({error:'no_token',message:'Задайте Antigravity OAuth-токен или refresh-связку в настройках'}));
      }
      // project: приоритет у query-параметра клиента (localStorage), иначе серверное значение
      const project=(url.searchParams.get('project')||'').trim()||googleAuth.project;
      if(agCache.result && agCache.project===project && Date.now()-agCache.ts<AG_CACHE_TTL_MS){
        res.writeHead(agCache.result.status,{...CORS,'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
        return res.end(JSON.stringify(agCache.result.data));
      }
      // Нет access-token, но есть refresh-связка — обновляем заранее
      if(!googleAuth.token){ await refreshGoogleToken(); }
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
      res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      return res.end(JSON.stringify({ok:true,providers:providers.map(p=>({id:p.id,name:p.name,hasKey:Boolean(p.apiKey)})),activeProvider:activeProvider?activeProvider.id:null,hasOmniRoute:false,hasGoogleToken:Boolean(googleAuth.token)||hasRefreshCreds()}));
    }
    serveStatic(req,res,url.pathname);
  }
  return http.createServer((req,res)=>{handleRequest(req,res).catch(err=>{if(res.headersSent)return res.destroy(); res.writeHead(500,{...CORS,'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'server_error',message:err instanceof Error?err.message:String(err)}))})});
}
module.exports = { createApp };
// CLI-запуск (node server.js): порт — единственная переменная окружения
if (require.main === module) {
  loadEnvFile('.env');
  const PORT = process.env.PORT || 8765;
  const providers = loadProviders();
  const app = createApp({ providers });
  app.on('error',err=>{console.error('Не удалось запустить сервер:',err.message);process.exit(1)});
  app.listen(PORT,()=>{console.log(`AI Панель · http://localhost:${PORT}`); for(const p of providers) console.log('  провайдер '+p.name+' ('+p.id+'): '+p.upstream)});
}
