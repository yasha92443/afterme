// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import assert from "node:assert/strict";
import { buildStoredPayload } from "../src/content.js";
import { STATES } from "../src/core.js";
import { runScheduledCheck } from "../src/worker.js";
import {readFileSync} from 'node:fs';
const rehearsalFont=readFileSync(new URL('../assets/fonts/afterme-song-sc.ttf',import.meta.url));

const start = new Date("2030-01-01T00:00:00.000Z");
const atHours = (hours, minutes = 0) => new Date(start.getTime() + hours * 3600_000 + minutes * 60_000);
const env = {
  PDF_FONTS:{async fetch(){return new Response(rehearsalFont);}},
  ADMIN_TOKEN: "isolated-rehearsal-key", CONTENT_ENCRYPTION_KEY: "isolated-content-key",
  BASE_URL: "https://isolated.afterme.invalid",
  FROM_EMAIL: "afterme-rehearsal@example.invalid",
  MAIL_PROVIDER: "dry-run",
  MAIL_INBOUND_ENABLED: "false",
  CONTACT_NOTIFICATIONS_ENABLED: "true",
  RELEASE_SUSPENDED: "false",
  MAX_DAILY_EMAILS: "20",
};

class IsolatedRepository {
  constructor({ encryptedPayload, start }) {
    this.owner = { id: 1, confirmation_round: 1, display_name: "示例用户", email: "owner@example.invalid", state: STATES.NORMAL, last_checkin_at: start, release_suspended: 0, release_ready_at: null };
    this.contacts = [1, 2, 3].map((id) => ({ id, name: `测试联系人${id}`, email: `contact${id}@example.invalid`, active: 1 }));
    this.item = { id: 1, title: "隔离演练私人信件", encrypted_payload: encryptedPayload, pdf_payload: null, recipient_name: "测试收件人", recipient_email: "recipient@example.invalid", created_at: start, released_at: null };
    this.publicFarewell = { id: 1, title: "公开遗言", status: "DRAFT", updated_at: start };
    this.publicGroups = [{ display_title: "隔离演练", title_updated_at: start, display_epigraph: "", epigraph_updated_at: null, entries: [{ display_body: "隔离演练公开正文", body_updated_at: start }] }];
    this.confirmedDeaths = 0;
    this.released = false;
    this.deliveries = [];
    this.audits = [];
    this.artifacts = new Map();
    this.farewell = { listFormalGroups: async () => this.publicGroups };
  }
  async getOwner() { return this.owner; }
  async getContact(id) { return this.contacts.find(c => c.id === id); }
  async updateOwnerState(state) { this.owner.state = state; }
  async audit(eventType, details, now) { this.audits.push({ eventType, details, now }); }
  async countConfirmedDeathConfirmations() { return this.confirmedDeaths; }
  async listActiveContacts() { return { results: this.contacts }; }
  async hasDelivery(key) { return this.deliveries.some((entry) => entry.dedupeKey === key && ["sent", "dry_run"].includes(entry.status)); }
  async countDeliveriesToday(date) { return this.deliveries.filter((entry) => entry.now?.startsWith(date) && ["sent", "dry_run"].includes(entry.status)).length; }
  async logDelivery(entry) { this.deliveries.push(entry); }
  async rotateContactToken() {}
  async resetReleaseGracePeriod(state) { this.owner.state = state; this.owner.release_ready_at = null; }
  async startReleaseGracePeriod(now) { this.owner.state = STATES.READY_TO_RELEASE; this.owner.release_ready_at = now; return this.owner; }
  async releasePrivateItems(now) { this.released = true; this.item.released_at = now; this.owner.state = STATES.PRIVATE_RELEASE; return true; }
  async listReleasedPrivateItemsForDelivery() { return { results: this.item.released_at ? [this.item] : [] }; }
  async updatePrivateItemPdf({ pdfPayload }) { this.item.pdf_payload = pdfPayload; }
  async autoPublishPublicFarewell(now) { if (this.publicFarewell.status === "PUBLIC_RELEASE") return false; this.publicFarewell.status = "PUBLIC_RELEASE"; this.publicFarewell.updated_at = now; return true; }
  async getPublicFarewell() { return this.publicFarewell; }
  async getDocumentArtifact(key) { return this.artifacts.get(key) || null; }
  async saveDocumentArtifact(artifact) { this.artifacts.set(artifact.key, { ...artifact, content_base64: artifact.contentBase64, mime_type: artifact.mimeType }); }
}

const encryptedPayload = await buildStoredPayload({
  body: { plaintext: "隔离演练私人信件正文" },
  env,
});
const repo = new IsolatedRepository({ encryptedPayload, start: start.toISOString() });
const captured = [];
const provider = {
  name: "capture",
  async send(message) {
    captured.push(message);
    return { status: "sent" };
  },
};
const step = async (hours, minutes = 0) => {
  const result = await runScheduledCheck(repo, env, atHours(hours, minutes), provider);
  return { at_hours: hours + minutes / 60, from: result.from, to: result.to };
};

const timeline = [];
timeline.push(await step(48));
timeline.push(await step(72));
timeline.push(await step(120));
assert.equal(repo.owner.state, STATES.VERIFY);
assert.equal(repo.released, false);
assert.equal(repo.publicFarewell.status, "DRAFT");

repo.confirmedDeaths = 3;
timeline.push(await step(120, 1));
assert.equal(repo.owner.state, STATES.READY_TO_RELEASE);
assert.equal(repo.released, false);
assert.equal(repo.publicFarewell.status, "DRAFT");

timeline.push(await step(191, 59));
assert.equal(repo.owner.state, STATES.READY_TO_RELEASE);
assert.equal(repo.released, false);

timeline.push(await step(192, 2));
assert.equal(repo.owner.state, STATES.PUBLIC_RELEASE);
assert.equal(repo.released, true);
assert.equal(repo.publicFarewell.status, "PUBLIC_RELEASE");

const eventCounts = Object.fromEntries([...new Set(repo.deliveries.map((entry) => entry.eventType))]
  .map((eventType) => [eventType, repo.deliveries.filter((entry) => entry.eventType === eventType && entry.status === "sent").length]));
assert.deepEqual(eventCounts, {
  owner_overdue: 1,
  contact_alert: 3,
  contact_verify: 3,
  private_letter_release: 1,
  public_farewell_release: 3,
});
assert.equal(captured.length, 11);
assert.equal(captured.filter((message) => message.attachments?.some((item) => item.contentType === "application/pdf")).length, 4);
assert.ok(captured.filter((message) => message.attachments?.length).every((message) =>
  message.attachments.every((attachment) => new TextDecoder().decode(attachment.data).startsWith("%PDF-1.7"))));

console.log(JSON.stringify({
  ok: true,
  isolated: true,
  timeline,
  event_counts: eventCounts,
  captured_messages: captured.length,
  pdf_attachments: 4,
  final_state: repo.owner.state,
  production_connections: 0,
}, null, 2));
