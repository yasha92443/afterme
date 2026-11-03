// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGmailRawMessage,
  createMailProvider,
  findContactReplyToken,
  isContactVerificationReplySubject,
  parseContactReplyCommand,
  parseGmailApiMessage,
} from "../src/mail.js";

test("gmail provider fails closed when OAuth secrets are missing", async () => {
  const provider = createMailProvider({ MAIL_PROVIDER: "gmail", FROM_EMAIL: "afterme.fixture@gmail.com" });
  assert.equal(provider.name, "gmail");
  const result = await provider.send({ to: "recipient@example.com", subject: "测试", text: "body" });
  assert.equal(result.status, "failed");
  assert.match(result.error, /missing/);
});

test("verification subject supports authenticated sender fallback", () => {
  assert.equal(isContactVerificationReplySubject("Re: 关于示例用户：请提交您掌握的情况"), true);
  assert.equal(isContactVerificationReplySubject("普通邮件"), false);
});

test("gmail raw message preserves Chinese subject and Reply-To", () => {
  const subject = "关于示例用户：请提交您掌握的情况";
  const raw = buildGmailRawMessage({
    from: "afterme.fixture@gmail.com",
    to: "recipient@example.com",
    replyTo: "afterme.fixture+verify-token12345678901234567890@gmail.com",
    subject,
    text: "中文正文",
  });
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const header = decoded.match(/^Subject: =\?UTF-8\?B\?([^?]+)\?=\r?$/m);
  assert.ok(header, decoded);
  assert.equal(Buffer.from(header[1], "base64").toString("utf8"), subject);
  assert.match(decoded, /^Reply-To: afterme\.fixture\+verify-token12345678901234567890@gmail\.com\r?$/m);
  assert.match(decoded, /中文正文/);
});

test("gmail parser extracts authenticated contact reply", () => {
  const token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
  const parsed = parseGmailApiMessage({
    id: "gmail-1",
    threadId: "thread-1",
    internalDate: "1784707200000",
    payload: {
      headers: [
        { name: "From", value: "联系人 <contact@example.com>" },
        { name: "To", value: `afterme.fixture+verify-${token}@gmail.com` },
        { name: "Subject", value: "Re: 关于示例用户" },
        { name: "Authentication-Results", value: "mx.google.com; dmarc=pass header.from=example.com; dkim=pass header.i=@example.com; spf=pass" },
      ],
      mimeType: "text/plain",
      body: { data: Buffer.from("我已从可靠来源确认本人死亡\n\n> 原邮件", "utf8").toString("base64url") },
    },
  });
  assert.equal(parsed.from, "contact@example.com");
  assert.equal(parsed.authenticationPassed, true);
  assert.equal(findContactReplyToken(parsed.recipients), token);
  assert.deepEqual(parseContactReplyCommand(parsed.body), {
    status: "confirmed_death",
    command: "我已从可靠来源确认本人死亡",
  });
});

test("contact reply parser rejects paraphrases", () => {
  assert.equal(parseContactReplyCommand("我觉得他可能去世了"), null);
});
