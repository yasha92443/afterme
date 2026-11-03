// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import { REPLY_COMMANDS, SYSTEM_MAIL } from './i18n.js';
import { defaultRules } from './settings.js';
function inline(value, fallback) {
  const text = String(value || "").replace(/[\r\n]+/g, " ").trim();
  return text || fallback;
}

export const MAIL_TEMPLATE_KEYS = Object.freeze(["contact_alert", "contact_verify", "public_release", "private_release"]);

export const DEFAULT_MAIL_TEMPLATES = Object.freeze({
  contact_alert: Object.freeze({
    label: "联系人提醒",
    subject_template: "请尝试联系{本人姓名}",
    body_template: `{联系人姓名}，您好。

您收到这封邮件，是因为{本人姓名}预先将您设为失联联系人。

{本人姓名}上次签到距今 {联系人提醒小时}\u00A0小时。请通过电话、微信或者平时使用的其他方式尝试联系他。

请在可信联系人之间私下沟通已经核实的信息。

本轮核验持续时，系统将在 {核验等待小时}\u00A0小时后再次联系您，请届时提交您掌握的情况。

此邮件由{本人姓名}预先设置的 AfterMe 系统自动发送。`,
  }),
  contact_verify: Object.freeze({
    label: "联系人核验",
    subject_template: "关于{本人姓名}：请提交您掌握的情况",
    body_template: `{联系人姓名}，您好。

您收到这封邮件，是因为{本人姓名}预先将您设为失联联系人。

{本人姓名}上次签到距今 {核验小时}\u00A0小时。请先通过电话、微信或者其他正常渠道尝试联系他，然后直接回复本邮件，并在正文第一行完整填写下面三句话中的一句：

暂时联系不上本人
我已从可靠来源确认本人死亡
我已确认本人安全，或者这是一次误报

请原样粘贴一条指令，单独置于正文第一行，并使用您登记的邮箱回复。

私人信件：需要 {私人确认人数} 名指定联系人确认死亡，随后缓冲 {私人缓冲小时} 小时。公开遗言：需要 {公开确认人数} 名指定联系人确认死亡，随后缓冲 {公开缓冲小时} 小时。两个通道独立推进；本人签到或有效误报会取消本轮。

此邮件由{本人姓名}预先设置的 AfterMe 系统自动发送。`,
  }),
  public_release: Object.freeze({
    label: "公开遗言送达",
    subject_template: "{本人姓名}的公开遗言",
    body_template: `{联系人姓名}，您好。

按照{本人姓名}预先设置的安排，系统现已释放他的公开遗言。

公开遗言已作为 PDF 附件随本邮件发送，下载后即可离线阅读。

您可以自行决定是否阅读或转发。此邮件由{本人姓名}预先设置的 AfterMe 系统自动发送。`,
  }),
  private_release: Object.freeze({
    label: "私人信件送达",
    subject_template: "{本人姓名}留给您的一封信",
    body_template: `{收件人姓名}，您好。

{本人姓名}预先通过他的身后事务系统为您留下了一封私人信件。按照{本人姓名}预先设置的安排，系统现在将这封信交给您。

您可以自行决定阅读、回复、保存或删除这封邮件。

信件正文已作为 PDF 附件随本邮件发送，下载后即可离线阅读。

这封私人信件仅供指定收件人阅读与保管。`,
  }),
});

export function mergeMailTemplates(rows = []) {
  const saved = new Map((rows?.results || rows || []).map((row) => [row.template_key, row]));
  return Object.fromEntries(MAIL_TEMPLATE_KEYS.map((key) => [key, {
    key,
    ...DEFAULT_MAIL_TEMPLATES[key],
    ...(saved.get(key) || {}),
    customized: saved.has(key),
  }]));
}

export function validateMailTemplate({ key, subjectTemplate, bodyTemplate }) {
  if (!MAIL_TEMPLATE_KEYS.includes(key)) return { ok: false, error: "未知邮件类型。" };
  if (!String(subjectTemplate || "").trim()) return { ok: false, error: "请填写邮件标题。" };
  if (!String(bodyTemplate || "").trim()) return { ok: false, error: "请填写邮件正文。" };
  if (String(subjectTemplate).length > 200) return { ok: false, error: "邮件标题上限为 200 个字符。" };
  if (String(bodyTemplate).length > 10000) return { ok: false, error: "邮件正文上限为 10000 个字符。" };
  const allowed = new Set(["本人姓名", key === "private_release" ? "收件人姓名" : "联系人姓名",'owner_name','contact_name','recipient_name','overdue_hours','alert_hours','verify_hours','private_quorum','public_quorum','private_grace_hours','public_grace_hours','reply_commands','本人提醒小时','联系人提醒小时','核验小时','核验等待小时','私人确认人数','公开确认人数','私人缓冲小时','公开缓冲小时']);
  const placeholders = [...`${subjectTemplate}\n${bodyTemplate}`.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
  const unknown = placeholders.find((placeholder) => !allowed.has(placeholder));
  return unknown ? { ok: false, error: `不支持的占位符：{${unknown}}` } : { ok: true };
}

function renderMailTemplate(template, values) {
  const replace = (value) => String(value || "").replace(/\{([^{}]+)\}/g, (match, key) => values[key] ?? match);
  return {
    subject: inline(replace(template.subject_template), "AfterMe 通知"),
    text: replace(template.body_template),
  };
}

export function buildContactAlertMail({ ownerName, contactName, template = DEFAULT_MAIL_TEMPLATES.contact_alert, rules=defaultRules(), locale='zh' }) {
  const owner = inline(ownerName, "本人");
  const contact = inline(contactName, "联系人");
  return dynamicMail('contact_alert',template,{ 本人姓名: owner, 联系人姓名: contact,owner_name:owner,contact_name:contact },rules,locale);
}

export function buildContactVerifyMail({ ownerName, contactName, template = DEFAULT_MAIL_TEMPLATES.contact_verify, rules=defaultRules(), locale='zh' }) {
  const owner = inline(ownerName, "本人");
  const contact = inline(contactName, "联系人");
  return dynamicMail('contact_verify',template,{ 本人姓名: owner, 联系人姓名: contact,owner_name:owner,contact_name:contact },rules,locale);
}

export function buildPrivateReleaseMail({ ownerName, recipientName, template = DEFAULT_MAIL_TEMPLATES.private_release, rules=defaultRules(), locale='zh' }) {
  const owner = inline(ownerName, "本人");
  const recipient = inline(recipientName, "收件人");
  return dynamicMail('private_release',template,{ 本人姓名: owner, 收件人姓名: recipient,owner_name:owner,recipient_name:recipient },rules,locale);
}

export function buildPublicReleaseMail({ ownerName, contactName, template = DEFAULT_MAIL_TEMPLATES.public_release, rules=defaultRules(), locale='zh' }) {
  const owner = inline(ownerName, "本人");
  const contact = inline(contactName, "联系人");
  return dynamicMail('public_release',template,{ 本人姓名: owner, 联系人姓名: contact,owner_name:owner,contact_name:contact },rules,locale);
}
function dynamicMail(key,template,names,rules,locale) {
  const values={...names,overdue_hours:rules.overdue_hours,alert_hours:rules.alert_hours,verify_hours:rules.verify_hours,private_quorum:rules.private.quorum,public_quorum:rules.public.quorum,private_grace_hours:rules.private.grace_hours,public_grace_hours:rules.public.grace_hours,reply_commands:(REPLY_COMMANDS[locale]||REPLY_COMMANDS.zh).join('\n')};
  Object.assign(values,{'本人提醒小时':values.overdue_hours,'联系人提醒小时':values.alert_hours,'核验小时':values.verify_hours,'核验等待小时':rules.verify_hours-rules.alert_hours,'私人确认人数':values.private_quorum,'公开确认人数':values.public_quorum,'私人缓冲小时':values.private_grace_hours,'公开缓冲小时':values.public_grace_hours});
  if(template===DEFAULT_MAIL_TEMPLATES[key]||template.customized===false) {
    if(SYSTEM_MAIL[locale])template=SYSTEM_MAIL[locale][key];
    else {
      let body=DEFAULT_MAIL_TEMPLATES[key].body_template;
      if(key==='contact_alert')body=body.replace('72\u00a0小时','{联系人提醒小时}\u00a0小时').replace('48\u00a0小时',String(rules.verify_hours-rules.alert_hours)+'\u00a0小时');
      if(key==='contact_verify')body=body.replace('120\u00a0小时','{核验小时}\u00a0小时').replace(/只有三名不同联系人[\s\S]*?感谢您的配合。/,`私人信件：需要 {私人确认人数} 名指定联系人确认死亡，随后缓冲 {私人缓冲小时} 小时。公开遗言：需要 {公开确认人数} 名指定联系人确认死亡，随后缓冲 {公开缓冲小时} 小时。两个通道独立推进；本人签到或有效误报会取消本轮。`);
      body=body.replace('PDF 使用黑底白字排版，下载后即可离线阅读。','下载 PDF 后即可离线阅读。');
      template={...DEFAULT_MAIL_TEMPLATES[key],body_template:body};
    }
  }
  return renderMailTemplate(template,values);
}
