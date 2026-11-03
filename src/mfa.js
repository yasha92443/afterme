// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import { buildStoredPayload,openStoredPayload } from './content.js';
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes){let bits=0,value=0,out='';for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=alphabet[(value>>>(bits-5))&31];bits-=5;}}if(bits)out+=alphabet[(value<<(5-bits))&31];return out;}
function unbase32(secret){let bits=0,value=0,out=[];for(const c of secret){const n=alphabet.indexOf(c);if(n<0)throw Error('Invalid TOTP secret');value=(value<<5)|n;bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}}return new Uint8Array(out);}
export async function totp(secret,counter,digits=6){
  const key=await crypto.subtle.importKey('raw',unbase32(secret),{name:'HMAC',hash:'SHA-1'},false,['sign']);
  const bytes=new Uint8Array(8);new DataView(bytes.buffer).setBigUint64(0,BigInt(counter));
  const mac=new Uint8Array(await crypto.subtle.sign('HMAC',key,bytes)),offset=mac[mac.length-1]&15;
  return String((new DataView(mac.buffer).getUint32(offset)&0x7fffffff)%10**digits).padStart(digits,'0');
}
export async function securityState(env){return await env.DB.prepare('SELECT * FROM admin_security WHERE id=1').first()||{enabled:0,revision:0};}
export async function recoveryHash(code,env){
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.ADMIN_TOKEN),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('afterme-recovery:'+code)))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function consumeFactor(env,code,state=null,now=Date.now()){
  state??=await securityState(env);
  if(!state.enabled)return false;
  if(typeof code!=='string'||code.length>100)return false;
  if(/^\d{6}$/.test(code)){
    const secret=(await openStoredPayload(state.secret_payload,env)).plaintext,current=Math.floor(now/30000);
    for(const counter of [current,current-1,current+1]){
      if(counter<=state.last_counter||await totp(secret,counter)!==code)continue;
      const r=await env.DB.prepare('UPDATE admin_security SET last_counter=? WHERE id=1 AND enabled=1 AND revision=? AND last_counter<?').bind(counter,state.revision,counter).run();return Boolean(r.meta.changes);
    }
    return false;
  }
  const r=await env.DB.prepare('UPDATE admin_recovery_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL AND enrollment_id=(SELECT pending_id FROM admin_security WHERE id=1 AND enabled=1 AND revision=?)').bind(now,await recoveryHash(code.trim(),env),state.revision).run();return Boolean(r.meta.changes);
}
export async function beginEnrollment(env,now=Date.now()){
  const state=await securityState(env);if(state.enabled)throw Object.assign(Error('请先通过双重验证关闭现有绑定，再重新绑定。'),{status:409});
  const secret=base32(crypto.getRandomValues(new Uint8Array(20))),id=crypto.randomUUID(),codes=Array.from({length:10},()=>base32(crypto.getRandomValues(new Uint8Array(10))));
  const payload=await buildStoredPayload({body:{plaintext:secret},env});
  await env.DB.batch([
    env.DB.prepare('UPDATE admin_security SET pending_payload=?,pending_id=?,pending_expires=? WHERE id=1 AND enabled=0').bind(payload,id,now+600000),
    env.DB.prepare('DELETE FROM admin_recovery_codes WHERE enrollment_id<>(SELECT pending_id FROM admin_security WHERE id=1)'),
    ...await Promise.all(codes.map(async code=>env.DB.prepare('INSERT INTO admin_recovery_codes(code_hash,enrollment_id) SELECT ?,? WHERE EXISTS(SELECT 1 FROM admin_security WHERE id=1 AND pending_id=? AND enabled=0)').bind(await recoveryHash(code,env),id,id)))
  ]);
  return {enrollment_id:id,secret,recovery_codes:codes,expires_at:now+600000,uri:`otpauth://totp/AfterMe:owner?secret=${secret}&issuer=AfterMe&algorithm=SHA1&digits=6&period=30`};
}
export async function finishEnrollment(env,{enrollment_id,code,acknowledged},now=Date.now()){
  const state=await securityState(env);
  if(state.enabled||!acknowledged||state.pending_id!==enrollment_id||state.pending_expires<now||!/^\d{6}$/.test(code||''))return false;
  const secret=(await openStoredPayload(state.pending_payload,env)).plaintext,current=Math.floor(now/30000);
  for(const counter of [current,current-1,current+1]){
    if(await totp(secret,counter)!==code)continue;
    const r=await env.DB.prepare('UPDATE admin_security SET enabled=1,secret_payload=pending_payload,pending_payload=NULL,pending_expires=NULL,last_counter=?,revision=revision+1 WHERE id=1 AND enabled=0 AND pending_id=? AND pending_expires>=?').bind(counter,enrollment_id,now).run();return Boolean(r.meta.changes);
  }return false;
}
