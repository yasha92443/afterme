// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
export const STATES = Object.freeze({
  NORMAL: "NORMAL",
  OVERDUE: "OVERDUE",
  ALERT: "ALERT",
  VERIFY: "VERIFY",
  READY_TO_RELEASE: "READY_TO_RELEASE",
  PRIVATE_RELEASE: "PRIVATE_RELEASE",
  PUBLIC_RELEASE: "PUBLIC_RELEASE",
  CLEANUP_ADVISORY: "CLEANUP_ADVISORY",
});

export const LIMITS = Object.freeze({
  LETTER_MAX_BYTES: 100 * 1024,
  MAX_DAILY_EMAILS: 20,
  OVERDUE_HOURS: 48,
  ALERT_HOURS: 72,
  VERIFY_HOURS: 120,
  REQUIRED_CONFIRMATIONS: 3,
  RELEASE_GRACE_HOURS: 72,
});

const RELEASE_STATES = new Set([
  STATES.READY_TO_RELEASE,
  STATES.PRIVATE_RELEASE,
  STATES.PUBLIC_RELEASE,
  STATES.CLEANUP_ADVISORY,
]);

export function isoNow(date = new Date()) {
  return date.toISOString();
}

export function hoursSince(isoDate, now = new Date()) {
  const then = new Date(isoDate).getTime();
  if (!Number.isFinite(then)) {
    throw new Error(`Invalid ISO date: ${isoDate}`);
  }
  return Math.max(0, (now.getTime() - then) / 36e5);
}

export function calculateState({ lastCheckinAt, currentState = STATES.NORMAL, rules, paused = false }, now = new Date()) {
  if (paused) return STATES.NORMAL;
  if (RELEASE_STATES.has(currentState)) {
    return currentState;
  }


  const elapsed = hoursSince(lastCheckinAt, now);
  if (elapsed >= (rules?.verify_hours ?? LIMITS.VERIFY_HOURS)) return STATES.VERIFY;
  if (elapsed >= (rules?.alert_hours ?? LIMITS.ALERT_HOURS)) return STATES.ALERT;
  if (elapsed >= (rules?.overdue_hours ?? LIMITS.OVERDUE_HOURS)) return STATES.OVERDUE;
  return STATES.NORMAL;
}

export function resetStateForCheckin(now = new Date()) {
  return {
    state: STATES.NORMAL,
    lastCheckinAt: isoNow(now),
  };
}

export function isQualifyingConfirmation(status) {
  return status === "unable_to_reach" || status === "confirmed_death";
}

export function canReleasePrivate({ state, releaseSuspended = false, confirmedDeaths = 0 }) {
  return (
    !releaseSuspended &&
    confirmedDeaths >= LIMITS.REQUIRED_CONFIRMATIONS &&
    (state === STATES.READY_TO_RELEASE || state === STATES.PRIVATE_RELEASE || state === STATES.PUBLIC_RELEASE)
  );
}

export function isReleaseGraceComplete(releaseReadyAt, now = new Date(), graceHours = LIMITS.RELEASE_GRACE_HOURS) {
  return Boolean(releaseReadyAt) && hoursSince(releaseReadyAt, now) >= graceHours;
}

export function validateStoredPayload(payload, maxBytes = LIMITS.LETTER_MAX_BYTES) {
  if (typeof payload !== "string" || payload.length === 0) {
    return { ok: false, error: "payload is required" };
  }
  const bytes = new TextEncoder().encode(payload).byteLength;
  if (bytes > maxBytes) {
    return { ok: false, error: `payload exceeds ${maxBytes} bytes`, bytes };
  }
  return { ok: true, bytes };
}

export const validateEncryptedPayload = validateStoredPayload;

export function remainingDailyEmailCapacity(sentToday, maxDaily = LIMITS.MAX_DAILY_EMAILS) {
  return Math.max(0, maxDaily - sentToday);
}

export function shouldSendTransitionEmail({ fromState, toState }) {
  return fromState !== toState && [STATES.OVERDUE, STATES.ALERT, STATES.VERIFY].includes(toState);
}

export function estimateOneYearUsage({ contacts = 3, checkins = 122, letters = 20, tasks = 20 } = {}) {
  const cronRuns = 365;
  const setupWrites = 1 + contacts + letters + tasks;
  const checkinWrites = checkins * 2;
  const cronReads = cronRuns * (1 + contacts);
  const transitionWrites = 12;
  const releaseWrites = letters + tasks + 10;

  return {
    rowsRead: cronReads + checkins + 200,
    rowsWritten: setupWrites + checkinWrites + transitionWrites + releaseWrites,
    storageBytesApprox: (letters + tasks) * LIMITS.LETTER_MAX_BYTES + contacts * 2048 + 1024 * 1024,
  };
}



