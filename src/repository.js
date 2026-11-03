// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import { FarewellV2Repository } from "./farewell-v2.js";
import { DEFAULT_PREFERENCES, defaultRules } from './settings.js';
import {BACKUP_SIZE_SQL,HTTP_BACKUP_MAX_BYTES,RECOVERY_COLUMNS,backupSizeSql} from './backup-format.js';
import {listPeople,getPerson,createPerson,patchPerson,patchLegacyPerson} from './people.js';
import {inboxWorkFence} from './inbox-fence.js';
export function privateMailKey(item) { return `private_letter_release:v2:${item.id}:${item.delivery_version??0}:${String(item.recipient_email||'').trim().toLowerCase()}`; }

export const PUBLIC_DELIVERY_PROBLEMS_SQL=`SELECT COUNT(*) AS count FROM owner o JOIN round_rules r ON r.round=o.confirmation_round JOIN release_progress p ON p.round=o.confirmation_round AND p.channel='public' JOIN public_farewell d ON d.id=1 JOIN farewell_document_versions dv ON dv.id=1 JOIN json_each(r.rules_json,'$.public.audience') a LEFT JOIN contacts c ON a.value='contact:'||c.id LEFT JOIN recipients rc ON a.value='recipient:'||rc.id LEFT JOIN mail_claims m ON m.dedupe_key='public_farewell_release:v2:'||dv.formal_revision||':'||d.updated_at||':'||a.value||':'||lower(trim(COALESCE(c.email,rc.email))) WHERE o.id=1 AND o.pause_mode IS NULL AND o.release_suspended=0 AND p.released_at IS NOT NULL AND json_extract(r.rules_json,'$.public.enabled')=1 AND json_extract(r.rules_json,'$.public.pdf')=1 AND COALESCE(c.active,rc.active,0)=1 AND COALESCE(m.status,'pending') NOT IN ('sent','dry_run')`;

export class Repository {
  constructor(db) {
    this.db = db;
    this.farewell = new FarewellV2Repository(db);
  }

  async getOwner() {
    return this.db.prepare("SELECT * FROM owner WHERE id = 1").first();
  }

  async setupOwner({ displayName, email, now }) {
    await this.db.prepare(
      `INSERT INTO owner (id, display_name, email, last_checkin_at, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         display_name = excluded.display_name,
         email = excluded.email,
         updated_at = excluded.updated_at`
    ).bind(displayName, email, now, now).run();
  }

  async updateOwnerState(state, now, round) {
    const result = await this.db.prepare("UPDATE owner SET state = ?, updated_at = ? WHERE id = 1 AND confirmation_round = ?").bind(state, now, round ?? (await this.getOwner()).confirmation_round).run();
    return Number(result.meta?.changes || 0) > 0;
  }

  async checkin(now, {ownerCheckin=true,expectedRound=null}={}) {
    this.invocationSettings=null;
    const existing=await this.getOwner(); if(existing) await this.getRoundRules(existing);
    const marker=crypto.randomUUID(),guard="EXISTS(SELECT 1 FROM user_settings WHERE id=1 AND save_id=?)";
    const fence=inboxWorkFence(this,now,{processing:Boolean(this.inboxFence)});
    const result=await this.db.batch([
      this.db.prepare("UPDATE user_settings SET active_rules_json = CASE WHEN ? THEN COALESCE(pending_rules_json, active_rules_json) ELSE active_rules_json END,active_rule_version=CASE WHEN ? THEN COALESCE(pending_rule_version,active_rule_version) ELSE active_rule_version END,pending_rule_version=CASE WHEN ? THEN NULL ELSE pending_rule_version END,pending_rules_json = CASE WHEN ? THEN NULL ELSE pending_rules_json END, revision = revision + 1, updated_at = ?,save_id=? WHERE id=1 AND (? IS NULL OR EXISTS(SELECT 1 FROM owner WHERE confirmation_round=?)) AND "+fence.sql).bind(ownerCheckin?1:0,ownerCheckin?1:0,ownerCheckin?1:0,ownerCheckin?1:0,now,marker,expectedRound,expectedRound,...fence.args),
      this.db.prepare("UPDATE owner SET state = 'NORMAL', last_checkin_at = CASE WHEN ? THEN ? ELSE last_checkin_at END, timer_anchor_at = ?, pause_until = NULL, pause_mode = NULL, release_ready_at = NULL, confirmation_round = confirmation_round + 1, updated_at = ? WHERE id = 1 AND "+guard).bind(ownerCheckin?1:0,now,now,now,marker),
      this.db.prepare("INSERT INTO round_rules SELECT confirmation_round, active_rules_json, timer_anchor_at, ?,active_rule_version FROM owner JOIN user_settings ON user_settings.id=1 WHERE user_settings.save_id=?").bind(now,marker),
      this.db.prepare("INSERT INTO release_progress SELECT confirmation_round, 'private', NULL, NULL FROM owner WHERE "+guard+" UNION ALL SELECT confirmation_round, 'public', NULL, NULL FROM owner WHERE "+guard).bind(marker,marker),
      this.db.prepare("UPDATE contacts SET token_hash = 'invalidated-' || id || '-' || (SELECT confirmation_round FROM owner WHERE id = 1), verification_round = NULL, verification_thread_id = NULL WHERE "+guard).bind(marker),
      this.db.prepare("UPDATE public_farewell SET status = 'DRAFT', auto_released_at = NULL WHERE status = 'PUBLIC_RELEASE' AND "+guard).bind(marker),
      this.db.prepare("UPDATE encrypted_items SET released_at = NULL WHERE released_at IS NOT NULL AND "+guard).bind(marker),
    ]);
    const changed=Boolean(result[1].meta?.changes);if(changed&&this.inboxFence)this.inboxFence.checkinMarker=marker;return changed;
  }

  async getSettings(env={}) {
    if(this.invocationBudget&&this.invocationSettings)return this.invocationSettings;
    const cap = Number(env.MAX_DAILY_EMAILS || 20);
    let row=await this.db.prepare('SELECT * FROM user_settings WHERE id=1').first();
    if(!row.configured){await this.db.prepare('UPDATE user_settings SET preferences_json=?, configured=1 WHERE id=1 AND configured=0').bind(JSON.stringify({...DEFAULT_PREFERENCES,daily_email_limit:cap,selfcheck:env.MAIL_HEALTHCHECK_ENABLED==='true'})).run();row=await this.db.prepare('SELECT * FROM user_settings WHERE id=1').first();}
    const settings={revision:row.revision,active_rule_version:row.active_rule_version,pending_rule_version:row.pending_rule_version,preferences:{...DEFAULT_PREFERENCES,...JSON.parse(row.preferences_json)},active:JSON.parse(row.active_rules_json),pending:row.pending_rules_json?JSON.parse(row.pending_rules_json):null,mail_cap:cap};
    if(this.invocationBudget)this.invocationSettings=settings;return settings;
  }
  async saveSettings({revision,preferences,rules,now,profile,languages=[]}) {
    this.invocationSettings=null;
    const marker=crypto.randomUUID(),encoded=JSON.stringify(rules);
    const stmts=[this.db.prepare('UPDATE user_settings SET preferences_json=?,pending_rule_version=CASE WHEN json(?)=json(active_rules_json) THEN NULL WHEN json(?)=json(pending_rules_json) THEN pending_rule_version ELSE revision+1 END, pending_rules_json=CASE WHEN json(?)=json(active_rules_json) THEN NULL ELSE ? END, revision=revision+1, updated_at=?,save_id=? WHERE id=1 AND revision=?').bind(JSON.stringify(preferences),encoded,encoded,encoded,encoded,now,marker,revision)];
    if(profile)stmts.push(this.db.prepare('UPDATE owner SET display_name=?,email=?,updated_at=? WHERE id=1 AND EXISTS(SELECT 1 FROM user_settings WHERE save_id=?)').bind(profile.display_name,profile.email,now,marker));
    for(const {table,id,locale} of languages) {
      if(!['contacts','recipients'].includes(table))throw Error('Invalid language table');
      stmts.push(this.db.prepare(`UPDATE ${table} SET locale=? WHERE id=? AND EXISTS(SELECT 1 FROM user_settings WHERE save_id=?)`).bind(locale,id,marker));
    }
    const result=await this.db.batch(stmts);
    return Number(result[0].meta?.changes||0)>0;
  }
  async getRoundRules(owner) {
    if(this.invocationBudget&&this.invocationRules?.has(owner.confirmation_round))return this.invocationRules.get(owner.confirmation_round);
    const row=await this.db.prepare('SELECT rules_json FROM round_rules WHERE round=?').bind(owner.confirmation_round).first();
    if(row) {const rules=JSON.parse(row.rules_json);if(this.invocationBudget){this.invocationRules ||= new Map();this.invocationRules.set(owner.confirmation_round,rules);}return rules;}
    // New installations have no owner when migration 18 runs. Freeze membership once.
    const hasPeople=await this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='people_links'").first();
    const bootstrapContacts=hasPeople?'contacts c LEFT JOIN people_links p ON p.contact_id=c.id WHERE c.active=1 AND COALESCE(p.legacy_contact,1)=1':'contacts c WHERE c.active=1';
    await this.db.batch([
      this.db.prepare(`UPDATE user_settings SET active_rules_json=json_set(active_rules_json,'$.private.contact_ids',json((SELECT COALESCE(json_group_array(c.id),'[]') FROM ${bootstrapContacts})),'$.public.contact_ids',json((SELECT COALESCE(json_group_array(c.id),'[]') FROM ${bootstrapContacts})),'$.public.audience',json((SELECT COALESCE(json_group_array('contact:' || c.id),'[]') FROM ${bootstrapContacts}))) WHERE revision=0 AND pending_rules_json IS NULL`),
      this.db.prepare('INSERT OR IGNORE INTO round_rules SELECT confirmation_round, active_rules_json, COALESCE(timer_anchor_at,last_checkin_at), owner.updated_at,active_rule_version FROM owner JOIN user_settings ON user_settings.id=1'),
      this.db.prepare("INSERT OR IGNORE INTO release_progress SELECT confirmation_round,'private',release_ready_at,CASE WHEN state IN ('PRIVATE_RELEASE','PUBLIC_RELEASE') THEN updated_at END FROM owner UNION ALL SELECT confirmation_round,'public',release_ready_at,(SELECT auto_released_at FROM public_farewell WHERE id=1) FROM owner"),
    ]);
    return JSON.parse((await this.db.prepare('SELECT rules_json FROM round_rules WHERE round=?').bind(owner.confirmation_round).first()).rules_json);
  }
  async getProgress(round) { return (await this.db.prepare('SELECT * FROM release_progress WHERE round=?').bind(round).all()).results; }
  async countChannelConfirmations(round,channel) {
    return Number((await this.db.prepare(`SELECT COUNT(*) AS count FROM confirmation_votes v JOIN contacts c ON c.id=v.contact_id JOIN round_rules r ON r.round=v.round WHERE v.round=? AND c.active=1 AND c.verification_round=v.round AND v.status='confirmed_death' AND c.id IN (SELECT value FROM json_each(r.rules_json,?))`).bind(round,'$.'+channel+'.contact_ids').first()).count);
  }
  async advanceChannel(round,channel,now) {
    const path='$.'+channel;
    const guard=`EXISTS (SELECT 1 FROM owner o JOIN round_rules r ON r.round=o.confirmation_round WHERE o.id=1 AND o.confirmation_round=release_progress.round AND o.release_suspended=0 AND o.pause_mode IS NULL AND o.state IN ('VERIFY','READY_TO_RELEASE','PRIVATE_RELEASE','PUBLIC_RELEASE') AND json_extract(r.rules_json, '${path}.enabled')=1 AND (SELECT COUNT(*) FROM confirmation_votes v JOIN contacts c ON c.id=v.contact_id WHERE v.round=o.confirmation_round AND c.active=1 AND c.verification_round=v.round AND v.status='confirmed_death' AND c.id IN (SELECT value FROM json_each(r.rules_json,'${path}.contact_ids'))) >= json_extract(r.rules_json,'${path}.quorum'))`;
    // Both the threshold and elapsed buffer are rechecked inside the transaction.
    const statements=[
      this.db.prepare(`UPDATE release_progress SET ready_at=NULL WHERE round=? AND channel=? AND released_at IS NULL AND NOT (${guard})`).bind(round,channel),
      this.db.prepare(`UPDATE release_progress SET ready_at=COALESCE(ready_at,?) WHERE round=? AND channel=? AND released_at IS NULL AND ${guard}`).bind(now,round,channel),
      this.db.prepare(`UPDATE release_progress SET released_at=? WHERE round=? AND channel=? AND released_at IS NULL AND ready_at IS NOT NULL AND ${guard} AND (julianday(?) - julianday(ready_at))*24 >= (SELECT json_extract(rules_json,'${path}.grace_hours') FROM round_rules WHERE round=?) - 0.0000001`).bind(now,round,channel,now,round),
    ];
    if(channel==='private') statements.push(this.db.prepare("UPDATE encrypted_items SET released_at=? WHERE release_stage='PRIVATE_RELEASE' AND released_at IS NULL AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM release_progress p JOIN owner o ON o.confirmation_round=p.round WHERE p.round=? AND p.channel='private' AND p.released_at IS NOT NULL AND o.release_suspended=0 AND o.pause_mode IS NULL)").bind(now,round));
    if(channel==='public') statements.push(this.db.prepare("UPDATE public_farewell SET status='PUBLIC_RELEASE', auto_released_at=? WHERE id=1 AND status='DRAFT' AND EXISTS(SELECT 1 FROM release_progress p JOIN round_rules r ON r.round=p.round JOIN owner o ON o.confirmation_round=p.round WHERE p.round=? AND p.channel='public' AND p.released_at IS NOT NULL AND json_extract(r.rules_json,'$.public.web')=1 AND o.release_suspended=0 AND o.pause_mode IS NULL)").bind(now,round));
    statements.push(this.db.prepare("UPDATE owner SET state=CASE WHEN EXISTS(SELECT 1 FROM release_progress WHERE round=? AND channel='public' AND released_at IS NOT NULL) THEN 'PUBLIC_RELEASE' WHEN EXISTS(SELECT 1 FROM release_progress WHERE round=? AND channel='private' AND released_at IS NOT NULL) THEN 'PRIVATE_RELEASE' WHEN EXISTS(SELECT 1 FROM release_progress WHERE round=? AND ready_at IS NOT NULL) THEN 'READY_TO_RELEASE' ELSE 'VERIFY' END, release_ready_at=(SELECT MIN(ready_at) FROM release_progress WHERE round=?), updated_at=? WHERE confirmation_round=? AND release_suspended=0 AND pause_mode IS NULL AND state IN ('VERIFY','READY_TO_RELEASE','PRIVATE_RELEASE','PUBLIC_RELEASE')").bind(round,round,round,round,now,round));
    await this.db.batch(statements);
    return this.getProgress(round);
  }
  async pause({until,mode,now}) {
    await this.db.batch([
      this.db.prepare("UPDATE owner SET state='NORMAL', pause_until=?, pause_mode=?, release_ready_at=NULL, confirmation_round=confirmation_round+1, updated_at=? WHERE id=1").bind(until,mode,now),
      this.db.prepare("INSERT INTO round_rules SELECT confirmation_round, active_rules_json, COALESCE(timer_anchor_at,last_checkin_at), ?,active_rule_version FROM owner JOIN user_settings ON user_settings.id=1").bind(now),
      this.db.prepare("INSERT INTO release_progress SELECT confirmation_round,'private',NULL,NULL FROM owner UNION ALL SELECT confirmation_round,'public',NULL,NULL FROM owner"),
      this.db.prepare("UPDATE contacts SET verification_round=NULL, verification_thread_id=NULL, token_hash='paused-' || id || '-' || (SELECT confirmation_round FROM owner)"),
      this.db.prepare("UPDATE encrypted_items SET released_at=NULL"),
      this.db.prepare("UPDATE public_farewell SET status='DRAFT', auto_released_at=NULL WHERE status='PUBLIC_RELEASE'"),
    ]);
  }
  async resumeExpiredPause(now) {
    await this.db.batch([
      this.db.prepare("UPDATE owner SET timer_anchor_at=pause_until, pause_until=NULL, pause_mode=NULL, state='NORMAL', updated_at=? WHERE id=1 AND pause_mode='automatic' AND pause_until<=?").bind(now,now),
      this.db.prepare('UPDATE round_rules SET anchor_at=(SELECT COALESCE(timer_anchor_at,last_checkin_at) FROM owner WHERE id=1) WHERE round=(SELECT confirmation_round FROM owner WHERE id=1) AND EXISTS(SELECT 1 FROM owner WHERE pause_mode IS NULL)'),
    ]);
    return this.getOwner();
  }
  async directory({cursor=0,limit=50}={}) {
    limit=Math.min(100,Math.max(1,Number(limit)||50));
    const statement=this.db.prepare(`SELECT i.id,i.kind,i.title,i.recipient_id,i.revision,i.updated_at,i.released_at,i.revoked_at,i.payload_size,COALESCE(r.name,c.name) AS recipient_name,COALESCE(r.email,c.email) AS recipient_email FROM encrypted_items i LEFT JOIN recipients r ON r.id=i.recipient_id LEFT JOIN contacts c ON c.id=i.recipient_contact_id ${cursor?'WHERE i.id<?':''} ORDER BY i.id DESC LIMIT ?`);
    const result=await (cursor?statement.bind(cursor,limit+1):statement.bind(limit+1)).all();
    const more=result.results.length>limit, rows=result.results.slice(0,limit);
    return {results:rows,next_cursor:more?rows.at(-1).id:null};
  }

  async startReleaseGracePeriod(now, round) {
    await this.getRoundRules(await this.getOwner());
    await this.advanceChannel(round,'private',now);
    await this.advanceChannel(round,'public',now);
    return this.getOwner();
  }

  async resetReleaseGracePeriod(state, now, round) {
    await this.db.prepare(
      "UPDATE owner SET state = ?, release_ready_at = NULL, updated_at = ? WHERE id = 1 AND confirmation_round = ? AND state = 'READY_TO_RELEASE'"
    ).bind(state, now, round).run();
  }

  async setReleaseSuspended(value, now) {
    await this.db.prepare("UPDATE owner SET release_suspended = ?, updated_at = ? WHERE id = 1").bind(value ? 1 : 0, now).run();
  }

  async listContacts() {
    return this.db.prepare("SELECT id, name, email, role, priority, can_release, active, created_at,locale FROM contacts ORDER BY priority, id").all();
  }

  async listPeople(){return listPeople(this.db);}
  async getPerson(id){return getPerson(this.db,id);}
  async createPerson(input,options){return createPerson(this.db,input,options);}
  async patchPerson(id,input,options){return patchPerson(this.db,id,input,options);}
  async patchLegacyPerson(side,id,input,options){return patchLegacyPerson(this.db,side,id,input,options);}

  async listActiveContacts() {
    return this.db.prepare("SELECT * FROM contacts WHERE active = 1 ORDER BY priority, id").all();
  }

  async getContact(id) {
    return this.db.prepare("SELECT * FROM contacts WHERE id = ?").bind(id).first();
  }

  async findContactByEmail(email) {
    return this.db.prepare(
      "SELECT * FROM contacts WHERE lower(trim(email)) = lower(trim(?))"
    ).bind(email).first();
  }

  async rotateContactToken({ id, tokenHash, expectedRound=null }) {
    const issued=new Date().toISOString(),expires=new Date(Date.now()+7*86400000).toISOString();
    await this.db.prepare("UPDATE contacts SET token_hash = ?, verification_round = (SELECT confirmation_round FROM owner WHERE id = 1), verification_thread_id = NULL,verification_issued_at=?,verification_expires_at=? WHERE id = ? AND active = 1 AND (? IS NULL OR EXISTS(SELECT 1 FROM owner WHERE confirmation_round=?))").bind(tokenHash,issued,expires,id,expectedRound,expectedRound).run();
    return this.getContact(id);
  }

  async createContact({ name, email, role, priority, canRelease, tokenHash }) {
    const result = await this.db.prepare(
      `INSERT INTO contacts (name, email, role, priority, can_release, token_hash)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(name, email, role, priority, canRelease ? 1 : 0, tokenHash).run();
    return result.meta.last_row_id;
  }

  async updateContact({ id, name, email, role, priority, active }) {
    await this.db.prepare(
      `UPDATE contacts
       SET verification_round = CASE WHEN email != ? OR ? = 0 THEN NULL ELSE verification_round END,
           name = ?, email = ?, role = ?, priority = ?, active = ?
       WHERE id = ?`
    ).bind(email, active ? 1 : 0, name, email, role, priority, active ? 1 : 0, id).run();
    return this.getContact(id);
  }

  async findContactByTokenHash(tokenHash) {
    return this.db.prepare("SELECT * FROM contacts WHERE token_hash = ? AND active = 1").bind(tokenHash).first();
  }

  async listPendingTransitionContacts(owner,state,limit=5) {
    const prefix=state+':'+owner.last_checkin_at+':';
    return this.db.prepare(`SELECT c.* FROM contacts c LEFT JOIN mail_claims m ON m.dedupe_key=?||c.id||':round-'||?||':email-'||lower(trim(c.email)) WHERE c.active=1 AND (m.status IS NULL OR m.status IN ('failed','cancelled')) AND EXISTS(SELECT 1 FROM round_rules r WHERE r.round=? AND ((json_extract(r.rules_json,'$.private.enabled')=1 AND c.id IN (SELECT value FROM json_each(r.rules_json,'$.private.contact_ids'))) OR (json_extract(r.rules_json,'$.public.enabled')=1 AND c.id IN (SELECT value FROM json_each(r.rules_json,'$.public.contact_ids'))))) ORDER BY COALESCE(m.claimed_at,''),c.priority,c.id LIMIT ?`).bind(prefix,owner.confirmation_round,owner.confirmation_round,limit).all();
  }
  async transitionMailAllowed(owner,contact,state,tokenHash=null) {
    return Boolean(await this.db.prepare("SELECT 1 FROM owner o JOIN round_rules r ON r.round=o.confirmation_round JOIN contacts c ON c.id=? WHERE o.id=1 AND o.confirmation_round=? AND o.pause_mode IS NULL AND c.active=1 AND lower(trim(c.email))=? AND ((json_extract(r.rules_json,'$.private.enabled')=1 AND c.id IN (SELECT value FROM json_each(r.rules_json,'$.private.contact_ids'))) OR (json_extract(r.rules_json,'$.public.enabled')=1 AND c.id IN (SELECT value FROM json_each(r.rules_json,'$.public.contact_ids')))) AND (o.state=? OR (?='VERIFY' AND o.state IN ('READY_TO_RELEASE','PRIVATE_RELEASE','PUBLIC_RELEASE'))) AND (? IS NULL OR (c.token_hash=? AND c.verification_round=o.confirmation_round))").bind(contact.id,owner.confirmation_round,String(contact.email).trim().toLowerCase(),state,state,tokenHash,tokenHash).first());
  }

  async listRecipients() {
    return this.db.prepare("SELECT id, name, email, note, active, created_at, updated_at,locale FROM recipients ORDER BY name, id").all();
  }

  async listActiveRecipients() {
    return this.db.prepare("SELECT id, name, email, note, active, created_at, updated_at,locale FROM recipients WHERE active = 1 ORDER BY name, id").all();
  }

  async getPublicDeliverySnapshot(round) {
    const [contacts,recipients,metadata]=await this.db.batch([
      this.db.prepare('SELECT * FROM contacts WHERE active=1 ORDER BY priority,id'),
      this.db.prepare('SELECT id,name,email,note,active,created_at,updated_at,locale FROM recipients WHERE active=1 ORDER BY name,id'),
      this.db.prepare(`SELECT d.*,v.formal_revision,
        'public-delivery:'||CAST(? AS INTEGER)||':'||v.formal_revision||':'||d.updated_at AS cursor_key,
        COALESCE((SELECT value FROM runtime_cursors WHERE key='public-delivery:'||CAST(? AS INTEGER)||':'||v.formal_revision||':'||d.updated_at),'') AS delivery_cursor
        FROM public_farewell d JOIN farewell_document_versions v ON v.id=1 WHERE d.id=1`).bind(round,round),
    ]);
    const row=metadata.results[0];
    if(!row)return {contacts:contacts.results,recipients:recipients.results,document:null,formalRevision:0,cursorKey:null,cursor:''};
    const {formal_revision,cursor_key,delivery_cursor,...document}=row;
    return {contacts:contacts.results,recipients:recipients.results,document,formalRevision:formal_revision,cursorKey:cursor_key,cursor:delivery_cursor};
  }

  async getRecipient(id) {
    return this.db.prepare("SELECT id, name, email, note, active, created_at, updated_at,locale FROM recipients WHERE id = ?").bind(id).first();
  }

  async findRecipientByEmail(email) {
    return this.db.prepare(
      "SELECT id, name, email, note, active, created_at, updated_at FROM recipients WHERE lower(trim(email)) = lower(trim(?))"
    ).bind(email).first();
  }

  async createRecipient({ name, email, note, now }) {
    const result = await this.db.prepare(
      `INSERT INTO recipients (name, email, note, updated_at)
       VALUES (?, ?, ?, ?)`
    ).bind(name, email, note || "", now).run();
    return result.meta.last_row_id;
  }

  async updateRecipient({ id, name, email, note, active, now }) {
    await this.db.prepare(
      `UPDATE recipients
       SET name = ?, email = ?, note = ?, active = ?, updated_at = ?
       WHERE id = ?`
    ).bind(name, email, note || "", active ? 1 : 0, now, id).run();
    return this.getRecipient(id);
  }

  async countQualifyingConfirmations() {
    const row = await this.db.prepare(
      "SELECT COUNT(*) AS count FROM confirmation_votes v JOIN contacts c ON c.id = v.contact_id JOIN owner o ON o.id = 1 WHERE c.active = 1 AND c.verification_round = v.round AND v.round = o.confirmation_round AND v.status IN ('unable_to_reach', 'confirmed_death')"
    ).first();
    return Number(row?.count || 0);
  }

  async countConfirmedDeathConfirmations() {
    const row = await this.db.prepare(
      "SELECT COUNT(*) AS count FROM confirmation_votes v JOIN contacts c ON c.id = v.contact_id JOIN owner o ON o.id = 1 WHERE c.active = 1 AND c.verification_round = v.round AND v.round = o.confirmation_round AND v.status = 'confirmed_death'"
    ).first();
    return Number(row?.count || 0);
  }

  async createConfirmation({ contactId, status, note, round, now = new Date().toISOString() }) {
    const fence=inboxWorkFence(this,now,{processing:Boolean(this.inboxFence)});
    const result = await this.db.prepare(
      `INSERT INTO confirmation_votes (contact_id, round, status, updated_at)
       SELECT c.id, o.confirmation_round, ?, ? FROM contacts c JOIN owner o ON o.id = 1
       WHERE c.id = ? AND c.active = 1 AND c.verification_round = o.confirmation_round
         AND o.confirmation_round = ? AND o.pause_mode IS NULL AND o.state IN ('VERIFY', 'READY_TO_RELEASE','PRIVATE_RELEASE','PUBLIC_RELEASE')
         AND ${fence.sql}
       ON CONFLICT(contact_id, round) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
       WHERE excluded.updated_at >= confirmation_votes.updated_at`
    ).bind(status, now, contactId, round ?? -1,...fence.args).run();
    if (Number(result.meta?.changes || 0)) {
      await this.db.prepare("INSERT OR IGNORE INTO confirmations (contact_id, status, note) SELECT ?,?,? WHERE "+fence.sql).bind(contactId,status,note||null,...fence.args).run();
      return true;
    }
    return false;
  }

  async clearConfirmations() {
    // Votes from previous rounds are retained as history and never counted.
  }
  async listConfirmations() {
    return this.db.prepare(
      `SELECT v.*, v.updated_at AS created_at, contacts.name, contacts.email
       FROM confirmation_votes v JOIN contacts ON contacts.id = v.contact_id
       WHERE v.round = (SELECT confirmation_round FROM owner WHERE id = 1) AND contacts.active = 1
       ORDER BY v.updated_at DESC`
    ).all();
  }

  async createEncryptedItem({ kind, title, recipientId, assigneeContactId, releaseStage, encryptedPayload, pdfPayload, payloadSize, vaultToken, vaultTokenHash, updatedAt }) {
    const result = await this.db.prepare(
      `INSERT INTO encrypted_items
       (kind, title, recipient_id, assignee_contact_id, release_stage, encrypted_payload, pdf_payload, payload_size, vault_token, vault_token_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      kind,
      title,
      recipientId || null,
      assigneeContactId || null,
      releaseStage || "PRIVATE_RELEASE",
      encryptedPayload,
      pdfPayload || null,
      payloadSize,
      vaultToken,
      vaultTokenHash,
      updatedAt || null
    ).run();
    return result.meta.last_row_id;
  }

  async getEncryptedItemForAdmin(id) {
    return this.db.prepare(
      `SELECT encrypted_items.*,
              COALESCE(recipients.email, legacy_contacts.email) AS recipient_email,
              COALESCE(recipients.name, legacy_contacts.name) AS recipient_name,
              COALESCE(recipients.locale, legacy_contacts.locale,'zh') AS recipient_locale
       FROM encrypted_items
       LEFT JOIN recipients ON recipients.id = encrypted_items.recipient_id
       LEFT JOIN contacts AS legacy_contacts ON legacy_contacts.id = encrypted_items.recipient_contact_id
       WHERE encrypted_items.id = ?`
    ).bind(id).first();
  }

  async listEncryptedItemsForAdmin() {
    return this.db.prepare(
      `SELECT encrypted_items.*,
              COALESCE(recipients.email, legacy_contacts.email) AS recipient_email,
              COALESCE(recipients.name, legacy_contacts.name) AS recipient_name
       FROM encrypted_items
       LEFT JOIN recipients ON recipients.id = encrypted_items.recipient_id
       LEFT JOIN contacts AS legacy_contacts ON legacy_contacts.id = encrypted_items.recipient_contact_id
       ORDER BY COALESCE(encrypted_items.updated_at, encrypted_items.created_at) DESC, encrypted_items.id DESC`
    ).all();
  }

  async updateEncryptedItem({ id, recipientId, encryptedPayload, pdfPayload, payloadSize, updatedAt, expectedRevision, deliveryChanged=true }) {
    const result = await this.db.prepare(
      `UPDATE encrypted_items
       SET title = '私人信件', recipient_id = ?, encrypted_payload = ?, pdf_payload = ?,
           payload_size = ?, updated_at = ?, revision = revision + 1, delivery_version = delivery_version + ?, pdf_cache_key=NULL
       WHERE id = ? AND kind = 'letter' AND released_at IS NULL AND (? IS NULL OR revision = ?)`
    ).bind(recipientId, encryptedPayload, pdfPayload || null, payloadSize, updatedAt, deliveryChanged?1:0, id, expectedRevision ?? null, expectedRevision ?? null).run();
    return Number(result.meta?.changes || 0) > 0;
  }

  async updatePrivateItemPdf({ id, pdfPayload, expectedRevision=null, cacheKey=null }) {
    const r=await this.db.prepare('UPDATE encrypted_items SET pdf_payload=?, pdf_cache_key=? WHERE id=? AND (? IS NULL OR revision=?)').bind(pdfPayload,cacheKey,id,expectedRevision,expectedRevision).run();
    return Number(r.meta?.changes||0)>0;
  }

  async getDocumentArtifact(key) {
    return this.db.prepare("SELECT * FROM document_artifacts WHERE artifact_key = ?").bind(key).first();
  }

  async saveDocumentArtifact({ key, filename, mimeType, contentBase64, sha256, updatedAt,layoutKey=null,guardDocument=false }) {
    const result=await this.db.prepare(
      `INSERT INTO document_artifacts (artifact_key, filename, mime_type, content_base64, sha256, updated_at,layout_key)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE ?=0 OR EXISTS(SELECT 1 FROM public_farewell WHERE id=1 AND updated_at=?)
       ON CONFLICT(artifact_key) DO UPDATE SET filename = excluded.filename, mime_type = excluded.mime_type,
         content_base64 = excluded.content_base64, sha256 = excluded.sha256, updated_at = excluded.updated_at,layout_key=excluded.layout_key`
    ).bind(key, filename, mimeType, contentBase64, sha256, updatedAt,layoutKey,guardDocument?1:0,updatedAt).run();
    return Boolean(result.meta?.changes);
  }

  async listPrivateItemsForPdfBackfill() {
    return this.db.prepare(
      `SELECT encrypted_items.*, COALESCE(recipients.name, legacy_contacts.name) AS recipient_name
       FROM encrypted_items
       LEFT JOIN recipients ON recipients.id = encrypted_items.recipient_id
       LEFT JOIN contacts AS legacy_contacts ON legacy_contacts.id = encrypted_items.recipient_contact_id
       ORDER BY encrypted_items.id`
    ).all();
  }

  async listEncryptedItems() {
    return this.db.prepare(
      `SELECT encrypted_items.id, kind, title, recipient_id, assignee_contact_id, release_stage,
              payload_size, released_at, encrypted_items.created_at AS created_at, encrypted_items.updated_at AS updated_at,
              COALESCE(recipients.email, legacy_contacts.email) AS recipient_email
       FROM encrypted_items
       LEFT JOIN recipients ON recipients.id = encrypted_items.recipient_id
       LEFT JOIN contacts AS legacy_contacts ON legacy_contacts.id = encrypted_items.recipient_contact_id
       ORDER BY encrypted_items.created_at DESC`
    ).all();
  }

  async releasePrivateItems(now, round) {
    const owner=await this.getOwner(); if(owner.confirmation_round!==round) return false;
    await this.getRoundRules(owner);
    const before=(await this.getProgress(round)).find(p=>p.channel==='private');
    const after=(await this.advanceChannel(round,'private',now)).find(p=>p.channel==='private');
    return !before?.released_at&&Boolean(after?.released_at);
  }

  async setVerificationThread(id, round, threadId, expectedClaim=null) {
    return this.db.prepare(`UPDATE contacts SET verification_thread_id=? WHERE id=? AND verification_round=?${expectedClaim?" AND EXISTS(SELECT 1 FROM mail_claims WHERE dedupe_key=? AND attempt_id=? AND status=?)":''}`)
      .bind(threadId,id,round,...(expectedClaim?[expectedClaim.dedupeKey,expectedClaim.attemptId,expectedClaim.status]:[])).run();
  }

  async claimMail(dedupeKey, now, maxDaily, attemptId=null) {
    if(attemptId){
      const result=await this.db.prepare(`INSERT INTO mail_claims(dedupe_key,status,claimed_at,attempt_id) SELECT ?,'sending',?,? WHERE (SELECT COUNT(*) FROM mail_claims WHERE claimed_at>=? AND status IN ('sending','sent','dry_run','uncertain'))<? ON CONFLICT(dedupe_key) DO UPDATE SET status='sending',claimed_at=excluded.claimed_at,attempt_id=excluded.attempt_id,last_error=NULL WHERE mail_claims.status IN ('failed','cancelled')`).bind(dedupeKey,now,attemptId,now.slice(0,10)+'T00:00:00.000Z',maxDaily).run();
      return Boolean(result.meta?.changes);
    }
    const result = await this.db.prepare(`INSERT INTO mail_claims (dedupe_key, status, claimed_at)
      SELECT ?, 'sending', ? WHERE (SELECT COUNT(*) FROM mail_claims WHERE claimed_at >= ? AND status IN ('sending','sent','dry_run','uncertain')) < ?
      ON CONFLICT(dedupe_key) DO UPDATE SET status = 'sending', claimed_at = excluded.claimed_at, last_error = NULL
      WHERE mail_claims.status IN ('failed', 'cancelled')`).bind(dedupeKey, now, now.slice(0, 10) + 'T00:00:00.000Z', maxDaily).run();
    return Number(result.meta?.changes || 0) > 0;
  }

  async finishMailClaim(dedupeKey, status, error, attemptId=null,receipt={}) {
    if(attemptId)return this.db.prepare("UPDATE mail_claims SET status=?,last_error=?,provider_message_id=?,provider_thread_id=? WHERE dedupe_key=? AND attempt_id=? AND status IN ('sending','uncertain')").bind(status,error||null,receipt.id||null,receipt.threadId||null,dedupeKey,attemptId).run();
    await this.db.prepare("UPDATE mail_claims SET status = ?, last_error = ? WHERE dedupe_key = ?").bind(status, error || null, dedupeKey).run();
  }

  async getCursor(key) {
    return (await this.db.prepare("SELECT value FROM runtime_cursors WHERE key = ?").bind(key).first())?.value || '';
  }

  async setCursor(key, value) {
    const fence=key==='gmail-inbox-page'?inboxWorkFence(this):{sql:'1',args:[]};
    await this.db.prepare(`INSERT INTO runtime_cursors (key, value) SELECT ?,? WHERE ${fence.sql} ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(key,value||'',...fence.args).run();
  }

  async setInboxStatus(status,round) {
    await this.db.batch([this.db.prepare("INSERT INTO runtime_cursors(key,value) VALUES('inbox-status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(status),this.db.prepare("INSERT INTO runtime_cursors(key,value) VALUES('inbox-status-round',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(round))]);
  }

  async inboundMessageComplete(id) {
    return Boolean(await this.db.prepare("SELECT 1 FROM inbound_mail_log WHERE gmail_message_id = ? AND status IN ('processed','rejected','ignored')").bind(id).first());
  }
  async completedInboundIds(ids,round=null) {
    if(!ids.length) return new Set();
    const rows=(await this.db.prepare(`SELECT gmail_message_id FROM inbound_mail_log WHERE gmail_message_id IN (${ids.map(()=>'?').join(',')}) AND (status IN ('processed','rejected','ignored')${round===null?'':' OR (confirmation_round IS NOT NULL AND confirmation_round<>?)'})`).bind(...ids,...(round===null?[]:[round])).all()).results;
    return new Set(rows.map(r=>r.gmail_message_id));
  }

  getMailDeliveryKey(item) { return privateMailKey(item); }

  async listReleasedPrivateItemsForDelivery({pending=false,id=null,limit=50,now=new Date().toISOString()}={}) {
    return this.db.prepare(
      `SELECT encrypted_items.*,
              COALESCE(recipients.email, legacy_contacts.email) AS recipient_email,
              COALESCE(recipients.name, legacy_contacts.name) AS recipient_name,
              COALESCE(recipients.locale, legacy_contacts.locale,'zh') AS recipient_locale
       FROM encrypted_items
       LEFT JOIN recipients ON recipients.id = encrypted_items.recipient_id
       LEFT JOIN contacts AS legacy_contacts ON legacy_contacts.id = encrypted_items.recipient_contact_id
       LEFT JOIN private_delivery_state ds ON ds.item_id=encrypted_items.id AND ds.content_version=encrypted_items.delivery_version
       WHERE encrypted_items.release_stage = 'PRIVATE_RELEASE'
         AND encrypted_items.released_at IS NOT NULL
         AND encrypted_items.revoked_at IS NULL
         AND COALESCE(recipients.active, legacy_contacts.active, 0) = 1
         AND EXISTS (SELECT 1 FROM owner WHERE id = 1 AND state IN ('PRIVATE_RELEASE', 'PUBLIC_RELEASE') AND release_suspended = 0)
         AND COALESCE(recipients.email, legacy_contacts.email) IS NOT NULL
         ${id!==null?'AND encrypted_items.id=?':''}
         ${pending?"AND CASE WHEN json_valid(encrypted_items.encrypted_payload) THEN json_extract(encrypted_items.encrypted_payload,'$.mode')='link' ELSE 0 END AND (ds.next_attempt_at IS NULL OR ds.next_attempt_at<=?) AND NOT EXISTS (SELECT 1 FROM mail_claims m WHERE (m.dedupe_key='private_letter_release:v2:' || encrypted_items.id || ':' || encrypted_items.delivery_version || ':' || lower(trim(COALESCE(recipients.email,legacy_contacts.email))) OR (encrypted_items.delivery_version=0 AND m.dedupe_key='private_letter_release:' || encrypted_items.id || ':' || COALESCE(recipients.email,legacy_contacts.email) AND NOT EXISTS (SELECT 1 FROM mail_claims canonical WHERE canonical.dedupe_key='private_letter_release:v2:' || encrypted_items.id || ':' || encrypted_items.delivery_version || ':' || lower(trim(COALESCE(recipients.email,legacy_contacts.email)))))) AND m.status IN ('sent','dry_run','uncertain','sending'))":''}
         ${pending?"ORDER BY COALESCE(ds.updated_at,''),encrypted_items.id LIMIT ?":''}`
    ).bind(...(id!==null?[id]:[]),...(pending?[now,Math.min(100,Math.max(1,limit))]:[])).all();
  }

  async findVaultItemByTokenHash(tokenHash) {
    return this.db.prepare(
      `SELECT encrypted_items.*, COALESCE(recipients.name, legacy_contacts.name) AS recipient_name
       FROM encrypted_items
       LEFT JOIN recipients ON recipients.id = encrypted_items.recipient_id
       LEFT JOIN contacts AS legacy_contacts ON legacy_contacts.id = encrypted_items.recipient_contact_id
       WHERE encrypted_items.vault_token_hash = ?
         AND encrypted_items.released_at IS NOT NULL AND encrypted_items.revoked_at IS NULL
         AND COALESCE(recipients.active, legacy_contacts.active, 0) = 1
         AND EXISTS (SELECT 1 FROM owner WHERE id = 1 AND state IN ('PRIVATE_RELEASE', 'PUBLIC_RELEASE') AND release_suspended = 0)`
    ).bind(tokenHash).first();
  }

  async claimInboundMessage({ gmailMessageId, gmailThreadId, senderEmail, recipientEmail, subject, receivedAt, processedAt, round=null, source='gmail' }) {
    const fence=inboxWorkFence(this,processedAt);
    const result = await this.db.prepare(
      `INSERT INTO inbound_mail_log
       (gmail_message_id, gmail_thread_id, sender_email, recipient_email, subject, status, received_at, processed_at,confirmation_round,source)
       SELECT ?, ?, ?, ?, ?, 'processing', ?, ?,COALESCE(?,(SELECT confirmation_round FROM owner WHERE id=1)),? WHERE ${fence.sql}
       ON CONFLICT(gmail_message_id) DO UPDATE SET status = 'processing', processed_at = excluded.processed_at,confirmation_round=COALESCE(inbound_mail_log.confirmation_round,excluded.confirmation_round)
       WHERE (inbound_mail_log.status = 'failed' OR (inbound_mail_log.status = 'processing' AND julianday(inbound_mail_log.processed_at) < julianday(excluded.processed_at) - 15.0 / 1440))${this.inboxFence?' AND (inbound_mail_log.confirmation_round IS NULL OR inbound_mail_log.confirmation_round=excluded.confirmation_round)':''}`
    ).bind(
      gmailMessageId,
      gmailThreadId || null,
      senderEmail || "",
      recipientEmail || "",
      subject || "",
      receivedAt || null,
      processedAt,round,source,...fence.args
    ).run();
    return Number(result.meta?.changes || 0) > 0;
  }

  async finishInboundMessage({ gmailMessageId, command, status, details, processedAt }) {
    const fence=inboxWorkFence(this,processedAt,{processing:Boolean(this.inboxFence)});
    return this.db.prepare(
      `UPDATE inbound_mail_log
       SET command = ?, status = ?, details_json = ?, processed_at = ?
       WHERE gmail_message_id = ? AND ${fence.sql}`
    ).bind(command || null, status, JSON.stringify(details || {}), processedAt, gmailMessageId,...fence.args).run();
  }

  async listInboundMailLog(limit = 50) {
    return this.db.prepare("SELECT * FROM inbound_mail_log ORDER BY processed_at DESC LIMIT ?").bind(limit).all();
  }
  async countDeliveriesToday(dayPrefix) {
    const row = await this.db.prepare(
      `SELECT COUNT(*) AS count FROM delivery_log
       WHERE created_at >= ?
         AND status IN ('dry_run', 'sent')`
    ).bind(`${dayPrefix}T00:00:00.000Z`).first();
    return Number(row?.count || 0);
  }

  async hasDelivery(dedupeKey) {
    const row = await this.db.prepare("SELECT 1 FROM mail_claims WHERE dedupe_key=? AND status IN ('sent','dry_run') UNION ALL SELECT 1 FROM delivery_log WHERE dedupe_key=? AND status IN ('sent','dry_run') LIMIT 1").bind(dedupeKey,dedupeKey).first();
    return Boolean(row);
  }

  async logDelivery({ eventType, recipientEmail, subject, provider, status, dedupeKey, lastError, now, expectedAttemptId=null }) {
    // The canonical CAS may precede this write by an await. A human retry can
    // invalidate that attempt meanwhile; test its identity inside the write.
    return this.db.prepare(
      `INSERT INTO delivery_log
       (event_type, recipient_email, subject, provider, status, dedupe_key, last_error, created_at)
       ${expectedAttemptId===null?'VALUES (?, ?, ?, ?, ?, ?, ?, ?)':'SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mail_claims WHERE dedupe_key=? AND attempt_id=? AND status=?)'}
       ON CONFLICT(dedupe_key) DO UPDATE SET
         status = excluded.status,
         last_error = excluded.last_error,
         attempts = delivery_log.attempts + 1,
         created_at = excluded.created_at`
    ).bind(eventType, recipientEmail, subject, provider, status === 'uncertain' ? 'failed' : status, dedupeKey, status === 'uncertain' ? '发送结果不明，已暂停重发；' + (lastError || '') : lastError || null, now,...(expectedAttemptId===null?[]:[dedupeKey,expectedAttemptId,status])).run();
  }

  async listDeliveryLog(limit = 50) {
    return this.db.prepare("SELECT * FROM delivery_log ORDER BY created_at DESC LIMIT ?").bind(limit).all();
  }

  async wasVerificationSubjectSentTo(email, subject) {
    const row = await this.db.prepare(
      `SELECT id FROM delivery_log
       WHERE event_type = 'contact_verify' AND status IN ('sent', 'dry_run')
         AND lower(trim(recipient_email)) = lower(trim(?)) AND subject = ?
       ORDER BY created_at DESC LIMIT 1`
    ).bind(email, subject).first();
    return Boolean(row);
  }

  async getOperationalHealth() {
    const [latestScheduled, recentCronGap, latestDelivery, latestSuccessfulDelivery, outboundProblems, inboundProblems, blockedMail, privateDeliveries, latestMailHealthcheck, latestBackup,privateProblems,publicProblems,inboundRows] = await Promise.all([
      this.db.prepare(
        "SELECT created_at, details_json FROM audit_log WHERE event_type = 'scheduled_check_completed' ORDER BY id DESC LIMIT 1"
      ).first(),
      this.db.prepare(
        `WITH runs AS (
           SELECT created_at, LAG(created_at) OVER (ORDER BY created_at) AS previous_at
           FROM audit_log
           WHERE event_type = 'scheduled_check_completed'
             AND created_at >= datetime('now', '-7 days')
         )
         SELECT MAX((julianday(created_at) - julianday(previous_at)) * 24) AS max_gap_hours
         FROM runs WHERE previous_at IS NOT NULL`
      ).first(),
      this.db.prepare(
        "SELECT event_type, status, last_error, created_at FROM delivery_log ORDER BY created_at DESC LIMIT 1"
      ).first(),
      this.db.prepare(
        "SELECT event_type, status, created_at FROM delivery_log WHERE status IN ('sent', 'dry_run') ORDER BY created_at DESC LIMIT 1"
      ).first(),
      this.db.prepare("SELECT COUNT(*) AS count FROM delivery_log WHERE status IN ('failed','uncertain') AND created_at >= (SELECT last_checkin_at FROM owner WHERE id = 1)").first(),
      this.db.prepare("SELECT COUNT(*) AS count FROM inbound_mail_log WHERE confirmation_round=(SELECT confirmation_round FROM owner WHERE id=1) AND (status = 'failed' OR (status = 'processing' AND julianday(processed_at) < julianday('now') - 15.0 / 1440))").first(),
      this.db.prepare("SELECT dedupe_key, status, claimed_at, last_error FROM mail_claims WHERE status = 'uncertain' OR (status = 'sending' AND julianday(claimed_at) < julianday('now') - 15.0 / 1440) ORDER BY claimed_at LIMIT 100").all(),
      this.listPrivateDeliveryStatus(),
      this.db.prepare("SELECT created_at FROM delivery_log WHERE event_type = 'mail_healthcheck' AND status = 'sent' ORDER BY created_at DESC LIMIT 1").first(),
      this.getLatestAudit('complete_backup_exported'),
      this.listPrivateDeliveryStatus({summary:true}),
      this.db.prepare(PUBLIC_DELIVERY_PROBLEMS_SQL).first(),
      this.db.prepare("SELECT gmail_message_id,subject,source,confirmation_round,status,processed_at,reconciliation_note FROM inbound_mail_log WHERE confirmation_round=(SELECT confirmation_round FROM owner WHERE id=1) AND (status='failed' OR (status='processing' AND julianday(processed_at)<julianday('now')-15.0/1440)) ORDER BY processed_at LIMIT 50").all(),
    ]);
    return {
      latestScheduled,
      maxCronGapHours: Number(recentCronGap?.max_gap_hours || 0),
      latestDelivery,
      latestSuccessfulDelivery,
      outboundProblemCount: Number(outboundProblems?.count || 0),
      inboundProblemCount: Number(inboundProblems?.count || 0),
      blockedMail: blockedMail.results || [],
      privateDeliveries: privateDeliveries.results || [],
      privateDeliveryProblemCount: Number(privateProblems?.count||0),
      publicDeliveryProblemCount: Number(publicProblems?.count||0),
      inboundProblems: inboundRows.results||[],
      latestMailHealthcheck,
      latestBackup,
    };
  }

  async recordPrivateDeliveryState(id, status, reason, now, contentVersion=0, expectedClaim=null) {
    const retry=status==='failed'?new Date(Date.parse(now)+300000).toISOString():null;
    return this.db.prepare(`INSERT INTO private_delivery_state(item_id,status,reason,updated_at,content_version,next_attempt_at)
      ${expectedClaim?'SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mail_claims WHERE dedupe_key=? AND attempt_id=? AND status=?) AND EXISTS(SELECT 1 FROM encrypted_items WHERE id=? AND delivery_version=?)':'VALUES(?,?,?,?,?,?)'}
      ON CONFLICT(item_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,updated_at=excluded.updated_at,content_version=excluded.content_version,next_attempt_at=excluded.next_attempt_at`)
      .bind(id,status,reason||null,now,contentVersion,retry,...(expectedClaim?[expectedClaim.dedupeKey,expectedClaim.attemptId,status,id,contentVersion]:[])).run();
  }

  async hasBlockingInbound(round,source='gmail') {
    return Boolean(await this.db.prepare("SELECT 1 FROM inbound_mail_log WHERE confirmation_round=? AND source=? AND status IN ('failed','processing') LIMIT 1").bind(round,source).first());
  }
  async pendingInboundIds(limit=5) {
    return (await this.db.prepare("SELECT gmail_message_id FROM inbound_mail_log WHERE confirmation_round=(SELECT confirmation_round FROM owner WHERE id=1) AND source='gmail' AND (status='failed' OR (status='processing' AND julianday(processed_at)<julianday('now')-15.0/1440)) ORDER BY processed_at LIMIT ?").bind(limit).all()).results.map(r=>r.gmail_message_id);
  }
  async reconcileInboundMessage({gmailMessageId,resolution,note,expectedRound,now=new Date().toISOString()}) {
    if(!['ignore','retry'].includes(resolution)||typeof note!=='string'||!note.trim()||note.length>2000)return false;
    const result=await this.db.prepare("UPDATE inbound_mail_log SET status=?,reconciled_at=?,reconciliation_note=? WHERE gmail_message_id=? AND confirmation_round IS ? AND (status='failed' OR (status='processing' AND julianday(processed_at)<julianday(?)-15.0/1440))").bind(resolution==='ignore'?'ignored':'failed',now,note.trim(),gmailMessageId,expectedRound??null,now).run();
    if(result.meta?.changes&&resolution==='retry')await this.setCursor('gmail-inbox-page','');
    return Boolean(result.meta?.changes);
  }
  async channelReleaseAllowed(round,channel='private') {
    const path='$.'+channel;
    return Boolean(await this.db.prepare(`SELECT 1 FROM owner o JOIN round_rules r ON r.round=o.confirmation_round JOIN release_progress p ON p.round=o.confirmation_round AND p.channel=? WHERE o.id=1 AND o.confirmation_round=? AND o.release_suspended=0 AND o.pause_mode IS NULL AND p.released_at IS NOT NULL AND json_extract(r.rules_json,?)=1 AND (SELECT COUNT(*) FROM confirmation_votes v JOIN contacts c ON c.id=v.contact_id WHERE v.round=o.confirmation_round AND c.active=1 AND c.verification_round=v.round AND v.status='confirmed_death' AND c.id IN (SELECT value FROM json_each(r.rules_json,?)))>=json_extract(r.rules_json,?)`).bind(channel,round,path+'.enabled',path+'.contact_ids',path+'.quorum').first());
  }
  async publicDeliveryAllowed(contact,round,documentAt,formalRevision) {
    const table=contact.type==='recipient'?'recipients':'contacts';
    return Boolean(await this.db.prepare(`SELECT 1 FROM owner o JOIN round_rules r ON r.round=o.confirmation_round JOIN release_progress p ON p.round=o.confirmation_round AND p.channel='public' JOIN public_farewell d ON d.id=1 JOIN farewell_document_versions dv ON dv.id=1 JOIN ${table} c ON c.id=? WHERE o.id=1 AND o.confirmation_round=? AND o.release_suspended=0 AND o.pause_mode IS NULL AND p.released_at IS NOT NULL AND d.updated_at=? AND dv.formal_revision=? AND c.active=1 AND lower(trim(c.email))=? AND json_extract(r.rules_json,'$.public.enabled')=1 AND (SELECT COUNT(*) FROM confirmation_votes v JOIN contacts vc ON vc.id=v.contact_id WHERE v.round=o.confirmation_round AND vc.active=1 AND vc.verification_round=v.round AND v.status='confirmed_death' AND vc.id IN (SELECT value FROM json_each(r.rules_json,'$.public.contact_ids')))>=json_extract(r.rules_json,'$.public.quorum')`).bind(contact.id,round,documentAt,formalRevision,String(contact.email).trim().toLowerCase()).first());
  }
  async privateDeliveryAllowed(item,round) {
    return Boolean(await this.db.prepare(`SELECT 1 FROM encrypted_items i LEFT JOIN recipients rc ON rc.id=i.recipient_id LEFT JOIN contacts lc ON lc.id=i.recipient_contact_id JOIN owner o ON o.id=1 JOIN round_rules r ON r.round=o.confirmation_round JOIN release_progress p ON p.round=o.confirmation_round AND p.channel='private' WHERE i.id=? AND i.delivery_version=? AND lower(trim(COALESCE(rc.email,lc.email)))=? AND COALESCE(rc.active,lc.active,0)=1 AND i.released_at IS NOT NULL AND i.revoked_at IS NULL AND o.confirmation_round=? AND o.release_suspended=0 AND o.pause_mode IS NULL AND p.released_at IS NOT NULL AND json_extract(r.rules_json,'$.private.enabled')=1 AND (SELECT COUNT(*) FROM confirmation_votes v JOIN contacts c ON c.id=v.contact_id WHERE v.round=o.confirmation_round AND c.active=1 AND c.verification_round=v.round AND v.status='confirmed_death' AND c.id IN (SELECT value FROM json_each(r.rules_json,'$.private.contact_ids')))>=json_extract(r.rules_json,'$.private.quorum')`).bind(item.id,item.delivery_version??0,String(item.recipient_email).trim().toLowerCase(),round).first());
  }

  async listPrivateDeliveryStatus({summary=false}={}) {
    const query=`SELECT i.id, COALESCE(r.name,c.name) AS recipient_name,
      CASE WHEN NOT json_valid(i.encrypted_payload) THEN 'manual'
           WHEN json_extract(i.encrypted_payload,'$.mode') = 'passphrase' THEN 'manual'
           WHEN m.status IN ('sent','dry_run') THEN m.status
           WHEN m.status IN ('sending','uncertain') THEN m.status
           ELSE COALESCE(s.status, 'pending') END AS status,
      s.reason, s.updated_at
      FROM encrypted_items i LEFT JOIN recipients r ON r.id=i.recipient_id
      LEFT JOIN contacts c ON c.id=i.recipient_contact_id
      LEFT JOIN private_delivery_state s ON s.item_id=i.id AND s.content_version=i.delivery_version
      LEFT JOIN mail_claims m ON m.dedupe_key='private_letter_release:v2:'||i.id||':'||i.delivery_version||':'||lower(trim(COALESCE(r.email,c.email)))
      WHERE i.release_stage='PRIVATE_RELEASE' AND i.released_at IS NOT NULL AND i.revoked_at IS NULL
      AND COALESCE(r.active,c.active,0)=1
      AND EXISTS (SELECT 1 FROM owner WHERE id=1 AND state IN ('PRIVATE_RELEASE','PUBLIC_RELEASE') AND release_suspended=0)
      ORDER BY i.id`;
    const statement=this.db.prepare(summary?`SELECT COUNT(*) AS count FROM (${query}) WHERE status NOT IN ('sent','dry_run','manual')`:query+' LIMIT 100');
    return summary?statement.first():statement.all();
  }

  async getPublicFarewell() {
    return this.db.prepare("SELECT * FROM public_farewell WHERE id = 1").first();
  }

  async getPublicFarewellUpdatedAt() {
    const row = await this.db.prepare(
      `SELECT MAX(updated_at) AS updated_at FROM (
         SELECT updated_at FROM public_farewell WHERE id = 1
         UNION ALL
         SELECT updated_at FROM public_farewell_items WHERE status = 'published'
       )`
    ).first();
    return row?.updated_at || null;
  }

  async upsertPublicFarewell({ title, body, status, now }) {
    await this.db.prepare(
      `INSERT INTO public_farewell (id, title, body, status, updated_at, auto_released_at)
       VALUES (1, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         body = excluded.body,
         status = excluded.status,
         updated_at = excluded.updated_at,
         auto_released_at = NULL`
    ).bind(title, body, status || "DRAFT", now).run();
  }

  async upsertPublicFarewellTitle({ title, now }) {
    await this.db.prepare(
      `INSERT INTO public_farewell (id, title, body, status, updated_at)
       VALUES (1, ?, '', 'DRAFT', ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         updated_at = excluded.updated_at`
    ).bind(title, now).run();
  }

  async autoPublishPublicFarewell(now, round) {
    const owner=await this.getOwner(); if(owner.confirmation_round!==round) return false;
    await this.getRoundRules(owner); const before=await this.getPublicFarewell();
    await this.advanceChannel(round,'public',now);
    return before?.status!=='PUBLIC_RELEASE'&&(await this.getPublicFarewell())?.status==='PUBLIC_RELEASE';
  }

  async retractAutoReleasedPublicFarewell(now) {
    const result = await this.db.prepare(
      `UPDATE public_farewell
       SET status = 'DRAFT', updated_at = ?, auto_released_at = NULL
       WHERE id = 1 AND auto_released_at IS NOT NULL`
    ).bind(now).run();
    return Number(result.meta?.changes || 0) > 0;
  }

  async listPublicFarewellItems({ publicOnly = false } = {}) {
    const where = publicOnly ? "WHERE status = 'published'" : "";
    return this.db.prepare(
      `SELECT id, title, body, sort_order, entry_order, status, created_at, updated_at
       FROM public_farewell_items
       ${where}
       ORDER BY sort_order, entry_order, id`
    ).all();
  }

  async getPublicFarewellItem(id) {
    return this.db.prepare(
      `SELECT id, title, body, sort_order, entry_order, status, created_at, updated_at
       FROM public_farewell_items WHERE id = ?`
    ).bind(id).first();
  }

  async getPublicFarewellTitleOrder(title) {
    return this.db.prepare(
      `SELECT MIN(sort_order) AS sort_order, MAX(entry_order) AS entry_order
       FROM public_farewell_items WHERE title = ?`
    ).bind(title).first();
  }

  async getNextPublicFarewellGroupOrder() {
    const row = await this.db.prepare("SELECT MAX(sort_order) AS sort_order FROM public_farewell_items").first();
    return Number(row?.sort_order || 0) + 10;
  }

  async upsertPublicFarewellItem({ id, title, body, sortOrder, entryOrder, status, now }) {
    if (id) {
      await this.db.prepare(
        `UPDATE public_farewell_items
         SET title = ?, body = ?, sort_order = ?, entry_order = ?, status = ?, updated_at = ?
         WHERE id = ?`
      ).bind(title, body, sortOrder, entryOrder, status, now, id).run();
      return Number(id);
    }

    const result = await this.db.prepare(
      `INSERT INTO public_farewell_items (title, body, sort_order, entry_order, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(title, body, sortOrder, entryOrder, status, now, now).run();
    return result.meta.last_row_id;
  }

  async movePublicFarewellItem({ id, direction, now }) {
    const item = await this.getPublicFarewellItem(id);
    if (!item) return { found: false, moved: false };
    const group = (await this.db.prepare(
      `SELECT id, entry_order FROM public_farewell_items
       WHERE title = ? ORDER BY entry_order, id`
    ).bind(item.title).all()).results || [];
    const index = group.findIndex((entry) => Number(entry.id) === Number(id));
    const targetIndex = index + (direction === "up" ? -1 : 1);
    if (index < 0 || targetIndex < 0 || targetIndex >= group.length) return { found: true, moved: false };

    const reordered = [...group];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIndex, 0, moved);
    for (let position = 0; position < reordered.length; position += 1) {
      await this.db.prepare(
        "UPDATE public_farewell_items SET entry_order = ?, updated_at = ? WHERE id = ?"
      ).bind((position + 1) * 10, now, reordered[position].id).run();
    }
    return { found: true, moved: true };
  }

  async renamePublicFarewellGroup({ title, newTitle, now }) {
    const sourceItems = (await this.db.prepare(
      `SELECT id, sort_order, entry_order FROM public_farewell_items
       WHERE title = ? ORDER BY entry_order, id`
    ).bind(title).all()).results || [];
    if (!sourceItems.length) return { found: false, merged: false };

    const targetItems = title === newTitle ? [] : (await this.db.prepare(
      `SELECT id, sort_order, entry_order FROM public_farewell_items
       WHERE title = ? ORDER BY entry_order, id`
    ).bind(newTitle).all()).results || [];
    const combined = [...targetItems, ...sourceItems];
    const sortOrder = Number(targetItems[0]?.sort_order ?? sourceItems[0].sort_order);
    for (let position = 0; position < combined.length; position += 1) {
      await this.db.prepare(
        `UPDATE public_farewell_items
         SET title = ?, sort_order = ?, entry_order = ?, updated_at = ?
         WHERE id = ?`
      ).bind(newTitle, sortOrder, (position + 1) * 10, now, combined[position].id).run();
    }
    await this.db.prepare("UPDATE public_farewell SET updated_at = ? WHERE id = 1").bind(now).run();
    return { found: true, merged: targetItems.length > 0 };
  }

  async movePublicFarewellGroup({ title, direction, now }) {
    const groups = (await this.db.prepare(
      `SELECT title, MIN(sort_order) AS sort_order, MIN(id) AS first_id
       FROM public_farewell_items
       GROUP BY title
       ORDER BY sort_order, first_id`
    ).all()).results || [];
    const index = groups.findIndex((group) => group.title === title);
    const targetIndex = index + (direction === "up" ? -1 : 1);
    if (index < 0) return { found: false, moved: false };
    if (targetIndex < 0 || targetIndex >= groups.length) return { found: true, moved: false };

    const reordered = [...groups];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIndex, 0, moved);
    for (let position = 0; position < reordered.length; position += 1) {
      await this.db.prepare(
        "UPDATE public_farewell_items SET sort_order = ? WHERE title = ?"
      ).bind((position + 1) * 10, reordered[position].title).run();
    }
    await this.db.prepare("UPDATE public_farewell SET updated_at = ? WHERE id = 1").bind(now).run();
    return { found: true, moved: true };
  }

  async getLegalWill() {
    return this.db.prepare("SELECT * FROM legal_will WHERE id = 1").first();
  }

  async upsertLegalWill({ status, location, custodian, notes, now }) {
    await this.db.prepare(
      `INSERT INTO legal_will (id, status, location, custodian, notes, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         location = excluded.location,
         custodian = excluded.custodian,
         notes = excluded.notes,
         updated_at = excluded.updated_at`
    ).bind(status, location, custodian, notes, now).run();
  }

  async listMailTemplates() {
    return this.db.prepare("SELECT template_key, subject_template, body_template, updated_at FROM mail_templates ORDER BY template_key").all();
  }

  async upsertMailTemplate({ key, subjectTemplate, bodyTemplate, now }) {
    await this.db.prepare(
      `INSERT INTO mail_templates (template_key, subject_template, body_template, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(template_key) DO UPDATE SET subject_template = excluded.subject_template,
         body_template = excluded.body_template, updated_at = excluded.updated_at`
    ).bind(key, subjectTemplate, bodyTemplate, now).run();
  }

  async resetMailTemplate(key) {
    await this.db.prepare("DELETE FROM mail_templates WHERE template_key = ?").bind(key).run();
  }

  async exportBackup({ includePayloads = false } = {}) {
    const schema=await this.recoveryLayout();
    await this.assertBackupCapacity(schema);
    if(includePayloads)return {
      format:'afterme-recovery-backup',format_version:2,schema_version:schema.version,
      exported_at:new Date().toISOString(),includes_payloads:true,
      recovery_tables:await this.recoverySnapshot(schema),
      redactions:['Supply ADMIN_TOKEN and provider secrets separately during recovery.','Contact and vault tokens are invalidated on recovery.','The complete backup contains sensitive metadata and encrypted private content.'],
    };
    const [owner, contacts, recipients, confirmations, items, deliveries, publicFarewell, publicFarewellItems, publicFarewellV2, legalWill, mailTemplates] = await Promise.all([
      this.getOwner(),
      this.listContacts(),
      this.listRecipients(),
      this.listConfirmations(),
      this.listEncryptedItems(),
      this.listDeliveryLog(200),
      this.getPublicFarewell(),
      this.listPublicFarewellItems(),
      this.farewell.getEditorState(),
      this.getLegalWill(),
      this.listMailTemplates(),
    ]);

    let payloads = [];
    if (includePayloads) {
      const result = await this.db.prepare(
        `SELECT id, kind, title, recipient_id, assignee_contact_id, release_stage, encrypted_payload, pdf_payload, payload_size, created_at, updated_at, released_at, revoked_at
         FROM encrypted_items
         ORDER BY id`
      ).all();
      payloads = result.results || [];
    }

    return {
      schema_version: schema.version,
      recovery_tables: includePayloads ? await this.recoverySnapshot(schema) : null,
      exported_at: new Date().toISOString(),
      includes_payloads: includePayloads,
      owner,
      contacts: (contacts.results || []).map(({ token_hash, ...contact }) => contact),
      recipients: recipients.results || [],
      confirmations: confirmations.results || [],
      private_items: items.results || [],
      private_item_payloads: payloads,
      public_farewell: publicFarewell,
      public_farewell_items: publicFarewellItems.results || [],
      public_farewell_v2: publicFarewellV2,
      legal_will: legalWill,
      mail_templates: mailTemplates.results || [],
      delivery_log: deliveries.results || [],
      redactions: [
        "Supply ADMIN_TOKEN and provider secrets separately during recovery.",
        "Contact token hashes stay in the deployment.",
        "Vault access tokens stay in the deployment.",
        "Encrypted private payloads are exported only with include_payloads=1."
      ],
    };
  }
  async recoveryLayout() {
    const current=await this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_jobs'").first();
    if(current)return {version:24,columns:RECOVERY_COLUMNS,sizeSql:BACKUP_SIZE_SQL};
    // Explicit v23 fixtures and databases remain exportable while their next
    // migration is being prepared. Never reference v24 columns on that schema.
    const columns=Object.fromEntries(Object.entries(RECOVERY_COLUMNS).filter(([table])=>table!=='background_jobs').map(([table,names])=>[table,table==='mail_claims'?names.slice(0,4):table==='pdf_artifacts'?names.slice(0,14):names]));
    return {version:23,columns,sizeSql:backupSizeSql(columns)};
  }
  async recoverySnapshot(schema) {
    schema ||= await this.recoveryLayout();
    const owner=await this.getOwner();if(!owner)throw new Error('Set up the owner before exporting a recovery backup');
    await this.getRoundRules(owner);
    const names = Object.keys(schema.columns);
    // D1 batch reads share one transaction; preserve relationships and PDF versions.
    const results = await this.db.batch(names.map(name => this.db.prepare(`SELECT * FROM ${name}`)));
    return Object.fromEntries(names.map((name, index) => [name, (results[index].results || []).map(row => {
      const { token_hash, verification_thread_id, vault_token, vault_token_hash, ...safe } = row;
      return safe;
    })]));
  }
  async assertBackupCapacity(schema) {
    schema ||= await this.recoveryLayout();
    const size=await this.db.prepare(schema.sizeSql).first();
    if(size.bytes>HTTP_BACKUP_MAX_BYTES)throw Object.assign(new Error('Backup exceeds the 16 MiB HTTP export limit; use the documented offline D1 export and backup:from-d1 path'),{status:413});
  }
  async audit(eventType, details, now) {
    const fence=inboxWorkFence(this,now,{processing:Boolean(this.inboxFence)});
    await this.db.prepare(`INSERT INTO audit_log (event_type, details_json, created_at) SELECT ?,?,? WHERE ${fence.sql}`)
      .bind(eventType, JSON.stringify(details || {}), now,...fence.args).run();
  }

  async getLatestAudit(eventType) {
    return this.db.prepare(
      "SELECT event_type, details_json, created_at FROM audit_log WHERE event_type = ? ORDER BY id DESC LIMIT 1"
    ).bind(eventType).first();
  }
}
