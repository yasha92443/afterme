// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { GmailMailProvider, isContactVerificationReplySubject, parseContactReplyCommand } from "../src/mail.js";
import { buildMailRehearsal } from "../src/rehearsal.js";
import {parseFont} from '../src/pdf-chinese-font.js';

const OAUTH_PATH = ".gmail-oauth.local.json";
const STATE_PATH = ".afterme-rehearsal.local.json";
const mode = process.argv[2] || "send";

const oauth = JSON.parse(await readFile(OAUTH_PATH, "utf8"));
const from = String(process.env.AFTERME_REHEARSAL_FROM || '').trim().toLowerCase();
const gmailSender = from.match(/^([^@\s]+)@gmail\.com$/);
if (!gmailSender) throw new Error('Set AFTERME_REHEARSAL_FROM to your authorized Gmail sender');
const env = {
  MAIL_PROVIDER: "gmail",
  FROM_EMAIL: from,
  GMAIL_CLIENT_ID: oauth.gmail_client_id,
  GMAIL_CLIENT_SECRET: oauth.gmail_client_secret,
  GMAIL_REFRESH_TOKEN: oauth.gmail_refresh_token,
};
const provider = new GmailMailProvider(env);

if (mode === "send") {
  const to = requireRehearsalAddress(process.env.AFTERME_REHEARSAL_EMAIL);
  const token = randomBytes(24).toString("base64url");
  const sentAt = new Date().toISOString();
  const chineseFont=parseFont(new Uint8Array(await readFile(new URL('../assets/fonts/afterme-song-sc.ttf',import.meta.url))));
  const messages = buildMailRehearsal({ to, from: env.FROM_EMAIL, token, now: sentAt,chineseFont });
  const results = [];
  for (const message of messages) {
    const result = await provider.send(message);
    results.push({ key: message.key, status: result.status, error: result.error || null });
    if (result.status !== "sent") break;
  }
  await writeFile(STATE_PATH, JSON.stringify({ to, token, sent_at: sentAt, results }, null, 2), "utf8");
  console.log(JSON.stringify({ ok: results.length === messages.length && results.every((item) => item.status === "sent"), to, results, next: "Reply to rehearsal email 3/5, then run: npm run rehearsal:verify-reply" }, null, 2));
} else if (mode === "verify-reply") {
  const state = JSON.parse(await readFile(STATE_PATH, "utf8"));
  const replyAddress = `${gmailSender[1]}+verify-${state.token}@gmail.com`;
  const messages = await provider.listInboundMessages({ maxResults: 20, query: `from:${state.to} newer_than:7d -from:me` });
  const senderMatch = (message) =>
    normalize(message.from) === normalize(state.to) &&
    new Date(message.receivedAt || 0).getTime() >= new Date(state.sent_at).getTime();
  const match = messages.find((message) => senderMatch(message) && (
    String(message.recipients || "").toLowerCase().includes(replyAddress.toLowerCase()) ||
    isContactVerificationReplySubject(message.subject)
  ));
  const parsed = match ? parseContactReplyCommand(match.body) : null;
  const candidates = messages.map((message) => ({
    received_at: message.receivedAt,
    recipient_has_rehearsal_token: String(message.recipients || "").toLowerCase().includes(replyAddress.toLowerCase()),
    sender_authenticated: Boolean(message.authenticationPassed),
    subject_is_rehearsal_reply: /AfterMe.*演练 3\/5/i.test(String(message.subject || "")),
  }));
  const result = {
    ok: Boolean(match && match.authenticationPassed && parsed),
    reply_found: Boolean(match),
    sender_matches: Boolean(match && normalize(match.from) === normalize(state.to)),
    sender_authenticated: Boolean(match?.authenticationPassed),
    command: parsed?.status || null,
    identification: match
      ? (String(match.recipients || "").toLowerCase().includes(replyAddress.toLowerCase()) ? "reply-token" : "authenticated-sender-and-subject")
      : null,
    candidate_count: candidates.length,
    candidates,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} else {
  throw new Error("Usage: node scripts/rehearse-mail.mjs [send|verify-reply]");
}

function requireRehearsalAddress(value) {
  const email = normalize(value);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Set AFTERME_REHEARSAL_EMAIL to the owner-controlled test mailbox");
  return email;
}

function normalize(value) { return String(value || "").trim().toLowerCase(); }
