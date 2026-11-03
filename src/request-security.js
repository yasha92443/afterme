// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import { createAdminSession, validAdminSession } from './session.js';
import { securityState,consumeFactor } from './mfa.js';
export function requestError(status,message) { const e=new Error(message); e.status=status; return e; }
export function securityHeaders(response) {
  for(const [k,v] of Object.entries({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()','Cross-Origin-Resource-Policy':'same-origin'})) response.headers.set(k,v);
  return response;
}
const bodies=new WeakMap();
export async function limitedBody(request) {
  if(bodies.has(request))return bodies.get(request);
  const task=parseLimitedBody(request);bodies.set(request,task);return task;
}
async function parseLimitedBody(request) {
  if(!['POST','PUT','PATCH','DELETE'].includes(request.method)) return {};
  const path=new URL(request.url).pathname;
  const cap=['/api/session','/admin'].includes(path)||path.startsWith('/api/security/')?8192:262144;
  const reader=request.body?.getReader(); const chunks=[]; let size=0;
  if(reader) { try { for(;;) { const {done,value}=await reader.read(); if(done) break; size+=value.byteLength; if(size>cap) {await reader.cancel(); throw requestError(413,'Request body too large');} chunks.push(value); } } finally {reader.releaseLock();} }
  const bytes=new Uint8Array(size); let offset=0; for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  const text=new TextDecoder('utf-8',{fatal:true}); let raw;
  try {raw=text.decode(bytes);} catch {throw requestError(400,'Invalid UTF-8');}
  if(!raw) return {};
  const type=(request.headers.get('content-type')||'').split(';')[0].trim();
  try {
    let body;
    if(type==='application/x-www-form-urlencoded') body=Object.fromEntries(new URLSearchParams(raw));
    else if(type==='multipart/form-data') body=Object.fromEntries(await new Response(bytes,{headers:{'Content-Type':request.headers.get('content-type')}}).formData());
    else if(type==='application/json'||!type) body=JSON.parse(raw);
    else throw requestError(415,'Unsupported content type');
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.values(body).some(v=>typeof Blob!=='undefined'&&v instanceof Blob)) throw requestError(400,'Object fields required');
    for(const field of ['admin_token','reauth_secret','admin_password','mfa_code','enrollment_id','challenge_id','verification_code','name','email','role','note','title','body','plaintext','status','mode','until','anchor_at','dedupe_key','resolution','epigraph'])if(body[field]!==undefined&&body[field]!==null&&typeof body[field]!=='string')throw requestError(400,'Text field has wrong type');
    for(const field of ['revision','expected_revision','recipient_id','recipient_contact_id','assignee_contact_id','group_id','priority'])if(body[field]!==undefined&&body[field]!==null&&body[field]!==''&&((typeof body[field]!=='number'&&typeof body[field]!=='string')||!/^\d+$/.test(String(body[field]))||!Number.isSafeInteger(Number(body[field]))))throw requestError(400,'Integer field has wrong type');
    for(const field of ['profile','contact_languages','recipient_languages'])if(body[field]!==undefined&&(!body[field]||typeof body[field]!=='object'||Array.isArray(body[field])))throw requestError(400,'Object field has wrong type');
    return body;
  } catch(e) {if(e.status) throw e; throw requestError(400,'Malformed request body');}
}
async function digest(token) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(v=>v.toString(16).padStart(2,'0')).join(''); }
export async function issueSession(env,now=Date.now(),mfaVerified=false,expectedRevision=null) {
  const token=await createAdminSession(env.ADMIN_TOKEN,now), csrf=crypto.randomUUID();
  await env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at<?').bind(now).run();
  const security=await securityState(env);
  if(expectedRevision!==null&&security.revision!==expectedRevision)throw requestError(401,'Security settings changed; sign in again');
  if(security.enabled&&!mfaVerified)throw requestError(401,'Second factor required');
  await env.DB.prepare('INSERT INTO admin_sessions(token_hash,csrf,expires_at,verified_at,mfa_verified,security_revision) VALUES(?,?,?,?,?,?)').bind(await digest(token),csrf,now+1800000,now,mfaVerified?1:0,security.revision).run();
  return {token,csrf,expires_at:now+1800000};
}
export function sessionCookie(token,secure=true) {return `afterme_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token?1800:0}${secure?'; Secure':''}`;}
export async function authenticate(request,env,body={}) {
  if(!env.ADMIN_TOKEN) throw requestError(503,'Admin secret not configured');
  const header=request.headers.get('authorization')||'';
  const formToken=body.admin_token;
  if(header===`Bearer ${env.ADMIN_TOKEN}`) {if((await securityState(env)).enabled)throw requestError(401,'Use a session authenticated with a second factor');return {api:true,fresh:true};}
  // Compatibility: existing form login and API clients may supply the password.
  if(formToken===env.ADMIN_TOKEN) {checkOrigin(request);if((await securityState(env)).enabled)throw requestError(401,'Second factor required');return {api:true,fresh:true};}
  const cookie=(request.headers.get('cookie')||'').match(/(?:^|;\s*)afterme_session=([^;]+)/)?.[1];
  const bearer=header.startsWith('Bearer ')?header.slice(7):null;
  const token=bearer||formToken||cookie;
  if(!await validAdminSession(token,env.ADMIN_TOKEN)) throw requestError(401,'admin authorization required');
  const row=await env.DB.prepare('SELECT s.*,a.enabled AS mfa_enabled,a.revision AS mfa_revision FROM admin_sessions s JOIN admin_security a ON a.id=1 WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?').bind(await digest(token),Date.now()).first();
  // Old signed sessions survive only their original 30-minute expiry; newly issued
  // sessions are registered and revocable. Missing rows are not accepted for cookies.
  if(!row) throw requestError(401,'Session expired or revoked');
  if(row.mfa_enabled&&(!row.mfa_verified||row.security_revision!==row.mfa_revision))throw requestError(401,'Session requires a second factor');
  if(!bearer&&['POST','PUT','PATCH','DELETE'].includes(request.method)) {
    checkOrigin(request);
    if(!formToken&&(request.headers.get('x-csrf-token')||body.csrf)!==row.csrf) throw requestError(403,'CSRF validation failed');
  }
  return {token,csrf:row.csrf,fresh:Date.now()-row.verified_at<=300000,api:Boolean(bearer)};
}
export function checkOrigin(request) {
  const origin=request.headers.get('origin');
  if(origin&&origin!==new URL(request.url).origin) throw requestError(403,'Origin not allowed');
  if(request.headers.get('sec-fetch-site')==='cross-site') throw requestError(403,'Cross-site request rejected');
}
export async function reverify(request,env,body,auth) {
  if(auth.fresh) return;
  if(body.reauth_secret!==env.ADMIN_TOKEN) throw requestError(428,'Recent password verification required');
  const state=await securityState(env);if(state.enabled&&!await consumeFactor(env,body.mfa_code,state))throw requestError(428,'Recent second-factor verification required');
  await env.DB.prepare('UPDATE admin_sessions SET verified_at=? WHERE token_hash=? AND revoked_at IS NULL').bind(Date.now(),await digest(auth.token)).run();
}
export async function revokeSession(env,auth) {
  if(auth.token) await env.DB.prepare('UPDATE admin_sessions SET revoked_at=? WHERE token_hash=?').bind(Date.now(),await digest(auth.token)).run();
}
const localLimits=new Map();
export async function rateLimit(request,env) {
  const path=new URL(request.url).pathname;
  const bucket=path==='/api/session'||(path==='/admin'&&request.method==='POST')||path.startsWith('/api/security/mfa/')?'login':path.startsWith('/verify/')?'verify':/export|preview|rebuild|content-key|maintenance\/status|pdf\/jobs\/advance|\/pdf(?:-source)?$/.test(path)?'expensive':path.startsWith('/static/')||path.startsWith('/vault/')||path==='/farewell'||path==='/health/operational'?'read':path.startsWith('/api/')||path.startsWith('/admin')?'api':null;
  if(!bucket) return;
  const ip=request.headers.get('cf-connecting-ip')||'local', key=`${bucket}:${ip}`;
  const binding=bucket==='login'?env.LOGIN_LIMITER:bucket==='verify'?env.VERIFY_LIMITER:bucket==='api'?env.API_LIMITER:bucket==='read'?env.READ_LIMITER:env.EXPENSIVE_LIMITER;
  if(binding) { if(!(await binding.limit({key})).success) throw requestError(429,'Too many requests'); return; }
  // Fail closed if a deployment lost its binding. Local development must opt in
  // explicitly; request headers and hostnames cannot enable this fallback.
  if(env.ALLOW_LOCAL_RATE_LIMIT_FALLBACK!==true&&env.ALLOW_LOCAL_RATE_LIMIT_FALLBACK!=='true')throw requestError(503,'Required rate limit binding is not configured');
  const now=Date.now(), row=localLimits.get(key); const limit=bucket==='login'?10:bucket==='api'?120:bucket==='read'?60:30;
  if(!row||now-row.start>=60000) localLimits.set(key,{start:now,count:1});
  else if(++row.count>limit) throw requestError(429,'Too many requests');
  if(localLimits.size>1000) {for(const [k,v] of localLimits) if(now-v.start>=60000) localLimits.delete(k);while(localLimits.size>1000)localLimits.delete(localLimits.keys().next().value);}
}
