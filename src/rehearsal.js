// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import { buildContactAlertMail, buildContactVerifyMail, buildPrivateReleaseMail, buildPublicReleaseMail } from "./mail-copy.js";
import { buildPrivateLetterPdf, buildPublicFarewellPdf } from "./pdf.js";

const REHEARSAL_NOTICE = `【AfterMe 安全演练】
这封测试邮件用于系统所有者验证合成场景。线上核验与内容释放记录保留当前状态。`;

export function buildMailRehearsal({ to, from, token, chineseFont, now = new Date().toISOString() }) {
  const ownerName = "示例用户";
  const contactName = "测试联系人";
  const recipientName = "测试收件人";
  const alert = buildContactAlertMail({ ownerName, contactName });
  const verify = buildContactVerifyMail({ ownerName, contactName });
  const privateMail = buildPrivateReleaseMail({ ownerName, recipientName });
  const publicMail = buildPublicReleaseMail({ ownerName, contactName });
  const withNotice = (text) => `${REHEARSAL_NOTICE}\n\n${text}`;
  const replyTo = gmailReplyAddress(from, token);
  const publicPdf = buildPublicFarewellPdf({
    chineseFont,
    ownerName,
    updatedAt: now,
    groups: [{
      display_title: "演练章节",
      title_updated_at: now,
      display_epigraph: "系统在约定的时刻行动，平日安静守候。\n-- AfterMe 演练",
      epigraph_updated_at: now,
      entries: [{ display_body: "这是合成场景中的公开遗言 PDF 演练正文。", body_updated_at: now }],
    }],
  });
  const privatePdf = buildPrivateLetterPdf({
    chineseFont,
    ownerName,
    recipientName,
    title: "演练私人信件",
    body: "这是合成场景中的私人信件 PDF 演练正文。",
    updatedAt: now,
  });

  return [
    {
      key: "owner-overdue",
      to,
      subject: "【AfterMe 演练 1/5】距上次签到已过 48\u00A0小时",
      text: withNotice("请尽快打开 AfterMe 管理页并签到。此阶段向本人发送签到提醒。"),
    },
    {
      key: "contact-alert",
      to,
      subject: `【AfterMe 演练 2/5】${alert.subject}`,
      text: withNotice(alert.text),
    },
    {
      key: "contact-verify",
      to,
      replyTo,
      subject: `【AfterMe 演练 3/5】${verify.subject}`,
      text: `${withNotice(verify.text)}\n\n【演练操作】请直接回复本邮件，并把“暂时联系不上本人”完整写在回复正文第一行。该回复用于验证 Gmail 收件和指令识别；线上确认记录保留当前状态。`,
    },
    {
      key: "private-pdf",
      to,
      subject: `【AfterMe 演练 4/5】${privateMail.subject}`,
      text: withNotice(privateMail.text),
      attachments: [{ filename: "afterme-rehearsal-private.pdf", contentType: "application/pdf", data: privatePdf }],
    },
    {
      key: "public-pdf",
      to,
      subject: `【AfterMe 演练 5/5】${publicMail.subject}`,
      text: withNotice(publicMail.text),
      attachments: [{ filename: "afterme-rehearsal-public.pdf", contentType: "application/pdf", data: publicPdf }],
    },
  ];
}

function gmailReplyAddress(from, token) {
  const match = String(from || "").trim().match(/^([^@]+)@gmail\.com$/i);
  if (!match) throw new Error("Rehearsal reply verification requires a Gmail FROM_EMAIL address");
  return `${match[1]}+verify-${token}@gmail.com`;
}
