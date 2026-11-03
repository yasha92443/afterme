// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from "node:test";
import assert from "node:assert/strict";
import { buildContactAlertMail, buildContactVerifyMail, buildPrivateReleaseMail, mergeMailTemplates, validateMailTemplate } from "../src/mail-copy.js";

test("approved contact alert copy is complete and personalized", () => {
  const message = buildContactAlertMail({ ownerName: "示例用户", contactName: "测试联系人" });
  assert.equal(message.subject, "请尝试联系示例用户");
  assert.match(message.text, /^测试联系人，您好。/);
  assert.match(message.text, /上次签到距今 72\u00A0小时/);
  assert.match(message.text, /系统将在 48\u00A0小时后再次联系您/);
  assert.match(message.text, /AfterMe 系统自动发送/);
});

test("verification copy uses an email reply instead of an inaccessible web link", () => {
  const message = buildContactVerifyMail({ ownerName: "示例用户", contactName: "测试联系人" });
  assert.equal(message.subject, "关于示例用户：请提交您掌握的情况");
  assert.match(message.text, /上次签到距今 120\u00A0小时/);
  assert.match(message.text, /直接回复本邮件/);
  assert.match(message.text, /暂时联系不上本人/);
  assert.match(message.text, /我已从可靠来源确认本人死亡/);
  assert.match(message.text, /我已确认本人安全，或者这是一次误报/);
  assert.match(message.text, /需要 3 名指定联系人确认死亡/);
  assert.match(message.text, /随后缓冲 72 小时/);
  assert.doesNotMatch(message.text, /https?:\/\//);
});

test("private release copy points to the PDF attachment and no web link", () => {
  const message = buildPrivateReleaseMail({
    ownerName: "示例用户",
    recipientName: "收件人",
  });
  assert.equal(message.subject, "示例用户留给您的一封信");
  assert.match(message.text, /^收件人，您好。/);
  assert.match(message.text, /可以自行决定/);
  assert.match(message.text, /阅读、回复、保存或删除/);
  assert.match(message.text, /PDF 附件/);
  assert.doesNotMatch(message.text, /https?:\/\//);
});

test("saved mail templates replace placeholders in subject and body", () => {
  const templates = mergeMailTemplates([{ template_key: "contact_alert", subject_template: "请找一下{本人姓名}", body_template: "{联系人姓名}：请联系{本人姓名}。", updated_at: "2026-08-13T00:00:00.000Z" }]);
  const message = buildContactAlertMail({ ownerName: "示例用户", contactName: "朋友", template: templates.contact_alert });
  assert.deepEqual(message, { subject: "请找一下示例用户", text: "朋友：请联系示例用户。" });
  assert.equal(templates.contact_alert.customized, true);
  assert.equal(templates.contact_verify.customized, false);
});

test("mail template validation rejects unknown placeholders", () => {
  assert.deepEqual(validateMailTemplate({ key: "contact_alert", subjectTemplate: "通知{陌生字段}", bodyTemplate: "正文" }), {
    ok: false,
    error: "不支持的占位符：{陌生字段}",
  });
  assert.deepEqual(validateMailTemplate({ key: "private_release", subjectTemplate: "{本人姓名}的信", bodyTemplate: "给{收件人姓名}" }), { ok: true });
});
