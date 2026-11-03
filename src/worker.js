// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {
  STATES,
  LIMITS,
  calculateState,
  canReleasePrivate,
  isReleaseGraceComplete,
  isQualifyingConfirmation,
  isoNow,
  shouldSendTransitionEmail,
  validateStoredPayload,
} from "./core.js";
import { buildStoredPayload, openStoredPayload, storedPayloadMode, keyFingerprint } from "./content.js";
import { createMailProvider, GmailMailProvider, findContactReplyToken, isContactVerificationReplySubject, scanContactReplyCommand, sendGuardedMail } from "./mail.js";
import { buildContactAlertMail, buildContactVerifyMail, buildPrivateReleaseMail, buildPublicReleaseMail, mergeMailTemplates, validateMailTemplate } from "./mail-copy.js";
import { buildPrivateLetterPdf, buildPublicFarewellPdf } from "./pdf.js";
import { Repository } from "./repository.js";
import { createAdminSession, validAdminSession } from "./session.js";
import { defaultRules, validateRules, validatePreferences, sensitiveChange, previewRules } from './settings.js';
import { limitedBody, securityHeaders, authenticate, issueSession, sessionCookie, revokeSession, reverify, checkOrigin, rateLimit } from './request-security.js';
import { dashboardPage, loginPage } from './dashboard.js';
import { farewellEditorMarkup, farewellEntryPageMarkup, farewellEntryEditorMarkup, farewellTrashPageMarkup } from './farewell-editor-ui.js';
import { securityState,consumeFactor,beginEnrollment,finishEnrollment } from './mfa.js';
import { startVerificationProof,consumeVerificationProof,notifyConfirmation as notifyConfirmationImmediate } from './verification-security.js';
import { recordSecurityEvent,sendSecurityAlerts } from './security-alerts.js';
import { t, REPLY_COMMANDS,SYSTEM_MAIL } from './i18n.js';
import { PDF_VERSION, pdfOptions,cachedPrivatePdf,cachedPublicPdf,queuePdfJob,processPdfBatch,privatePdfPayload } from './pdf-cache.js';
import {cloudChineseFont} from './pdf-chinese-font.js';
import { verificationPage,verificationResult } from './external-pages.js';
import {boundedPublicReading} from './bounded-public-reading.js';
import { measureDatabase } from './metrics.js';
import { createInvocationBudget, invocationBudget, wrapBudgetDatabase, isInvocationBudgetError,base64ToBytes,bytesToBase64 } from './invocation-budget.js';
import { migrateContentKeys } from './content-key-migration.js';
import { artifactContext,artifactById,publicArtifact,beginArtifact,uploadArtifactChunk,completeArtifact,listPdfPreparationTargets,pdfPreparationSource,assertPublicPdfSourceSize } from './pdf-artifacts.js';
import { refreshOperationalSnapshot,readOperationalSnapshot } from './operational-snapshot.js';
import {dashboardSnapshot} from './dashboard-snapshot.js';
import {runStagedRuntime,runReleaseStage,queueConfirmationNotice} from './staged-runtime.js';
import {backgroundStatus,enqueueJob} from './background-jobs.js';
import {backgroundLaneForCron} from './background-scheduler.js';
import {inboxGenerationFresh,inboxOperationallyHealthy} from './background-scheduler.js';
import {pdfPreviewDescriptor,pdfPreviewChunk} from './pdf-download.js';
import { escapeHtml, homePage, layout, lockedHomePage, mailPreviewPage, publicFarewellPage, vaultPage, verificationResultPage, verifyPage } from "./ui.js";

export const PDF_GENERATOR_VERSION = PDF_VERSION;

export default {
  async fetch(request, env) {
    return fetchApplication(request, env);
  },

  async scheduled(_controller, env) {
    const budget=createInvocationBudget();env={...env,INVOCATION_BUDGET:budget,DB:wrapBudgetDatabase(env.DB,budget)};
    const repo = new Repository(env.DB);
    const lane=env.BACKGROUND_LANE_SCHEDULING==='true'?backgroundLaneForCron(_controller.cron):undefined;
    try{await runScheduledCheck(repo, env, new Date(),createMailProvider(env),{lane});if(env.BACKGROUND_EXECUTION_MODE!=='staged'&&(!invocationBudget(env)||invocationBudget(env).remainingD1>=20))await sendSecurityAlerts(repo,env,isoNow());}catch(error){if(!isInvocationBudgetError(error))await recordSecurityEvent(env,500);throw error;}
  },
};

// Only the bound runtime calls this with rateLimited=true after the edge check.
// No request header, URL parameter or environment variable can grant that flag.
export async function fetchApplication(request, env, {rateLimited=false}={}) {
    try {
      return await handleRequest(request, env, {rateLimited});
    } catch (error) {
      console.error('request_failed', error.status || 500);
      const status = isInvocationBudgetError(error)?503:error.status || 500;
      if(!isInvocationBudgetError(error))try{await recordSecurityEvent(env,status);}catch{}
      return securityHeaders(json({ error: status === 500 ? "internal_error" : "request_error", message: status === 500 ? "系统暂时无法完成操作，请重试。" : error.message }, status));
    }
}

export async function handleRequest(request, env, {rateLimited=false}={}) {
  const started=performance.now(),budget=invocationBudget(env)||createInvocationBudget(),measurement=measureDatabase(wrapBudgetDatabase(env.DB,budget));
  env={...env,DB:measurement.db,INVOCATION_BUDGET:budget};
  if(!rateLimited)await rateLimit(request,env);
  if(['POST','PUT','PATCH','DELETE'].includes(request.method)) await limitedBody(request);
  const response = await dispatchRequest(request, env);
  if(response.status>=400&&budget.remainingD1>=3)await recordSecurityEvent(env,response.status);
  response.headers.set('Server-Timing',`app;dur=${(performance.now()-started).toFixed(1)}, db;dur=${measurement.stats.db_wall_ms.toFixed(1)}, db_total;dur=${measurement.stats.db_ms.toFixed(1)}`);
  if(new URL(request.url).pathname.startsWith('/api/')||new URL(request.url).pathname==='/admin') {
    response.headers.set('X-AfterMe-DB-Queries',String(measurement.stats.queries));response.headers.set('X-AfterMe-DB-Roundtrips',String(measurement.stats.roundtrips));response.headers.set('X-AfterMe-Rows-Read',String(measurement.stats.rows_read));
  }
  const protectedResponse=securityHeaders(response);
  if(new URL(request.url).pathname==='/static/pdf-font.ttf'&&response.ok)protectedResponse.headers.set('Cache-Control','private, max-age=86400');
  return protectedResponse;
}

async function dispatchRequest(request, env) {
  const url = new URL(request.url);
  const repo = new Repository(env.DB);
  repo.invocationBudget=invocationBudget(env);repo.invocationRules=new Map();
  const staticAsset={'/static/pdf-client.js':'/browser/pdf-client.js','/static/pdf-worker.js':'/browser/pdf-worker.js','/static/pdf-font.ttf':'/fonts/afterme-song-sc.ttf'}[url.pathname];
  if(request.method==='GET'&&staticAsset){
    await requireAdmin(request,env);
    if(!env.PDF_FONTS?.fetch)throw new HttpError(503,'PDF browser assets unavailable');
    const response=await env.PDF_FONTS.fetch(new Request(new URL(staticAsset,request.url),{method:'GET'}));
    return new Response(response.body,{status:response.status,headers:{'Content-Type':staticAsset.endsWith('.ttf')?'font/ttf':'text/javascript; charset=utf-8','Cache-Control':'private, max-age=86400','X-Content-Type-Options':'nosniff'}});
  }
  if(url.pathname.startsWith('/api/pdf-artifacts')){
    await requireAdmin(request,env);
    if(request.method==='POST'&&url.pathname==='/api/pdf-artifacts/preview')return json(await pdfPreviewDescriptor(repo,env,await readBody(request)));
    if(request.method==='GET'&&url.pathname==='/api/pdf-artifacts/targets')return json(await listPdfPreparationTargets(repo,env,{cursor:Number(url.searchParams.get('cursor')||0)}));
    if(request.method==='POST'&&url.pathname==='/api/pdf-artifacts')return json(await beginArtifact(repo,env,await readBody(request)),201);
    const match=url.pathname.match(/^\/api\/pdf-artifacts\/([a-f0-9-]{36})(?:\/(source|complete|chunks)(?:\/(\d+))?)?$/);
    if(!match)return json({error:'not_found'},404);
    const [,id,action,index]=match;
    if(request.method==='GET'&&!action){const row=await artifactById(repo,id);return row?json(publicArtifact(row)):json({error:'not_found'},404);}
    if(request.method==='GET'&&action==='source'){
      const row=await artifactById(repo,id);if(!row)return json({error:'not_found'},404);
      const context=await artifactContext(repo,env,{kind:row.kind,id:row.item_id,locale:row.locale,metadataOnly:env.BACKGROUND_EXECUTION_MODE==='staged'});
      if(context.source_revision!==row.source_revision||context.layout_key!==row.layout_key)return json({error:'edit_conflict'},409);
      const source=await pdfPreparationSource(repo,env,context,{cursor:url.searchParams.get('cursor')||undefined});
      const after=await artifactContext(repo,env,{kind:row.kind,id:row.item_id,locale:row.locale,metadataOnly:env.BACKGROUND_EXECUTION_MODE==='staged'});
      if(after.source_revision!==row.source_revision||after.layout_key!==row.layout_key)return json({error:'edit_conflict'},409);
      return json(source);
    }
    if(request.method==='GET'&&action==='chunks'&&index!==undefined)return pdfPreviewChunk(repo,env,{artifact_id:id,index:Number(index),upload_revision:url.searchParams.get('revision'),pin:url.searchParams.get('pin')});
    if(request.method==='PUT'&&action==='chunks'&&index!==undefined)return json(await uploadArtifactChunk(repo,env,id,Number(index),(await readBody(request)).data));
    if(request.method==='POST'&&action==='complete'){const result=await completeArtifact(repo,env,id,await readBody(request));return json(result,result.status==='validating'?202:200);}
    return json({error:'not_found'},404);
  }
  if(request.method==='GET'&&url.pathname==='/favicon.ico')return new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="10" fill="#171917"/><text x="10" y="49" font-family="Georgia,serif" font-size="48" fill="#d5dfad">A</text></svg>',{headers:{'Content-Type':'image/svg+xml'}});

  if (request.method === 'POST' && url.pathname === '/api/session') {
    checkOrigin(request);
    const body = await readBody(request);
    if (!env.ADMIN_TOKEN || body.admin_token !== env.ADMIN_TOKEN) throw new HttpError(401, '登录口令不正确。');
    const security=await securityState(env);
    if(security.enabled&&!await consumeFactor(env,body.mfa_code,security))return json({error:'mfa_required',message:'请输入验证器动态码或一次性恢复码。'},401);
    const session=await issueSession(env,Date.now(),Boolean(security.enabled),security.revision);
    const response=json({ok:true,...session});
    response.headers.set('Set-Cookie',sessionCookie(session.token,url.protocol==='https:'));
    return response;
  }

  if(url.pathname==='/api/security'&&request.method==='GET') {
    await requireAdmin(request,env);const state=await securityState(env);
    return json({enabled:Boolean(state.enabled),revision:state.revision,recovery_remaining:Number((await env.DB.prepare('SELECT COUNT(*) AS count FROM admin_recovery_codes WHERE enrollment_id=? AND used_at IS NULL').bind(state.pending_id||'').first()).count)});
  }
  if(url.pathname.startsWith('/api/security/mfa/')&&request.method==='POST') {
    const auth=await requireAdmin(request,env),body=await readBody(request);if(url.pathname!=='/api/security/mfa/disable')await reverify(request,env,body,auth);
    if(url.pathname==='/api/security/mfa/start')return json({ok:true,...await beginEnrollment(env)});
    if(url.pathname==='/api/security/mfa/enable'){
      if(!await finishEnrollment(env,{...body,code:body.mfa_code,acknowledged:body.acknowledged===true}))throw new HttpError(400,'验证码、绑定期限或恢复码保存确认不正确。');
    }else if(url.pathname==='/api/security/mfa/disable'){
      const state=await securityState(env);
      if(body.admin_password!==env.ADMIN_TOKEN||!await consumeFactor(env,body.mfa_code,state))throw new HttpError(401,'关闭双重验证需要口令和新的动态码／恢复码。');
      await env.DB.batch([env.DB.prepare('UPDATE admin_security SET enabled=0,secret_payload=NULL,pending_payload=NULL,pending_id=NULL,pending_expires=NULL,last_counter=-1,revision=revision+1 WHERE id=1 AND revision=?').bind(state.revision),env.DB.prepare('DELETE FROM admin_recovery_codes')]);
    }else return json({error:'not_found'},404);
    await env.DB.prepare('DELETE FROM admin_sessions').run();
    const security=await securityState(env),session=await issueSession(env,Date.now(),Boolean(security.enabled),security.revision);
    await repo.audit(security.enabled?'mfa_enabled':'mfa_disabled',{},isoNow());
    const owner=await repo.getOwner();
    if(owner)try{await sendGuardedMail({repo,env,provider:createMailProvider(env),eventType:'security_mfa_notice',to:owner.email,subject:'AfterMe / login security changed',text:`AfterMe MFA ${security.enabled?'enabled':'disabled'}. If you did not make this change, review your deployment and login credentials immediately.`,dedupeKey:'security-mfa:'+security.revision,now:isoNow()});}catch{await repo.audit('security_notice_failed',{kind:'mfa'},isoNow());}
    const response=json({ok:true,...session,enabled:Boolean(security.enabled)});response.headers.set('Set-Cookie',sessionCookie(session.token,url.protocol==='https:'));return response;
  }

  if(url.pathname==='/api/logout'&&request.method==='POST') {
    const auth=await requireAdmin(request,env); await revokeSession(env,auth);
    const response=json({ok:true}); response.headers.set('Set-Cookie',sessionCookie('',url.protocol==='https:')); return response;
  }
  if(url.pathname==='/api/settings'&&request.method==='GET') {
    const auth=await requireAdmin(request,env),snapshot=await dashboardSnapshot(repo,env);
    return json({...snapshot.settings,round:snapshot.owner?snapshot.rules:null,progress:snapshot.progress,counts:{private:snapshot.counts.private,public:snapshot.counts.public},owner:snapshot.owner,csrf:auth.csrf});
  }
  if(url.pathname==='/api/settings'&&request.method==='PUT') {
    const auth=await requireAdmin(request,env), body=await readBody(request), current=await repo.getSettings(env);
    const revision=requireRevision(body.revision), rules=validateRules(body.rules), preferences=validatePreferences(body.preferences,current.mail_cap);
    if((sensitiveChange(current.active,rules)||sensitiveChange(current.pending||current.active,rules))&&JSON.stringify(rules)!==JSON.stringify(current.pending||current.active)) await reverify(request,env,body,auth);
    const contacts=(await repo.listContacts()).results, recipients=(await repo.listRecipients()).results;
    if(['private','public'].some(k=>rules[k].contact_ids.some(id=>!contacts.some(c=>c.id===id)))||rules.public.audience.some(v=>{const [type,id]=v.split(':');return !(type==='contact'?contacts:recipients).some(c=>c.id===Number(id));})) throw new HttpError(400,'Unknown contact or recipient');
    const profile=body.profile?{display_name:requireString(body.profile.display_name,'display_name'),email:requireString(body.profile.email,'email')}:null;
    const languages=[];
    for(const [table,key] of [['contacts','contact_languages'],['recipients','recipient_languages']]) {
      for(const [id,locale] of Object.entries(body[key]||{})) {
        if(!/^\d+$/.test(id)||!['zh','en','ru'].includes(locale)) throw new HttpError(400,'Invalid recipient language');
        languages.push({table,id:Number(id),locale});
      }
    }
    if(!await repo.saveSettings({revision,preferences,rules,profile,languages,now:isoNow()})) return json({error:'edit_conflict',current:await repo.getSettings(env)},409);
    await repo.audit('settings_saved',{revision:revision+1,pending:true},isoNow());
    return json({ok:true,...await repo.getSettings(env)});
  }
  if(url.pathname==='/api/settings/preview'&&request.method==='POST') {
    await requireAdmin(request,env); const body=await readBody(request),owner=await repo.getOwner();
    return json(previewRules(body.rules,body.anchor_at||owner?.timer_anchor_at||owner?.last_checkin_at||isoNow(),(await repo.listContacts()).results,Number(env.MAX_DAILY_EMAILS||20),body.daily_email_limit));
  }
  if(url.pathname==='/api/pause'&&request.method==='POST') {
    await requireAdmin(request,env); const body=await readBody(request),now=isoNow();
    if(!['automatic','manual'].includes(body.mode)||!Number.isFinite(Date.parse(body.until))||Date.parse(body.until)<=Date.now()||Date.parse(body.until)>Date.now()+365*86400000) throw new HttpError(400,'Invalid pause');
    await repo.pause({until:new Date(body.until).toISOString(),mode:body.mode,now}); await repo.audit('travel_pause',{mode:body.mode,until:body.until},now); return json({ok:true,owner:await repo.getOwner()});
  }
  if(url.pathname==='/api/resume'&&request.method==='POST') {
    await requireAdmin(request,env); await repo.checkin(isoNow()); return json({ok:true,owner:await repo.getOwner()});
  }
  if(url.pathname==='/api/items/directory'&&request.method==='GET') {
    await requireAdmin(request,env); return json(await repo.directory({...pageParameters(url)}));
  }
  const lazyItem=url.pathname.match(/^\/api\/items\/(\d+)\/content$/);
  if(lazyItem&&request.method==='GET') {
    await requireAdmin(request,env); const item=await repo.getEncryptedItemForAdmin(Number(lazyItem[1])); if(!item) return json({error:'not_found'},404);
    return json((await preparePrivateItemsForAdmin([item],env))[0]);
  }
  if(url.pathname==='/api/logs'&&request.method==='GET') {
    await requireAdmin(request,env); const type=url.searchParams.get('type')==='inbound'?'inbound_mail_log':'delivery_log',{cursor,limit}=pageParameters(url);
    const rows=(await repo.db.prepare(`SELECT rowid AS cursor,* FROM ${type} ${cursor?'WHERE rowid<?':''} ORDER BY rowid DESC LIMIT ?`).bind(...(cursor?[cursor]:[]),limit+1).all()).results;
    return json({results:rows.slice(0,limit),next_cursor:rows.length>limit?rows[limit-1].cursor:null});
  }

  if (request.method === 'POST' && url.pathname === '/api/public-farewell-v2/changes') {
    await requireAdmin(request, env);
    return json({ok:true,...await repo.farewell.getChanges()});
  }

  if (request.method === 'POST' && url.pathname === '/api/maintenance/content-key-migrate') {
    const auth=await requireAdmin(request, env),body=await readBody(request);await reverify(request,env,body,auth);
    if (!env.CONTENT_ENCRYPTION_KEY) return json({ error: '独立内容密钥尚未配置' }, 409);
    const result=await migrateContentKeys(repo,env,{cursor:Number(body.cursor||0),artifact_cursor:Number(body.artifact_cursor||0),job_cursor:Number(body.job_cursor||0),manifest_cursor:Number(body.manifest_cursor||0),limit:Math.min(10,Number(body.limit||1))});
    await repo.audit('content_key_migrated',{fingerprint:result.fingerprint,migrated:result.migrated,verified:result.verified,conflicts:result.conflicts,has_more:result.has_more},isoNow());
    return json(result);
  }

  const revocation = url.pathname.match(/^\/api\/items\/(\d+)\/(revoke|restore)$/);
  if (request.method === 'POST' && revocation) {
    await requireAdmin(request, env);
    const id = Number(revocation[1]);
    const item = await repo.getEncryptedItemForAdmin(id);
    if (!item) return json({ error: '信件不存在' }, 404);
    const now = isoNow();
    await repo.db.prepare('UPDATE encrypted_items SET revoked_at = ?, released_at = NULL, revision = revision + 1 WHERE id = ?').bind(revocation[2] === 'revoke' ? now : null, id).run();
    await repo.audit('private_item_' + revocation[2], { item_id: id }, now);
    return json({ ok: true });
  }

  if (request.method === 'POST' && url.pathname === '/api/mail/reconcile') {
    await requireAdmin(request, env);
    const body = await readBody(request);
    if (!['delivered', 'retry'].includes(body.resolution)) return json({ error: 'invalid resolution' }, 400);
    const claim = await repo.db.prepare("SELECT * FROM mail_claims WHERE dedupe_key = ? AND (status = 'uncertain' OR (status = 'sending' AND julianday(claimed_at) < julianday('now') - 15.0 / 1440))").bind(body.dedupe_key || '').first();
    if (!claim) return json({ error: '没有需要核对的投递' }, 409);
    const status = body.resolution === 'delivered' ? 'sent' : 'failed';
    const staged=env.BACKGROUND_EXECUTION_MODE==='staged',now=isoNow();
    const hasAttempt=Object.hasOwn(claim,'attempt_id');
    const identity=`dedupe_key=? AND status=? AND claimed_at=?${hasAttempt?' AND attempt_id IS ?':''}`;
    const expected=[claim.dedupe_key,claim.status,claim.claimed_at,...(hasAttempt?[claim.attempt_id]:[])];
    // D1 batches are transactional. Keep the claim unchanged until the final
    // statement so every dependent write tests the same previously read attempt.
    // A receipt or another reconciliation winning the race makes the whole batch
    // a no-op; invalidating attempt_id also fences an old in-flight response.
    const results=await repo.db.batch([
      repo.db.prepare(`UPDATE delivery_log SET status=?,last_error=NULL WHERE dedupe_key=? AND EXISTS(SELECT 1 FROM mail_claims WHERE ${identity})`).bind(status,claim.dedupe_key,...expected),
      ...(staged?[repo.db.prepare(`UPDATE background_jobs SET state=CASE WHEN ?='completed' THEN 'completed' WHEN confirmation_round IS NULL OR confirmation_round=(SELECT confirmation_round FROM owner WHERE id=1) THEN 'pending' ELSE 'cancelled' END,checkpoint=NULL,lease_token=NULL,lease_until=NULL,attempt_id=NULL,next_attempt_at=?,last_error=NULL,updated_at=? WHERE dedupe_key=? AND state IN ('running','pending','failed','uncertain') AND EXISTS(SELECT 1 FROM mail_claims WHERE ${identity})`).bind(body.resolution==='delivered'?'completed':'pending',now,now,claim.dedupe_key,...expected)]:[]),
      repo.db.prepare(`UPDATE mail_claims SET status=?,last_error=NULL${hasAttempt?',attempt_id=NULL':''}${staged?',provider_message_id=NULL,provider_thread_id=NULL':''} WHERE ${identity}`).bind(status,...expected),
    ]);
    if(!results.at(-1)?.meta?.changes)return json({error:'投递状态已变化，请刷新后重新核对'},409);
    await repo.audit('mail_reconciled', { dedupe_key: claim.dedupe_key, resolution: body.resolution }, isoNow());
    return isForm(request) ? renderHome(repo, body.admin_token, env) : json({ ok: true });
  }
  if(request.method==='POST'&&url.pathname==='/api/inbound/reconcile'){
    const auth=await requireAdmin(request,env),body=await readBody(request);await reverify(request,env,body,auth);
    const round=requireRevision(body.expected_round);
    if(round<1||typeof body.gmail_message_id!=='string'||!body.gmail_message_id||body.gmail_message_id.length>256||typeof body.note!=='string'||!body.note.trim()||body.note.length>2000||!['ignore','retry'].includes(body.resolution))throw new HttpError(400,'Choose a resolution and record a review note');
    const now=isoNow(),changed=await repo.reconcileInboundMessage({gmailMessageId:body.gmail_message_id,resolution:body.resolution,note:body.note,expectedRound:round,now});
    if(!changed)return json({error:'edit_conflict',message:'The inbound message or round changed; reload before reconciling'},409);
    await repo.audit('inbound_reconciled',{gmail_message_id:body.gmail_message_id,resolution:body.resolution,round},now);
    return json({ok:true});
  }

  if (request.method === "GET" && url.pathname === "/") {
    return loginPage();
  }
  if(request.method==='GET'&&url.pathname==='/admin') {try{const auth=await requireAdmin(request,env);return renderHome(repo,'',env,auth.csrf);}catch(e){if(e.status===401)return loginPage();throw e;}}
  if(request.method==='GET'&&url.pathname==='/admin/legacy') {
    const auth=await requireAdmin(request,env); return renderLegacyHome(repo,auth.token||'',env);
  }
  if(request.method==='GET'&&url.pathname==='/api/chapters') {
    await requireAdmin(request,env);const {limit}=pageParameters(url,{compound:true}),cursor=url.searchParams.get('cursor')||'0',parts=cursor.split(':').map(Number);
    if(cursor!=='0'&&(!/^\d+:\d+$/.test(cursor)||parts.some(n=>!Number.isSafeInteger(n))))throw new HttpError(400,'Invalid cursor');
    const rows=(await repo.db.prepare(`SELECT g.id,substr(g.draft_title,1,160) AS draft_title,g.revision,g.draft_sort_order,(SELECT COUNT(*) FROM public_farewell_entries_v2 e WHERE e.draft_group_id=g.id AND e.draft_is_deleted=0) AS entry_count FROM public_farewell_groups_v2 g WHERE g.draft_is_deleted=0 ${cursor==='0'?'':'AND (g.draft_sort_order,g.id)>(?,?)'} ORDER BY g.draft_sort_order,g.id LIMIT ?`).bind(...(cursor==='0'?[]:parts),limit+1).all()).results;
    return json({results:rows.slice(0,limit),next_cursor:rows.length>limit?rows[limit-1].draft_sort_order+':'+rows[limit-1].id:null});
  }
  if(request.method==='GET'&&url.pathname==='/api/public-farewell-v2/editor') {
    const auth=await requireAdmin(request,env),id=Number(url.searchParams.get('group')||0);
    if(!Number.isSafeInteger(id)||id<0)throw new HttpError(400,'Invalid group');
    const [state,rules]=await Promise.all([repo.farewell.getEditorPage({groupId:id}),repo.getOwner().then(owner=>owner?repo.getRoundRules(owner):repo.getSettings(env).then(s=>s.active))]);
    const tokenInput=auth.token?`<input type="hidden" name="admin_token" value="${escapeHtml(auth.token)}">`:'';
    const summary=g=>g?{id:g.id,draft_title:g.draft_title,revision:g.revision,draft_sort_order:g.draft_sort_order,entry_count:g.entry_count}:null;
    return json({html:farewellEditorMarkup({state,tokenInput,embedded:true,releaseGraceHours:rules.public.grace_hours,releaseQuorum:rules.public.quorum}),
      directory:{results:state.draft_groups.map(summary),next_cursor:state.next_group_cursor,selected:summary(state.editor_group)}});
  }
  const chapter=url.pathname.match(/^\/api\/chapters\/(\d+)$/);
  if(request.method==='GET'&&chapter) {
    const auth=await requireAdmin(request,env),id=Number(chapter[1]),{cursor,limit}=pageParameters(url,{compound:true});
    const page=await repo.farewell.getEntryPage({groupId:id,cursor,limit:Math.min(50,limit)});
    return json({...page,html:farewellEntryPageMarkup(page.results,[],auth.token?`<input type="hidden" name="admin_token" value="${escapeHtml(auth.token)}">`:'')});
  }
  const entryContent=url.pathname.match(/^\/api\/public-farewell-v2\/entries\/(\d+)\/content$/);
  if(request.method==='GET'&&entryContent){
    const auth=await requireAdmin(request,env),entry=await repo.farewell.getEntryEditor(Number(entryContent[1]));
    if(!entry)return json({error:'not_found'},404);
    return json({entry,html:farewellEntryEditorMarkup(entry,[],auth.token?`<input type="hidden" name="admin_token" value="${escapeHtml(auth.token)}">`:'')});
  }
  const formalChapter=url.pathname.match(/^\/api\/chapters\/(\d+)\/formal$/);
  if(request.method==='GET'&&formalChapter){
    await requireAdmin(request,env);const before=await repo.farewell.getVersions(),expected=url.searchParams.get('revision');
    if(expected!==null&&(!/^\d+$/.test(expected)||Number(expected)!==before.formal_revision))return json({error:'edit_conflict',current:before},409);
    const page=await repo.farewell.getFormalPage({groupId:Number(formalChapter[1]),cursor:url.searchParams.get('cursor')||'0',limit:50,byteLimit:65536});
    const after=await repo.farewell.getVersions();if(after.formal_revision!==before.formal_revision)return json({error:'edit_conflict',current:after},409);
    return json({...page,formal_revision:before.formal_revision});
  }
  if(request.method==='GET'&&url.pathname==='/api/public-farewell-v2/trash'){
    const auth=await requireAdmin(request,env),kind=url.searchParams.get('kind')||'entries',page={...await repo.farewell.getTrashPage({kind,cursor:Number(url.searchParams.get('cursor')||0),limit:50}),kind};
    return json({...page,html:farewellTrashPageMarkup(page,auth.token?`<input type="hidden" name="admin_token" value="${escapeHtml(auth.token)}">`:'')});
  }
  if(url.pathname==='/api/mail/templates'&&request.method==='GET') {await requireAdmin(request,env);const locale=(await repo.getSettings(env)).preferences.locale;return json({results:Object.values(mergeMailTemplates(await repo.listMailTemplates())).map(c=>({...c,...(!c.customized&&SYSTEM_MAIL[locale]?SYSTEM_MAIL[locale][c.key]:{}),legacy_timing_warning:c.customized&&/\b(48|72|120)\b|三名|三人|三天/.test(c.body_template) }))});}
  if(url.pathname==='/api/maintenance/status'&&request.method==='GET') {
    await requireAdmin(request,env);const health=await repo.getOperationalHealth();
    if(env.BACKGROUND_EXECUTION_MODE==='staged')health.background={jobs:await backgroundStatus(repo),scheduler:env.BACKGROUND_LANE_SCHEDULING==='true'?(await repo.db.prepare('SELECT lane,control_at,inbox_at,maintenance_at,last_stage,last_error,updated_at FROM background_lane_leases ORDER BY lane').all()).results:await repo.db.prepare('SELECT control_at,inbox_at,maintenance_at,last_stage,last_error,updated_at FROM background_scheduler WHERE id=1').first()};
    return json(health);
  }
  if(url.pathname==='/api/pdf/jobs'&&request.method==='GET') {await requireAdmin(request,env);return json({results:(await repo.db.prepare('SELECT * FROM pdf_jobs ORDER BY id DESC LIMIT 10').all()).results});}
  if(url.pathname==='/api/pdf/jobs/advance'&&request.method==='POST') {await requireAdmin(request,env);return json(await processPdfBatch(repo,env,isoNow()));}

  if (request.method === "GET" && url.pathname === "/farewell") {
    try {
      return await boundedPublicReading(repo,env,url);
    } catch (error) {
      if([400,404].includes(error.status))return new Response(error.status===404?'Chapter not found':'Invalid reading cursor',{status:error.status});
      console.error('public_page_unavailable');
      return new Response('页面暂时无法读取，请稍后重试。', { status: 503 });
    }
  }

  if (request.method === "POST" && url.pathname === "/admin") {
    const body = await readBody(request);
    const auth=await requireAdmin(request, env);
    if(body.admin_token===env.ADMIN_TOKEN) {
      const session=await issueSession(env), response=await renderHome(repo,'',env,session.csrf);
      response.headers.set('Set-Cookie',sessionCookie(session.token,url.protocol==='https:'));return response;
    }
    return renderHome(repo,'',env,auth.csrf);
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/health/operational") {
    const result = readOperationalSnapshot(await repo.getCursor('public-health'));
    if(env.BACKGROUND_EXECUTION_MODE==='staged'){
      const row=await repo.db.prepare("SELECT o.confirmation_round,o.pause_mode,c.value AS control,i.value AS inbox,EXISTS(SELECT 1 FROM inbound_mail_log WHERE confirmation_round=o.confirmation_round AND source='gmail' AND status IN ('failed','processing')) AS inbound_blocked FROM owner o LEFT JOIN runtime_cursors c ON c.key='background-control' LEFT JOIN runtime_cursors i ON i.key='background-inbox' WHERE o.id=1").first();
      let control={},inbox={};try{control=JSON.parse(row?.control||'{}');inbox=JSON.parse(row?.inbox||'{}');}catch{}
      const fresh=at=>{const age=Date.now()-Date.parse(at||'');return Number.isFinite(age)&&age>=0&&age<=300000;};
      result.checks.cron_fresh=control.round===row?.confirmation_round&&fresh(control.completed_at);
      const gmail=(env.INBOUND_PROVIDER||(env.MAIL_PROVIDER==='gmail'?'gmail':'web'))==='gmail'&&enabledUnlessFalse(env.MAIL_INBOUND_ENABLED);
      const at=new Date().toISOString(),lanes=env.BACKGROUND_LANE_SCHEDULING==='true';
      result.checks.gmail_inbound_healthy=Boolean(row?.pause_mode)||!gmail||(lanes?inboxOperationallyHealthy(inbox,row?.confirmation_round,at,{blocked:Boolean(row?.inbound_blocked)}):inboxGenerationFresh(inbox,row?.confirmation_round,at)&&!row?.inbound_blocked);
      result.verification_inbox_ready=!row?.pause_mode&&(!gmail||inboxGenerationFresh(inbox,row?.confirmation_round,at)&&!row?.inbound_blocked);
      const age=Date.now()-Date.parse(result.snapshot_at||'');
      result.ok=lanes?Number.isFinite(age)&&age>=0&&age<=15*60000&&Object.values(result.checks).every(check=>check===true):result.ok&&result.checks.cron_fresh&&result.checks.gmail_inbound_healthy;
    }
    return new Response(JSON.stringify(result, null, 2), {
      status: result.ok ? 200 : 503,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  if (request.method === "POST" && url.pathname === "/api/setup") {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const now = isoNow();
    await repo.setupOwner({ displayName: body.display_name || "Owner", email: requireString(body.email, "email"), now });
    await repo.audit("setup_owner", { email: body.email }, now);
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/checkin") {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const now = isoNow();
    const resumeRelease = parseBool(body.resume_release);
    await repo.checkin(now);
    await repo.clearConfirmations();
    if (resumeRelease) await repo.setReleaseSuspended(false, now);
    await repo.audit("checkin", { cleared_confirmations: true, release_resumed: resumeRelease }, now);
    if (isForm(request)) return renderHome(repo, body.admin_token || "", env);
    return json({ ok: true, state: STATES.NORMAL, last_checkin_at: now, release_suspended: resumeRelease ? false : undefined });
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    await requireAdmin(request, env);
    const owner=await repo.getOwner(); return json({ owner: ownerWithEffectiveState(owner,new Date(),owner?await repo.getRoundRules(owner):null) });
  }

  if (request.method === "POST" && url.pathname === "/api/mail/test") {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const owner = await repo.getOwner();
    const to = optionalString(body.email) || owner?.email;
    if (!to) return json({ error: "email is required" }, 400);
    const now = isoNow();
    const provider = createMailProvider(env);
    const result = await sendGuardedMail({
      repo,
      provider,
      env,
      eventType: "mail_test",
      to,
      subject: "AfterMe mail health check",
      text: `这是一封 AfterMe 邮件通道测试。\n\n时间：${now}\nProvider：${provider.name}\nBase URL：${env.BASE_URL || "未配置"}`,
      dedupeKey: `mail_test:${now}:${to}`,
      now,
    });
    if (isForm(request)) {
      return layout({ title: "邮件测试结果", body: `<h1>邮件测试结果</h1><pre>${escapeForPre(JSON.stringify(result, null, 2))}</pre>` });
    }
    return json({ ok: result.status === "sent" || result.status === "dry_run", provider: provider.name, result });
  }

  if (["GET", "POST"].includes(request.method) && url.pathname === "/api/mail/preview") {
    await requireAdmin(request, env);
    const owner = await repo.getOwner();
    const ownerName = owner?.display_name || "本人";
    const templates = mergeMailTemplates(await repo.listMailTemplates());
    const rules=owner?await repo.getRoundRules(owner):defaultRules(),locale=(await repo.getSettings(env)).preferences.locale;
    const messages={
      alert: buildContactAlertMail({ ownerName, contactName:t(locale,'name'), template: templates.contact_alert,rules,locale }),
      verify: buildContactVerifyMail({ ownerName, contactName:t(locale,'name'), template: templates.contact_verify,rules,locale }),
      publicMail: buildPublicReleaseMail({ ownerName, contactName:t(locale,'name'), template: templates.public_release,rules,locale }),
      privateMail: buildPrivateReleaseMail({
        ownerName,
        recipientName: "收件人姓名",
        content: "[这里会显示您为该收件人保存的私人信件正文]",
        template: templates.private_release,
        rules,locale,
      }),
    };
    return layout({title:t(locale,'mailPreview'),locale,body:`<h1>${escapeHtml(t(locale,'mailPreview'))}</h1><p>${escapeHtml(t(locale,'previewOnly'))}</p>${Object.values(messages).map(m=>`<section class="panel"><h2>${escapeHtml(m.subject)}</h2><pre>${escapeForPre(m.text)}</pre></section>`).join('')}`});
  }

  if (request.method === "POST" && url.pathname === "/api/mail/templates") {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const key = requireString(body.template_key, "template_key");
    const subjectTemplate = requireString(body.subject_template, "subject_template");
    const bodyTemplate = requireString(body.body_template, "body_template");
    const validation = validateMailTemplate({ key, subjectTemplate, bodyTemplate });
    if (!validation.ok) return json({ error: "invalid_mail_template", message: validation.error }, 400);
    const now = isoNow();
    await repo.upsertMailTemplate({ key, subjectTemplate, bodyTemplate, now });
    await repo.audit("mail_template_updated", { template_key: key }, now);
    return json({ ok: true, template_key: key, updated_at: now });
  }

  if (request.method === "POST" && url.pathname === "/api/mail/templates/reset") {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const key = requireString(body.template_key, "template_key");
    const validation = validateMailTemplate({ key, subjectTemplate: "default", bodyTemplate: "default" });
    if (!validation.ok) return json({ error: "invalid_mail_template", message: validation.error }, 400);
    const now = isoNow();
    await repo.resetMailTemplate(key);
    await repo.audit("mail_template_reset", { template_key: key }, now);
    return json({ ok: true, template_key: key, reset: true });
  }
  if (request.method === "POST" && url.pathname === "/api/suspend-release") {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const now = isoNow();
    const suspended = parseBool(body.release_suspended);
    if (!suspended) {
      return json({ error: "resume requires a fresh checkin with resume_release=1" }, 400);
    }
    await repo.setReleaseSuspended(true, now);
    await repo.audit("release_suspended", { value: true }, now);
    if (isForm(request)) return renderHome(repo, body.admin_token || "", env);
    return json({ ok: true, release_suspended: true });
  }

  if ((request.method === "GET" || request.method === "POST") && url.pathname === "/api/export") {
    const auth=await requireAdmin(request, env);
    const body = request.method === "POST" ? await readBody(request) : {};
    const includePayloads = url.searchParams.get("include_payloads") === "1" || parseBool(body.include_payloads);
    if(includePayloads) await reverify(request,env,body,auth);
    const backup = await repo.exportBackup({ includePayloads });
    if (includePayloads) await repo.audit('complete_backup_exported', { schema_version: backup.schema_version }, backup.exported_at);
    const response = json(backup);
    response.headers.set('Content-Disposition', `attachment; filename="afterme-${includePayloads ? 'recovery-backup' : 'metadata'}-${backup.exported_at.slice(0, 10)}.json"`);
    return response;
  }

  if (request.method === "GET" && url.pathname === "/api/legal-will") {
    await requireAdmin(request, env);
    return json({ legal_will: await repo.getLegalWill() });
  }

  if (request.method === "POST" && url.pathname === "/api/legal-will") {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const status = body.status || "not_started";
    if (!["not_started", "drafted", "signed", "notarized"].includes(status)) {
      return json({ error: "invalid legal will status" }, 400);
    }
    const now = isoNow();
    await repo.upsertLegalWill({
      status,
      location: optionalString(body.location),
      custodian: optionalString(body.custodian),
      notes: optionalString(body.notes),
      now,
    });
    await repo.audit("legal_will_upsert", { status }, now);
    if (isForm(request)) return layout({ title: "已保存", body: "<p>法律遗嘱位置记录已保存。</p>" });
    return json({ ok: true, status });
  }


  if (request.method === "POST" && url.pathname === "/api/public-farewell-v2/groups") {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const now = isoNow();
    const id = await repo.farewell.createGroup({ title: requireString(body.title, "title"), now });
    await repo.audit("public_farewell_v2_group_draft_created", { id }, now);
    return json({ ok: true, id });
  }

  const farewellGroupDraftMatch = url.pathname.match(/^\/api\/public-farewell-v2\/groups\/(\d+)$/);
  if (request.method === "POST" && farewellGroupDraftMatch) {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const now = isoNow();
    const result = await repo.farewell.saveGroupDraft({
      id: Number(farewellGroupDraftMatch[1]),
      title: requireString(body.title, "title"),
      epigraph: optionalString(body.epigraph),
      now,
      expectedRevision: requireRevision(body.expected_revision),
    });
    if (!result.found) return json({ error: "group not found" }, 404);
    if (result.conflict) return json({ ok: false, error: 'edit_conflict', message: '其他页面已修改这个分组。请选择要保留的版本。', current: result.current }, 409);
    return json({ ok: true, ...result, saved_at: now });
  }

  if (request.method === "POST" && url.pathname === "/api/public-farewell-v2/entries") {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const now = isoNow();
    const id = await repo.farewell.createEntry({
      groupId: Number(requireString(body.group_id, "group_id")),
      body: requireString(body.body, "body"),
      isPublic: parseBool(body.is_public),
      now,
    });
    if (!id) return json({ error: "target group not found" }, 404);
    await repo.audit("public_farewell_v2_entry_draft_created", { id }, now);
    return json({ ok: true, id });
  }

  const farewellEntryDraftMatch = url.pathname.match(/^\/api\/public-farewell-v2\/entries\/(\d+)$/);
  if (request.method === "POST" && farewellEntryDraftMatch) {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const now = isoNow();
    const result = await repo.farewell.saveEntryDraft({
      id: Number(farewellEntryDraftMatch[1]),
      body: requireString(body.body, "body"),
      isPublic: parseBool(body.is_public),
      groupId: Number(requireString(body.group_id, "group_id")),
      now,
      expectedRevision: requireRevision(body.expected_revision),
    });
    if (!result.found) return json({ error: "entry or target group not found" }, 404);
    if (result.conflict) return json({ ok: false, error: 'edit_conflict', message: '其他页面已修改这个条目。请选择要保留的版本。', current: result.current }, 409);
    return json({ ok: true, ...result, saved_at: now });
  }

  const farewellReorderMatch = url.pathname.match(/^\/api\/public-farewell-v2\/(groups|entries)\/(\d+)\/reorder$/);
  if (request.method === "POST" && farewellReorderMatch) {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const direction = body.direction;
    if (!["top", "up", "down", "bottom"].includes(direction)) return json({ error: "invalid direction" }, 400);
    const now = isoNow();
    const kind = farewellReorderMatch[1] === "groups" ? "group" : "entry";
    const result = await repo.farewell.reorder({ kind, id: Number(farewellReorderMatch[2]), direction, now });
    if (!result.found) return json({ error: kind + " not found" }, 404);
    return json({ ok: true, ...result });
  }

  const farewellTrashMatch = url.pathname.match(/^\/api\/public-farewell-v2\/(groups|entries)\/(\d+)\/(trash|restore|permanent)$/);
  if (request.method === "POST" && farewellTrashMatch) {
    await requireAdmin(request, env);
    const kind = farewellTrashMatch[1] === "groups" ? "group" : "entry";
    const id = Number(farewellTrashMatch[2]);
    const action = farewellTrashMatch[3];
    const now = isoNow();
    if (action === "permanent") {
      const deleted = await repo.farewell.permanentlyDelete({ kind, id });
      if (!deleted) return json({ error: "只有正式版本和草稿都已移除后才能永久删除" }, 409);
      await repo.audit("public_farewell_v2_permanently_deleted", { kind, id }, now);
      return json({ ok: true, deleted: true });
    }
    const found = await repo.farewell.setTrashed({ kind, id, trashed: action === "trash", now });
    if (!found) return json({ error: kind + " not found" }, 404);
    return json({ ok: true, trashed: action === "trash" });
  }

  if (request.method === "POST" && url.pathname === "/api/public-farewell-v2/apply") {
    await requireAdmin(request, env);
    const body=await readBody(request),now = isoNow();
    const result = await repo.farewell.applyDraft({ now,expectedDraftRevision:requireRevision(body.expected_draft_revision) });
    if(result.conflict)return json({ok:false,error:'edit_conflict',...result},409);
    if (result.changed) await repo.audit("public_farewell_v2_applied", { updated_at: result.updated_at }, now);
    return json({ ok: true, ...result,pdf_status:'pending' });
  }

  if (request.method === "POST" && url.pathname === "/api/pdf/rebuild") {
    await requireAdmin(request, env);
    const now = isoNow();
    const job = await queuePdfJob(repo, env, now,{force:true});
    return json({ ok: true, job });
  }

  if (request.method === "POST" && url.pathname === "/api/public-farewell-v2/discard") {
    await requireAdmin(request, env);
    const body=await readBody(request),now = isoNow();
    const result = await repo.farewell.discardDraft({ now,expectedDraftRevision:requireRevision(body.expected_draft_revision) });
    if(result.conflict)return json({ok:false,error:'edit_conflict',...result},409);
    if (result.discarded) await repo.audit("public_farewell_v2_draft_discarded", result, now);
    return json({ ok: true, ...result });
  }

  if (request.method === "POST" && url.pathname === "/api/public-farewell") {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const status = body.status || "DRAFT";
    if (!["DRAFT", "PUBLIC_RELEASE"].includes(status)) return json({ error: "invalid public farewell status" }, 400);
    if (status === "PUBLIC_RELEASE") return json({ error: "请通过核验与缓冲流程发布公开内容；保存与预览用于准备正式版本。" }, 409);
    const now = isoNow();
    await repo.upsertPublicFarewell({
      title: requireString(body.title || "公开遗言", "title"),
      body: optionalString(body.body),
      status,
      now,
    });
    await repo.audit("public_farewell_upsert", { status }, now);
    if (isForm(request)) return renderHome(repo, body.admin_token || "", env);
    return json({ ok: true, status });
  }

  if (request.method === "POST" && url.pathname === "/api/public-farewell/title") {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const title = requireString(body.title, "title");
    const now = isoNow();
    await repo.upsertPublicFarewellTitle({ title, now });
    await repo.audit("public_farewell_title_updated", {}, now);
    if (isForm(request)) return renderHome(repo, body.admin_token || "", env);
    return json({ ok: true, title });
  }

  if (["GET", "POST"].includes(request.method) && url.pathname === "/api/public-farewell/pdf-source") {
    await requireAdmin(request, env);
    await assertPublicPdfSourceSize(repo,env);
    const [owner,document]=await Promise.all([repo.getOwner(),repo.getPublicFarewell()]);
    const groups=await repo.farewell.listFormalGroups();
    if((await repo.getPublicFarewell())?.updated_at!==document?.updated_at)return json({error:'edit_conflict',message:'正式内容已变化，请重新导出。'},409);
    const formalGroups=groups.map(g=>({display_title:g.display_title,display_epigraph:g.display_epigraph,title_updated_at:g.title_updated_at,epigraph_updated_at:g.epigraph_updated_at,entries:g.entries.map(e=>({display_body:e.display_body,body_updated_at:e.body_updated_at}))}));
    return json({kind:'public',options:{...await pdfOptions(repo,env),ownerName:owner?.display_name,groups:formalGroups,updatedAt:document?.updated_at},formal:true});
  }

  if (["GET", "POST"].includes(request.method) && url.pathname === "/api/public-farewell/pdf") {
    await requireAdmin(request, env);
    const artifact = await cachedPublicPdf(repo, env, await repo.getOwner());
    return new Response(base64ToBytes(artifact.content_base64), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="afterme-public-farewell.pdf"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  if (["GET", "POST"].includes(request.method) && url.pathname === "/api/public-farewell/preview") {
    await requireAdmin(request, env);
    return boundedPublicReading(repo,env,url,{preview:true});
  }

  if (request.method === "GET" && url.pathname === "/api/public-farewell-items") {
    await requireAdmin(request, env);
    return json(await repo.listPublicFarewellItems());
  }

  if (request.method === "POST" && url.pathname === "/api/public-farewell-groups/rename") {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const title = requireString(body.title, "title");
    const newTitle = requireString(body.new_title, "new_title");
    const now = isoNow();
    const result = await repo.renamePublicFarewellGroup({ title, newTitle, now });
    if (!result.found) return json({ error: "public farewell group not found" }, 404);
    await repo.audit("public_farewell_group_renamed", { title, new_title: newTitle, merged: result.merged }, now);
    if (isForm(request)) return renderHome(repo, body.admin_token || "", env);
    return json({ ok: true, new_title: newTitle, ...result });
  }

  if (request.method === "POST" && url.pathname === "/api/public-farewell-groups/move") {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const direction = body.direction;
    if (!["up", "down"].includes(direction)) return json({ error: "invalid move direction" }, 400);
    const now = isoNow();
    const result = await repo.movePublicFarewellGroup({
      title: requireString(body.title, "title"),
      direction,
      now,
    });
    if (!result.found) return json({ error: "public farewell group not found" }, 404);
    await repo.audit("public_farewell_group_reordered", { title: body.title, direction, moved: result.moved }, now);
    if (isForm(request)) return renderHome(repo, body.admin_token || "", env);
    return json({ ok: true, ...result });
  }

  const publicItemMoveMatch = url.pathname.match(/^\/api\/public-farewell-items\/(\d+)\/(up|down)$/);
  if (request.method === "POST" && publicItemMoveMatch) {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const now = isoNow();
    const result = await repo.movePublicFarewellItem({
      id: Number(publicItemMoveMatch[1]),
      direction: publicItemMoveMatch[2],
      now,
    });
    if (!result.found) return json({ error: "public farewell item not found" }, 404);
    await repo.audit("public_farewell_item_reordered", { id: Number(publicItemMoveMatch[1]), direction: publicItemMoveMatch[2], moved: result.moved }, now);
    if (isForm(request)) return renderHome(repo, body.admin_token || "", env);
    return json({ ok: true, ...result });
  }

  if (request.method === "POST" && url.pathname === "/api/public-farewell-items") {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const status = body.status || "draft";
    if (!["draft", "published", "archived", "private_note"].includes(status)) {
      return json({ error: "invalid public farewell item status" }, 400);
    }
    const now = isoNow();
    if (!(await repo.getPublicFarewell())) {
      await repo.upsertPublicFarewell({ title: "公开遗言", body: "", status: "DRAFT", now });
    }
    const title = requireString(body.title, "title");
    const existing = body.id ? await repo.getPublicFarewellItem(Number(body.id)) : null;
    if (body.id && !existing) return json({ error: "public farewell item not found" }, 404);
    const titleChanged = !existing || existing.title !== title;
    const titleOrder = titleChanged ? await repo.getPublicFarewellTitleOrder(title) : null;
    const sortOrder = titleChanged
      ? (titleOrder?.sort_order == null ? await repo.getNextPublicFarewellGroupOrder() : Number(titleOrder.sort_order))
      : Number(existing.sort_order);
    const entryOrder = titleChanged
      ? (titleOrder?.entry_order == null ? 10 : Number(titleOrder.entry_order) + 10)
      : Number(existing.entry_order);
    const id = await repo.upsertPublicFarewellItem({
      id: existing?.id || null,
      title,
      body: requireString(body.body, "body"),
      sortOrder,
      entryOrder,
      status,
      now,
    });
    await repo.audit("public_farewell_item_upsert", { id, status }, now);
    if (isForm(request)) return renderHome(repo, body.admin_token || "", env);
    return json({ ok: true, id, status });
  }

  if(request.method==='GET'&&url.pathname==='/api/people'){
    await requireAdmin(request,env);return json(await repo.listPeople());
  }
  if(request.method==='POST'&&url.pathname==='/api/people'){
    await requireAdmin(request,env);const body=await readBody(request),now=isoNow();
    try{const person=await repo.createPerson(body,{now,defaultLocale:(await repo.getSettings(env)).preferences.locale});await repo.audit('person_created',{contact_id:person.id,recipient_id:person.recipient_id},now);return json({ok:true,id:person.id,recipient_id:person.recipient_id,person},201);}catch(error){return personErrorResponse(error);}
  }
  const personMatch=url.pathname.match(/^\/api\/people\/(\d+)$/);
  if(personMatch&&['PATCH','DELETE'].includes(request.method)){
    await requireAdmin(request,env);const body=await readBody(request),now=isoNow(),id=Number(personMatch[1]);
    try{const person=await repo.patchPerson(id,request.method==='DELETE'?{active:false}:body,{expectedRevision:requireRevision(body.expected_revision),now});await repo.audit('person_updated',{contact_id:id,recipient_id:person.recipient_id},now);return json({ok:true,id,recipient_id:person.recipient_id,person});}catch(error){return personErrorResponse(error);}
  }

  const recipientUpdateMatch = url.pathname.match(/^\/api\/recipients\/(\d+)$/);
  if (request.method === "POST" && recipientUpdateMatch) {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const id = Number(recipientUpdateMatch[1]);
    let person;try{person=await repo.patchLegacyPerson('recipient',id,body,{now:isoNow()});}catch(error){return personErrorResponse(error);}
    const recipient={id:person.recipient_id,name:person.recipient_name,email:person.recipient_email,note:person.note,active:person.recipient_active,locale:person.recipient_locale,revision:person.revision,contact_id:person.id};
    await repo.audit("recipient_updated", { recipient_id: id, active: Boolean(recipient.active) }, isoNow());
    if (isForm(request)) return renderHome(repo, body.admin_token || "", env);
    return json({ ok: true, recipient });
  }

  if (request.method === "POST" && url.pathname === "/api/recipients") {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const now = isoNow();
    let person;try{person=await repo.createPerson(body,{now});}catch(error){return personErrorResponse(error);}
    const id=person.recipient_id;
    await repo.audit("recipient_created", { recipient_id: id }, now);
    if (isForm(request)) return renderHome(repo, body.admin_token || "", env);
    return json({ ok: true, id,contact_id:person.id,person }, 201);
  }

  if (request.method === "GET" && url.pathname === "/api/recipients") {
    await requireAdmin(request, env);
    return json(await repo.listRecipients());
  }

  const contactUpdateMatch = url.pathname.match(/^\/api\/contacts\/(\d+)$/);
  if (request.method === "POST" && contactUpdateMatch) {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const id = Number(contactUpdateMatch[1]);
    let person;try{person=await repo.patchLegacyPerson('contact',id,body,{now:isoNow()});}catch(error){return personErrorResponse(error);}
    const contact={id:person.id,name:person.contact_name,email:person.contact_email,role:person.role,priority:person.priority,active:person.contact_active,locale:person.contact_locale,revision:person.revision,recipient_id:person.recipient_id};
    await repo.audit("contact_updated", { contact_id: id, active: Boolean(contact.active) }, isoNow());
    if (isForm(request)) return renderHome(repo, body.admin_token || "", env);
    return json({ ok: true, contact });
  }

  if (request.method === "POST" && url.pathname === "/api/contacts") {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const token = createToken();
    let person;try{person=await repo.createPerson(body,{tokenHash:await hashToken(token)});}catch(error){return personErrorResponse(error);}
    const id=person.id;
    const baseUrl = getBaseUrl(env, new URL(request.url));
    const response = {
      ok: true,
      id,
      recipient_id:person.recipient_id,
      person,
      verify_url: `${baseUrl}/verify/${token}`,
      contact_token: token,
      note: "The verification link is for rehearsal or emergency fallback. Normal operation delivers a fresh link automatically when verification is needed.",
    };
    if (isForm(request)) {
      return renderHome(repo, body.admin_token || "", env);
    }
    return json(response, 201);
  }

  if (request.method === "GET" && url.pathname === "/api/contacts") {
    await requireAdmin(request, env);
    return json(await repo.listContacts());
  }

  if (request.method === "POST" && url.pathname === "/api/contacts/rotate-token") {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const contactId = Number(body.contact_id || 0);
    if (!contactId) return json({ error: "contact_id is required" }, 400);
    const token = createToken();
    const contact = await repo.rotateContactToken({ id: contactId, tokenHash: await hashToken(token) });
    if (!contact) return json({ error: "contact not found or inactive" }, 404);
    const baseUrl = getBaseUrl(env, new URL(request.url));
    const templates = mergeMailTemplates(await repo.listMailTemplates());
    const pack = buildManualContactPack({
      owner: await repo.getOwner(),
      rules:await repo.getRoundRules(await repo.getOwner()),
      contact,
      verifyUrl: `${baseUrl}/verify/${token}`,
      templates,
    });
    const response = { ok: true, contact, verify_url: pack.verify_url, contact_token: token, manual_messages: pack.messages };
    await repo.audit("contact_token_rotated", { contact_id: contactId }, isoNow());
    if (isForm(request)) {
      return manualContactPackPage({ contactName: contact.name, pack });
    }
    return json(response);
  }

  if (request.method === "POST" && url.pathname === "/api/items") {
    await requireAdmin(request, env);
    const body = await readBody(request);
    let storedPayload;
    try {
      storedPayload = await buildStoredPayload({ body, env });
    } catch (error) {
      return json({ error: error.message }, 400);
    }
    const validation = validateStoredPayload(storedPayload);
    if (!validation.ok) return json({ error: validation.error, bytes: validation.bytes }, 400);

    const recipientId = Number(body.recipient_id || 0);
    if (!recipientId) return json({ error: "recipient_id is required", message: "私人信件必须指定收件人。" }, 400);
    const recipient = await repo.getRecipient(recipientId);
    if (!recipient || !Number(recipient.active)) return json({ error: "recipient not found or inactive" }, 400);
    const now = isoNow();
    // A PDF is a replaceable derivative. Persist the original letter even if
    // font loading, browser generation or artifact upload is unavailable.
    const pdfPayload = null;
    const vaultToken = createToken();
    const id = await repo.createEncryptedItem({
      kind: "letter",
      title: "私人信件",
      recipientId,
      assigneeContactId: body.assignee_contact_id ? Number(body.assignee_contact_id) : null,
      releaseStage: body.release_stage || "PRIVATE_RELEASE",
      encryptedPayload: storedPayload,
      pdfPayload,
      payloadSize: validation.bytes,
      vaultToken,
      vaultTokenHash: await hashToken(vaultToken),
      updatedAt: now,
    });
    await repo.audit("private_letter_created", { item_id: id, recipient_id: recipientId }, now);
    const baseUrl = getBaseUrl(env, new URL(request.url));
    const response = { ok: true, id,revision:0,pdf_status:storedPayloadMode(storedPayload)==='link'?'pending':'manual', access_mode: storedPayloadMode(storedPayload), vault_url_after_release: `${baseUrl}/vault/${vaultToken}` };
    if (isForm(request)) {
      return layout({ title: "私人内容已保存", body: `<h1>私人内容已保存</h1><p>下方 vault 链接用于释放后的访问；交付按预先安排进行。</p><pre>${escapeForPre(JSON.stringify(response, null, 2))}</pre>` });
    }
    return json(response, 201);
  }

  const privatePdfSourceMatch = url.pathname.match(/^\/api\/items\/(\d+)\/pdf-source$/);
  if (["GET", "POST"].includes(request.method) && privatePdfSourceMatch) {
    await requireAdmin(request, env);
    const item=await repo.getEncryptedItemForAdmin(Number(privatePdfSourceMatch[1]));
    if(!item||item.kind!=='letter')return json({error:'private letter not found'},404);
    if(storedPayloadMode(item.encrypted_payload)!=='link')return json({error:'pdf_preview_unavailable',message:'高敏感口令密文不能生成本机 PDF 源文件。'},409);
    const [owner,opened]=await Promise.all([repo.getOwner(),openStoredPayload(item.encrypted_payload,env)]);
    return json({kind:'private',options:{...await pdfOptions(repo,env,item.recipient_locale),ownerName:owner?.display_name,recipientName:item.recipient_name,body:opened.plaintext,updatedAt:item.updated_at||item.created_at},revision:item.revision});
  }

  const privatePdfMatch = url.pathname.match(/^\/api\/items\/(\d+)\/pdf$/);
  if (request.method === "POST" && privatePdfMatch) {
    await requireAdmin(request, env);
    const id = Number(privatePdfMatch[1]);
    const item = await repo.getEncryptedItemForAdmin(id);
    if (!item || item.kind !== "letter") return json({ error: "private letter not found" }, 404);
    if (storedPayloadMode(item.encrypted_payload) !== "link") {
      return json({ error: "pdf_preview_unavailable", message: "高敏感口令密文不能生成服务器端 PDF 预览。" }, 409);
    }
    if(repo.getSettings) {
      const owner=await repo.getOwner(),pdf=await cachedPrivatePdf(repo,env,item,owner);
      if(pdf.conflict)return json({error:'edit_conflict'},409);
      return privateLetterPdfResponse(pdf.bytes,owner?.display_name);
    }

    let pdf;
    if (item.pdf_payload) {
      try {
        const storedPdf = await openStoredPayload(item.pdf_payload, env);
        pdf = base64ToBytes(storedPdf.plaintext);
      } catch {
        // Rebuild a missing or outdated cached PDF below.
      }
    }
    if (!pdf) {
      const [owner, opened] = await Promise.all([
        repo.getOwner(),
        openStoredPayload(item.encrypted_payload, env),
      ]);
      pdf = buildPrivateLetterPdf({
        chineseFont:await cloudChineseFont(env),
        ownerName: owner?.display_name,
        recipientName: item.recipient_name,
        body: opened.plaintext,
        updatedAt: item.updated_at || item.created_at || isoNow(),
      });
      const pdfPayload = await buildStoredPayload({ body: { plaintext: bytesToBase64(pdf) }, env });
      await repo.updatePrivateItemPdf({ id, pdfPayload });
    }
    const owner = await repo.getOwner();
    return privateLetterPdfResponse(pdf, owner?.display_name || "本人");
  }

  const privateItemMatch = url.pathname.match(/^\/api\/items\/(\d+)$/);
  if (request.method === "POST" && privateItemMatch) {
    await requireAdmin(request, env);
    const body = await readBody(request);
    const id = Number(privateItemMatch[1]);
    const existing = await repo.getEncryptedItemForAdmin(id);
    if (!existing || existing.kind !== "letter") return json({ error: "private letter not found" }, 404);
    if (existing.released_at) return json({ error: "released_letter_is_read_only", message: "这封信已释放，当前为只读状态。" }, 409);
    const expectedRevision = requireRevision(body.expected_revision);
    const conflictResponse = async () => {
      const current = await repo.getEncryptedItemForAdmin(id);
      const opened = await openStoredPayload(current.encrypted_payload, env);
      return json({ ok: false, error: 'edit_conflict', message: '其他页面已修改这封信。请选择要保留的版本。', current: { revision: current.revision, recipient_id: current.recipient_id, plaintext: opened.plaintext } }, 409);
    };
    if (existing.revision !== expectedRevision) return conflictResponse();

    // A body-only edit must retain the stored identity, including pre-recipient
    // letters whose address still comes from recipient_contact_id. Never infer
    // a replacement from the directory bridge or a client-supplied contact ID.
    const preserveRecipient=Object.hasOwn(body,'preserve_recipient')&&parseBool(body.preserve_recipient);
    const recipientId=preserveRecipient?existing.recipient_id:Number(body.recipient_id||0);
    if(!preserveRecipient&&!recipientId)return json({error:'recipient_id is required',message:'私人信件必须指定收件人。'},400);
    const recipient=recipientId!==null&&recipientId!==undefined?await repo.getRecipient(recipientId):preserveRecipient&&existing.recipient_contact_id?await repo.getContact(existing.recipient_contact_id):null;
    if (!recipient || !Number(recipient.active)) return json({ error: "recipient not found or inactive" }, 400);

    let storedPayload;
    try {
      storedPayload = await buildStoredPayload({ body: { ...body, access_mode: "link" }, env });
    } catch (error) {
      return json({ error: error.message }, 400);
    }
    const validation = validateStoredPayload(storedPayload);
    if (!validation.ok) return json({ error: validation.error, bytes: validation.bytes }, 400);

    const now = isoNow();
    const previousContent=await openStoredPayload(existing.encrypted_payload,env);
    const deliveryChanged=previousContent.plaintext!==(body.plaintext??body.content??body.body)||existing.recipient_id!==recipientId;
    const pdfPayload = null;
    const updated = await repo.updateEncryptedItem({
      id,
      recipientId,
      encryptedPayload: storedPayload,
      pdfPayload,
      payloadSize: validation.bytes,
      updatedAt: now,
      expectedRevision,
      deliveryChanged,
    });
    if (!updated) return conflictResponse();
    await repo.audit("private_letter_updated", { item_id: id, recipient_id: recipientId }, now);
    if (isForm(request)) return renderHome(repo, body.admin_token || "", env);
    return json({ ok: true, id, updated_at: now, revision: expectedRevision + 1,pdf_status:'pending' });
  }

  if (request.method === "GET" && url.pathname === "/api/items") {
    await requireAdmin(request, env);
    return json(await repo.directory({...pageParameters(url)}));
  }

  if (request.method === "POST" && url.pathname === "/api/release/private") {
    await requireAdmin(request, env);
    const now = isoNow();
    const release = await releasePrivateIfReady({ repo, env, requestUrl: new URL(request.url), now, reason: "admin_manual_release" });
    if (!release.released) return json({ error: "private release conditions are not met", reason: release.reason }, 409);
    return json({ ok: true, state: release.publicRelease?.published ? STATES.PUBLIC_RELEASE : STATES.PRIVATE_RELEASE, deliveries: release.deliveries, public_release: release.publicRelease });
  }

  if (request.method === "GET" && url.pathname.startsWith("/verify/")) {
    const token = decodeURIComponent(url.pathname.slice("/verify/".length));
    const contact = await contactFromToken(repo, token);
    if (!contact || !currentVerification(contact, await repo.getOwner(), true)) return layout({ title: "链接无效", pageClass: "external", body: "<section class=\"external-shell\"><p class=\"eyebrow\">AfterMe</p><h1>这个确认链接已失效</h1><p>当前不在核验期，或链接已被签到、替换、停用。</p></section>" });
    const owner=await repo.getOwner();return verificationPage({contact,owner,rules:await repo.getRoundRules(owner),preferences:(await repo.getSettings(env)).preferences,proofRequired:true,expired:!contact.verification_expires_at||Date.parse(contact.verification_expires_at)<Date.now()});
  }

  if (request.method === "POST" && url.pathname.startsWith("/verify/")) {
    checkOrigin(request);
    const challenge=url.pathname.endsWith('/challenge');
    const token = decodeURIComponent(url.pathname.slice("/verify/".length).replace(/\/challenge$/,''));
    const contact = await contactFromToken(repo, token);
    if (!contact) return json({ error: "invalid token" }, 403);
    const body = await readBody(request);
    const verificationOwner = await repo.getOwner();
    if (!currentVerification(contact, verificationOwner, true)) return json({ error: "本轮核验已结束，请勿使用旧链接。" }, 409);
    if(challenge){const proof=await startVerificationProof({repo,env,contact,owner:verificationOwner});return json({ok:true,challenge_id:proof.id,expires_at:proof.expires_at});}
    const status = body.status;
    if(body.note!==undefined&&(typeof body.note!=='string'||body.note.length>4000))throw new HttpError(400,'Note must be at most 4000 characters');
    if (!["unable_to_reach", "confirmed_death", "false_alarm"].includes(status)) {
      return json({ error: "invalid status" }, 400);
    }

    const now = isoNow();
    if(!await consumeVerificationProof({repo,env,contact,owner:verificationOwner,id:body.challenge_id,code:body.verification_code}))throw new HttpError(403,'请先获取并输入发送到联系人邮箱的有效验证码。');
    if(!contact.verification_expires_at||Date.parse(contact.verification_expires_at)<Date.now()){
      await repo.db.prepare('UPDATE contacts SET verification_issued_at=?,verification_expires_at=? WHERE id=? AND token_hash=? AND verification_round=?').bind(now,new Date(Date.parse(now)+7*86400000).toISOString(),contact.id,contact.token_hash,verificationOwner.confirmation_round).run();
      await repo.audit('verification_link_renewed',{contact_id:contact.id,round:verificationOwner.confirmation_round},now);
    }
    if (status === "false_alarm") {
      if(!await repo.checkin(now,{ownerCheckin:false,expectedRound:verificationOwner.confirmation_round}))throw new HttpError(409,'本輪核验已结束。');
      const retractedPublicFarewell = ['PRIVATE_RELEASE','PUBLIC_RELEASE'].includes(verificationOwner.state);
      await repo.audit("false_alarm", { by: contact.id, cleared_confirmations: true, retracted_public_farewell: retractedPublicFarewell }, now);
      await notifyConfirmation({repo,env,contact,owner:verificationOwner,status,now});
      return verificationResult({locale:contact.locale,status,release:{released:false}});
    }

    const accepted = await repo.createConfirmation({ contactId: contact.id, status, note: body.note, round: verificationOwner.confirmation_round, now });
    if (!accepted) return json({ error: "核验状态已变更，本次回复未计入。" }, 409);
    await repo.audit("contact_confirmation", { by: contact.id, status }, now);
    await notifyConfirmation({repo,env,contact,owner:verificationOwner,status,now});
    const count = await repo.countQualifyingConfirmations();
    const release = isQualifyingConfirmation(status)
      ? await releasePrivateIfReady({ repo, env, requestUrl: new URL(request.url), now, reason: "contact_confirmations" })
      : { released: false };
    return verificationResult({locale:contact.locale,status,release});
  }

  if (request.method === "GET" && url.pathname.startsWith("/vault/")) {
    if (env.RELEASE_SUSPENDED === 'true') return layout({ title: '已暂停', body: '<p>内容访问已暂停。</p>' });
    const token = decodeURIComponent(url.pathname.slice("/vault/".length));
    const item = await repo.findVaultItemByTokenHash(await hashToken(token));
    if (!item) return layout({ title: "未释放", body: "<p>内容不存在、链接无效，或尚未释放。</p>" });
    const opened = await openStoredPayload(item.encrypted_payload, env);
    return vaultPage(item, opened);
  }

  return json({ error: "not_found" }, 404);
}

async function renderHome(repo, adminToken = "", env = {}, csrf) {
  const {owner,settings,rules,progress,latestBackup,mailProblems,counts}=await dashboardSnapshot(repo,env);
  const notices=[];if(mailProblems.outbound||mailProblems.inbound)notices.push('mailAttention');
  if(!latestBackup||Date.now()-Date.parse(latestBackup.created_at)>settings.preferences.backup_reminder_days*86400000) notices.push('backupReminder');
  const response=dashboardPage({owner:ownerWithEffectiveState(owner,new Date(),rules),settings,rules,progress,counts,notices,csrf,mailProvider:env.MAIL_PROVIDER||'dry-run',inbound:env.INBOUND_PROVIDER||(env.MAIL_PROVIDER==='gmail'&&enabledUnlessFalse(env.MAIL_INBOUND_ENABLED)?'gmail':'web')});
  if(adminToken){const auth=await authenticate(new Request('https://afterme.example/admin',{headers:{Authorization:'Bearer '+adminToken}}),env);const session=auth.token?auth:await issueSession(env);const next=dashboardPage({owner:ownerWithEffectiveState(owner,new Date(),rules),settings,rules,progress,counts,notices,csrf:session.csrf,mailProvider:env.MAIL_PROVIDER||'dry-run',inbound:env.INBOUND_PROVIDER||'web'});next.headers.set('Set-Cookie',sessionCookie(session.token));return next;}
  return response;
}

async function renderLegacyHome(repo, adminToken = "", env = {}) {
  try {
    if (adminToken === env.ADMIN_TOKEN) adminToken = (await issueSession(env)).token;
    const [owner, contacts, recipients, confirmations, items, deliveries, farewellEditor, legalWill, operationalHealth, storedMailTemplates] = await Promise.all([
      repo.getOwner(),
      repo.listContacts(),
      repo.listRecipients(),
      repo.listConfirmations(),
      repo.directory({limit:100}),
      repo.listDeliveryLog(30),
      repo.farewell.getVersions(),
      repo.getLegalWill(),
      repo.getOperationalHealth(),
      repo.listMailTemplates(),
    ]);
    const privateItems = [];
    const rules=owner?await repo.getRoundRules(owner):defaultRules();
    return homePage({
      owner: ownerWithEffectiveState(owner,new Date(),rules), contacts, recipients, confirmations, items, deliveries,
      privateItems, farewellEditor, legalWill, operationalHealth, adminToken,
      mailProvider: env.MAIL_PROVIDER || "dry-run",
      mailInboundEnabled: enabledUnlessFalse(env.MAIL_INBOUND_ENABLED),
      contactNotificationsEnabled: enabledUnlessFalse(env.CONTACT_NOTIFICATIONS_ENABLED),
      releaseLockedByConfig: parseBool(env.RELEASE_SUSPENDED),
      requiredConfirmations: rules.private.quorum, mailTemplates: mergeMailTemplates(storedMailTemplates),
      releaseGraceHours: rules.private.grace_hours,
    });
  } catch (error) {
    return layout({
      title: "AfterMe v1",
      body: `<h1>AfterMe v1</h1><p class="warning">D1 schema 尚未初始化。</p><pre>${escapeForPre(error.message)}</pre>`,
    });
  }
}

async function preparePrivateItemsForAdmin(itemsResult, env) {
  const rows = itemsResult?.results || itemsResult || [];
  return Promise.all(rows.map(async (item) => {
    const accessMode = storedPayloadMode(item.encrypted_payload);
    if (accessMode !== "link") {
      return { ...item, encrypted_payload: undefined, pdf_payload: undefined, access_mode: accessMode, plaintext: null };
    }
    try {
      const opened = await openStoredPayload(item.encrypted_payload, env);
      return { ...item, encrypted_payload: undefined, pdf_payload: undefined, access_mode: "link", plaintext: opened.plaintext };
    } catch {
      return { ...item, encrypted_payload: undefined, pdf_payload: undefined, access_mode: "link", plaintext: null, decrypt_failed: true };
    }
  }));
}

export async function runScheduledCheck(repo, env, nowDate = new Date(), provider = createMailProvider(env),{lane}={}) {
  if(env.BACKGROUND_EXECUTION_MODE==='staged'){
    const budget=invocationBudget(env)||createInvocationBudget(),originalDb=repo.db,originalFarewellDb=repo.farewell?.db;
    env={...env,INVOCATION_BUDGET:budget};repo.db=wrapBudgetDatabase(repo.db,budget);repo.invocationBudget=budget;if(repo.farewell)repo.farewell.db=repo.db;if(provider.env)provider.env=env;
    try{return await runStagedRuntime(repo,env,isoNow(nowDate),{processReplies:processContactEmailReplies,maintenance:runStagedMaintenance,provider,lane});}
    finally{repo.db=originalDb;if(repo.farewell)repo.farewell.db=originalFarewellDb;repo.invocationBudget=null;repo.invocationSettings=null;repo.invocationRules=null;}
  }
  const budget=invocationBudget(env)||createInvocationBudget();
  const originalDb=repo.db,originalFarewellDb=repo.farewell?.db;
  env={...env,INVOCATION_BUDGET:budget};
  if(repo.db){repo.db=wrapBudgetDatabase(repo.db,budget);if(repo.farewell)repo.farewell.db=repo.db;repo.invocationBudget=budget;repo.invocationSettings=null;repo.invocationRules=new Map();}
  if(provider.env)provider.env=env;
  try {
  let owner = await repo.getOwner();
  if (!owner) return { ok: false, reason: "owner-not-setup" };

  const now = isoNow(nowDate);
  if(repo.resumeExpiredPause&&owner.pause_mode==='automatic'&&Date.parse(owner.pause_until)<=nowDate.getTime()) owner=await repo.resumeExpiredPause(now);
  let rules=repo.getRoundRules?await repo.getRoundRules(owner):defaultRules();
  if(owner.pause_mode) {await repo.audit('scheduled_check_completed',{from:owner.state,to:owner.state,inbox_status:'paused'},now);if(repo.db&&budget.canStart(2))await refreshOperationalSnapshot(repo,env,now,evaluateOperationalHealth); return {ok:true,paused:true};}
  let inboxStatus = "not-configured";
  const inboxProvider=provider.name==='gmail'?provider:env.INBOUND_PROVIDER==='gmail'?new GmailMailProvider(env):null;
  env.INBOX_ACTIVE=Boolean(inboxProvider&&enabledUnlessFalse(env.MAIL_INBOUND_ENABLED));
  if(inboxProvider?.env)inboxProvider.env=env;
  if (env.INBOX_ACTIVE) {
    try {
      const inbox = await processContactEmailReplies({ repo, env, now, provider:inboxProvider });
      inboxStatus = inbox.failed || inbox.backlog ? "degraded" : "healthy";
    } catch (error) {
      inboxStatus = "failed";
      await repo.audit("gmail_inbox_poll_failed", { error: error.name||'Error' }, now);
    }
    owner = await repo.getOwner();
    rules=repo.getRoundRules?await repo.getRoundRules(owner):defaultRules();
  } else if (provider.name === "gmail") {
    inboxStatus = "disabled";
  }
  if(repo.setInboxStatus)await repo.setInboxStatus(inboxStatus,owner.confirmation_round);else if(repo.setCursor) await repo.setCursor('inbox-status',inboxStatus);

  const previous = owner.state;
  const next = calculateState({
    lastCheckinAt: owner.timer_anchor_at || owner.last_checkin_at,
    currentState: owner.state,
    rules,
  }, nowDate);

  if (next !== previous) {
    await repo.updateOwnerState(next, now, owner.confirmation_round);
    await repo.audit("state_transition", { from: previous, to: next }, now);
  }

  // Monthly self-check gets a place before a long release queue consumes today's quota.
  await maybeSendMailHealthcheck({ repo, env, owner, now, provider });
  if (shouldSendTransitionEmail({ fromState: previous, toState: next }) || [STATES.OVERDUE, STATES.ALERT, STATES.VERIFY].includes(next)) {
    await sendTransitionEmails({ repo, env, owner, toState: next, now, provider });
  }
  if(!['failed','degraded'].includes(inboxStatus)&&repo.getProgress&&[STATES.READY_TO_RELEASE,STATES.PRIVATE_RELEASE,STATES.PUBLIC_RELEASE].includes(next)) {
    const progress=await repo.getProgress(owner.confirmation_round);
    if(['private','public'].some(k=>rules[k].enabled&&!progress.find(p=>p.channel===k)?.released_at))await sendTransitionEmails({repo,env,owner,toState:STATES.VERIFY,now,provider});
  }

  const release = ['failed', 'degraded'].includes(inboxStatus) ? { released: false, reason: 'inbox-unhealthy', state: next } : await releasePrivateIfReady({
    repo,
    env,
    requestUrl: new URL(getBaseUrl(env, { origin: env.BASE_URL || "https://replace-with-workers-dev-url" })),
    now,
    reason: "scheduled_confirmations",
    provider,
  });

  if(env.PDF_GENERATION_MODE!=='browser'&&budget.canStart(17))try {await ensureCurrentPdfArtifacts(repo,env,now);} catch(error) {if(!isInvocationBudgetError(error)&&budget.canStart(2))await repo.audit('pdf_artifacts_rebuild_failed',{generator_version:PDF_GENERATOR_VERSION},now);}
  const finalState = release.state || next;
  await repo.audit("scheduled_check_completed", { from: previous, to: finalState, inbox_status: inboxStatus }, now);
  if(repo.db&&budget.canStart(2))await refreshOperationalSnapshot(repo,env,now,evaluateOperationalHealth);
  return { ok: true, from: previous, to: finalState, inboxStatus, budget:{d1:budget.usedD1,external:budget.usedExternal} };
  } catch(error) {if(!isInvocationBudgetError(error))throw error;return {ok:true,deferred:true,reason:'invocation-budget',budget:{d1:budget.usedD1,external:budget.usedExternal}};} finally {repo.db=originalDb;if(repo.farewell)repo.farewell.db=originalFarewellDb;repo.invocationBudget=null;repo.invocationSettings=null;repo.invocationRules=null;}
}

export function ownerWithEffectiveState(owner, nowDate = new Date(), rules) {
  if (!owner) return owner;
  const effectiveState = calculateState({
    lastCheckinAt: owner.timer_anchor_at || owner.last_checkin_at,
    currentState: owner.state,
    rules,paused:Boolean(owner.pause_mode),
  }, nowDate);
  return effectiveState === owner.state ? owner : { ...owner, stored_state: owner.state, state: effectiveState };
}

export function currentVerification(contact, owner, allowFalseAlarm = false) {
  const states = [STATES.VERIFY, STATES.READY_TO_RELEASE, STATES.PRIVATE_RELEASE, STATES.PUBLIC_RELEASE];
  return Boolean(contact?.active && owner && !owner.pause_mode && Number.isInteger(owner.confirmation_round) && contact.verification_round === owner.confirmation_round && states.includes(owner.state));
}

async function releaseStillAllowed(repo, env, owner, channel='private') {
  if(env.RELEASE_SUSPENDED==='true')return false;
  if(repo.channelReleaseAllowed)return repo.channelReleaseAllowed(owner.confirmation_round,channel);
  const current = await repo.getOwner();
  if(repo.getProgress) {
    const rules=await repo.getRoundRules(current), progress=await repo.getProgress(current.confirmation_round);
    return current.confirmation_round===owner.confirmation_round&&!current.pause_mode&&!current.release_suspended&&env.RELEASE_SUSPENDED!=='true'&&Boolean(progress.find(p=>p.channel===channel)?.released_at)&&await repo.countChannelConfirmations(current.confirmation_round,channel)>=rules[channel].quorum;
  }
  return current.confirmation_round === owner.confirmation_round && !current.release_suspended && env.RELEASE_SUSPENDED !== 'true'
    && [STATES.PRIVATE_RELEASE, STATES.PUBLIC_RELEASE].includes(current.state)
    && await repo.countConfirmedDeathConfirmations() >= LIMITS.REQUIRED_CONFIRMATIONS;
}

export async function processContactEmailReplies({ repo, env, now, provider = createMailProvider(env) }) {
  if (provider.name !== "gmail" || typeof provider.listInboundMessages !== "function") {
    return { ok: true, skipped: true, processed: 0, rejected: 0, ignored: 0 };
  }

  const budget=invocationBudget(env),originalCursor=repo.getCursor?await repo.getCursor('gmail-inbox-page'):'';
  const batchOwner=repo.getOwner?await repo.getOwner():null;
  const messages = await provider.listInboundMessages({ maxResults:env.BACKGROUND_EXECUTION_MODE==='staged'?1:budget?5:40, repo });
  messages.sort((a, b) => String(a.receivedAt || "").localeCompare(String(b.receivedAt || "")));
  const summary = { ok: true, processed: 0, rejected: 0, ignored: 0, duplicate: 0, failed: 0, backlog:Boolean(messages.backlog||messages.nextPageToken) };

  let completeBatch=true;
  for (const message of messages) {
    if(budget&&!budget.canStart(12)){summary.backlog=true;completeBatch=false;break;}
    if (!message.id) continue;
    const claimed = await repo.claimInboundMessage({
      gmailMessageId: message.id,
      gmailThreadId: message.threadId,
      senderEmail: message.from,
      recipientEmail: message.recipients,
      subject: message.subject,
      receivedAt: message.receivedAt,
      processedAt: now,round:batchOwner?.confirmation_round,source:'gmail',
    });
    if (!claimed) {
      summary.duplicate += 1;
      continue;
    }

    let command = null;
    let finalStatus = "ignored";
    let details = {};
    try {
      if(message.incomplete)throw Error('Incomplete inbound message');
      const token = findContactReplyToken(message.recipients);
      const contact = token
        ? await repo.findContactByTokenHash(await hashToken(token))
        : await repo.findContactByEmail(message.from);
      const owner = !token && contact ? await repo.getOwner() : null;
      const expectedSubject = !token && contact
        ? buildContactVerifyMail({ ownerName: owner?.display_name, contactName: contact.name, template: mergeMailTemplates(typeof repo.listMailTemplates==='function'?await repo.listMailTemplates():[]).contact_verify }).subject
        : null;
      const currentSubjectMatches = contact && isContactVerificationReplySubject(message.subject, expectedSubject);
      const normalizedReplySubject = String(message.subject || "").replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "").trim();
      const sentSubjectMatches = !token && contact && !currentSubjectMatches && typeof repo.wasVerificationSubjectSentTo === "function"
        ? await repo.wasVerificationSubjectSentTo(contact.email, normalizedReplySubject)
        : false;
      const identified = Boolean(token) || Boolean(contact && (currentSubjectMatches || sentSubjectMatches));
      if (!identified) {
        details = { reason: "not-a-contact-reply" };
      } else {
        const identification = token ? "reply-token" : "authenticated-sender-and-subject";
        if (!contact) {
          finalStatus = "rejected";
          details = { reason: "invalid-or-expired-token" };
        } else if (!contact.active) {
          finalStatus = "rejected";
          details = { reason: "inactive-contact", contact_id: contact.id };
        } else if (normalizeEmail(message.from) !== normalizeEmail(contact.email)) {
          finalStatus = "rejected";
          details = { reason: "sender-mismatch", contact_id: contact.id };
        } else if (!message.authenticationPassed) {
          finalStatus = "rejected";
          details = { reason: "sender-authentication-not-passed", contact_id: contact.id };
        } else {
          const scanned=scanContactReplyCommand(message.body);
          if(env.BACKGROUND_EXECUTION_MODE==='staged'&&!scanned.complete)throw Error('Incomplete inbound command');
          const parsed = scanned.complete?scanned.command:null;
          command = parsed?.command || null;
          if (!parsed) {
            finalStatus = "rejected";
            details = { reason: "unrecognized-command", contact_id: contact.id };
          } else {
            const currentOwner = owner || await repo.getOwner();
            const sameThread = token || (contact.verification_thread_id && message.threadId === contact.verification_thread_id);
            const freshMessage = message.receivedAt && message.receivedAt >= currentOwner.last_checkin_at;
            if (!currentVerification(contact, currentOwner, parsed.status === "false_alarm") || !sameThread || !freshMessage) {
              finalStatus = "rejected";
              details = { reason: "state-not-accepting-confirmations", state: currentOwner.state, contact_id: contact.id };
            } else if (parsed.status === "false_alarm") {
              const cancelled=await repo.checkin(now,{ownerCheckin:false,expectedRound:currentOwner.confirmation_round});
              if(cancelled===false)throw new Error('Verification round changed');
              const retracted = ['PRIVATE_RELEASE','PUBLIC_RELEASE'].includes(currentOwner.state);
              await repo.audit("false_alarm", { by: contact.id, via: "gmail_reply", identification, cleared_confirmations: true, retracted_public_farewell: retracted }, now);
              finalStatus = "processed";
              details = { contact_id: contact.id, confirmation_status: parsed.status, identification };
              if(repo.db&&repo.getRoundRules)await notifyConfirmation({repo,env,contact,owner:currentOwner,status:parsed.status,now,provider});
            } else {
              const accepted = await repo.createConfirmation({ contactId: contact.id, status: parsed.status, round: currentOwner.confirmation_round, now: message.receivedAt, note: "Submitted by authenticated Gmail reply" });
              if (accepted === false) {
                finalStatus = 'rejected';
                details = { reason: 'older-vote-or-round-changed', contact_id: contact.id };
              } else {
                await repo.audit("contact_confirmation", { by: contact.id, status: parsed.status, via: "gmail_reply", identification }, now);
                finalStatus = "processed";
                details = { contact_id: contact.id, confirmation_status: parsed.status, identification };
                if(repo.db&&repo.getRoundRules)await notifyConfirmation({repo,env,contact,owner:currentOwner,status:parsed.status,now,provider});
              }
              // Release is evaluated after the whole inbox batch, so a later
              // false alarm in the same poll always has a chance to cancel it.
            }
          }
        }
      }
    } catch (error) {
      finalStatus = "failed";
      details = { reason: "processing-error", error: error.name||'Error' };
    }

    await repo.finishInboundMessage({ gmailMessageId: message.id, command, status: finalStatus, details, processedAt: now });
    if (finalStatus === "processed") summary.processed += 1;
    else if (finalStatus === "ignored") summary.ignored += 1;
    else if (finalStatus === "failed") { summary.failed += 1; summary.ok = false; }
    else summary.rejected += 1;
  }
  if (!summary.failed && repo.setCursor && messages.nextPageToken !== undefined) {
    const nextCursor=completeBatch?messages.nextPageToken:originalCursor;
    if(nextCursor!==originalCursor)await repo.setCursor('gmail-inbox-page',nextCursor);
  }
  return summary;
}
async function notifyConfirmation(options){
  return options.env.BACKGROUND_EXECUTION_MODE==='staged'?queueConfirmationNotice(options):notifyConfirmationImmediate(options);
}

export async function runStagedMaintenance(repo,env,now,provider){
  const owner=await repo.getOwner();if(!owner)return {skipped:true};
  let inbox={};try{inbox=JSON.parse(await repo.getCursor('background-inbox')||'{}');}catch{}
  const inboxStatus=env.BACKGROUND_LANE_SCHEDULING==='true'?(inboxOperationallyHealthy(inbox,owner.confirmation_round,now)?'healthy':'degraded'):inbox.status==='healthy'
    ? inboxGenerationFresh(inbox,owner.confirmation_round,now)?'healthy':'degraded'
    : inbox.status||'not-configured';
  await repo.audit('scheduled_check_completed',{from:owner.state,to:owner.state,inbox_status:inboxStatus,execution_mode:'staged'},now);
  await refreshOperationalSnapshot(repo,env,now,evaluateOperationalHealth);
  const settings=await repo.getSettings(env),turn=Number(await repo.getCursor('background-maintenance')||0)%3;
  await repo.setCursor('background-maintenance',String((turn+1)%3));
  if(turn===0&&settings.preferences.selfcheck){
    const to=env.MAIL_HEALTHCHECK_EMAIL||owner.email;
    const dedupeKey=`mail_healthcheck:${now.slice(0,7)}:${to}`;
    if(!await repo.hasDelivery(dedupeKey))await enqueueJob(repo,env,{key:dedupeKey,kind:'mail',round:owner.confirmation_round,payload:{type:'service',round:owner.confirmation_round,dedupeKey,eventType:'mail_healthcheck',message:{to,subject:t(settings.preferences.locale,'mailCheckSubject'),text:t(settings.preferences.locale,'mailCheckBody')+'\n'+now+'\n'+provider.name}},now});
  }else if(turn===1){
    const event=await repo.db.prepare(`SELECT e.kind,SUM(e.count) AS count FROM security_events e WHERE e.hour>=? AND NOT EXISTS(SELECT 1 FROM background_jobs j WHERE j.dedupe_key='security-alert:'||?||':'||e.kind AND j.state<>'cancelled') AND NOT EXISTS(SELECT 1 FROM mail_claims m WHERE m.dedupe_key='security-alert:'||?||':'||e.kind AND m.status IN ('sent','dry_run','sending','uncertain')) GROUP BY e.kind HAVING e.kind='service_failure' OR SUM(e.count)>=5 ORDER BY e.kind LIMIT 1`).bind(new Date(Date.parse(now)-86400000).toISOString().slice(0,13),now.slice(0,10),now.slice(0,10)).first();
    let selected=event;
    if(!selected){let health={};try{health=JSON.parse(await repo.getCursor('public-health')||'{}');}catch{}
      const kinds=[];if(health.checks?.gmail_inbound_healthy===false||health.checks?.inbound_processing_healthy===false)kinds.push('inbox_degraded');if(health.checks?.deliveries_healthy===false)kinds.push('outbound_degraded');
      for(const kind of kinds){const key='security-alert:'+now.slice(0,10)+':'+kind;if(!await repo.hasDelivery(key)&&!await repo.db.prepare("SELECT 1 FROM background_jobs WHERE dedupe_key=? AND state<>'cancelled' LIMIT 1").bind(key).first()){selected={kind,count:1};break;}}
    }
    if(selected){const dedupeKey='security-alert:'+now.slice(0,10)+':'+selected.kind;await enqueueJob(repo,env,{key:dedupeKey,kind:'mail',round:owner.confirmation_round,payload:{type:'service',round:owner.confirmation_round,dedupeKey,eventType:'security_alert',message:{to:owner.email,subject:'AfterMe / security and service alert',text:`AfterMe observed ${selected.kind} (${selected.count} sampled events in the last 24 hours). This notice summarizes sampled event types and counts. Review the maintenance page and operational health for details.`}},now});}
  }else if(turn===2){
    await repo.db.batch([
      repo.db.prepare('DELETE FROM security_events WHERE rowid IN (SELECT rowid FROM security_events WHERE hour<? LIMIT 100)').bind(new Date(Date.parse(now)-7*86400000).toISOString().slice(0,13)),
      repo.db.prepare('DELETE FROM verification_code_budget WHERE day<?').bind(new Date(Date.parse(now)-7*86400000).toISOString().slice(0,10)),
      repo.db.prepare("DELETE FROM background_jobs WHERE id IN (SELECT id FROM background_jobs WHERE state IN ('completed','cancelled') AND updated_at<? ORDER BY updated_at LIMIT 10)").bind(new Date(Date.parse(now)-7*86400000).toISOString()),
    ]);
  }
  return {ok:true,turn};
}
async function maybeSendMailHealthcheck({ repo, env, owner, now, provider = createMailProvider(env) }) {
  const preferences=repo.getSettings?(await repo.getSettings(env)).preferences:null;
  if (preferences?!preferences.selfcheck:env.MAIL_PROVIDER !== "gmail" || env.MAIL_HEALTHCHECK_ENABLED !== "true") return;
  const nowDate = new Date(now);
  const to = env.MAIL_HEALTHCHECK_EMAIL || owner.email;
  if (!to) return;
  await sendGuardedMail({
    repo,
    provider,
    env,
    eventType: "mail_healthcheck",
    to,
    subject: t(preferences?.locale||'zh','mailCheckSubject'),
    text: t(preferences?.locale||'zh','mailCheckBody')+'\n'+now+'\n'+provider.name,
    dedupeKey: `mail_healthcheck:${now.slice(0, 7)}:${to}`,
    now,
  });
}

async function releasePrivateIfReady({ repo, env, requestUrl, now, reason, provider = createMailProvider(env) }) {
  if(env.BACKGROUND_EXECUTION_MODE==='staged')return runReleaseStage(repo,env,now);
  let owner = await repo.getOwner();
  if(repo.advanceChannel) {
    if(![STATES.VERIFY,STATES.READY_TO_RELEASE,STATES.PRIVATE_RELEASE,STATES.PUBLIC_RELEASE].includes(owner.state))return {released:false,reason:'conditions-not-met',state:owner.state};
    const rules=await repo.getRoundRules(owner);
    const budget=invocationBudget(env);
    if(budget&&!budget.canStart(11))return {released:false,reason:'invocation-budget',state:owner.state};
    const gmail=env.INBOX_ACTIVE??((env.INBOUND_PROVIDER||(env.MAIL_PROVIDER==='gmail'?'gmail':'web'))==='gmail'&&enabledUnlessFalse(env.MAIL_INBOUND_ENABLED));
    const inbox=gmail?await repo.getCursor('inbox-status'):'';
    const failed=gmail&&(repo.hasBlockingInbound?await repo.hasBlockingInbound(owner.confirmation_round):await repo.db.prepare("SELECT 1 FROM inbound_mail_log WHERE status IN ('failed','processing') LIMIT 1").first());
    const inboxRound=repo.setInboxStatus&&gmail?await repo.getCursor('inbox-status-round'):String(owner.confirmation_round);
    if((String(owner.confirmation_round)===inboxRound&&['failed','degraded'].includes(inbox))||failed) return {released:false,reason:'inbox-unhealthy',state:owner.state};
    if(owner.release_suspended||owner.pause_mode||env.RELEASE_SUSPENDED==='true') return {released:false,reason:'release-suspended',state:owner.state};
    const before=await repo.getProgress(owner.confirmation_round);
    let advanced=false;
    for(const channel of ['private','public']){const current=before.find(p=>p.channel===channel);if(current?.released_at)continue;if(!rules[channel].enabled&&!current?.ready_at)continue;const count=await repo.countChannelConfirmations(owner.confirmation_round,channel);if(count<rules[channel].quorum&&!current?.ready_at)continue;await repo.advanceChannel(owner.confirmation_round,channel,now);advanced=true;}
    let progress=before;
    if(advanced){owner=await repo.getOwner();progress=await repo.getProgress(owner.confirmation_round);}
    const p=progress.find(x=>x.channel==='private'),u=progress.find(x=>x.channel==='public');
    const deliveries=p?.released_at?await deliverReleasedItems(repo,env,requestUrl,now,owner,provider):[];
    let publicDeliveries=[];
    if(u?.released_at&&rules.public.pdf&&(!budget||budget.canStart(14)))try{publicDeliveries=await deliverPublicFarewell(repo,env,now,owner,provider);}catch(error){if(!isInvocationBudgetError(error)&&(!budget||budget.canStart(2)))await repo.audit('public_pdf_delivery_deferred',{reason:error.name||'Error'},now);}
    return {released:Boolean(p?.released_at||u?.released_at),state:owner.state,progress,deliveries,publicDeliveries,reason:p?.ready_at||u?.ready_at?'release-grace-period':'conditions-not-met'};
  }
  const confirmedDeaths = await repo.countConfirmedDeathConfirmations();
  const releaseSuspended = Boolean(owner.release_suspended) || env.RELEASE_SUSPENDED === "true";

  // A legacy READY state without three death confirmations must never release content.
  if (owner.state === STATES.READY_TO_RELEASE && confirmedDeaths < LIMITS.REQUIRED_CONFIRMATIONS) {
    await repo.resetReleaseGracePeriod(STATES.VERIFY, now, owner.confirmation_round);
    await repo.audit("release_grace_cancelled", { reason: "death-confirmation-threshold-not-met" }, now);
    owner = { ...owner, state: STATES.VERIFY, release_ready_at: null };
  }

  if (!releaseSuspended && confirmedDeaths >= LIMITS.REQUIRED_CONFIRMATIONS &&
      (owner.state === STATES.VERIFY || (owner.state === STATES.READY_TO_RELEASE && !owner.release_ready_at))) {
    const from = owner.state;
    owner = await repo.startReleaseGracePeriod(now, owner.confirmation_round);
    await repo.audit("release_grace_started", {
      from,
      confirmed_deaths: confirmedDeaths,
      grace_hours: LIMITS.RELEASE_GRACE_HOURS,
      release_ready_at: owner.release_ready_at,
      reason,
    }, now);
  }

  const alreadyReleased = owner.state === STATES.PRIVATE_RELEASE || owner.state === STATES.PUBLIC_RELEASE;
  if (!canReleasePrivate({ state: owner.state, releaseSuspended, confirmedDeaths })) {
    return { released: false, reason: "conditions-not-met", state: owner.state, confirmedDeaths };
  }

  if (!alreadyReleased && !isReleaseGraceComplete(owner.release_ready_at, new Date(now))) {
    return {
      released: false,
      reason: "release-grace-period",
      state: owner.state,
      confirmedDeaths,
      releaseReadyAt: owner.release_ready_at,
      releaseAt: new Date(new Date(owner.release_ready_at).getTime() + LIMITS.RELEASE_GRACE_HOURS * 3600_000).toISOString(),
    };
  }

  if (!alreadyReleased) {
    const released = await repo.releasePrivateItems(now, owner.confirmation_round);
    if (released === false) return { released: false, reason: "release-state-changed" };
    await repo.audit("private_release", { by: reason, confirmed_deaths: confirmedDeaths }, now);
    owner = { ...owner, state: STATES.PRIVATE_RELEASE };
  }

  const deliveries = await deliverReleasedItems(repo, env, requestUrl, now, owner, provider);
  const publicRelease = await autoReleasePublicFarewellIfConfirmed({ repo, owner, releaseSuspended, now, reason });
  const publicDeliveries = publicRelease.published || owner.state === STATES.PUBLIC_RELEASE
    ? await deliverPublicFarewell(repo, env, now, owner, provider)
    : [];
  return { released: true, alreadyReleased, deliveries, publicDeliveries, publicRelease, state: publicRelease?.published || owner.state === STATES.PUBLIC_RELEASE ? STATES.PUBLIC_RELEASE : STATES.PRIVATE_RELEASE };
}

async function autoReleasePublicFarewellIfConfirmed({ repo, owner, releaseSuspended, now, reason }) {
  if (releaseSuspended) return { published: false, reason: "release-suspended" };
  const confirmedDeaths = await repo.countConfirmedDeathConfirmations();
  if (confirmedDeaths < LIMITS.REQUIRED_CONFIRMATIONS) {
    return { published: false, reason: "confirmed-death-threshold-not-met", confirmedDeaths };
  }

  const published = await repo.autoPublishPublicFarewell(now, owner.confirmation_round);
  if (published) {
    await repo.updateOwnerState(STATES.PUBLIC_RELEASE, now, owner.confirmation_round);
    await repo.audit("public_farewell_auto_released", { by: reason, confirmed_deaths: confirmedDeaths }, now);
  }
  return { published, confirmedDeaths };
}

export async function sendTransitionEmails({ repo, env, owner, toState, now, provider = createMailProvider(env) }) {
  const baseUrl = env.BASE_URL || "https://replace-with-workers-dev-url";
  if([STATES.ALERT,STATES.VERIFY].includes(toState)&&!enabledUnlessFalse(env.CONTACT_NOTIFICATIONS_ENABLED))return [];
  const rules=repo.getRoundRules?await repo.getRoundRules(owner):defaultRules();
  const preferences=repo.getSettings?(await repo.getSettings(env)).preferences:{locale:'zh'};

  if (toState === STATES.OVERDUE) {
    await sendGuardedMail({
      repo,
      provider,
      env,
      eventType: "owner_overdue",
      to: owner.email,
      subject: 'AfterMe: '+t(preferences.locale,'overdue_hours')+' · '+rules.overdue_hours+'h',
      text: t(preferences.locale,'ownerOverdue',{hours:rules.overdue_hours})+'\n'+baseUrl,
      dedupeKey: `owner_overdue:${owner.timer_anchor_at||owner.last_checkin_at}`,
      canSend: async () => {
        const current = await repo.getOwner();
        return !current.pause_mode && current.confirmation_round === owner.confirmation_round && current.state === STATES.OVERDUE;
      },
      now,
    });
  }

  if (toState === STATES.ALERT || toState === STATES.VERIFY) {
    const contactsResult = repo.listPendingTransitionContacts?await repo.listPendingTransitionContacts(owner,toState,5):await repo.listActiveContacts();
    const contacts = contactsResult.results ?? contactsResult;
    if(!contacts.length)return [];
    const templates = typeof repo.listMailTemplates === "function" ? mergeMailTemplates(await repo.listMailTemplates()) : mergeMailTemplates();
    for (const contact of contacts) {
      if(repo.getRoundRules&&!['private','public'].some(k=>rules[k].enabled&&rules[k].contact_ids.includes(contact.id)))continue;
      const dedupeKey = `${toState}:${owner.last_checkin_at}:${contact.id}:round-${owner.confirmation_round}:email-${normalizeEmail(contact.email)}`;
      let preparedTokenHash=null;
      if (await repo.hasDelivery(dedupeKey)) continue;
      const message = toState === STATES.ALERT
        ? buildContactAlertMail({ ownerName: owner.display_name, contactName: contact.name, template: templates.contact_alert,rules,locale:contact.locale||preferences.locale })
        : buildContactVerifyMail({ ownerName: owner.display_name, contactName: contact.name, template: templates.contact_verify,rules,locale:contact.locale||preferences.locale });
      const result = await sendGuardedMail({
        repo,
        provider,
        env,
        eventType: toState === STATES.ALERT ? "contact_alert" : "contact_verify",
        to: contact.email,
        canSend: async () => {
          if(repo.transitionMailAllowed)return repo.transitionMailAllowed(owner,contact,toState,preparedTokenHash);
          const current = await repo.getOwner();
          return !current.pause_mode && current.confirmation_round === owner.confirmation_round && (current.state===toState||(toState===STATES.VERIFY&&[STATES.READY_TO_RELEASE,STATES.PRIVATE_RELEASE,STATES.PUBLIC_RELEASE].includes(current.state)));
        },
        prepareMessage: toState === STATES.VERIFY ? async () => {
          const token = createToken();
          preparedTokenHash=await hashToken(token);
          await repo.rotateContactToken({ id: contact.id, tokenHash: preparedTokenHash,expectedRound:owner.confirmation_round });
          const inboundGmail=env.INBOUND_PROVIDER==='gmail'||(!env.INBOUND_PROVIDER&&env.MAIL_PROVIDER==='gmail'&&enabledUnlessFalse(env.MAIL_INBOUND_ENABLED));
          return { replyTo:inboundGmail?buildContactReplyAddress(env.VERIFICATION_EMAIL||env.FROM_EMAIL, token):undefined,text:message.text+'\n\n'+baseUrl+'/verify/'+token };
        } : undefined,
        subject: message.subject,
        text: message.text,
        dedupeKey,
        now,
      });
      if(result.reason==='invocation-budget')break;
      if (result.threadId && repo.setVerificationThread) await repo.setVerificationThread(contact.id, owner.confirmation_round, result.threadId);
    }
  }
}

function enabledUnlessFalse(value) {
  return String(value ?? "true").trim().toLowerCase() !== "false";
}

export function evaluateOperationalHealth(health, nowDate = new Date(), mailInboundEnabled = true, { mailHealthcheckEnabled = false,verificationPath='gmail',paused=false } = {}) {
  const latestScheduledAt = health?.latestScheduled?.created_at || null;
  const latestScheduledMs = latestScheduledAt ? new Date(latestScheduledAt).getTime() : NaN;
  const cronAgeMinutes = Number.isFinite(latestScheduledMs)
    ? (nowDate.getTime() - latestScheduledMs) / 60_000
    : Infinity;
  let scheduledDetails = {};
  try {
    scheduledDetails = JSON.parse(health?.latestScheduled?.details_json || "{}");
  } catch {
    scheduledDetails = {};
  }
  const cronFresh = cronAgeMinutes >= 0 && cronAgeMinutes <= 150;
  const gmailInboundHealthy = paused||verificationPath==='web'||(mailInboundEnabled && scheduledDetails.inbox_status === "healthy");
  const deliveriesHealthy = !(health?.outboundProblemCount > 0) && !(health?.blockedMail?.length > 0) && !(health?.privateDeliveryProblemCount > 0) && !(health?.publicDeliveryProblemCount > 0);
  const lastMailCheck = new Date(health?.latestMailHealthcheck?.created_at || '').getTime();
  const outboundFresh = !mailHealthcheckEnabled || (Number.isFinite(lastMailCheck) && nowDate.getTime() >= lastMailCheck && nowDate.getTime() - lastMailCheck <= 42 * 86400_000);
  const processingHealthy = !(health?.inboundProblemCount > 0);
  return {
    ok: cronFresh && gmailInboundHealthy && deliveriesHealthy && processingHealthy && outboundFresh,
    checks: {
      worker_reachable: true,
      cron_fresh: cronFresh,
      gmail_inbound_healthy: gmailInboundHealthy,
      deliveries_healthy: deliveriesHealthy,
      inbound_processing_healthy: processingHealthy,
      mail_outbound_fresh: outboundFresh,
    },
    last_scheduled_at: latestScheduledAt,
    cron_age_minutes: Number.isFinite(cronAgeMinutes) ? Number(cronAgeMinutes.toFixed(1)) : null,
  };
}
export async function deliverReleasedItems(repo, env, requestUrl, now, owner, provider = createMailProvider(env)) {
  const itemsResult = await repo.listReleasedPrivateItemsForDelivery({pending:true,limit:5,now});
  const items = itemsResult.results ?? itemsResult;
  const results = [];
  if(!items.length)return results;

  const templates = typeof repo.listMailTemplates === "function" ? mergeMailTemplates(await repo.listMailTemplates()) : mergeMailTemplates();
  for (const item of items) {
    const budget=invocationBudget(env);
    if(budget&&!budget.canStart(14,provider.name==='gmail'?2:1)){results.push({item_id:item.id,status:'deferred',reason:'invocation-budget'});break;}
    const mode = storedPayloadMode(item.encrypted_payload);
    if (mode !== "link") {
      await repo.recordPrivateDeliveryState?.(item.id, 'manual', 'passphrase-content', now,item.delivery_version??0);
      await repo.audit("private_delivery_deferred", { item_id: item.id, reason: "passphrase-content-cannot-be-delivered-inline" }, now);
      results.push({ item_id: item.id, recipient: item.recipient_email, status: "deferred", reason: "passphrase-content" });
      continue;
    }

    let opened;
    if(env.PDF_GENERATION_MODE!=='browser'||!repo.getSettings){
      try {
        opened = await openStoredPayload(item.encrypted_payload, env);
      } catch (error) {
        await repo.recordPrivateDeliveryState?.(item.id, 'failed', 'decrypt-failed', now,item.delivery_version??0);
        await repo.audit("private_delivery_deferred", { item_id: item.id, reason: "decrypt-failed", error: error.name||'Error' }, now);
        results.push({ item_id: item.id, recipient: item.recipient_email, status: "deferred", reason: "decrypt-failed" });
        continue;
      }
    }

    let pdf;
    try {
    if(repo.getSettings) {
      const generated=await cachedPrivatePdf(repo,env,item,owner);
      if(generated.conflict){results.push({item_id:item.id,status:'deferred',reason:'revision-changed'});continue;}
      pdf=generated.bytes;
      if(!pdf?.length||new TextDecoder().decode(pdf.subarray(0,5))!=='%PDF-'){const rebuilt=await cachedPrivatePdf(repo,env,{...item,pdf_payload:null,pdf_cache_key:null},owner);if(rebuilt.conflict)continue;pdf=rebuilt.bytes;}
    } else if (item.pdf_payload) {
      try {
        const storedPdf = await openStoredPayload(item.pdf_payload, env);
        pdf = base64ToBytes(storedPdf.plaintext);
      } catch (error) {
        await repo.audit("private_pdf_rebuild", { item_id: item.id, reason: error.name||'Error' }, now);
      }
    }
    if (!pdf) {
      pdf = buildPrivateLetterPdf({ chineseFont:await cloudChineseFont(env),ownerName: owner?.display_name, recipientName: item.recipient_name, body: opened.plaintext, updatedAt: item.updated_at || item.created_at || now });
      const pdfPayload = await buildStoredPayload({ body: { plaintext: bytesToBase64(pdf) }, env });
      await repo.updatePrivateItemPdf({ id: item.id, pdfPayload });
    }
    if(!pdf?.length||new TextDecoder().decode(pdf.subarray(0,5))!=='%PDF-')throw Error('Invalid PDF derivative');
    } catch(error) {
      if(isInvocationBudgetError(error)){results.push({item_id:item.id,status:'deferred',reason:'invocation-budget'});break;}
      await repo.recordPrivateDeliveryState?.(item.id,error.code==='pdf_not_ready'?'pending':'failed',error.code==='pdf_not_ready'?'pdf-not-ready':'pdf-generation-failed',now,item.delivery_version??0);
      await repo.audit('private_pdf_delivery_deferred',{item_id:item.id,reason:error.name||'Error'},now);
      results.push({item_id:item.id,status:'deferred',reason:'pdf-generation-failed'});continue;
    }
    const rules=repo.getRoundRules?await repo.getRoundRules(owner):defaultRules();
    const message = buildPrivateReleaseMail({ ownerName: owner?.display_name, recipientName: item.recipient_name, template: templates.private_release,rules,locale:item.recipient_locale||'zh' });
    const result = await sendGuardedMail({
      repo,
      provider,
      env,
      eventType: "private_letter_release",
      to: item.recipient_email,
      subject: message.subject,
      text: message.text,
      attachments: [{ filename: `${owner?.display_name || "本人"}留给您的一封信.pdf`, contentType: "application/pdf", data: pdf }],
      dedupeKey: repo.getMailDeliveryKey?repo.getMailDeliveryKey(item):`private_letter_release:${item.id}:${item.recipient_email}`,
      canSend: async () => {
        if(env.RELEASE_SUSPENDED==='true')return false;
        if(repo.privateDeliveryAllowed)return repo.privateDeliveryAllowed(item,owner.confirmation_round);
        if (!await releaseStillAllowed(repo, env, owner)) return false;
        const eligible = await repo.listReleasedPrivateItemsForDelivery({id:item.id});
        return (eligible.results ?? eligible).some(current => current.id === item.id && current.recipient_email === item.recipient_email && current.revision===item.revision);
      },
      now,
    });
    if(result.reason==='invocation-budget'){results.push({item_id:item.id,status:'deferred',reason:result.reason});break;}
    if (result.reason !== 'dedupe') await repo.recordPrivateDeliveryState?.(item.id, result.status, result.reason || result.error, now,item.delivery_version??0);
    results.push({ item_id: item.id, recipient: item.recipient_email, status: result.status });
  }

  return results;
}
async function rebuildPdfArtifacts(repo, env, now) {
  const owner = await repo.getOwner();
  const document = await repo.getPublicFarewell();
  const groups = await repo.farewell.listFormalGroups();
  const publicPdf = buildPublicFarewellPdf({ chineseFont:await cloudChineseFont(env),ownerName: owner?.display_name, groups, updatedAt: document?.updated_at || now });
  await repo.saveDocumentArtifact(await makeArtifact("public_farewell", "afterme-public-farewell.pdf", publicPdf, document?.updated_at || now));

  const itemsResult = await repo.listPrivateItemsForPdfBackfill();
  const items = itemsResult.results ?? itemsResult;
  let privateGenerated = 0;
  let skipped = 0;
  for (const item of items) {
    if (storedPayloadMode(item.encrypted_payload) !== "link") { skipped += 1; continue; }
    const opened = await openStoredPayload(item.encrypted_payload, env);
    const pdf = buildPrivateLetterPdf({ chineseFont:await cloudChineseFont(env),ownerName: owner?.display_name, recipientName: item.recipient_name, body: opened.plaintext, updatedAt: item.updated_at || item.created_at || now });
    const pdfPayload = await buildStoredPayload({ body: { plaintext: bytesToBase64(pdf) }, env });
    await repo.updatePrivateItemPdf({ id: item.id, pdfPayload });
    privateGenerated += 1;
  }
  return { public_generated: true, private_generated: privateGenerated, skipped, generator_version: PDF_GENERATOR_VERSION };
}

export async function ensureCurrentPdfArtifacts(repo, env, now) {
  if(repo.getSettings&&repo.db)return processPdfBatch(repo,env,now);
  if (typeof repo.getLatestAudit !== "function") return { skipped: true, reason: "audit-version-check-unavailable" };
  const latest = await repo.getLatestAudit("pdf_artifacts_rebuilt");
  let details = {};
  try {
    details = JSON.parse(latest?.details_json || "{}");
  } catch {
    details = {};
  }
  if (details.generator_version === PDF_GENERATOR_VERSION) {
    return { skipped: true, reason: "current", generator_version: PDF_GENERATOR_VERSION };
  }
  const result = await rebuildPdfArtifacts(repo, env, now);
  await repo.audit("pdf_artifacts_rebuilt", result, now);
  return result;
}

export async function deliverPublicFarewell(repo, env, now, owner, provider = createMailProvider(env)) {
  let artifact = repo.getSettings?null:await repo.getDocumentArtifact("public_farewell");
  if (!artifact&&!repo.getSettings) {
    const groups = await repo.farewell.listFormalGroups();
    const document = await repo.getPublicFarewell();
    const pdf = buildPublicFarewellPdf({ chineseFont:await cloudChineseFont(env),ownerName: owner?.display_name, groups, updatedAt: document?.updated_at || now });
    const generated = await makeArtifact("public_farewell", "afterme-public-farewell.pdf", pdf, document?.updated_at || now);
    await repo.saveDocumentArtifact(generated);
    artifact = { ...generated, content_base64: generated.contentBase64, mime_type: generated.mimeType };
  }
  const rules=repo.getRoundRules?await repo.getRoundRules(owner):null;
  const snapshot=rules&&repo.getPublicDeliverySnapshot?await repo.getPublicDeliverySnapshot(owner.confirmation_round):null;
  const contactsResult=snapshot?snapshot.contacts:await repo.listActiveContacts();
  let contacts = contactsResult.results ?? contactsResult;
  const document=snapshot?snapshot.document:rules?await repo.getPublicFarewell():null;
  const formalRevision=snapshot?snapshot.formalRevision:rules&&repo.farewell.getVersions?(await repo.farewell.getVersions()).formal_revision:0;
  if(rules) {
    const recipients=snapshot?snapshot.recipients:(await repo.listActiveRecipients()).results;
    contacts=[...contacts.map(c=>({...c,audience_key:'contact:'+c.id,type:'contact'})),...recipients.map(r=>({...r,audience_key:'recipient:'+r.id,type:'recipient'}))].filter(c=>rules.public.audience.includes(c.audience_key));
  }
  const results = [];
  const cursorKey=snapshot?snapshot.cursorKey:rules?`public-delivery:${owner.confirmation_round}:${formalRevision}:${document.updated_at}`:null;
  const cursor=snapshot?snapshot.cursor:cursorKey&&repo.getCursor?await repo.getCursor(cursorKey):'';
  contacts.sort((a,b)=>String(a.audience_key||a.id).localeCompare(String(b.audience_key||b.id)));
  if(cursor){const at=contacts.findIndex(c=>String(c.audience_key||c.id)===cursor);if(at>=0)contacts=[...contacts.slice(at+1),...contacts.slice(0,at+1)];}
  let completedCursor=null;
  const mailKey=contact=>rules?`public_farewell_release:v2:${formalRevision}:${document.updated_at}:${contact.audience_key}:${normalizeEmail(contact.email)}`:`public_farewell_release:${artifact.sha256}:${contact.id}`;
  const selected=contacts.slice(0,5),keys=selected.map(mailKey),completed=new Set();
  if(repo.db&&keys.length){
    const placeholders=keys.map(()=>'?').join(',');
    for(const row of (await repo.db.prepare(`SELECT dedupe_key FROM mail_claims WHERE dedupe_key IN (${placeholders}) AND status IN ('sent','dry_run','uncertain','sending') UNION ALL SELECT dedupe_key FROM delivery_log WHERE dedupe_key IN (${placeholders}) AND status IN ('sent','dry_run')`).bind(...keys,...keys).all()).results)completed.add(row.dedupe_key);
  }
  let templates;
  const localeArtifacts=new Map();
  for (const contact of selected) {
    const dedupeKey=mailKey(contact);
    if(completed.has(dedupeKey)){completedCursor=String(contact.audience_key||contact.id);results.push({contact_id:contact.id,status:'skipped',reason:'dedupe'});continue;}
    const budget=invocationBudget(env);if(budget&&!budget.canStart(14,provider.name==='gmail'?2:1))break;
    templates ||= typeof repo.listMailTemplates === "function" ? mergeMailTemplates(await repo.listMailTemplates()) : mergeMailTemplates();
    if(repo.getSettings){
      const locale=contact.locale||'zh';
      if(!localeArtifacts.has(locale)){
        try{localeArtifacts.set(locale,await cachedPublicPdf(repo,env,owner,locale,true,{bytesOnly:true}));}
        catch(error){if(isInvocationBudgetError(error))break;localeArtifacts.set(locale,{preparation_error:error.code==='pdf_not_ready'?'pdf-not-ready':'pdf-preparation-failed'});}
      }
      artifact=localeArtifacts.get(locale);
      if(artifact.preparation_error){completedCursor=String(contact.audience_key||contact.id);results.push({contact_id:contact.id,status:'pending',reason:artifact.preparation_error});continue;}
    }
    if(rules&&artifact.updated_at!==document.updated_at)break;
    const message = buildPublicReleaseMail({ ownerName: owner?.display_name, contactName: contact.name, template: templates.public_release,rules:rules||defaultRules(),locale:contact.locale||'zh' });
    const result = await sendGuardedMail({
      repo, provider, env, eventType: "public_farewell_release", to: contact.email,
      subject: message.subject, text: message.text,
      attachments: [{ filename: artifact.filename, contentType: artifact.mime_type || artifact.mimeType, data: artifact.bytes || base64ToBytes(artifact.content_base64 || artifact.contentBase64) }],
      dedupeKey, now,
      canSend: async () => {
        if(env.RELEASE_SUSPENDED==='true')return false;
        if(repo.publicDeliveryAllowed)return repo.publicDeliveryAllowed(contact,owner.confirmation_round,document.updated_at,formalRevision);
        if(!await releaseStillAllowed(repo,env,owner,'public'))return false;
        if(rules&&(await repo.getPublicFarewell()).updated_at!==document.updated_at)return false;
        const current=contact.type==='recipient'?await repo.getRecipient(contact.id):await repo.getContact(contact.id);
        return Boolean(current?.active)&&current.email===contact.email;
      },
    });
    if(result.reason==='invocation-budget')break;
    completedCursor=String(contact.audience_key||contact.id);
    results.push({ contact_id: contact.id, recipient: contact.email, status: result.status });
  }
  if(cursorKey&&completedCursor!==null&&repo.setCursor)await repo.setCursor(cursorKey,completedCursor);
  return results;
}

async function makeArtifact(key, filename, bytes, updatedAt) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    key, filename, mimeType: "application/pdf", contentBase64: bytesToBase64(bytes),
    sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""), updatedAt,
  };
}

export function privateLetterPdfResponse(pdf, ownerName = "本人") {
  const filename = `${ownerName}留给您的一封信.pdf`;
  return new Response(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="private-letter.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function requireAdmin(request, env) {
  return authenticate(request,env,await limitedBody(request));
}

async function contactFromToken(repo, token) {
  if (!token) return null;
  return repo.findContactByTokenHash(await hashToken(token));
}

async function readBody(request) {
  return limitedBody(request);
}

function isForm(request) {
  return (request.headers.get("content-type") || "").includes("application/x-www-form-urlencoded");
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new HttpError(400, `${field} is required`);
  if(value.length>102400)throw new HttpError(400,`${field} too long`);
  if(field==='email'&&(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())||value.length>254))throw new HttpError(400,'Invalid email');
  return value.trim();
}

function optionalString(value) {
  if(value===undefined||value===null)return '';
  if(typeof value!=='string')throw new HttpError(400,'Text field has wrong type');
  return value.trim();
}

function requireRevision(value) {
  if (value === undefined || value === null || value === '') throw new HttpError(428, '请刷新旧页面后再编辑；当前页面缺少版本信息。');
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new HttpError(400, '版本信息无效。');
  return revision;
}

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function pageParameters(url,{compound=false}={}){const c=url.searchParams.get('cursor')||'0',l=url.searchParams.get('limit')||'50';if((!compound&&(!/^\d+$/.test(c)||!Number.isSafeInteger(Number(c))))||!/^\d+$/.test(l)||!Number.isSafeInteger(Number(l))||Number(l)<1)throw new HttpError(400,'Invalid pagination');return {cursor:compound?c:Number(c),limit:Math.min(100,Number(l))};}
function parseBool(value) {
  if(value!==undefined&&value!==null&&!['',true,false,0,1,'0','1','false','true','on','off'].includes(value))throw new HttpError(400,'Invalid boolean');
  return value === true || value === 1 || value === "1" || value === "true" || value === "on";
}

function buildContactReplyAddress(fromEmail, token) {
  const normalized = normalizeEmail(fromEmail);
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || !token) return undefined;
  return `${normalized.slice(0, at)}+verify-${token}${normalized.slice(at)}`;
}

function getBaseUrl(env, url) {
  return env.BASE_URL && !env.BASE_URL.includes("example") ? env.BASE_URL.replace(/\/$/, "") : url.origin;
}

function buildManualContactPack({ owner, contact, verifyUrl, templates = mergeMailTemplates(),rules=defaultRules() }) {
  const ownerName = owner?.display_name || "本人";
  return {
    verify_url: verifyUrl,
    messages: {
      alert: buildContactAlertMail({ ownerName, contactName: contact.name, template: templates.contact_alert,rules,locale:contact.locale||'zh' }),
      verify: buildContactVerifyMail({ ownerName, contactName: contact.name, template: templates.contact_verify,rules,locale:contact.locale||'zh' }),
    },
  };
}

function manualContactPackPage({ contactName, pack }) {
  return layout({
    title: "演练与故障备用",
    body: `<header><h1>给 ${escapeHtml(contactName)} 的演练/备用通知</h1><p>这些文本供演练与备用转交通知使用。正常流程按阶段自动发送。</p></header>
      <section class="panel"><h2>确认链接</h2><p>仅在你主动演练或邮件通道失效时使用。新链接已生效，旧链接已失效。</p><pre>${escapeForPre(pack.verify_url)}</pre></section>
      <section class="panel"><h2>失联提醒文本</h2><p>ALERT 阶段用于联系本人；确认链接在核验阶段提供。</p><pre>${escapeForPre(pack.messages.alert.text)}</pre></section>
      <section class="panel"><h2>人工确认文本</h2><p>进入 VERIFY 阶段时使用，才附上确认链接。</p><pre>${escapeForPre(pack.messages.verify.text)}</pre></section>`,
  });
}

function redirect(location) {
  return new Response(null, { status: 303, headers: { Location: location } });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function personErrorResponse(error){
  if(![400,404,409].includes(error.status))throw error;
  return json({ok:false,error:error.code||'invalid_person',message:error.code==='edit_conflict'?'人员资料已在其他页面修改，请重新载入。':error.code==='person_email_exists'?'这个邮箱已经属于现有人员。':'无法保存人员资料，请检查输入。',...(error.current?{current:error.current}:{})},error.status);
}

function createToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function hashToken(token) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function escapeForPre(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
