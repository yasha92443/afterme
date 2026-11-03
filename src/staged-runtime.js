// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {calculateState,STATES} from './core.js';
import {createMailProvider,GmailMailProvider} from './mail.js';
import {buildContactAlertMail,buildContactVerifyMail,buildPrivateReleaseMail,buildPublicReleaseMail,mergeMailTemplates} from './mail-copy.js';
import {artifactContext,artifactById,artifactCurrentGuard,findReadyArtifact,runArtifactValidationStep,readValidatedArtifactRange} from './pdf-artifacts.js';
import {PDF_MANIFEST_ALGORITHM,PDF_CHUNK_BYTES} from './pdf-validation.js';
import {enqueueJob,claimJob,checkpointJob,openJobValue,cancelObsoleteJobs} from './background-jobs.js';
import {runBackgroundTick,runBackgroundLaneTick,inboxAllowsDelivery,inboxGenerationFresh} from './background-scheduler.js';
import {runInboxPipelineStep} from './staged-inbox.js';
import {runStagedMail} from './staged-mail.js';
import {t} from './i18n.js';

const email=value=>String(value||'').trim().toLowerCase();
const enabled=value=>String(value??'true').trim().toLowerCase()!=='false';
const base64url=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const blocked="'sent','dry_run','sending','uncertain'";
const jobExists=key=>`EXISTS(SELECT 1 FROM background_jobs j WHERE j.dedupe_key=${key} AND j.state NOT IN ('cancelled'))`;
const claimExists=key=>`EXISTS(SELECT 1 FROM mail_claims m WHERE m.dedupe_key=${key} AND m.status IN (${blocked}))`;

export async function queueConfirmationNotice({repo,env,contact,owner,status,now}){
  const current=await repo.getOwner();
  return enqueueJob(repo,env,{key:`notice:${owner.confirmation_round}:${contact.id}:${status}:${now}`,kind:'notice',round:current.confirmation_round,payload:{sourceRound:owner.confirmation_round,actor:{id:contact.id,name:contact.name},ownerEmail:owner.email,status,at:now},now});
}

// The control stage never performs mail I/O or reads letter bodies.
export async function runControlStage(repo,env,now){
  let owner=await repo.getOwner();if(!owner)return {skipped:true};
  if(owner.pause_mode==='automatic'&&Date.parse(owner.pause_until)<=Date.parse(now))owner=await repo.resumeExpiredPause(now);
  const rules=await repo.getRoundRules(owner),next=calculateState({lastCheckinAt:owner.timer_anchor_at||owner.last_checkin_at,currentState:owner.state,rules,paused:Boolean(owner.pause_mode)},new Date(now));
  const previous=owner.state;
  if(next!==owner.state){const changed=await repo.updateOwnerState(next,now,owner.confirmation_round);if(changed)await repo.audit('state_transition',{from:owner.state,to:next},now);owner=await repo.getOwner();}
  await cancelObsoleteJobs(repo,now);
  await repo.setCursor('background-control',JSON.stringify({round:owner.confirmation_round,completed_at:now,state:owner.state}));
  return {from:previous,to:owner.state,round:owner.confirmation_round};
}

export async function runInboxStage(repo,env,now,processReplies,provider){
  const before=await repo.db.prepare("SELECT o.*,c.value AS inbox_generation FROM owner o LEFT JOIN runtime_cursors c ON c.key='background-inbox' WHERE o.id=1").first();if(!before)return {skipped:true};
  const configured=(env.INBOUND_PROVIDER||(env.MAIL_PROVIDER==='gmail'?'gmail':'web'))==='gmail'&&enabled(env.MAIL_INBOUND_ENABLED);
  let previous;try{previous=JSON.parse(before.inbox_generation||'');}catch{}
  const continuing=previous?.round===before.confirmation_round&&typeof previous.generation_id==='string'&&previous.generation_id&&Number.isFinite(Date.parse(previous.started_at))&&Date.parse(previous.started_at)<=Date.parse(now)&&previous.closed!==true&&!['healthy','not-configured'].includes(previous.status);
  const generation=continuing?{round:previous.round,generation_id:previous.generation_id,started_at:previous.started_at}:{round:before.confirmation_round,generation_id:crypto.randomUUID(),started_at:now};
  const scanning=JSON.stringify({...generation,status:'scanning',closed:false,completed_at:null,observed_at:now});
  // Publish the scanning generation before I/O. The snapshot comparison prevents
  // a superseded poll from resetting a newer poll's cursor or healthy watermark.
  const beginning=await repo.db.batch([
    repo.db.prepare("INSERT INTO runtime_cursors(key,value) SELECT 'background-inbox',? WHERE EXISTS(SELECT 1 FROM owner WHERE id=1 AND confirmation_round=?) AND ((? IS NULL AND NOT EXISTS(SELECT 1 FROM runtime_cursors WHERE key='background-inbox')) OR EXISTS(SELECT 1 FROM runtime_cursors WHERE key='background-inbox' AND value IS ?)) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(scanning,generation.round,before.inbox_generation,before.inbox_generation),
    ...(!continuing?[repo.db.prepare("INSERT INTO runtime_cursors(key,value) SELECT 'gmail-inbox-page','' WHERE EXISTS(SELECT 1 FROM owner WHERE id=1 AND confirmation_round=?) AND EXISTS(SELECT 1 FROM runtime_cursors WHERE key='background-inbox' AND value=?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(generation.round,scanning)]:[]),
  ]);
  if(!beginning[0]?.meta?.changes)return {ok:false,status:'degraded',backlog:true,reason:'inbox-generation-changed'};
  const readCursor=async key=>{
    if(key!=='gmail-inbox-page')return repo.getCursor(key);
    const row=await repo.db.prepare("SELECT COALESCE(p.value,'') AS value FROM owner o JOIN runtime_cursors g ON g.key='background-inbox' AND g.value=? LEFT JOIN runtime_cursors p ON p.key='gmail-inbox-page' WHERE o.id=1 AND o.confirmation_round=?").bind(scanning,generation.round).first();
    if(!row)throw Error('Inbox generation changed');
    return row.value;
  };
  const writeCursor=async(key,value)=>{
    if(key!=='gmail-inbox-page')return repo.setCursor(key,value);
    const result=await repo.db.prepare("INSERT INTO runtime_cursors(key,value) SELECT 'gmail-inbox-page',? WHERE EXISTS(SELECT 1 FROM owner WHERE id=1 AND confirmation_round=?) AND EXISTS(SELECT 1 FROM runtime_cursors WHERE key='background-inbox' AND value=?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(value||'',generation.round,scanning).run();
    return Boolean(result.meta?.changes);
  };
  // Both processing and the provider's invalid-page recovery use this view.
  // Other repository methods retain their original receiver and caches.
  const scopedRepo=new Proxy(repo,{get(target,key){
    if(key==='getCursor')return readCursor;if(key==='setCursor')return writeCursor;
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  async function finish(state){
    const owned="EXISTS(SELECT 1 FROM owner WHERE id=1 AND confirmation_round=?) AND EXISTS(SELECT 1 FROM runtime_cursors WHERE key='background-inbox' AND value=?)";
    // All three compatibility/public cursors are committed in one transaction;
    // update the ownership row last so every statement tests the same value.
    const results=await repo.db.batch([
      repo.db.prepare(`INSERT INTO runtime_cursors(key,value) SELECT 'inbox-status',? WHERE ${owned} ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(state.status,generation.round,scanning),
      repo.db.prepare(`INSERT INTO runtime_cursors(key,value) SELECT 'inbox-status-round',? WHERE ${owned} ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(String(generation.round),generation.round,scanning),
      repo.db.prepare(`UPDATE runtime_cursors SET value=? WHERE key='background-inbox' AND value=? AND EXISTS(SELECT 1 FROM owner WHERE id=1 AND confirmation_round=?)`).bind(JSON.stringify(state),scanning,generation.round),
    ]);
    return Boolean(results.at(-1)?.meta?.changes);
  }
  const started=performance.now();
  let result={ok:true,processed:0},status=configured?'failed':'not-configured';
  try{
    if(configured)result=await processReplies({repo:scopedRepo,env,now,provider:provider?.name==='gmail'?provider:new GmailMailProvider(env)});
    const after=await repo.db.prepare("SELECT confirmation_round,EXISTS(SELECT 1 FROM inbound_mail_log WHERE confirmation_round=owner.confirmation_round AND source='gmail' AND status IN ('failed','processing')) AS blocked FROM owner WHERE id=1").first();
    // A vote may start a new round. A scan of the previous round proves nothing
    // about that new round, even when its last page happened to be empty.
    const closed=!result.failed&&!result.backlog&&!after?.blocked&&after?.confirmation_round===generation.round;
    const age=Date.parse(now)+performance.now()-started-Date.parse(generation.started_at);
    if(configured)status=closed&&age>=0&&age<=300000?'healthy':'degraded';
    const committed=await finish({...generation,status,closed:!configured||closed,completed_at:status==='healthy'?now:null,observed_at:now});
    if(!committed)status='degraded';
    return {...result,status};
  }catch(error){
    await finish({...generation,status:'failed',closed:false,completed_at:null,observed_at:now});
    throw error;
  }
}

export async function runReleaseStage(repo,env,now){
  const owner=await repo.getOwner();if(!owner||owner.pause_mode||owner.release_suspended||env.RELEASE_SUSPENDED==='true')return {released:false,reason:'release-suspended'};
  if(![STATES.VERIFY,STATES.READY_TO_RELEASE,STATES.PRIVATE_RELEASE,STATES.PUBLIC_RELEASE].includes(owner.state))return {released:false,reason:'conditions-not-met'};
  if(!await inboxAllowsDelivery(repo,env,owner.confirmation_round,now))return {released:false,reason:'inbox-unhealthy'};
  const cursor=await repo.getCursor('background-release-channel'),channel=cursor==='private'?'public':'private';
  await repo.getRoundRules(owner);
  const progress=await repo.advanceChannel(owner.confirmation_round,channel,now);
  await repo.setCursor('background-release-channel',channel);
  return {channel,progress};
}

async function queueMail(repo,env,owner,payload,now,artifact=null){
  if(await repo.hasDelivery(payload.dedupeKey))return {skipped:true};
  return enqueueJob(repo,env,{key:payload.dedupeKey+(artifact?':pdf-'+artifact.id:''),kind:'mail',round:owner.confirmation_round,payload:{...payload,round:owner.confirmation_round,...(artifact?{artifactId:artifact.id,artifactRevision:artifact.upload_revision,manifest:artifact.manifest_sha256,artifactChunkBytes:artifact.chunk_bytes??PDF_CHUNK_BYTES}: {})},now});
}

async function discoverPrivate(repo,env,owner,now){
  const key="'private_letter_release:v2:'||i.id||':'||i.delivery_version||':'||lower(trim(COALESCE(r.email,c.email)))";
  const cursorKey=`background-discovery-private:${owner.confirmation_round}`;
  const item=await repo.db.prepare(`SELECT i.id,i.delivery_version,COALESCE(r.email,c.email) AS recipient_email,COALESCE(r.name,c.name) AS recipient_name,COALESCE(r.locale,c.locale,'zh') AS recipient_locale FROM encrypted_items i LEFT JOIN recipients r ON r.id=i.recipient_id LEFT JOIN contacts c ON c.id=i.recipient_contact_id JOIN owner o ON o.id=1 JOIN round_rules rr ON rr.round=o.confirmation_round JOIN release_progress p ON p.round=o.confirmation_round AND p.channel='private' LEFT JOIN runtime_cursors dc ON dc.key=? WHERE o.confirmation_round=? AND o.pause_mode IS NULL AND o.release_suspended=0 AND o.state IN ('PRIVATE_RELEASE','PUBLIC_RELEASE') AND p.released_at IS NOT NULL AND json_extract(rr.rules_json,'$.private.enabled')=1 AND i.release_stage='PRIVATE_RELEASE' AND i.released_at IS NOT NULL AND i.revoked_at IS NULL AND COALESCE(r.active,c.active,0)=1 AND json_valid(i.encrypted_payload) AND json_extract(i.encrypted_payload,'$.mode')='link' AND NOT ${claimExists(key)} AND NOT ${jobExists(key)} ORDER BY CASE WHEN i.id>CAST(COALESCE(dc.value,'0') AS INTEGER) THEN 0 ELSE 1 END,i.id LIMIT 1`).bind(cursorKey,owner.confirmation_round).first();
  if(!item)return {skipped:true};
  await repo.setCursor(cursorKey,String(item.id));
  const context=await artifactContext(repo,env,{kind:'private',id:item.id,metadataOnly:true}),artifact=await findReadyArtifact(repo,context);
  if(!artifact){await repo.recordPrivateDeliveryState(item.id,'pending','pdf-not-ready',now,item.delivery_version);return {pending:true};}
  return queueMail(repo,env,owner,{type:'private',item,dedupeKey:repo.getMailDeliveryKey(item),eventType:'private_letter_release',source:sourceIdentity(context)},now,artifact);
}
function sourceIdentity(context){return {kind:context.kind,item_id:context.item_id,source_revision:context.source_revision,layout_key:context.layout_key,locale:context.locale,settings_revision:context.settings_revision,owner:{display_name:context.owner?.display_name}};}

async function discoverPublic(repo,env,owner,now){
  const key="'public_farewell_release:v2:'||dv.formal_revision||':'||d.updated_at||':'||a.value||':'||lower(trim(COALESCE(c.email,r.email)))";
  const contact=await repo.db.prepare(`SELECT COALESCE(c.id,r.id) AS id,COALESCE(c.email,r.email) AS email,COALESCE(c.name,r.name) AS name,COALESCE(c.locale,r.locale,'zh') AS locale,a.value AS audience_key,CASE WHEN c.id IS NOT NULL THEN 'contact' ELSE 'recipient' END AS type,d.updated_at AS document_at,dv.formal_revision,'background-discovery-public:'||o.confirmation_round||':'||dv.formal_revision||':'||d.updated_at AS cursor_key,${key} AS dedupe_key FROM owner o JOIN round_rules rr ON rr.round=o.confirmation_round JOIN release_progress p ON p.round=o.confirmation_round AND p.channel='public' JOIN public_farewell d ON d.id=1 JOIN farewell_document_versions dv ON dv.id=1 JOIN json_each(rr.rules_json,'$.public.audience') a LEFT JOIN contacts c ON a.value='contact:'||c.id LEFT JOIN recipients r ON a.value='recipient:'||r.id LEFT JOIN runtime_cursors dc ON dc.key='background-discovery-public:'||o.confirmation_round||':'||dv.formal_revision||':'||d.updated_at WHERE o.id=1 AND o.confirmation_round=? AND o.pause_mode IS NULL AND o.release_suspended=0 AND o.state IN ('PRIVATE_RELEASE','PUBLIC_RELEASE') AND p.released_at IS NOT NULL AND json_extract(rr.rules_json,'$.public.enabled')=1 AND json_extract(rr.rules_json,'$.public.pdf')=1 AND COALESCE(c.active,r.active,0)=1 AND NOT ${claimExists(key)} AND NOT ${jobExists(key)} ORDER BY CASE WHEN a.value>COALESCE(dc.value,'') THEN 0 ELSE 1 END,a.value LIMIT 1`).bind(owner.confirmation_round).first();
  if(!contact)return {skipped:true};
  await repo.setCursor(contact.cursor_key,contact.audience_key);
  const context=await artifactContext(repo,env,{kind:'public',locale:contact.locale,metadataOnly:true}),artifact=await findReadyArtifact(repo,context);
  if(!artifact)return {pending:true,reason:'pdf-not-ready'};
  return queueMail(repo,env,owner,{type:'public',contact,dedupeKey:contact.dedupe_key,eventType:'public_farewell_release',source:sourceIdentity(context)},now,artifact);
}

async function discoverTransition(repo,env,owner,now){
  if(owner.pause_mode)return {skipped:true};
  const rules=await repo.getRoundRules(owner);
  if(owner.state===STATES.OVERDUE){
    const settings=await repo.getSettings(env),dedupeKey=`owner_overdue:${owner.timer_anchor_at||owner.last_checkin_at}`;
    return queueMail(repo,env,owner,{type:'owner',dedupeKey,eventType:'owner_overdue',message:{to:owner.email,subject:'AfterMe: '+t(settings.preferences.locale,'overdue_hours')+' · '+rules.overdue_hours+'h',text:t(settings.preferences.locale,'ownerOverdue',{hours:rules.overdue_hours})+'\n'+env.BASE_URL}},now);
  }
  if(!enabled(env.CONTACT_NOTIFICATIONS_ENABLED))return {skipped:true};
  const state=owner.state===STATES.ALERT?STATES.ALERT:[STATES.VERIFY,STATES.READY_TO_RELEASE,STATES.PRIVATE_RELEASE,STATES.PUBLIC_RELEASE].includes(owner.state)?STATES.VERIFY:null;
  if(!state)return {skipped:true};
  const contactIds=[...new Set(['private','public'].flatMap(channel=>rules[channel].enabled?rules[channel].contact_ids:[]))];
  if(!contactIds.length)return {skipped:true};
  const key="?||':'||?||':'||c.id||':round-'||?||':email-'||lower(trim(c.email))";
  const contact=await repo.db.prepare(`SELECT c.* FROM contacts c WHERE c.active=1 AND c.id IN (SELECT value FROM json_each(?)) AND NOT ${claimExists(key)} AND NOT ${jobExists(key)} ORDER BY c.priority,c.id LIMIT 1`).bind(JSON.stringify(contactIds),state,owner.last_checkin_at,owner.confirmation_round,state,owner.last_checkin_at,owner.confirmation_round).first();
  if(!contact)return {skipped:true};
  const dedupeKey=`${state}:${owner.last_checkin_at}:${contact.id}:round-${owner.confirmation_round}:email-${email(contact.email)}`;
  return queueMail(repo,env,owner,{type:'transition',owner,contact,state,dedupeKey,eventType:state===STATES.ALERT?'contact_alert':'contact_verify'},now);
}

export async function runDiscoveryStage(repo,env,now){
  const owner=await repo.getOwner();if(!owner||owner.pause_mode)return {skipped:true};
  const at=Number(await repo.getCursor('background-discovery')||0)%3;
  await repo.setCursor('background-discovery',String((at+1)%3));
  if(at===0)return discoverTransition(repo,env,owner,now);
  if(owner.release_suspended||env.RELEASE_SUSPENDED==='true')return {skipped:true};
  return at===1?discoverPrivate(repo,env,owner,now):discoverPublic(repo,env,owner,now);
}

export async function runNoticeStage(repo,env,now){
  const job=await claimJob(repo,{now,kind:'notice'});if(!job)return {skipped:true};
  const p=await openJobValue(env,job.payload),checkpoint=await openJobValue(env,job.checkpoint),owner=await repo.getOwner();
  const row=await repo.db.prepare('SELECT rules_json FROM round_rules WHERE round=?').bind(p.sourceRound).first();
  if(!row)return checkpointJob(repo,env,job,{state:'cancelled',now});
  let recipient;
  if(!checkpoint.ownerDone){recipient={email:p.ownerEmail,locale:(await repo.getSettings(env)).preferences.locale};checkpoint.ownerDone=true;}
  else {
    recipient=await repo.db.prepare(`SELECT id,email,locale FROM contacts WHERE active=1 AND id<>? AND id>? AND id IN (SELECT value FROM json_each(?,'$.private.contact_ids') UNION SELECT value FROM json_each(?,'$.public.contact_ids')) ORDER BY id LIMIT 1`).bind(p.actor.id,checkpoint.contactId||0,row.rules_json,row.rules_json).first();
    if(recipient)checkpoint.contactId=recipient.id;
  }
  if(!recipient)return checkpointJob(repo,env,job,{checkpoint,state:'completed',now});
  const labels={zh:'核验回复已记录；如果是误报，请本人签到，或联系人提交“误报”。',en:'A verification reply was recorded. If incorrect, the owner should check in or a contact should report a false alarm.',ru:'Ответ проверки записан. При ошибке владельцу нужно отметиться или контакту сообщить о ложной тревоге.'};
  await queueMail(repo,env,owner,{type:'notice',recipientId:recipient.id||null,dedupeKey:`security-confirmation:${p.sourceRound}:${p.actor.id}:${p.status}:${recipient.email}`,eventType:'security_confirmation_notice',message:{to:recipient.email,subject:'AfterMe / verification notice',text:`${labels[recipient.locale]||labels.zh}\n${p.actor.name}: ${p.status}\n${p.at}`}},now);
  return checkpointJob(repo,env,job,{checkpoint,now});
}

export async function prepareStagedMessage(repo,env,job,p,checkpoint){
  const owner=await repo.getOwner(),rules=await repo.getRoundRules(owner),templates=mergeMailTemplates(await repo.listMailTemplates());
  let message=p.message,preparedTokenHash;
  if(p.type==='private')message={...buildPrivateReleaseMail({ownerName:owner.display_name,recipientName:p.item.recipient_name,template:templates.private_release,rules,locale:p.item.recipient_locale}),to:p.item.recipient_email};
  if(p.type==='public')message={...buildPublicReleaseMail({ownerName:owner.display_name,contactName:p.contact.name,template:templates.public_release,rules,locale:p.contact.locale}),to:p.contact.email};
  if(p.type==='transition'){
    message={...(p.state===STATES.ALERT?buildContactAlertMail:buildContactVerifyMail)({ownerName:owner.display_name,contactName:p.contact.name,template:p.state===STATES.ALERT?templates.contact_alert:templates.contact_verify,rules,locale:p.contact.locale}),to:p.contact.email};
    if(p.state===STATES.VERIFY){
      const token=base64url(crypto.getRandomValues(new Uint8Array(32)));
      preparedTokenHash=base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))));
      await repo.rotateContactToken({id:p.contact.id,tokenHash:preparedTokenHash,expectedRound:p.round});
      const from=env.VERIFICATION_EMAIL||env.FROM_EMAIL,at=from?.lastIndexOf('@');
      const inbound=(env.INBOUND_PROVIDER||(env.MAIL_PROVIDER==='gmail'?'gmail':'web'))==='gmail'&&enabled(env.MAIL_INBOUND_ENABLED);
      message={...message,text:message.text+'\n\n'+env.BASE_URL+'/verify/'+token,...(inbound&&at>0?{replyTo:from.slice(0,at).split('+')[0]+'+verify-'+token+from.slice(at)}:{})};
    }
  }
  if(!message)throw Error('Unknown background mail');
  message={...message,from:env.FROM_EMAIL,messageId:'<afterme_'+job.id+'@afterme.invalid>'};
  if(p.artifactId){const artifact=await artifactById(repo,p.artifactId);if(!artifact||artifact.status!=='ready')throw Error('PDF unavailable');message.attachment={filename:p.type==='private'?`${owner.display_name||'AfterMe'}留给您的一封信.pdf`:'afterme-public-farewell.pdf',contentType:'application/pdf',byteLength:artifact.total_bytes};}
  return {...checkpoint,message,preparedTokenHash};
}

export async function stagedMailAllowed(repo,env,job,p,checkpoint,now,{final=true}={}){
  if(p.type==='private'||p.type==='public'){
    const source=p.source,privateMail=p.type==='private',identity=privateMail?p.item:p.contact;
    if(env.RELEASE_SUSPENDED==='true'||!source||source.kind!==p.type||!Number.isSafeInteger(p.round)||!Number.isSafeInteger(source.settings_revision)||typeof source.source_revision!=='string'||typeof source.layout_key!=='string'||!['zh','en','ru'].includes(source.locale)||!source.owner||!(typeof source.owner.display_name==='string'||source.owner.display_name===null)||typeof p.artifactId!=='string'||!Number.isSafeInteger(p.artifactRevision)||p.artifactRevision<0||!(p.manifest===null||typeof p.manifest==='string'&&/^[a-f0-9]{64}$/.test(p.manifest))||!identity||!Number.isSafeInteger(identity.id)||identity.id<1)return false;
    if(privateMail){if(source.item_id!==identity.id||typeof identity.recipient_email!=='string'||(identity.recipient_locale||'zh')!==source.locale)return false;}
    else if(source.item_id!==0||!['contact','recipient'].includes(identity.type)||identity.audience_key!==identity.type+':'+identity.id||typeof identity.email!=='string'||(identity.locale||'zh')!==source.locale||typeof identity.document_at!=='string'||!Number.isSafeInteger(identity.formal_revision))return false;
    if(p.artifactChunkBytes!==undefined&&![16*1024,32*1024,64*1024,128*1024].includes(p.artifactChunkBytes))return false;
    const gmail=final&&(env.INBOUND_PROVIDER||(env.MAIL_PROVIDER==='gmail'?'gmail':'web'))==='gmail'&&enabled(env.MAIL_INBOUND_ENABLED);
    const current=artifactCurrentGuard(source),path='$.'+p.type;
    const joins=privateMail?`JOIN encrypted_items i ON i.id=? LEFT JOIN recipients rc ON rc.id=i.recipient_id LEFT JOIN contacts lc ON lc.id=i.recipient_contact_id`:`JOIN public_farewell d ON d.id=1 JOIN farewell_document_versions dv ON dv.id=1 JOIN ${identity.type==='recipient'?'recipients':'contacts'} recipient ON recipient.id=?`;
    const target=privateMail?`i.delivery_version=? AND lower(trim(COALESCE(rc.email,lc.email)))=? AND COALESCE(rc.active,lc.active,0)=1 AND i.released_at IS NOT NULL AND i.revoked_at IS NULL`:`d.updated_at=? AND dv.formal_revision=? AND recipient.active=1 AND lower(trim(recipient.email))=? AND COALESCE(recipient.locale,'zh')=? AND json_extract(r.rules_json,'$.public.pdf')=1 AND EXISTS(SELECT 1 FROM json_each(r.rules_json,'$.public.audience') audience WHERE audience.value=?)`;
    const targetArgs=privateMail?[identity.delivery_version??0,email(identity.recipient_email)]:[identity.document_at,identity.formal_revision,email(identity.email),source.locale,identity.audience_key];
    // Lease, current round, recipient, frozen quorum/audience, source/layout and
    // artifact binding share one SQLite snapshot. Final inbox state is read in
    // that same snapshot, rather than following the business guard with more I/O.
    const row=await repo.db.prepare(`SELECT 1 AS allowed${gmail?`,(SELECT value FROM runtime_cursors WHERE key='background-inbox') AS inbox_generation,EXISTS(SELECT 1 FROM inbound_mail_log WHERE confirmation_round=o.confirmation_round AND source='gmail' AND status IN ('failed','processing')) AS inbound_blocked`:''}
      FROM background_jobs j JOIN owner o ON o.id=1 JOIN round_rules r ON r.round=o.confirmation_round
      JOIN release_progress progress ON progress.round=o.confirmation_round AND progress.channel='${p.type}'
      JOIN pdf_artifacts artifact ON artifact.id=? ${joins}
      WHERE j.id=? AND j.state='running' AND j.lease_token=? AND j.lease_until>? AND (j.confirmation_round IS NULL OR j.confirmation_round=o.confirmation_round)
      AND o.confirmation_round=? AND o.pause_mode IS NULL AND o.release_suspended=0 AND o.state IN ('PRIVATE_RELEASE','PUBLIC_RELEASE') AND progress.released_at IS NOT NULL
      AND json_extract(r.rules_json,'${path}.enabled')=1
      AND (SELECT COUNT(*) FROM confirmation_votes vote JOIN contacts verifier ON verifier.id=vote.contact_id WHERE vote.round=o.confirmation_round AND verifier.active=1 AND verifier.verification_round=vote.round AND vote.status='confirmed_death' AND verifier.id IN (SELECT value FROM json_each(r.rules_json,'${path}.contact_ids')))>=json_extract(r.rules_json,'${path}.quorum')
      AND ${target} AND ${current.sql}
      AND artifact.status='ready' AND artifact.upload_revision=? AND artifact.manifest_sha256 IS ? AND artifact.kind=? AND artifact.item_id=? AND artifact.source_revision=? AND artifact.layout_key=? AND artifact.locale=?
      AND ((artifact.validation_algorithm IS NULL AND artifact.manifest_sha256 IS NULL) OR (artifact.validation_algorithm=? AND artifact.validation_state='verified' AND artifact.validation_cursor=artifact.chunk_count AND artifact.validation_bytes=artifact.total_bytes))
      ${p.artifactChunkBytes!==undefined?'AND artifact.chunk_bytes=?':''}`)
      .bind(p.artifactId,identity.id,job.id,job.lease_token,now,p.round,...targetArgs,...current.args,p.artifactRevision,p.manifest,p.type,source.item_id,source.source_revision,source.layout_key,source.locale,PDF_MANIFEST_ALGORITHM,...(p.artifactChunkBytes!==undefined?[p.artifactChunkBytes]:[])).first();
    if(!row)return false;
    if(!gmail)return true;
    let generation;try{generation=JSON.parse(row.inbox_generation||'');}catch{return false;}
    return !row.inbound_blocked&&inboxGenerationFresh(generation,p.round,now);
  }
  const lease=await repo.db.prepare("SELECT 1 FROM background_jobs j JOIN owner o ON o.id=1 WHERE j.id=? AND j.state='running' AND j.lease_token=? AND j.lease_until>? AND (j.confirmation_round IS NULL OR j.confirmation_round=o.confirmation_round)").bind(job.id,job.lease_token,now).first();
  if(!lease)return false;
  const owner=await repo.getOwner();if(owner.confirmation_round!==p.round)return false;
  if(p.type==='transition')return enabled(env.CONTACT_NOTIFICATIONS_ENABLED)&&repo.transitionMailAllowed(p.owner,p.contact,p.state,checkpoint.preparedTokenHash||null);
  if(p.type==='owner')return !owner.pause_mode&&owner.state===STATES.OVERDUE&&email(owner.email)===email(p.message.to);
  if(p.type==='notice'){
    if(!p.recipientId)return email(owner.email)===email(p.message.to);
    const contact=await repo.getContact(p.recipientId);return Boolean(contact?.active)&&email(contact.email)===email(p.message.to);
  }
  if(p.type==='service'){
    const target=p.eventType==='mail_healthcheck'?(env.MAIL_HEALTHCHECK_EMAIL||owner.email):p.eventType==='security_alert'?owner.email:null;
    return Boolean(target)&&email(target)===email(p.message?.to);
  }
  return false;
}

export async function recordStagedResult(repo,job,p,checkpoint,result,now){
  if(!checkpoint.finalAttemptId||!p.dedupeKey)return false;
  const expectedClaim={dedupeKey:p.dedupeKey,attemptId:checkpoint.finalAttemptId,status:result.status};
  if(p.type==='private')await repo.recordPrivateDeliveryState?.(p.item.id,result.status,null,now,p.item.delivery_version??0,expectedClaim);
  if(p.type==='transition'&&p.state===STATES.VERIFY&&result.threadId)await repo.setVerificationThread?.(p.contact.id,p.round,result.threadId,expectedClaim);
}

export async function stagedDeliveryReady(repo,env,p,now,job,checkpoint){
  return !['private','public'].includes(p.type)||(job?stagedMailAllowed(repo,env,job,p,checkpoint,now,{final:true}):inboxAllowsDelivery(repo,env,p.round,now));
}

export async function stagedAttachmentRange(repo,env,job,p,checkpoint,start,length){
  return readValidatedArtifactRange(repo,env,{artifact_id:p.artifactId,upload_revision:p.artifactRevision,manifest_sha256:p.manifest,...(p.artifactChunkBytes!==undefined?{chunk_bytes:p.artifactChunkBytes}:{})},start,length);
}

export async function runStagedRuntime(repo,env,now,{processReplies,maintenance,provider=createMailProvider(env),lane}={}){
  repo.invocationRules=new Map();repo.invocationSettings=null;
  const started=performance.now(),currentTime=()=>new Date(Date.parse(now)+performance.now()-started).toISOString();
  const hooks={
    control:()=>runControlStage(repo,env,now),
    inbox:()=>env.BACKGROUND_LANE_SCHEDULING==='true'?runInboxPipelineStep(repo,env,now,{processReplies,provider}):runInboxStage(repo,env,now,processReplies,provider),
    release:()=>runReleaseStage(repo,env,now),
    discover:()=>runDiscoveryStage(repo,env,now),
    notice:()=>runNoticeStage(repo,env,now),
    validate:async()=>{const artifact=await repo.db.prepare("SELECT id FROM pdf_artifacts WHERE status='pending' AND validation_state='validating' ORDER BY updated_at,id LIMIT 1").first();return artifact?runArtifactValidationStep(repo,env,{artifact_id:artifact.id},now):{skipped:true};},
    mail:()=>runStagedMail(repo,env,now,{provider,prepare:(job,p,c)=>prepareStagedMessage(repo,env,job,p,c),canSend:(job,p,c)=>stagedMailAllowed(repo,env,job,p,c,currentTime(),{final:false}),deliveryReady:(job,p,c)=>stagedDeliveryReady(repo,env,p,currentTime(),job,c),readAttachmentRange:(job,p,c,start,length)=>stagedAttachmentRange(repo,env,job,p,c,start,length),onResult:(job,p,c,result)=>recordStagedResult(repo,job,p,c,result,currentTime())}),
    maintenance:()=>maintenance(repo,env,now,provider),
    availability:async()=>repo.db.prepare(`SELECT
      EXISTS(SELECT 1 FROM background_jobs WHERE kind='mail' AND state IN ('pending','running','failed') AND next_attempt_at<=? AND (lease_token IS NULL OR lease_until<=?)) AS mail,
      EXISTS(SELECT 1 FROM pdf_artifacts WHERE status='pending' AND validation_state='validating') AS validate,
      EXISTS(SELECT 1 FROM background_jobs WHERE kind='notice' AND state IN ('pending','running','failed') AND next_attempt_at<=? AND (lease_token IS NULL OR lease_until<=?)) AS notice,
      EXISTS(SELECT 1 FROM owner WHERE id=1 AND pause_mode IS NULL AND state<>'NORMAL') AS discover,
      EXISTS(SELECT 1 FROM owner o JOIN release_progress p ON p.round=o.confirmation_round JOIN round_rules r ON r.round=o.confirmation_round WHERE o.id=1 AND o.pause_mode IS NULL AND o.release_suspended=0 AND o.state IN ('VERIFY','READY_TO_RELEASE','PRIVATE_RELEASE','PUBLIC_RELEASE') AND p.released_at IS NULL AND json_extract(r.rules_json,'$.'||p.channel||'.enabled')=1) AS release`).bind(now,now,now,now).first(),
    available:async kind=>{
      if(kind==='mail'||kind==='notice')return Boolean(await repo.db.prepare("SELECT 1 FROM background_jobs WHERE kind=? AND state IN ('pending','running','failed') AND next_attempt_at<=? AND (lease_token IS NULL OR lease_until<=?) LIMIT 1").bind(kind,now,now).first());
      if(kind==='validate')return Boolean(await repo.db.prepare("SELECT 1 FROM pdf_artifacts WHERE status='pending' AND validation_state='validating' LIMIT 1").first());
      return true;
    },
  };
  return env.BACKGROUND_LANE_SCHEDULING==='true'?runBackgroundLaneTick(repo,env,now,lane,hooks):runBackgroundTick(repo,env,now,hooks);
}
