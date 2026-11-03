import {testFontAssets} from './helpers/pdf-fonts.js';
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/database.js';
import { Repository } from '../src/repository.js';
import { ensurePeopleLinks } from '../src/people.js';
import { handleRequest, deliverReleasedItems, evaluateOperationalHealth, runScheduledCheck } from '../src/worker.js';
import { GmailMailProvider, sendGuardedMail } from '../src/mail.js';
import { buildStoredPayload } from '../src/content.js';
import { validAdminSession } from '../src/session.js';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const now = new Date().toISOString();
async function fixture(t) {
  const db = database(); t.after(() => db.close());
  const env = {PDF_FONTS:testFontAssets, DB: db, ALLOW_LOCAL_RATE_LIMIT_FALLBACK:true,ADMIN_TOKEN: 'test-admin', CONTENT_ENCRYPTION_KEY: 'test-content', MAIL_PROVIDER: 'dry-run', FROM_EMAIL: 'test@example.invalid', BASE_URL: 'https://test.invalid' };
  const repo = new Repository(db);
  await repo.setupOwner({ displayName: '测试', email: 'owner@example.invalid', now });
  await repo.createRecipient({ name: '朋友', email: 'friend@example.invalid', now });
  const payload = await buildStoredPayload({ body: { plaintext: '仅用于测试的信件' }, env });
  const token = 'test-vault';
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('base64url');
  await repo.createEncryptedItem({ kind: 'letter', title: '私人信件', recipientId: 1, encryptedPayload: payload, payloadSize: payload.length, vaultToken: token, vaultTokenHash: hash, updatedAt: now });
  await repo.upsertPublicFarewell({ title: '公开遗言', body: '', status: 'DRAFT', now });
  return { db, env, repo, token };
}
function post(env, path, body = {}) {
  return handleRequest(new Request('https://test.invalid' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + env.ADMIN_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
}
async function markReleased(db) {
  await db.prepare("UPDATE owner SET state='PRIVATE_RELEASE', release_suspended=0").run();
  await db.prepare('UPDATE encrypted_items SET released_at=?').bind(now).run();
}

test('deployment suspension closes released private links and reopening preserves content', async t => {
  const { db, env, token } = await fixture(t); await markReleased(db);
  const request = () => new Request('https://test.invalid/vault/' + token);
  assert.match(await (await handleRequest(request(), env)).text(), /仅用于测试的信件/);
  assert.doesNotMatch(await (await handleRequest(request(), { ...env, RELEASE_SUSPENDED: 'true' })).text(), /仅用于测试的信件/);
  assert.match(await (await handleRequest(request(), env)).text(), /仅用于测试的信件/);
});

test('Gmail cancellation before submission can retry, but an uncertain submission stays blocked', async t => {
  const { repo, env } = await fixture(t);
  const provider = new GmailMailProvider({ GMAIL_CLIENT_ID: 'test', GMAIL_CLIENT_SECRET: 'test', GMAIL_REFRESH_TOKEN: 'test', FROM_EMAIL: env.FROM_EMAIL });
  provider.getAccessToken = async () => ({ ok: true, accessToken: 'test' });
  let checks = 0, sends = 0;
  const input = { repo, provider, env, eventType: 'test', to: 'friend@example.invalid', subject: 'test', text: 'test', dedupeKey: 'cancellation', now, canSend: async () => ++checks === 1 };
  assert.equal((await sendGuardedMail(input)).status, 'skipped');
  const retry = { ...input, canSend: async () => true, provider: { name: 'test', async send() { sends++; return { status: 'sent' }; } } };
  assert.equal((await sendGuardedMail(retry)).status, 'sent'); assert.equal(sends, 1);
  const uncertain = { ...retry, dedupeKey: 'uncertain', provider: { name: 'test', async send() { throw new Error('submission timeout'); } } };
  assert.equal((await sendGuardedMail(uncertain)).status, 'uncertain');
  assert.equal((await sendGuardedMail({ ...retry, dedupeKey: 'uncertain' })).status, 'skipped'); assert.equal(sends, 1);
});

test('failed letter decryption degrades health and successful delivery clears the problem', async t => {
  const { db, env, repo } = await fixture(t); await markReleased(db);
  const provider = { name: 'test', async send() { return { status: 'sent' }; } };
  await repo.audit('scheduled_check_completed', { inbox_status: 'healthy' }, now);
  const wrongKey = await deliverReleasedItems(repo, { ...env, CONTENT_ENCRYPTION_KEY: 'wrong' }, new URL(env.BASE_URL), now, await repo.getOwner(), provider);
  assert.equal(wrongKey[0].reason, 'decrypt-failed');
  assert.equal(evaluateOperationalHealth(await repo.getOperationalHealth(), new Date(now)).ok, false);
  // Verify eligibility with three current contacts, then retry with the correct key.
  await db.prepare("UPDATE owner SET state='VERIFY'").run();
  for (let id=1;id<=3;id++) {
    await repo.createContact({ name: 'C'+id, email: 'c'+id+'@example.invalid', role: 'contact', priority: id, tokenHash: 'test'+id });
    await repo.rotateContactToken({ id, tokenHash: 'current'+id });
    await repo.createConfirmation({ contactId: id, status: 'confirmed_death', round: 1, now });
  }
  await db.prepare("UPDATE owner SET state='PRIVATE_RELEASE'").run();
  assert.equal((await deliverReleasedItems(repo, env, new URL(env.BASE_URL), new Date(Date.parse(now)+300001).toISOString(), await repo.getOwner(), provider))[0].status, 'sent');
  assert.equal(evaluateOperationalHealth(await repo.getOperationalHealth(), new Date(now)).ok, true);
  await repo.checkin(now);
  assert.equal((await repo.getOperationalHealth()).privateDeliveries.length, 0);
});

test('parallel public saves using the same revision accept one edit and preserve the winning text', async t => {
  const { repo, env } = await fixture(t);
  const group = await repo.farewell.createGroup({ title: '章', now });
  const entry = await repo.farewell.createEntry({ groupId: group, body: '原文', isPublic: true, now });
  const responses = await Promise.all(['电脑新文', '手机新文'].map(body => post(env, '/api/public-farewell-v2/entries/'+entry, { body, group_id: String(group), is_public: '1', expected_revision: 0 })));
  assert.deepEqual(responses.map(r=>r.status).sort(), [200,409]);
  const saved = await repo.farewell.getEntry(entry); assert.equal(saved.revision, 1);
  const conflict = await responses.find(r=>r.status===409).json(); assert.equal(conflict.current.draft_body, saved.draft_body);
  const first = await post(env, '/api/public-farewell-v2/groups/'+group, { title:'新章', expected_revision:0 }); assert.equal(first.status,200);
  assert.equal((await post(env, '/api/public-farewell-v2/groups/'+group, { title:'旧章', expected_revision:0 })).status,409);
});

test('private edits reject missing and stale revisions and retain the latest encrypted body', async t => {
  const { env, repo } = await fixture(t);
  await assert.rejects(post(env,'/api/items/1',{recipient_id:1,plaintext:'旧页'}), error=>error.status===428);
  assert.equal((await post(env,'/api/items/1',{recipient_id:1,plaintext:'电脑保存',expected_revision:0})).status,200);
  const stale = await post(env,'/api/items/1',{recipient_id:1,plaintext:'手机旧文',expected_revision:0}); assert.equal(stale.status,409);
  assert.equal((await stale.json()).current.plaintext,'电脑保存');
  assert.equal((await repo.getEncryptedItemForAdmin(1)).revision,1);
});

test('reauthentication produces a short session and refuses a session token as the login secret', async t => {
  const { env } = await fixture(t);
  const response=await post(env,'/api/session',{admin_token:env.ADMIN_TOKEN});
  const result=await response.json(); assert.equal(await validAdminSession(result.token,env.ADMIN_TOKEN),true);
  await assert.rejects(post(env,'/api/session',{admin_token:result.token}),error=>error.status===401);
});

test('complete backup is downloadable, auditable and verifiable offline; metadata is identified separately', async t => {
  const { env, repo }=await fixture(t);
  await ensurePeopleLinks(repo.db);
  const metadata=await post(env,'/api/export'); assert.match(metadata.headers.get('Content-Disposition'),/metadata/); assert.equal((await metadata.json()).includes_payloads,false);
  assert.equal(await repo.getLatestAudit('complete_backup_exported'),null);
  const response=await post(env,'/api/export',{include_payloads:true}); assert.match(response.headers.get('Content-Disposition'),/recovery-backup/);
  const backup=await response.json(); assert.equal(backup.schema_version,24); assert.equal(backup.format_version,2);assert.equal(backup.includes_payloads,true);assert.equal(backup.private_item_payloads,undefined);
  assert.ok(await repo.getLatestAudit('complete_backup_exported'));
  const directory=mkdtempSync(join(tmpdir(),'afterme-verify-test-')); const file=join(directory,'backup.json');
  t.after(()=>{unlinkSync(file);rmdirSync(directory);}); writeFileSync(file,JSON.stringify(backup));
  const verified=spawnSync(process.execPath,['scripts/verify-backup.mjs',file],{encoding:'utf8',env:{...process.env,CONTENT_ENCRYPTION_KEY:env.CONTENT_ENCRYPTION_KEY}});
  assert.equal(verified.status,0,verified.stderr); assert.equal(JSON.parse(verified.stdout).network_used,false);
});

test('monthly outbound check catches up after day one and dedupes subsequent scheduled runs', async t => {
  const { env, repo }=await fixture(t); let sent=0;
  const provider={name:'gmail',async listInboundMessages(){return [];},async send(){sent++;return {status:'sent'};}};
  const catchupEnv={...env,MAIL_PROVIDER:'gmail',MAIL_HEALTHCHECK_ENABLED:'true'};
  const date=new Date('2031-02-05T08:00:00.000Z'); await repo.checkin(date.toISOString());
  await runScheduledCheck(repo,catchupEnv,date,provider); await runScheduledCheck(repo,catchupEnv,new Date('2031-02-06T08:00:00.000Z'),provider);
  assert.equal(sent,1);
  const health=await repo.getOperationalHealth(); assert.equal(evaluateOperationalHealth(health,date,true,{mailHealthcheckEnabled:true}).checks.mail_outbound_fresh,true);
  assert.equal(evaluateOperationalHealth(health,new Date('2031-03-25T08:00:00.000Z'),true,{mailHealthcheckEnabled:true}).checks.mail_outbound_fresh,false);
});
