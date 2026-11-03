import {testFontAssets} from './helpers/pdf-fonts.js';
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from "node:test";
import assert from "node:assert/strict";
import { deliverReleasedItems, ensureCurrentPdfArtifacts, evaluateOperationalHealth, handleRequest, normalizeEmail, ownerWithEffectiveState, PDF_GENERATOR_VERSION, processContactEmailReplies, runScheduledCheck, sendTransitionEmails } from "../src/worker.js";
import { STATES } from "../src/core.js";
import { buildStoredPayload } from "../src/content.js";

test("VERIFY automatically issues fresh confirmation links", async () => {
  const deliveries = [];
  const rotations = [];
  const owner = {
    state: STATES.ALERT,
    display_name: "示例用户",
    email: "owner@example.com",
    last_checkin_at: "2026-07-04T00:00:00.000Z",
    release_suspended: 0,
  };
  const repo = {
    async getOwner() { return owner; },
    async countConfirmedDeathConfirmations() { return 0; },
    async updateOwnerState(state) { owner.state = state; },
    async resetReleaseGracePeriod() {},
    async audit() {},
    async listActiveContacts() {
      return { results: [
        { id: 1, name: "朋友A", email: "a@example.com" },
        { id: 2, name: "朋友B", email: "b@example.com" },
      ] };
    },
    async rotateContactToken(entry) { rotations.push(entry); },
    async hasDelivery(key) { return deliveries.some((entry) => entry.dedupeKey === key); },
    async countDeliveriesToday() { return deliveries.length; },
    async logDelivery(entry) { deliveries.push(entry); },
    async listReleasedPrivateItemsForDelivery() { return { results: [] }; },
  };

  const result = await runScheduledCheck(repo, {
    BASE_URL: "https://afterme.example.workers.dev",
    MAIL_PROVIDER: "dry-run",
    FROM_EMAIL: "sender@example.com",
    MAX_DAILY_EMAILS: "20",
  }, new Date("2026-07-10T01:00:00.000Z"));

  assert.equal(result.to, STATES.VERIFY);
  assert.equal(rotations.length, 2);
  assert.equal(deliveries.length, 2);
  assert.ok(deliveries.every((entry) => entry.eventType === "contact_verify"));
  assert.ok(deliveries.every((entry) => entry.subject === "关于示例用户：请提交您掌握的情况"));
  assert.ok(deliveries.every((entry) => entry.status === "dry_run"));
  assert.ok(deliveries.every((entry) => entry.dedupeKey.startsWith("VERIFY:")));
});
test("three death confirmations start a 72-hour grace period before any release", async () => {
  const owner = {
    state: STATES.VERIFY, confirmation_round: 1,
    display_name: "示例用户",
    email: "owner@example.com",
    last_checkin_at: "2026-07-04T00:00:00.000Z",
    release_suspended: 0,
    release_ready_at: null,
  };
  const events = [];
  const repo = {
    async getOwner() { return owner; },
    async countConfirmedDeathConfirmations() { return 3; },
    async startReleaseGracePeriod(now) { owner.state = STATES.READY_TO_RELEASE; owner.release_ready_at = now; return owner; },
    async resetReleaseGracePeriod() {},
    async updateOwnerState(state) { owner.state = state; events.push(`state:${state}`); },
    async audit(eventType) { events.push(eventType); },
    async releasePrivateItems() { events.push("private-items-released"); },
    async listReleasedPrivateItemsForDelivery() { return { results: [] }; },
    async autoPublishPublicFarewell() { events.push("public-farewell-published"); return true; },
    async getDocumentArtifact() { return { filename: "farewell.pdf", mime_type: "application/pdf", content_base64: "JVBERi0=", sha256: "abc" }; },
    async listActiveContacts() { return { results: [] }; },
  };
  const env = {PDF_FONTS:testFontAssets, BASE_URL: "https://afterme.example.workers.dev", MAIL_PROVIDER: "dry-run" };

  const started = await runScheduledCheck(repo, env, new Date("2026-07-10T01:00:00.000Z"));
  assert.equal(started.to, STATES.READY_TO_RELEASE);
  assert.equal(owner.state, STATES.READY_TO_RELEASE);
  assert.ok(events.includes("release_grace_started"));
  assert.ok(!events.includes("private-items-released"));
  assert.ok(!events.includes("public-farewell-published"));

  const released = await runScheduledCheck(repo, env, new Date("2026-07-13T01:00:00.000Z"));
  assert.equal(released.to, STATES.PUBLIC_RELEASE);
  assert.equal(owner.state, STATES.PUBLIC_RELEASE);
  assert.ok(events.includes("private-items-released"));
  assert.ok(events.includes("public-farewell-published"));
});
test("unreachable confirmations do not auto-publish the public farewell", async () => {
  const owner = {
    state: STATES.VERIFY, confirmation_round: 1,
    display_name: "示例用户",
    email: "owner@example.com",
    last_checkin_at: "2026-07-04T00:00:00.000Z",
    release_suspended: 0,
  };
  let autoPublishCalls = 0;
  const repo = {
    async getOwner() { return owner; },
    async countQualifyingConfirmations() { return 3; },
    async countConfirmedDeathConfirmations() { return 2; },
    async listActiveContacts() { return { results: [] }; },
    async updateOwnerState(state) { owner.state = state; },
    async resetReleaseGracePeriod() {},
    async audit() {},
    async releasePrivateItems() {},
    async listReleasedPrivateItemsForDelivery() { return { results: [] }; },
    async autoPublishPublicFarewell() { autoPublishCalls += 1; return true; },
  };

  const result = await runScheduledCheck(repo, {
    BASE_URL: "https://afterme.example.workers.dev",
    MAIL_PROVIDER: "dry-run",
  }, new Date("2026-07-10T01:00:00.000Z"));

  assert.equal(result.to, STATES.VERIFY);
  assert.equal(owner.state, STATES.VERIFY);
  assert.equal(autoPublishCalls, 0);
});
test("transition sender gives the provider the same complete copy shown in preview", async () => {
  const sent = [];
  const deliveries = [];
  const rotations = [];
  const provider = {
    name: "capture",
    async send(message) {
      sent.push(message);
      return { status: "sent" };
    },
  };
  const repo = {
    async getOwner() { return owner; },
    async listActiveContacts() {
      return { results: [{ id: 1, name: "测试联系人", email: "contact@example.com" }] };
    },
    async rotateContactToken(entry) { rotations.push(entry); },
    async hasDelivery() { return false; },
    async countDeliveriesToday() { return deliveries.length; },
    async logDelivery(entry) { deliveries.push(entry); },
  };
  const owner = {
    display_name: "示例用户",
    last_checkin_at: "2026-07-09T00:00:00.000Z",
  };
  const env = {PDF_FONTS:testFontAssets,
    BASE_URL: "https://afterme.example.workers.dev",
    FROM_EMAIL: "afterme.fixture@gmail.com",
    INBOUND_PROVIDER: "gmail",
    MAX_DAILY_EMAILS: "20",
  };

  owner.state = STATES.ALERT;
  await sendTransitionEmails({ repo, env, owner, toState: STATES.ALERT, now: "2026-07-12T00:00:00.000Z", provider });
  owner.state = STATES.VERIFY;
  await sendTransitionEmails({ repo, env, owner, toState: STATES.VERIFY, now: "2026-07-14T00:00:00.000Z", provider });

  assert.equal(sent.length, 2);
  assert.equal(sent[0].subject, "请尝试联系示例用户");
  assert.match(sent[0].text, /^测试联系人，您好。/);
  assert.match(sent[0].text, /上次签到距今 72\u00A0小时/);
  assert.equal(sent[1].subject, "关于示例用户：请提交您掌握的情况");
  assert.match(sent[1].text, /上次签到距今 120\u00A0小时/);
  assert.match(sent[1].text, /直接回复本邮件/);
  assert.match(sent[1].text, /https:\/\/afterme\.example\.workers\.dev\/verify\//);
  assert.match(sent[1].replyTo, /^afterme\.fixture\+verify-[A-Za-z0-9_-]+@gmail\.com$/);
  assert.equal(rotations.length, 1);
});

test("private release sender attaches the stored letter as a PDF", async () => {
  const sent = [];
  const deliveries = [];
  const audits = [];
  const provider = {
    name: "capture",
    async send(message) {
      sent.push(message);
      return { status: "sent" };
    },
  };
  const env = {PDF_FONTS:testFontAssets,
    BASE_URL: "https://afterme.example.workers.dev",
    FROM_EMAIL: "afterme.fixture@gmail.com",
    MAX_DAILY_EMAILS: "20",
    CONTENT_ENCRYPTION_KEY: "test-content-key",
  };
  const encryptedPayload = await buildStoredPayload({ body: { plaintext: "这是一封测试信正文。" }, env });
  const owner = { display_name: "示例用户", state: STATES.PRIVATE_RELEASE, confirmation_round: 1 };
  const repo = {
    async getOwner() { return owner; },
    async countConfirmedDeathConfirmations() { return 3; },
    async listReleasedPrivateItemsForDelivery() {
      return { results: [{
        id: 7,
        title: "不应出现在邮件标题里的私人标题",
        encrypted_payload: encryptedPayload,
        recipient_name: "测试收件人",
        recipient_email: "recipient@example.com",
      }] };
    },
    async hasDelivery() { return false; },
    async countDeliveriesToday() { return deliveries.length; },
    async logDelivery(entry) { deliveries.push(entry); },
    async audit(eventType, details) { audits.push({ eventType, details }); },
    async updatePrivateItemPdf() {},
  };

  await deliverReleasedItems(
    repo,
    env,
    new URL("https://afterme.example.workers.dev"),
    "2026-07-14T00:00:00.000Z",
    owner,
    provider
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, "示例用户留给您的一封信");
  assert.doesNotMatch(sent[0].subject, /私人标题/);
  assert.match(sent[0].text, /^测试收件人，您好。/);
  assert.match(sent[0].text, /阅读、回复、保存或删除/);
  assert.match(sent[0].text, /PDF 附件/);
  // Opening the notification must not expose the private letter before the recipient chooses to read it.
  assert.doesNotMatch(sent[0].text, /这是一封测试信正文/);
  assert.doesNotMatch(sent[0].subject, /这是一封测试信正文/);
  assert.equal(sent[0].attachments.length, 1);
  assert.equal(sent[0].attachments[0].contentType, "application/pdf");
  assert.equal(sent[0].attachments[0].filename, "示例用户留给您的一封信.pdf");
  assert.match(new TextDecoder().decode(sent[0].attachments[0].data), /^%PDF-1.7/);
  assert.doesNotMatch(sent[0].text, /https?:\/\//);
  assert.equal(audits.length, 0);
});
test("authenticated Gmail reply records a contact confirmation without opening a web page", async () => {
  const token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
  const tokenHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("base64url");
  const finished = [];
  const confirmations = [];
  const owner = {
    state: STATES.VERIFY, confirmation_round: 1,
    display_name: "示例用户",
    last_checkin_at: "2026-07-01T00:00:00.000Z",
    release_suspended: 0,
  };
  const repo = {
    async claimInboundMessage() { return true; },
    async finishInboundMessage(entry) { finished.push(entry); },
    async findContactByTokenHash(value) {
      return value === tokenHash ? { id: 3, email: "contact@example.com", active: 1, verification_round: 1 } : null;
    },
    async getOwner() { return owner; },
    async createConfirmation(entry) { confirmations.push(entry); },
    async countConfirmedDeathConfirmations() { return 0; },
    async audit() {},
  };
  const provider = {
    name: "gmail",
    async listInboundMessages() {
      return [{
        id: "gmail-message-1",
        threadId: "thread-1",
        from: "contact@example.com",
        recipients: `afterme.fixture+verify-${token}@gmail.com`,
        subject: "Re: 关于示例用户",
        body: "暂时联系不上本人\n\n> 原邮件",
        authenticationPassed: true,
        receivedAt: "2026-07-14T00:00:00.000Z",
      }];
    },
  };

  const result = await processContactEmailReplies({
    repo,
    env: { BASE_URL: "https://afterme.example.workers.dev" },
    now: "2026-07-14T01:00:00.000Z",
    provider,
  });

  assert.equal(result.processed, 1);
  assert.deepEqual(confirmations, [{ contactId: 3, status: "unable_to_reach", round: 1, now: "2026-07-14T00:00:00.000Z", note: "Submitted by authenticated Gmail reply" }]);
  assert.equal(finished[0].status, "processed");
});

test("authenticated Gmail reply falls back to unique contact email when a client strips the plus token", async () => {
  const finished = [];
  const confirmations = [];
  const audits = [];
  const owner = {
    state: STATES.VERIFY, confirmation_round: 1,
    display_name: "示例用户",
    last_checkin_at: "2026-07-01T00:00:00.000Z",
    release_suspended: 1,
  };
  const repo = {
    async claimInboundMessage() { return true; },
    async finishInboundMessage(entry) { finished.push(entry); },
    async findContactByEmail(email) {
      return email === "contact@example.com" ? { id: 4, email, active: 1, verification_round: 1, verification_thread_id: "thread-stripped-token" } : null;
    },
    async getOwner() { return owner; },
    async createConfirmation(entry) { confirmations.push(entry); },
    async countConfirmedDeathConfirmations() { return 0; },
    async audit(eventType, details) { audits.push({ eventType, details }); },
  };
  const provider = {
    name: "gmail",
    async listInboundMessages() {
      return [{
        id: "gmail-message-stripped-token",
        threadId: "thread-stripped-token",
        from: "contact@example.com",
        recipients: "afterme.fixture@gmail.com",
        subject: "Re: 关于示例用户：请提交您掌握的情况",
        body: "暂时联系不上本人\n\n> 原邮件",
        authenticationPassed: true,
        receivedAt: "2026-07-14T00:00:00.000Z",
      }];
    },
  };

  const result = await processContactEmailReplies({ repo, env: {}, now: "2026-07-14T01:00:00.000Z", provider });
  assert.equal(result.processed, 1);
  assert.deepEqual(confirmations, [{ contactId: 4, status: "unable_to_reach", round: 1, now: "2026-07-14T00:00:00.000Z", note: "Submitted by authenticated Gmail reply" }]);
  assert.equal(finished[0].details.identification, "authenticated-sender-and-subject");
  assert.equal(audits[0].details.identification, "authenticated-sender-and-subject");
});

test("tokenless reply still matches the subject recorded before a template edit", async () => {
  const confirmations = [];
  const repo = {
    async claimInboundMessage() { return true; },
    async finishInboundMessage() {},
    async findContactByEmail() { return { id: 5, name: "朋友", email: "contact@example.com", active: 1, verification_round: 1, verification_thread_id: "old-thread" }; },
    async getOwner() { return { state: STATES.VERIFY, confirmation_round: 1, display_name: "示例用户", last_checkin_at: "2026-07-01T00:00:00.000Z", release_suspended: 1 }; },
    async listMailTemplates() {
      return { results: [{ template_key: "contact_verify", subject_template: "新的核验标题", body_template: "{联系人姓名}", updated_at: "2026-08-13T00:00:00.000Z" }] };
    },
    async wasVerificationSubjectSentTo(email, subject) {
      return email === "contact@example.com" && subject === "旧的核验标题";
    },
    async createConfirmation(entry) { confirmations.push(entry); },
    async countConfirmedDeathConfirmations() { return 0; },
    async audit() {},
  };
  const provider = {
    name: "gmail",
    async listInboundMessages() {
      return [{
        id: "gmail-message-old-custom-subject", threadId: "old-thread", receivedAt: "2026-08-13T00:00:00.000Z",
        from: "contact@example.com",
        recipients: "afterme.fixture@gmail.com",
        subject: "Re: 旧的核验标题",
        body: "暂时联系不上本人",
        authenticationPassed: true,
      }];
    },
  };
  const result = await processContactEmailReplies({ repo, env: {}, now: "2026-08-13T01:00:00.000Z", provider });
  assert.equal(result.processed, 1);
  assert.equal(confirmations[0].contactId, 5);
});

test("tokenless Gmail message with an unrelated subject is ignored", async () => {
  const finished = [];
  const repo = {
    async claimInboundMessage() { return true; },
    async finishInboundMessage(entry) { finished.push(entry); },
    async findContactByEmail() { return null; },
  };
  const provider = {
    name: "gmail",
    async listInboundMessages() {
      return [{
        id: "gmail-message-unrelated",
        from: "contact@example.com",
        recipients: "afterme.fixture@gmail.com",
        subject: "普通邮件",
        body: "暂时联系不上本人",
        authenticationPassed: true,
      }];
    },
  };
  const result = await processContactEmailReplies({ repo, env: {}, now: "2026-07-14T01:00:00.000Z", provider });
  assert.equal(result.ignored, 1);
  assert.equal(finished[0].details.reason, "not-a-contact-reply");
});

test("Gmail reply with failed sender authentication is rejected", async () => {
  const token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
  const finished = [];
  const repo = {
    async claimInboundMessage() { return true; },
    async finishInboundMessage(entry) { finished.push(entry); },
    async findContactByTokenHash() { return { id: 3, email: "contact@example.com", active: 1 }; },
  };
  const provider = {
    name: "gmail",
    async listInboundMessages() {
      return [{
        id: "gmail-message-2",
        from: "contact@example.com",
        recipients: `afterme.fixture+verify-${token}@gmail.com`,
        body: "我已从可靠来源确认本人死亡",
        authenticationPassed: false,
      }];
    },
  };

  const result = await processContactEmailReplies({ repo, env: {}, now: "2026-07-14T01:00:00.000Z", provider });
  assert.equal(result.rejected, 1);
  assert.equal(finished[0].status, "rejected");
  assert.equal(finished[0].details.reason, "sender-authentication-not-passed");
});
test("contact emails are normalized before duplicate checks and storage", () => {
  assert.equal(normalizeEmail("  Example.User@EXAMPLE.INVALID  "), "example.user@example.invalid");
});
test("private letters require an active recipient", async (t) => {
  const request = new Request("https://afterme.example.workers.dev/api/items", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-admin",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: "没有收件人的信", plaintext: "正文" }),
  });
  const {database}=await import('./helpers/database.js');const db=database();t.after(()=>db.close());
  const response = await handleRequest(request, { ALLOW_LOCAL_RATE_LIMIT_FALLBACK:true,ADMIN_TOKEN: "test-admin", CONTENT_ENCRYPTION_KEY: "test-content", DB: db });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "recipient_id is required",
    message: "私人信件必须指定收件人。",
  });
});


test("Gmail inbox failure cannot block the 48-hour state transition", async () => {
  const owner = {
    state: STATES.NORMAL,
    display_name: "示例用户",
    email: "owner@example.com",
    last_checkin_at: "2026-07-30T00:00:00.000Z",
    release_suspended: 0,
  };
  const audits = [];
  const deliveries = [];
  const repo = {
    async getOwner() { return owner; },
    async updateOwnerState(state) { owner.state = state; },
    async audit(eventType, details) { audits.push({ eventType, details }); },
    async countConfirmedDeathConfirmations() { return 0; },
    async hasDelivery() { return false; },
    async countDeliveriesToday() { return 0; },
    async logDelivery(entry) { deliveries.push(entry); },
  };

  const result = await runScheduledCheck(repo, {
    MAIL_PROVIDER: "gmail",
    FROM_EMAIL: "afterme.fixture@gmail.com",
    MAX_DAILY_EMAILS: "20",
    BASE_URL: "https://afterme.example.workers.dev",
  }, new Date("2026-08-01T01:00:00.000Z"));

  assert.equal(result.ok, true);
  assert.equal(result.inboxStatus, "failed");
  assert.equal(owner.state, STATES.OVERDUE);
  assert.ok(audits.some((entry) => entry.eventType === "gmail_inbox_poll_failed"));
  assert.ok(audits.some((entry) => entry.eventType === "state_transition"));
  assert.ok(audits.some((entry) => entry.eventType === "scheduled_check_completed"));
  assert.equal(deliveries[0].eventType, "owner_overdue");
  assert.equal(deliveries[0].status, "failed");
});

test("effective owner state never displays stale NORMAL after 48 hours", () => {
  const owner = ownerWithEffectiveState({
    state: STATES.NORMAL,
    last_checkin_at: "2026-07-30T00:00:00.000Z",
  }, new Date("2026-08-01T01:00:00.000Z"));
  assert.equal(owner.state, STATES.OVERDUE);
  assert.equal(owner.stored_state, STATES.NORMAL);
});

test("an already delivered verification does not rotate its reply token", async () => {
  let rotations = 0;
  let sends = 0;
  const owner = { display_name: "示例用户", last_checkin_at: "2026-07-01T00:00:00.000Z" };
  const repo = {
    async listActiveContacts() { return { results: [{ id: 1, name: "朋友", email: "friend@example.com" }] }; },
    async hasDelivery() { return true; },
    async rotateContactToken() { rotations += 1; },
  };
  const provider = { name: "capture", async send() { sends += 1; return { status: "sent" }; } };

  await sendTransitionEmails({ repo, env: { FROM_EMAIL: "afterme.fixture@gmail.com" }, owner, toState: STATES.VERIFY, now: "2026-08-01T00:00:00.000Z", provider });
  assert.equal(rotations, 0);
  assert.equal(sends, 0);
});

test("temporary owner-only mode skips Gmail inbox polling and contact notifications", async () => {
  const owner = {
    state: STATES.NORMAL,
    display_name: "示例用户",
    email: "owner@example.com",
    last_checkin_at: "2026-07-30T00:00:00.000Z",
    release_suspended: 1,
  };
  const audits = [];
  const deliveries = [];
  const repo = {
    async getOwner() { return owner; },
    async updateOwnerState(state) { owner.state = state; },
    async audit(eventType, details) { audits.push({ eventType, details }); },
    async countConfirmedDeathConfirmations() { return 0; },
    async hasDelivery() { return false; },
    async countDeliveriesToday() { return 0; },
    async logDelivery(entry) { deliveries.push(entry); },
    async listActiveContacts() { throw new Error("contact notifications must stay disabled"); },
  };
  const env = {PDF_FONTS:testFontAssets,
    MAIL_PROVIDER: "gmail",
    MAIL_INBOUND_ENABLED: "false",
    CONTACT_NOTIFICATIONS_ENABLED: "false",
    FROM_EMAIL: "owner-sender@example.com",
    BASE_URL: "https://afterme.example.workers.dev",
  };

  const overdue = await runScheduledCheck(repo, env, new Date("2026-08-01T01:00:00.000Z"));
  assert.equal(overdue.inboxStatus, "disabled");
  assert.equal(owner.state, STATES.OVERDUE);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].eventType, "owner_overdue");
  assert.ok(!audits.some((entry) => entry.eventType === "gmail_inbox_poll_failed"));

  owner.state = STATES.ALERT;
  await sendTransitionEmails({ repo, env, owner, toState: STATES.ALERT, now: "2026-08-02T01:00:00.000Z", provider: { name: "capture", async send() { throw new Error("must not send"); } } });
});

test("operational health requires a fresh cron and healthy Gmail inbox poll", () => {
  const now = new Date("2026-08-11T15:00:00.000Z");
  const healthy = evaluateOperationalHealth({
    latestScheduled: {
      created_at: "2026-08-11T14:17:00.000Z",
      details_json: '{"inbox_status":"healthy"}',
    },
  }, now, true);
  assert.equal(healthy.ok, true);
  assert.deepEqual(healthy.checks, {
    worker_reachable: true,
    cron_fresh: true,
    gmail_inbound_healthy: true, deliveries_healthy: true, inbound_processing_healthy: true, mail_outbound_fresh: true,
  });

  const stale = evaluateOperationalHealth({
    latestScheduled: {
      created_at: "2026-08-11T12:17:00.000Z",
      details_json: '{"inbox_status":"healthy"}',
    },
  }, now, true);
  assert.equal(stale.ok, false);
  assert.equal(stale.checks.cron_fresh, false);

  const mailFailed = evaluateOperationalHealth({
    latestScheduled: {
      created_at: "2026-08-11T14:17:00.000Z",
      details_json: '{"inbox_status":"failed"}',
    },
  }, now, true);
  assert.equal(mailFailed.ok, false);
  assert.equal(mailFailed.checks.gmail_inbound_healthy, false);

  const malformed = evaluateOperationalHealth({
    latestScheduled: {
      created_at: "2026-08-11T14:17:00.000Z",
      details_json: "not-json",
    },
  }, now, true);
  assert.equal(malformed.ok, false);
});

test("PDF artifacts rebuild once when the generator version changes", async () => {
  let savedArtifacts = 0;
  const audits = [];
  const repo = {
    farewell: { async listFormalGroups() { return []; } },
    async getLatestAudit() { return { details_json: "{}" }; },
    async getOwner() { return { display_name: "示例用户" }; },
    async getPublicFarewell() { return { updated_at: "2026-09-02T00:00:00.000Z" }; },
    async saveDocumentArtifact() { savedArtifacts += 1; },
    async listPrivateItemsForPdfBackfill() { return { results: [] }; },
    async audit(eventType, details) { audits.push({ eventType, details }); },
  };

  const rebuilt = await ensureCurrentPdfArtifacts(repo, {PDF_FONTS:testFontAssets}, "2026-09-02T02:17:00.000Z");
  assert.equal(rebuilt.generator_version, PDF_GENERATOR_VERSION);
  assert.equal(rebuilt.public_generated, true);
  assert.equal(savedArtifacts, 1);
  assert.deepEqual(audits, [{ eventType: "pdf_artifacts_rebuilt", details: rebuilt }]);

  repo.getLatestAudit = async () => ({ details_json: JSON.stringify({ generator_version: PDF_GENERATOR_VERSION }) });
  const current = await ensureCurrentPdfArtifacts(repo, {}, "2026-09-02T03:17:00.000Z");
  assert.equal(current.reason, "current");
  assert.equal(savedArtifacts, 1);
});
