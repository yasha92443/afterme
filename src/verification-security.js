// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import { recoveryHash } from './mfa.js';
import { createMailProvider,sendGuardedMail } from './mail.js';
const copy={zh:{subject:'AfterMe：核验网页验证码',code:'网页核验验证码',help:'10 分钟内有效，仅输入到你主动打开的 AfterMe 核验网页。请勿转发链接或验证码。'},en:{subject:'AfterMe: verification code',code:'Web verification code',help:'Valid for 10 minutes. Enter only on the AfterMe verification page you opened yourself. Do not share this code or your link.'},ru:{subject:'AfterMe: код проверки',code:'Код проверки',help:'Действует 10 минут. Введите только на самостоятельно открытой странице AfterMe. Не передавайте код или ссылку.'}};
export async function startVerificationProof({repo,env,contact,owner,now=Date.now(),provider=createMailProvider(env)}){
  if(provider.name==='dry-run')throw Object.assign(Error('Verification email delivery is not configured'),{status:503});
  const id=crypto.randomUUID();let random;do{random=crypto.getRandomValues(new Uint32Array(1))[0];}while(random>=4200000000);
  const code=String(random%100000000).padStart(8,'0');
  const maximumProofs=Math.max(1,Math.floor(Math.min(Number(env.MAX_DAILY_EMAILS||20),(await repo.getSettings(env)).preferences.daily_email_limit)/2));
  const rows=await repo.db.batch([
    repo.db.prepare('DELETE FROM verification_challenges WHERE expires_at<?').bind(now),
    // Reserve both limits in the same transaction. A rejected contact-window
    // reservation must not consume the shared daily delivery budget.
    repo.db.prepare(`INSERT INTO verification_code_budget(day,count,last_id)
      SELECT ?,1,? WHERE (SELECT COUNT(*) FROM verification_challenges WHERE contact_id=? AND created_at>?)<3
      AND EXISTS(SELECT 1 FROM contacts c JOIN owner o ON o.id=1 WHERE c.id=? AND c.active=1 AND c.token_hash=? AND c.verification_round=? AND o.confirmation_round=? AND o.pause_mode IS NULL AND o.state IN ('VERIFY','READY_TO_RELEASE','PRIVATE_RELEASE','PUBLIC_RELEASE'))
      ON CONFLICT(day) DO UPDATE SET count=count+1,last_id=excluded.last_id WHERE count<?`)
      .bind(new Date(now).toISOString().slice(0,10),id,contact.id,now-300000,contact.id,contact.token_hash,owner.confirmation_round,owner.confirmation_round,maximumProofs),
    repo.db.prepare('INSERT INTO verification_challenges(id,contact_id,round,token_hash,code_hash,expires_at,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM verification_code_budget WHERE last_id=?)').bind(id,contact.id,owner.confirmation_round,contact.token_hash,await recoveryHash('verification:'+id+':'+code,env),now+600000,now,id),
    repo.db.prepare('UPDATE verification_challenges SET used_at=? WHERE contact_id=? AND id<>? AND used_at IS NULL AND EXISTS(SELECT 1 FROM verification_challenges WHERE id=?)').bind(now,contact.id,id,id)
  ]);
  if(!rows[2].meta.changes)throw Object.assign(Error('Verification-code request limit reached or this round ended; retry later'),{status:429});
  const c=copy[contact.locale]||copy.zh;
  const result=await sendGuardedMail({repo,provider,env,eventType:'verification_code',to:contact.email,subject:c.subject,text:`${c.code}: ${code}\n\n${c.help}`,dedupeKey:'verification-code:'+id,now:new Date(now).toISOString(),canSend:async()=>{const o=await repo.getOwner();const current=await repo.getContact(contact.id);const proof=await repo.db.prepare('SELECT used_at FROM verification_challenges WHERE id=?').bind(id).first();return proof&&proof.used_at===null&&o.confirmation_round===owner.confirmation_round&&!o.pause_mode&&current.active&&current.token_hash===contact.token_hash;}});
  if(result.status!=='sent')throw Object.assign(Error('Code delivery failed or is uncertain; retry later'),{status:503});
  await repo.db.prepare('UPDATE verification_challenges SET delivered=1 WHERE id=?').bind(id).run();
  return {id,expires_at:now+600000};
}
export async function consumeVerificationProof({repo,env,contact,owner,id,code,now=Date.now()}){
  if(typeof id!=='string'||id.length>50||typeof code!=='string'||!/^\d{8}$/.test(code))return false;
  const hash=await recoveryHash('verification:'+id+':'+code,env);
  // Count every attempt and consume exactly once, atomically with round/token checks.
  const result=await repo.db.batch([
    repo.db.prepare('UPDATE verification_challenges SET attempts=attempts+1 WHERE id=? AND contact_id=? AND used_at IS NULL AND delivered=1 AND expires_at>=?').bind(id,contact.id,now),
    repo.db.prepare(`UPDATE verification_challenges SET used_at=? WHERE id=? AND contact_id=? AND round=? AND token_hash=? AND code_hash=? AND used_at IS NULL AND delivered=1 AND expires_at>=? AND attempts<=5 AND EXISTS(SELECT 1 FROM owner o JOIN contacts c ON c.id=verification_challenges.contact_id WHERE o.confirmation_round=verification_challenges.round AND c.verification_round=o.confirmation_round AND c.token_hash=verification_challenges.token_hash AND c.active=1 AND o.pause_mode IS NULL AND o.state IN ('VERIFY','READY_TO_RELEASE','PRIVATE_RELEASE','PUBLIC_RELEASE'))`).bind(now,id,contact.id,owner.confirmation_round,contact.token_hash,hash,now)
  ]);
  return Boolean(result[1].meta.changes);
}
export async function notifyConfirmation({repo,env,contact,owner,status,now,provider=createMailProvider(env)}){
  try{
  const settings=await repo.getSettings(env),rules=await repo.getRoundRules(owner),contacts=(await repo.listContacts()).results;
  const ids=new Set([...rules.private.contact_ids,...rules.public.contact_ids]);
  const recipients=[{email:owner.email,locale:settings.preferences.locale},...contacts.filter(c=>c.active&&c.id!==contact.id&&ids.has(c.id))];
  for(const recipient of recipients){
    const labels={zh:'核验回复已记录；如果是误报，请本人签到，或联系人提交“误报”。',en:'A verification reply was recorded. If incorrect, the owner should check in or a contact should report a false alarm.',ru:'Ответ проверки записан. При ошибке владельцу нужно отметиться или контакту сообщить о ложной тревоге.'};
    await sendGuardedMail({repo,env,provider,eventType:'security_confirmation_notice',to:recipient.email,subject:'AfterMe / verification notice',text:`${labels[recipient.locale]||labels.zh}\n${contact.name}: ${status}\n${now}`,dedupeKey:`security-confirmation:${owner.confirmation_round}:${contact.id}:${status}:${recipient.email}`,now});
  }
  }catch{await repo.audit('security_notice_failed',{kind:'confirmation'},now);}
}
