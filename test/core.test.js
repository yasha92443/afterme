// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from "node:test";
import assert from "node:assert/strict";
import {
  STATES,
  LIMITS,
  calculateState,
  canReleasePrivate,
  isReleaseGraceComplete,
  estimateOneYearUsage,
  resetStateForCheckin,
  validateEncryptedPayload,
} from "../src/core.js";
import { sendGuardedMail } from "../src/mail.js";

test("state machine only reminds owner at 48h", () => {
  const now = new Date("2026-07-09T12:00:00.000Z");
  const lastCheckinAt = "2026-07-07T11:59:00.000Z";
  assert.equal(calculateState({ lastCheckinAt }, now), STATES.OVERDUE);
});

test("state machine alerts contacts at 72h", () => {
  const now = new Date("2026-07-09T12:00:00.000Z");
  const lastCheckinAt = "2026-07-06T11:59:00.000Z";
  assert.equal(calculateState({ lastCheckinAt }, now), STATES.ALERT);
});

test("state machine enters verify after 5 days", () => {
  const now = new Date("2026-07-09T12:00:00.000Z");
  const lastCheckinAt = "2026-07-04T11:59:00.000Z";
  assert.equal(calculateState({ lastCheckinAt }, now), STATES.VERIFY);
});

test("checkin resets state before release", () => {
  const now = new Date("2026-07-09T12:00:00.000Z");
  assert.deepEqual(resetStateForCheckin(now), {
    state: STATES.NORMAL,
    lastCheckinAt: "2026-07-09T12:00:00.000Z",
  });
});

test("unreachable confirmations do not change the timed absence state", () => {
  const now = new Date("2026-07-09T12:00:00.000Z");
  const lastCheckinAt = "2026-07-04T11:59:00.000Z";
  assert.equal(calculateState({ lastCheckinAt, currentState: STATES.VERIFY, qualifyingConfirmations: 3 }, now), STATES.VERIFY);
});

test("private release requires ready state, three death confirmations, and no suspension", () => {
  assert.equal(canReleasePrivate({ state: STATES.READY_TO_RELEASE, confirmedDeaths: 3 }), true);
  assert.equal(canReleasePrivate({ state: STATES.PRIVATE_RELEASE, confirmedDeaths: 3 }), true);
  assert.equal(canReleasePrivate({ state: STATES.VERIFY, confirmedDeaths: 3 }), false);
  assert.equal(canReleasePrivate({ state: STATES.READY_TO_RELEASE, confirmedDeaths: 2 }), false);
  assert.equal(canReleasePrivate({ state: STATES.READY_TO_RELEASE, confirmedDeaths: 3, releaseSuspended: true }), false);
});

test("release grace period lasts 72 hours", () => {
  const readyAt = "2026-07-09T12:00:00.000Z";
  assert.equal(isReleaseGraceComplete(readyAt, new Date("2026-07-12T11:59:00.000Z")), false);
  assert.equal(isReleaseGraceComplete(readyAt, new Date("2026-07-12T12:00:00.000Z")), true);
});

test("encrypted payload is capped at 100KB", () => {
  assert.equal(validateEncryptedPayload("x".repeat(LIMITS.LETTER_MAX_BYTES)).ok, true);
  const tooLarge = validateEncryptedPayload("x".repeat(LIMITS.LETTER_MAX_BYTES + 1));
  assert.equal(tooLarge.ok, false);
});

test("guarded mail dedupes and caps daily sends", async () => {
  const deliveries = [];
  const repo = {
    async hasDelivery(key) { return deliveries.some((item) => item.dedupeKey === key); },
    async countDeliveriesToday() { return deliveries.filter((item) => item.status === "sent" || item.status === "dry_run").length; },
    async logDelivery(entry) { deliveries.push(entry); },
  };
  const provider = { name: "test", async send() { return { status: "sent" }; } };
  const env = { MAX_DAILY_EMAILS: "1" };
  const base = { repo, provider, env, eventType: "test", to: "a@example.com", subject: "s", text: "t", now: "2026-07-09T00:00:00.000Z" };

  assert.equal((await sendGuardedMail({ ...base, dedupeKey: "a" })).status, "sent");
  assert.equal((await sendGuardedMail({ ...base, dedupeKey: "a" })).status, "skipped");
  assert.equal((await sendGuardedMail({ ...base, dedupeKey: "b" })).reason, "daily-cap");
});

test("one-year personal usage remains far below Cloudflare free limits", () => {
  const usage = estimateOneYearUsage({ contacts: 3, checkins: 122, letters: 20, tasks: 20 });
  assert.ok(usage.rowsRead < 5_000_000);
  assert.ok(usage.rowsWritten < 100_000);
  assert.ok(usage.storageBytesApprox < 5 * 1024 * 1024 * 1024);
});




test("failed mail is logged and retried until one delivery succeeds", async () => {
  const deliveries = new Map();
  let sendCalls = 0;
  const repo = {
    async hasDelivery(key) { return ["sent", "dry_run"].includes(deliveries.get(key)?.status); },
    async countDeliveriesToday() { return 0; },
    async logDelivery(entry) { deliveries.set(entry.dedupeKey, entry); },
  };
  const provider = {
    name: "test",
    async send() {
      sendCalls += 1;
      if (sendCalls === 1) return { status: "failed", error: "provider rejected before acceptance" };
      return { status: "sent" };
    },
  };
  const input = {
    repo,
    provider,
    env: { MAX_DAILY_EMAILS: "20" },
    eventType: "owner_overdue",
    to: "owner@example.com",
    subject: "提醒",
    text: "签到",
    dedupeKey: "retry-me",
    now: "2026-08-01T00:00:00.000Z",
  };

  assert.equal((await sendGuardedMail(input)).status, "failed");
  assert.equal(deliveries.get("retry-me").status, "failed");
  assert.equal((await sendGuardedMail({ ...input, now: "2026-08-01T01:00:00.000Z" })).status, "sent");
  assert.equal((await sendGuardedMail({ ...input, now: "2026-08-01T02:00:00.000Z" })).reason, "dedupe");
  assert.equal(sendCalls, 2);
});
