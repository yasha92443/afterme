// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import { LIMITS, remainingDailyEmailCapacity } from "./core.js";
import { REPLY_COMMANDS } from './i18n.js';
import { budgetFetch, invocationBudget, isInvocationBudgetError, bytesToBase64 as fastBytesToBase64, base64ToBytes as fastBase64ToBytes } from './invocation-budget.js';
import {Buffer} from 'node:buffer';

export function createMailProvider(env) {
  if (env.MAIL_PROVIDER === "gmail") return new GmailMailProvider(env);
  if (env.MAIL_PROVIDER === "resend") {
    if(!env.RESEND_API_KEY||!env.FROM_EMAIL) throw new Error('Resend configuration incomplete');
    if(!['gmail','web'].includes(env.INBOUND_PROVIDER)) throw new Error('Choose an explicit verification path for Resend');
    if(env.INBOUND_PROVIDER==='gmail'&&(!env.VERIFICATION_EMAIL||!env.GMAIL_CLIENT_ID||!env.GMAIL_CLIENT_SECRET||!env.GMAIL_REFRESH_TOKEN)) throw new Error('Verification inbox configuration incomplete');
    return new ResendMailProvider(env);
  }
  if(env.MAIL_PROVIDER&&!['dry-run','gmail','resend'].includes(env.MAIL_PROVIDER)) throw new Error('Unknown mail provider');
  return new DryRunMailProvider();
}

export class DryRunMailProvider {
  constructor() {
    this.name = "dry-run";
  }

  async send(message) {
    console.log('[mail:dry-run]', JSON.stringify({attachments:(message.attachments||[]).length}));
    return { status: "dry_run" };
  }
}

export class ResendMailProvider {
  constructor(env) {
    this.name = "resend";
    this.env = env;
    this.apiKey = env.RESEND_API_KEY;
    this.from = env.FROM_EMAIL;
  }

  async send(message) {
    const payload = {
      from: message.from || this.from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
    };
    if (message.replyTo) payload.reply_to = message.replyTo;
    if (message.attachments?.length) payload.attachments = message.attachments.map((item) => ({
      filename: item.filename, content: bytesToBase64(item.data),
    }));
    const body=JSON.stringify(payload);
    if (message.canSend && !await message.canSend()) return { status: 'skipped', error: 'state-changed' };
    const response = await budgetFetch(this.env, "https://api.resend.com/emails", {
      signal: AbortSignal.timeout(20000),
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(message.dedupeKey ? { "Idempotency-Key": message.dedupeKey } : {}),
        "Content-Type": "application/json",
      },
      body,
    });
    if (!response.ok) return { status: response.status >= 500 ? "uncertain" : "failed", error: `resend HTTP ${response.status}` };
    return { status: "sent" };
  }
}

export class GmailMailProvider {
  constructor(env) {
    this.name = "gmail";
    this.env = env;
    this.clientId = env.GMAIL_CLIENT_ID;
    this.clientSecret = env.GMAIL_CLIENT_SECRET;
    this.refreshToken = env.GMAIL_REFRESH_TOKEN;
    this.from = env.FROM_EMAIL;
  }

  missingConfiguration() {
    return ["clientId", "clientSecret", "refreshToken", "from"].filter((key) => !this[key]);
  }

  async inboundRequest(input,init) {
    if(!this.transport)return budgetFetch(this.env,input,init);
    invocationBudget(this.env)?.consumeExternal();
    return this.transport(input,init);
  }

  async send(message) {
    if((this.env.BACKGROUND_EXECUTION_MODE==='staged'||this.env.MAIL_PIPELINE_MODE==='staged')&&!message.attachments?.length)return this.sendMedia(message);
    const missing = this.missingConfiguration();
    if (missing.length) return { status: "failed", error: `gmail provider missing: ${missing.join(", ")}` };

    let token;
    try { token = await this.getAccessToken(); }
    catch (error) { if(isInvocationBudgetError(error)) return { status:'deferred', reason:'invocation-budget' }; return { status: 'failed', error: 'OAuth: '+(error.name||'Error') }; }
    if (!token.ok) return { status: "failed", error: token.error };
    // Complete MIME/base64 work before the final state check and dispatch.
    const body = JSON.stringify({raw:buildGmailRawMessage({from:message.from||this.from,to:message.to,replyTo:message.replyTo,subject:message.subject,text:message.text,attachments:message.attachments})});
    if (message.canSend && !await message.canSend()) return { status: 'skipped', error: 'state-changed' };
    const response = await budgetFetch(this.env, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      signal: AbortSignal.timeout(20000),
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
      body,
    });
    if (!response.ok) return { status: response.status >= 500 ? "uncertain" : "failed", error: `gmail HTTP ${response.status}` };
    const sent = await response.json();
    return { status: "sent", id: sent.id, threadId: sent.threadId };
  }

  async sendMedia(message,{transport=this.transport}={}) {
    if(message.attachments?.length)return {status:'failed',error:'media-attachments-require-staged-upload'};
    if(this.missingConfiguration().length)return {status:'failed',error:'gmail-configuration'};
    let token,body,claimed=false;
    try{
      token=await this.getAccessToken();if(!token.ok)return {status:'failed',error:token.error};
      body=buildGmailMimeMessage({...message,from:message.from||this.from});
      if(Buffer.byteLength(body,'utf8')>256*1024)return {status:'failed',error:'media-body-too-large'};
      if(message.canSend&&!await message.canSend())return {status:'skipped',error:'state-changed'};
      if(message.beforeFinal){if(!await message.beforeFinal())return {status:'skipped',reason:'claimed-or-cap'};claimed=true;}
      if(message.canSend&&!await message.canSend())return {status:'skipped',error:'state-changed',claimed};
    }catch(error){return isInvocationBudgetError(error)?{status:'deferred',reason:'invocation-budget',claimed}:{status:'failed',error:'media-preparation-failed',claimed};}
    try{
      const input='https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media&fields=id,threadId',init={method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token.accessToken,'Content-Type':'message/rfc822'},body};
      if(transport)invocationBudget(this.env)?.consumeExternal();
      const response=await (transport?transport(input,init):budgetFetch(this.env,input,init));
      if(!response.ok)return {status:response.status>=500?'uncertain':'failed',error:'gmail HTTP '+response.status,claimed};
      const sent=await boundedJson(response,16384);if(typeof sent?.id!=='string'||!sent.id)return {status:'uncertain',error:'gmail-invalid-receipt',claimed};
      return {status:'sent',id:sent.id,threadId:sent.threadId,claimed};
    }catch(error){return isInvocationBudgetError(error)?{status:'deferred',reason:'invocation-budget',claimed}:{status:'uncertain',error:'gmail-response-lost',claimed};}
  }

  async listInboundPage({pageToken='',query='newer_than:30d -from:me',maxResults=100}={}) {
    if(typeof pageToken!=='string'||pageToken.length>4096||!Number.isSafeInteger(maxResults)||maxResults<1||maxResults>100)throw Error('Invalid inbox page request');
    if(this.missingConfiguration().length)throw Error('Gmail inbox configuration unavailable');
    const token=await this.getAccessToken();if(!token.ok)throw Error('Gmail inbox OAuth unavailable');
    const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('maxResults',String(maxResults));url.searchParams.set('q',query);url.searchParams.set('fields','messages(id,threadId),nextPageToken');if(pageToken)url.searchParams.set('pageToken',pageToken);
    const response=await this.inboundRequest(url,{signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token.accessToken}});
    if(!response.ok)throw Object.assign(Error('Gmail inbox list unavailable'),{statusCode:response.status});
    const value=await boundedJson(response,65536),messages=value?.messages||[];
    if(!value||!Array.isArray(messages)||messages.length>100||value.nextPageToken!==undefined&&(typeof value.nextPageToken!=='string'||value.nextPageToken.length>4096))throw Error('Gmail inbox list incomplete');
    const seen=new Set();for(const row of messages){if(!row||typeof row.id!=='string'||!row.id||row.id.length>512||seen.has(row.id)||row.threadId!==undefined&&(typeof row.threadId!=='string'||row.threadId.length>512))throw Error('Gmail inbox list incomplete');seen.add(row.id);}
    return {messages:messages.map(({id,threadId})=>({id,...(threadId?{threadId}:{})})),nextPageToken:value.nextPageToken||''};
  }

  async fetchInboundDetail({id,threadId}={}) {
    if(typeof id!=='string'||!id||id.length>512)throw Error('Invalid inbox message request');
    if(this.missingConfiguration().length)throw Error('Gmail inbox configuration unavailable');
    const token=await this.getAccessToken();if(!token.ok)throw Error('Gmail inbox OAuth unavailable');
    const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages/'+encodeURIComponent(id));url.searchParams.set('format','full');
    const response=await this.inboundRequest(url,{signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token.accessToken}});
    if(!response.ok)throw Object.assign(Error('Gmail inbox detail unavailable'),{statusCode:response.status});
    return this.readInboundDetail(response,{id,threadId});
  }

  async listInboundMessages({ maxResults = 40, query = "newer_than:30d -from:me", repo } = {}) {
    const missing = this.missingConfiguration();
    if (missing.length) throw new Error(`gmail provider missing: ${missing.join(", ")}`);
    const token = await this.getAccessToken();
    if (!token.ok) throw new Error(token.error);

    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    const staged=this.env.BACKGROUND_EXECUTION_MODE==='staged'||this.env.MAIL_PIPELINE_MODE==='staged';
    listUrl.searchParams.set("maxResults", '100');
    listUrl.searchParams.set("q", query);
    if(staged)listUrl.searchParams.set('fields','messages(id,threadId),nextPageToken');
    let pageToken = repo ? await repo.getCursor('gmail-inbox-page') : '';
    const messages = [];
    // Failed current-round messages remain retryable even outside the search's 30-day window.
    const retryIds=repo?.pendingInboundIds?await repo.pendingInboundIds(Math.min(5,maxResults)):[];
    if(retryIds.length){
      for(const id of retryIds){const detail=new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);detail.searchParams.set('format','full');const response=await this.inboundRequest(detail,{signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${token.accessToken}`}});if(!response.ok)throw Error(`gmail retry fetch failed: ${response.status}`);messages.push(await this.readInboundDetail(response,{id}));}
      messages.backlog=true;messages.nextPageToken=pageToken;return messages;
    }
    for (let page = 0; page < (staged?1:4); page++) {
      if (pageToken) listUrl.searchParams.set('pageToken', pageToken);
      else listUrl.searchParams.delete('pageToken');
      const listResponse = await this.inboundRequest(listUrl, {
        signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${token.accessToken}` },
      });
      if (!listResponse.ok) {
        if (pageToken && listResponse.status === 400 && repo) await repo.setCursor('gmail-inbox-page', '');
        throw new Error(`gmail inbox list failed: ${listResponse.status}`);
      }
      const list = staged?await boundedJson(listResponse,65536):await listResponse.json();
      if(!list||!Array.isArray(list.messages||[])||list.nextPageToken!==undefined&&typeof list.nextPageToken!=='string')throw Error('gmail inbox list response incomplete');
      const summaries = list.messages || [];
      const completed=repo?.completedInboundIds?await repo.completedInboundIds(summaries.map(m=>m.id)):new Set(repo?await Promise.all(summaries.map(async m=>await repo.inboundMessageComplete(m.id)?m.id:null)):[]);
      const fresh=summaries.filter(m=>!completed.has(m.id)),remaining=Math.max(0,Math.min(40,maxResults)-messages.length),capacity=invocationBudget(this.env)?Math.max(0,invocationBudget(this.env).remainingExternal-3):remaining,selected=fresh.slice(0,Math.min(remaining,capacity));
      for (let offset = 0; offset < selected.length; offset += 5) {
        const batch = await Promise.all(selected.slice(offset, offset + 5).map(async ({ id,threadId }) => {
      const detailUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
      detailUrl.searchParams.set("format", "full");
      const response = await this.inboundRequest(detailUrl, {
        signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${token.accessToken}` },
      });
      if (!response.ok) throw new Error(`gmail message fetch failed: ${response.status}`);
      return this.readInboundDetail(response,{id,threadId});
        }));
        messages.push(...batch.filter(Boolean));
      }
      if(fresh.length>selected.length){messages.backlog=true;break;}
      pageToken = list.nextPageToken || '';
      if(messages.length>=Math.min(40,maxResults)){messages.backlog=Boolean(pageToken);break;}
      if (!pageToken) break;
    }
    messages.nextPageToken = pageToken;
    messages.backlog ||= Boolean(pageToken);
    return messages;
  }

  async readInboundDetail(response,{id,threadId}={}) {
    if(this.env.BACKGROUND_EXECUTION_MODE!=='staged'&&this.env.MAIL_PIPELINE_MODE!=='staged')return parseGmailApiMessage(await response.json());
    const value=await boundedJson(response,65536);
    try{if(value&&typeof value.id==='string'&&value.payload&&typeof value.payload==='object'&&(!id||value.id===id))return parseGmailApiMessage(value);}catch{/* Keep this ID retryable; never turn incomplete input into an ignored reply. */}
    return {id:String(id||''),threadId:String(threadId||''),from:'',recipients:'',subject:'',body:'',authenticationPassed:false,receivedAt:null,incomplete:true};
  }

  async getAccessToken() {
    if (this.cachedToken && this.tokenExpiresAt > Date.now() + 60000) return { ok: true, accessToken: this.cachedToken };
    const response = await this.inboundRequest("https://oauth2.googleapis.com/token", {
      signal: AbortSignal.timeout(15000),
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      return { ok: false, error: `gmail OAuth HTTP ${response.status}${['invalid_grant','invalid_client','unauthorized_client','access_denied'].includes(data.error)?' ('+data.error+')':''}` };
    }
    this.cachedToken = data.access_token;
    this.tokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
    return { ok: true, accessToken: data.access_token };
  }
}

export async function sendGuardedMail({ repo, provider, env, eventType, to, replyTo, subject, text, attachments = [], dedupeKey, now, canSend, prepareMessage }) {
  const budget=invocationBudget(env);
  if(budget&&!budget.canStart(15,provider.name==='gmail'?2:1))return {status:'deferred',reason:'invocation-budget'};
  if(provider.env)provider.env=env;
  if (await repo.hasDelivery(dedupeKey)) return { status: "skipped", reason: "dedupe" };

  const cap=Number(env.MAX_DAILY_EMAILS||LIMITS.MAX_DAILY_EMAILS);
  const settings=repo.getSettings?await repo.getSettings(env):null;
  const maxDaily=Math.min(cap,settings?.preferences.daily_email_limit??cap);
  const sentToday = await repo.countDeliveriesToday(now.slice(0, 10));
  if (remainingDailyEmailCapacity(sentToday, maxDaily) <= 0) {
    await repo.logDelivery({
      eventType,
      recipientEmail: to,
      subject,
      provider: provider.name,
      status: "skipped",
      dedupeKey,
      lastError: "daily email cap reached",
      now,
    });
    return { status: "skipped", reason: "daily-cap" };
  }

  if (repo.claimMail && !await repo.claimMail(dedupeKey, now, maxDaily)) return { status: "skipped", reason: "claimed-or-cap" };
  let result,enteredProvider=false;
  try {
    if (canSend && !await canSend()) {
      if (repo.finishMailClaim) await repo.finishMailClaim(dedupeKey, "cancelled", "state-changed-before-send");
      return { status: "skipped", reason: "state-changed" };
    }
    if (prepareMessage) {const prepared=await prepareMessage();replyTo=prepared.replyTo??replyTo;subject=prepared.subject??subject;text=prepared.text??text;}
    enteredProvider=true;
    result = await provider.send({ from: env.FROM_EMAIL, to, replyTo, subject, text, attachments, canSend, dedupeKey });
  } catch (error) {
    result = isInvocationBudgetError(error) ? {status:'deferred',reason:'invocation-budget'} : { status: enteredProvider?'uncertain':'failed', error: error.name||'Error' };
  }
  // A timeout can occur after the provider accepted the mail. Never auto retry it.
  const claimStatus = result.status==='deferred'||(result.status === 'skipped' && result.error === 'state-changed') ? 'cancelled' : result.status;
  if (repo.finishMailClaim) await repo.finishMailClaim(dedupeKey, claimStatus, result.error);
  await repo.logDelivery({
    eventType,
    recipientEmail: to,
    subject,
    provider: provider.name,
    status: result.status==='deferred'?'skipped':result.status,
    dedupeKey,
    lastError: result.error,
    now,
  });
  return result;
}

export function buildGmailRawMessage(message) {return base64UrlEncodeUtf8(buildGmailMimeMessage(message));}

export function buildGmailMimeMessage({ from, to, replyTo, subject, text, attachments = [],boundary,messageId }) {
  const headers = [
    `From: ${sanitizeAddress(from)}`,
    `To: ${sanitizeAddress(to)}`,
  ];
  if (replyTo) headers.push(`Reply-To: ${sanitizeAddress(replyTo)}`);
  if(messageId){if(!/^<[A-Za-z0-9._-]{1,180}@[A-Za-z0-9.-]{1,80}>$/.test(messageId))throw new Error('Invalid MIME message id');headers.push('Message-ID: '+messageId);}
  headers.push(`Subject: ${encodeMimeHeader(subject)}`, "MIME-Version: 1.0");
  if (!attachments.length) {
    headers.push("Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", String(text || ""));
  } else {
    boundary ||= `afterme_${crypto.randomUUID().replaceAll("-", "")}`;
    if(!/^[A-Za-z0-9_-]{1,70}$/.test(boundary))throw new Error('Invalid MIME boundary');
    if(new RegExp('(?:^|\\r?\\n)--'+boundary+'(?:--|\\r?\\n|$)').test(String(text||'')))throw new Error('MIME boundary appears in message text');
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", String(text || ""));
    for (const attachment of attachments) {
      if(attachment.contentType&&!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(attachment.contentType))throw new Error('Invalid MIME content type');
      const filename = mimeFilenameParameters(attachment.filename);
      headers.push(
        `--${boundary}`,
        `Content-Type: ${attachment.contentType || "application/octet-stream"}; name="${filename.fallback}"; name*=UTF-8''${filename.extended}`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${filename.fallback}"; filename*=UTF-8''${filename.extended}`,
        "",
        wrapBase64(bytesToBase64(attachment.data))
      );
    }
    headers.push(`--${boundary}--`, "");
  }
  return headers.join("\r\n");
}

export function parseGmailApiMessage(message) {
  const headers = {};
  for (const header of message?.payload?.headers || []) {
    const key = String(header.name || "").toLowerCase();
    headers[key] = headers[key] ? `${headers[key]}\n${header.value || ""}` : String(header.value || "");
  }
  const bodyState={},body=extractMimeText(message?.payload,bodyState);
  return {
    id: String(message?.id || ""),
    threadId: String(message?.threadId || ""),
    from: extractEmailAddress(headers.from),
    recipients: [headers.to, headers["delivered-to"], headers["x-original-to"]].filter(Boolean).join(", "),
    subject: headers.subject || "",
    body,
    ...(bodyState.incomplete?{incomplete:true}:{}),
    authenticationPassed: trustedSenderAuthentication(message?.payload?.headers || [], headers.from),
    receivedAt: Number.isFinite(Number(message?.internalDate))
      ? new Date(Number(message.internalDate)).toISOString()
      : null,
  };
}

export function trustedSenderAuthentication(headers, from) {
  // Gmail prepends its own Authentication-Results. Never search lower,
  // potentially sender-supplied headers for a more permissive result.
  const value = String(headers.find(h => String(h.name).toLowerCase() === 'authentication-results')?.value || '');
  if (!/^mx\.google\.com\s*;/i.test(value.trim()) || /[\r\n]/.test(from || '')) return false;
  const domain = extractEmailAddress(from).split('@')[1]?.toLowerCase();
  const dmarc = value.match(/(?:^|;)\s*dmarc=pass\b([^;]*)/i);
  const authenticatedDomain = dmarc?.[1].match(/\bheader\.from=([a-z0-9.-]+)/i)?.[1]?.toLowerCase();
  return Boolean(domain && authenticatedDomain === domain);
}

export function findContactReplyToken(recipientHeaders) {
  const match = String(recipientHeaders || "").match(/\+verify-([A-Za-z0-9_-]{20,})@gmail\.com\b/i);
  return match?.[1] || null;
}

export function parseContactReplyCommand(body,options) {const result=scanContactReplyCommand(body,options);return result.complete?result.command:null;}

export function scanContactReplyCommand(body,{maxChars=16384,truncated=false}={}) {
  if(!Number.isSafeInteger(maxChars)||maxChars<1||maxChars>65536)throw new Error('Invalid reply scan bound');
  const statuses=['unable_to_reach','confirmed_death','false_alarm'];
  const commands=new Map(Object.values(REPLY_COMMANDS).flatMap(lines=>lines.map((line,i)=>[line,statuses[i]])));
  const source=String(body||''),text=source.slice(0,maxChars),limit=text.length,sourceComplete=source.length<=maxChars&&!truncated,lines=[];let offset=0,complete=false;
  while(lines.length<20&&offset<limit){
    const end=text.indexOf('\n',offset);
    if(end>=0&&end<limit){lines.push(text.slice(offset,end).replace(/\r$/,''));offset=end+1;continue;}
    if(sourceComplete){lines.push(text.slice(offset));complete=true;}
    break;
  }
  complete ||= lines.length===20||(offset===text.length&&sourceComplete);
  const found=[];
  const first=lines.find(line=>line.trim())?.trim().replace(/[。.;；]+$/, '');
  if(!commands.has(first))return {complete,command:null};
  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/[。.;；]+$/, "");
    if (/^(On .+wrote:|在.+写道：|From:|发件人：|От:|.+написал[аи]?:|>|[-_]{2,}|Forwarded message|Пересланное сообщение)/i.test(line)) {complete=true;break;}
    if (commands.has(line)) found.push({status:commands.get(line),command:line});
  }
  return {complete,command:complete&&found.length===1?found[0]:null};
}

export function isContactVerificationReplySubject(subject, expectedSubject) {
  const normalize = (value) => String(value || "").replace(/^\s*((re|fw|fwd|ответ|пересл)\s*:\s*)+/i, "").trim();
  if (expectedSubject === undefined) return normalize(subject).includes("请提交您掌握的情况");
  return Boolean(normalize(expectedSubject)) && normalize(subject).includes(normalize(expectedSubject));
}

function extractMimeText(part,state={}) {
  if (!part) return "";
  if(part.mimeType==='text/plain'&&!part.body?.data&&(part.body?.attachmentId||Number(part.body?.size)>0)){state.incomplete=true;return '';}
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64UrlUtf8(part.body.data);
  for (const child of part.parts || []) {
    const text = extractMimeText(child,state);
    if (text||state.incomplete) return text;
  }
  if (part.body?.data) return decodeBase64UrlUtf8(part.body.data);
  return "";
}

function extractEmailAddress(value) {
  const text = String(value || "").trim();
  const bracketed = text.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (bracketed) return bracketed[1].toLowerCase();
  const direct = text.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/i);
  return direct ? direct[0].toLowerCase() : "";
}

function sanitizeAddress(value) {
  return String(value || "").replace(/[\r\n]/g, "").trim();
}

function mimeFilenameParameters(value) {
  const original = String(value || "attachment.bin").replace(/[\r\n"\\]/g, "").trim() || "attachment.bin";
  const ascii = original.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^_+/, "");
  const extension = original.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] || ".bin";
  const fallback = ascii && /[A-Za-z0-9]/.test(ascii.replace(extension, "")) ? ascii : `attachment${extension}`;
  return { fallback, extended: encodeURIComponent(original) };
}

function wrapBase64(value) { return String(value).replace(/.{76}(?=.)/g,'$&\r\n'); }

function bytesToBase64(value) {
  return fastBytesToBase64(value instanceof Uint8Array ? value : new Uint8Array(value || []));
}

function encodeMimeHeader(value) {
  const text = String(value || "").replace(/[\r\n]/g, " ").trim();
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${base64EncodeUtf8(text)}?=`;
}

function base64UrlEncodeUtf8(value) {
  return Buffer.from(String(value),'utf8').toString('base64url');
}

function decodeBase64UrlUtf8(value) {
  const normalized = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return new TextDecoder().decode(fastBase64ToBytes(padded));
}

function base64EncodeUtf8(value) {
  return fastBytesToBase64(new TextEncoder().encode(value));
}

async function boundedJson(response,maxBytes){
  const reader=response.body?.getReader();if(!reader)return null;const chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes){await reader.cancel();return null;}chunks.push(value);}const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch{return null;}finally{reader.releaseLock();}
}
