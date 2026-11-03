import {testFontAssets} from './helpers/pdf-fonts.js';
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers/database.js';
import { Repository } from '../src/repository.js';
import {ensurePeopleLinks} from '../src/people.js';
import { handleRequest, runScheduledCheck, evaluateOperationalHealth, processContactEmailReplies } from '../src/worker.js';
import { sendGuardedMail, trustedSenderAuthentication, GmailMailProvider } from '../src/mail.js';
import { buildStoredPayload, openStoredPayload } from '../src/content.js';
import { createAdminSession, validAdminSession } from '../src/session.js';
import { farewellEditorScript } from '../src/farewell-editor-ui.js';
import { Script } from 'node:vm';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const now = '2030-01-10T00:00:00.000Z';
const envBase = {PDF_FONTS:testFontAssets, ALLOW_LOCAL_RATE_LIMIT_FALLBACK:true,ADMIN_TOKEN: 'test-only-admin', CONTENT_ENCRYPTION_KEY: 'test-only-content', MAIL_PROVIDER: 'dry-run', BASE_URL: 'https://test.invalid' };
async function fixture(t) {
  const db = database(); t.after(() => db.close());
  const repo = new Repository(db);
  await repo.setupOwner({ displayName: '测试', email: 'owner@example.invalid', now: '2030-01-01T00:00:00.000Z' });
  for (let i = 1; i <= 3; i++) {
    await repo.createContact({ name: '联系人' + i, email: `c${i}@example.invalid`, role: 'contact', priority: i, tokenHash: 'unused-' + i });
    await repo.rotateContactToken({ id: i, tokenHash: 'current-' + i });
  }
  await repo.updateOwnerState('VERIFY', now, 1);
  await repo.upsertPublicFarewell({ title: '公开遗言', body: '', status: 'DRAFT', now });
  return { db, repo, env: { ...envBase, DB: db } };
}
async function vote(repo, id, status = 'confirmed_death', round = 1) {
  return repo.createConfirmation({ contactId: id, status, round, now });
}
function post(env, path, body = {}) {
  return handleRequest(new Request('https://test.invalid' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + env.ADMIN_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
}

test('only the latest vote of each active contact in the current round counts', async t => {
  const { repo, db } = await fixture(t);
  for (let i = 1; i <= 3; i++) assert.equal(await vote(repo, i), true);
  assert.equal(await repo.countConfirmedDeathConfirmations(), 3);
  await vote(repo, 1, 'unable_to_reach');
  assert.equal(await repo.countConfirmedDeathConfirmations(), 2);
  await db.prepare('UPDATE contacts SET active = 0 WHERE id = 2').run();
  assert.equal(await repo.countConfirmedDeathConfirmations(), 1);
  assert.equal(await vote(repo, 2), false);
  await repo.checkin(now);
  assert.equal(await repo.countConfirmedDeathConfirmations(), 0);
  assert.equal(await repo.findContactByTokenHash('current-3'), null);
  assert.equal(await vote(repo, 3), false);
  assert.equal((await repo.getOwner()).confirmation_round, 2);
});

test('web confirmation refuses NORMAL state and legacy publication cannot bypass gates', async t => {
  const { repo, env } = await fixture(t);
  const token = 'testing-current-token';
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('base64url');
  await repo.rotateContactToken({ id: 1, tokenHash: hash });
  await repo.updateOwnerState('NORMAL', now, 1);
  assert.equal((await post(env, '/verify/' + token, { status: 'confirmed_death' })).status, 409);
  assert.equal((await post(env, '/api/public-farewell', { status: 'PUBLIC_RELEASE', title: 'test' })).status, 409);
  assert.equal(await repo.countConfirmedDeathConfirmations(), 0);
});

test('real release transaction requires three votes, 72 hours, and an unchanged round', async t => {
  const { repo } = await fixture(t);
  assert.equal(await repo.releasePrivateItems(now, 1), false);
  for (let i = 1; i <= 3; i++) await vote(repo, i);
  await repo.startReleaseGracePeriod(now, 1);
  assert.equal(await repo.releasePrivateItems('2030-01-12T23:59:59.000Z', 1), false);
  await repo.checkin('2030-01-13T00:00:00.000Z');
  assert.equal(await repo.releasePrivateItems('2030-01-13T00:00:01.000Z', 1), false);
  assert.equal(await repo.updateOwnerState('PUBLIC_RELEASE', now, 1), false);
  assert.equal((await repo.getOwner()).state, 'NORMAL');
});

test('checkin retracts public pages and private links; inactive recipients never receive content', async t => {
  const { repo, db, env } = await fixture(t);
  await repo.createRecipient({ name: 'Recipient', email: 'r@example.invalid', now });
  const payload = await buildStoredPayload({ body: { plaintext: 'fixture letter' }, env });
  await repo.createEncryptedItem({ kind: 'letter', title: 'private', recipientId: 1, encryptedPayload: payload, payloadSize: payload.length, vaultToken: 'raw-test', vaultTokenHash: 'test-hash', updatedAt: now });
  for (let i = 1; i <= 3; i++) await vote(repo, i);
  await repo.startReleaseGracePeriod(now, 1);
  assert.equal(await repo.releasePrivateItems('2030-01-13T00:00:00.000Z', 1), true);
  assert.equal((await repo.listReleasedPrivateItemsForDelivery()).results.length, 1);
  assert.ok(await repo.findVaultItemByTokenHash('test-hash'));
  await db.prepare('UPDATE recipients SET active = 0 WHERE id = 1').run();
  assert.equal((await repo.listReleasedPrivateItemsForDelivery()).results.length, 0);
  assert.equal(await repo.findVaultItemByTokenHash('test-hash'), null);
  await repo.autoPublishPublicFarewell(now, 1);
  await repo.checkin(now);
  assert.equal((await repo.getPublicFarewell()).status, 'DRAFT');
  assert.equal((await repo.getEncryptedItemForAdmin(1)).released_at, null);
});

test('concurrent senders claim a dedupe key once; uncertain sends stay blocked', async t => {
  const { repo } = await fixture(t);
  let calls = 0;
  const provider = { name: 'mock', async send() { calls++; await new Promise(resolve => setTimeout(resolve, 15)); return { status: 'sent' }; } };
  const input = { repo, provider, env: {}, dedupeKey: 'same-message', eventType: 'test', to: 't@example.invalid', subject: 'test', text: 'test', now };
  await Promise.all([sendGuardedMail(input), sendGuardedMail(input), sendGuardedMail(input)]);
  assert.equal(calls, 1);
  const uncertain = { ...input, dedupeKey: 'timeout', provider: { name: 'mock', async send() { calls++; throw new Error('timeout after possible acceptance'); } } };
  assert.equal((await sendGuardedMail(uncertain)).status, 'uncertain');
  assert.equal((await sendGuardedMail(uncertain)).status, 'skipped');
  assert.equal(calls, 2);
});

test('failed or expired inbound leases retry but finished messages do not', async t => {
  const { repo } = await fixture(t);
  const item = { gmailMessageId: 'mail', senderEmail: 'x@example.invalid', processedAt: now };
  assert.equal(await repo.claimInboundMessage(item), true);
  assert.equal(await repo.claimInboundMessage(item), false);
  assert.equal(await repo.claimInboundMessage({ ...item, processedAt: '2030-01-10T00:16:00.000Z' }), true);
  await repo.finishInboundMessage({ gmailMessageId: 'mail', status: 'failed', processedAt: now });
  assert.equal(await repo.claimInboundMessage(item), true);
  await repo.finishInboundMessage({ gmailMessageId: 'mail', status: 'processed', processedAt: now });
  assert.equal(await repo.claimInboundMessage(item), false);
});

test('Gmail authentication rejects mismatched SPF, untrusted and injected lower headers', () => {
  const header = value => ({ name: 'Authentication-Results', value });
  assert.equal(trustedSenderAuthentication([header('mx.google.com; spf=pass smtp.mailfrom=attacker.invalid; dmarc=fail header.from=example.com')], 'a@example.com'), false);
  assert.equal(trustedSenderAuthentication([header('evil.invalid; dmarc=pass header.from=example.com')], 'a@example.com'), false);
  assert.equal(trustedSenderAuthentication([header('mx.google.com; dmarc=fail header.from=example.com'), header('mx.google.com; dmarc=pass header.from=example.com')], 'a@example.com'), false);
  assert.equal(trustedSenderAuthentication([header('mx.google.com; dmarc=pass header.from=example.com')], 'a@example.com'), true);
});

test('Gmail reads subsequent pages and skips downloaded details for completed mail', async t => {
  const originalFetch = globalThis.fetch; t.after(() => globalThis.fetch = originalFetch);
  const urls = [];
  globalThis.fetch = async value => {
    const url = String(value); urls.push(url);
    if (url.includes('/token')) return Response.json({ access_token: 'test-token', expires_in: 3600 });
    if (url.includes('/messages?')) return Response.json(url.includes('pageToken=next') ? { messages: [{ id: 'old' }] } : { messages: [{ id: 'done' }], nextPageToken: 'next' });
    return Response.json({ id: 'old', internalDate: '1893456000000', payload: { headers: [] } });
  };
  const provider = new GmailMailProvider({ GMAIL_CLIENT_ID: 'test', GMAIL_CLIENT_SECRET: 'test', GMAIL_REFRESH_TOKEN: 'test', FROM_EMAIL: 'afterme.fixture@gmail.com' });
  const repo = { async getCursor() { return ''; }, async inboundMessageComplete(id) { return id === 'done'; } };
  const messages = await provider.listInboundMessages({ repo });
  assert.deepEqual(messages.map(m => m.id), ['old']);
  assert.ok(urls.some(u => u.includes('pageToken=next')));
  assert.equal(urls.some(u => u.includes('/messages/done')), false);
  assert.equal(messages.nextPageToken, '');
  await provider.getAccessToken();
  assert.equal(urls.filter(u => u.includes('/token')).length, 1);
});

test('expiring admin sessions, content key independence, HTML security and generated scripts', async t => {
  const session = await createAdminSession('admin', 1000);
  assert.equal(await validAdminSession(session, 'admin', 2000), true);
  assert.equal(await validAdminSession(session, 'other', 2000), false);
  assert.equal(await validAdminSession(session, 'admin', 1801000), false);
  const payload = await buildStoredPayload({ body: { plaintext: 'test' }, env: envBase });
  assert.equal((await openStoredPayload(payload, { ...envBase, ALLOW_LOCAL_RATE_LIMIT_FALLBACK:true,ADMIN_TOKEN: 'rotated' })).plaintext, 'test');
  await assert.rejects(buildStoredPayload({ body: { plaintext: 'test' }, env: { ALLOW_LOCAL_RATE_LIMIT_FALLBACK:true,ADMIN_TOKEN: 'only-admin' } }));
  const { env } = await fixture(t);
  const response = await post(env, '/admin');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  const html = await response.text();
  for (const [, script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Script(script);
  new Script(farewellEditorScript());
});

test('operational health is degraded by failed individual processing or delivery', () => {
  const health = { latestScheduled: { created_at: now, details_json: '{"inbox_status":"healthy"}' }, outboundProblemCount: 1 };
  assert.equal(evaluateOperationalHealth(health, new Date(now)).ok, false);
  assert.equal(evaluateOperationalHealth({ ...health, outboundProblemCount: 0, inboundProblemCount: 1 }, new Date(now)).ok, false);
});

test('complete encrypted backup restores offline with releases suspended and keys verified', async t => {
  const { repo, env } = await fixture(t);
  const payload = await buildStoredPayload({ body: { plaintext: 'recovery fixture' }, env });
  await repo.createRecipient({ name: 'R', email: 'r@example.invalid', now });
  await repo.createEncryptedItem({ kind: 'letter', title: 'test', recipientId: 1, encryptedPayload: payload, payloadSize: payload.length, vaultToken: 'test-raw', vaultTokenHash: 'test-hash', updatedAt: now });
  await ensurePeopleLinks(repo.db);
  const backup = await repo.exportBackup({ includePayloads: true });
  assert.equal(backup.recovery_tables.encrypted_items.length, 1);
  assert.equal('vault_token' in backup.recovery_tables.encrypted_items[0], false);
  const directory = mkdtempSync(join(tmpdir(), 'afterme-recovery-'));
  const input = join(directory, 'backup.json'), output = join(directory, 'recovery.sqlite');
  writeFileSync(input, JSON.stringify(backup));
  const result = spawnSync(process.execPath, ['scripts/restore-backup.mjs', input, output], { encoding: 'utf8', env: { ...process.env, CONTENT_ENCRYPTION_KEY: env.CONTENT_ENCRYPTION_KEY } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).verified_encrypted_payloads, 1);
  assert.ok(readFileSync(output).length > 0);
});

test('key migration verifies old ciphertext and leaves content timestamps unchanged', async t => {
  const { repo, env } = await fixture(t);
  const legacy = JSON.parse(await buildStoredPayload({ body: { plaintext: 'legacy private fixture' }, env: { CONTENT_ENCRYPTION_KEY: env.ADMIN_TOKEN } }));
  delete legacy.key_id;
  const payload = JSON.stringify(legacy);
  await repo.createRecipient({ name: 'R', email: 'r@example.invalid', now });
  await repo.createEncryptedItem({ kind: 'letter', title: 'test', recipientId: 1, encryptedPayload: payload, pdfPayload: payload, payloadSize: payload.length, vaultToken: 'legacy', vaultTokenHash: 'legacy-hash', updatedAt: now });
  const response = await post(env, '/api/maintenance/content-key-migrate');
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.migrated, 1);
  assert.equal(result.verified, 2);
  const saved = await repo.getEncryptedItemForAdmin(1);
  assert.equal(saved.updated_at, now);
  assert.equal((await openStoredPayload(saved.encrypted_payload, { CONTENT_ENCRYPTION_KEY: env.CONTENT_ENCRYPTION_KEY })).plaintext, 'legacy private fixture');
  assert.equal((await (await post(env, '/api/maintenance/content-key-migrate')).json()).migrated, 0);
});

test('older replies cannot overwrite a newer correction', async t => {
  const { repo } = await fixture(t);
  await repo.createConfirmation({ contactId: 1, round: 1, status: 'unable_to_reach', now: '2030-01-10T12:00:00.000Z' });
  assert.equal(await vote(repo, 1), false);
  assert.equal(await repo.countConfirmedDeathConfirmations(), 0);
});

test('failed inbox blocks a due release and successful recovery releases exactly once in real SQLite', async t => {
  const { repo, env } = await fixture(t);
  for (let id = 1; id <= 3; id++) await vote(repo, id);
  await repo.startReleaseGracePeriod(now, 1);
  const sent = [];
  const provider = { name: 'gmail', async listInboundMessages() { throw new Error('isolated inbox failure'); }, async send(message) { sent.push(message); return { status: 'sent' }; } };
  await runScheduledCheck(repo, env, new Date('2030-01-13T00:00:01.000Z'), provider);
  assert.equal((await repo.getOwner()).state, 'READY_TO_RELEASE');
  assert.equal(sent.length, 0);
  provider.listInboundMessages = async () => [];
  for(let tick=0;tick<12&&sent.filter(m=>m.attachments?.length).length<3;tick++)await runScheduledCheck(repo, env, new Date(Date.parse('2030-01-13T01:00:01.000Z')+tick*300000), provider);
  assert.equal((await repo.getOwner()).state, 'PUBLIC_RELEASE');
  assert.equal(sent.filter(m=>m.attachments?.length).length, 3);
  await runScheduledCheck(repo, env, new Date('2030-01-13T02:00:01.000Z'), provider);
  assert.equal(sent.filter(m=>m.attachments?.length).length, 3);
});
