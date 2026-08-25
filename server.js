// AI Панель — прокси без секретов из env (ключи в localStorage).
if (typeof globalThis.fetch === 'undefined') { console.error('Node 18+ is required'); process.exit(1); }
const http = require('http');
const fs = require('fs');
const path = require('path');
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
loadEnvFile('.env');
const { loadProviders } = require('./providers');
const PORT = process.env.PORT || 8765;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 2 * 1024 * 1024;
const providers = loadProviders({});
const activeProvider = providers[0] || null;
const MIME = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8' };
const CORS = { 'access-control-allow-origin':'*','access-control-allow-methods':'GET, POST, PUT, PATCH, DELETE, OPTIONS','access-control-allow-headers':'authorization, x-api-key, content-type, accept' };
function resolveStaticPath(pathname){ const relative=pathname==='/'?'index.html':pathname.slice(1); let decoded; try{decoded=decodeURIComponent(relative)}catch{return null} const resolved=path.normalize(path.join(PUBLIC_DIR,decoded)); if(resolved!==PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR+path.sep)) return null; return resolved; }
function serveStatic(req,res,pathname){ const filePath=resolveStaticPath(pathname); if(!filePath){res.writeHead(403,{'content-type':'text/plain; charset=utf-8'});return res.end('403 Forbidden')} fs.stat(filePath,(err,stats)=>{ if(err||!stats.isFile()){res.writeHead(404,{'content-type':'text/plain; charset=utf-8'});return res.end('404 Not Found')} const ext=path.extname(filePath).toLowerCase(); const mime=MIME[ext]||'application/octet-stream'; res.writeHead(200,{'content-type':mime,'cache-control':ext==='.html'?'no-store':'max-age=3600'}); const s=fs.createReadStream(filePath); s.on('error',()=>res.destroy()); s.pipe(res); });}
function readBody(req){return new Promise((resolve,reject)=>{const chunks=[];let size=0;let done=false; req.on('data',c=>{if(done)return; size+=c.length; if(size>MAX_BODY){done=true;return resolve(null)} chunks.push(c)}); req.on('end',()=>{if(!done)resolve(Buffer.concat(chunks))}); req.on('error',e=>{if(!done)reject(e)});});}
async function handleProxy(req,res,url,{prefix,upstream}){ if(req.method==='OPTIONS'){res.writeHead(204,{...CORS});return res.end()} let body; try{body=await readBody(req)}catch{if(!res.headersSent)res.writeHead(400,{'content-type':'text/plain'});return res.end()} if(body===null){res.writeHead(413,{...CORS,'content-type':'application/json; charset=utf-8','connection':'close'});return res.end(JSON.stringify({error:'payload_too_large',message:'Тело запроса превышает лимит 2 МБ'}))} const suffix=url.pathname.replace(new RegExp('^'+prefix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),'')+url.search; const target=upstream+suffix; const fwdHeaders={}; for(const n of ['authorization','x-api-key','content-type','accept']) if(req.headers[n]) fwdHeaders[n]=req.headers[n]; const ac=new AbortController(); res.on('close',()=>ac.abort()); try{ const upstreamRes=await fetch(target,{method:req.method,headers:fwdHeaders,body:body.length>0?body:undefined,signal:ac.signal}); const resHeaders={...CORS}; const ct=upstreamRes.headers.get('content-type'); if(ct) resHeaders['content-type']=ct; res.writeHead(upstreamRes.status,resHeaders); if(upstreamRes.body){for await(const chunk of upstreamRes.body){if(!res.writable)break; res.write(chunk)}} res.end(); }catch(err){ if(res.headersSent)return res.destroy(); res.writeHead(502,{...CORS,'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'proxy_error',message:err instanceof Error?err.message:String(err)})); } }
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
  if(url.pathname==='/api/config'){
    res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
    return res.end(JSON.stringify({ok:true,providers:providers.map(p=>({id:p.id,name:p.name,hasKey:false})),activeProvider:activeProvider?activeProvider.id:null,hasOmniRoute:false}));
  }
  serveStatic(req,res,url.pathname);
}
const server=http.createServer((req,res)=>{handleRequest(req,res).catch(err=>{if(res.headersSent)return res.destroy(); res.writeHead(500,{...CORS,'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'server_error',message:err instanceof Error?err.message:String(err)}))})});
server.on('error',err=>{console.error('Не удалось запустить сервер:',err.message);process.exit(1)});
server.listen(PORT,()=>{console.log(`AI Панель · http://localhost:${PORT}`); for(const p of providers) console.log('  провайдер '+p.name+' ('+p.id+'): '+p.upstream)});
