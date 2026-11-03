// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from "node:test";
import assert from "node:assert/strict";
import { homePage } from "../src/ui.js";
import { mergeMailTemplates } from "../src/mail-copy.js";
import {farewellEditorMarkup} from '../src/farewell-editor-ui.js';

const emptyEditor = {
  document: { status: "DRAFT", updated_at: "2026-07-10T00:00:00.000Z" },
  draft_groups: [],
  formal_groups: [],
  trashed_groups: [],
  trashed_entries: [],
  pending_count: 0,
  draft_updated_at: null,
};

function base(overrides = {}) {
  return {
    owner: { state: "NORMAL", last_checkin_at: "2026-07-09T00:00:00.000Z", release_suspended: 0 },
    contacts: { results: [] },
    recipients: { results: [] },
    confirmations: { results: [] },
    items: { results: [] },
    deliveries: { results: [] },
    publicFarewell: null,
    publicFarewellItems: { results: [] },
    farewellEditor: emptyEditor,
    legalWill: null,
    mailTemplates: mergeMailTemplates(),
    ...overrides,
  };
}

test("admin page shows legal will, export, and the directory farewell editor", async () => {
  const response = homePage(base({
    contacts: { results: [{ id: 1, name: "朋友A", email: "friend@example.com", role: "contact", priority: 1 }] },
    recipients: { results: [{ id: 8, name: "收件人A", email: "recipient@example.com", note: "朋友", active: 1 }] },
    legalWill: { status: "drafted", location: "书桌抽屉", custodian: "本人", updated_at: "2026-07-09T00:00:00.000Z" },
  }));
  const html = await response.text();
  assert.match(html, /法律遗嘱位置/);
  assert.match(html, /书桌抽屉/);
  assert.match(html, /action="\/api\/export"/);
  assert.match(html, /核验联系人管理/);
  assert.match(html, /私人信件收件人/);
  assert.match(html, /name="recipient_id" required/);
  assert.match(html, /自动释放保护/);
  assert.match(html, /id="public-farewell-v2"/);
  assert.match(html, /href="\/admin#farewell"/);
  assert.match(html, /打开公开遗言编辑器/);
  assert.match(html, /实际邮件文案/);
  assert.match(html, /name="subject_template"/);
  assert.match(html, /name="body_template"/);
  assert.match(html, /\{联系人姓名\}/);
  assert.doesNotMatch(html, /action="\/api\/public-farewell-v2\/groups"/);
  assert.match(html, /action="\/api\/pdf\/rebuild"/);
  assert.match(html, /重建全部 PDF/);
  assert.doesNotMatch(html, /公开页面标题/);
  assert.doesNotMatch(html, /action="\/api\/public-farewell\/title"/);
});

test("private letters use recipient and body only and can be edited after creation", async () => {
  const response = homePage(base({
    recipients: { results: [{ id: 8, name: "收件人A", email: "recipient@example.com", note: "朋友", active: 1 }] },
    privateItems: [{
      id: 12,
      recipient_id: 8,
      recipient_name: "收件人A",
      recipient_email: "recipient@example.com",
      access_mode: "link",
      plaintext: "原来的正文",
      created_at: "2026-08-30T00:00:00.000Z",
      updated_at: "2026-08-31T00:00:00.000Z",
      released_at: null,
    }],
  }));
  const html = await response.text();
  assert.match(html, /写给 收件人A/);
  assert.match(html, /action="\/api\/items\/12"/);
  assert.match(html, /<form class="private-pdf-preview-form" method="post" action="\/api\/items\/12\/pdf">/);
  assert.match(html, /在当前标签页预览 PDF/);
  assert.doesNotMatch(html, /formtarget="_blank"/);
  assert.match(html, /<textarea name="plaintext" required>原来的正文<\/textarea>/);
  const createForm = html.match(/<form method="post" action="\/api\/items" data-private-item-form>[\s\S]*?<\/form>/)?.[0] || "";
  assert.match(createForm, /name="recipient_id" required/);
  assert.match(createForm, /name="plaintext" required/);
  assert.doesNotMatch(createForm, /name="title"/);
});

test("admin page requires a fresh checkin before resuming release", async () => {
  const response = homePage(base({
    owner: { state: "VERIFY", last_checkin_at: "2026-07-09T00:00:00.000Z", release_suspended: 1 },
  }));
  const html = await response.text();
  assert.match(html, /自动释放已暂停/);
  assert.match(html, /重新签到并解除暂停/);
  assert.match(html, /name="resume_release" value="1"/);
});

test("public farewell editor uses explicit groups and one current entry editor", async () => {
  const group = {
    id: 1,
    title: "总则",
    draft_title: "总则",
    display_title: "总则",
    epigraph: "认识你自己。\n——德尔斐箴言",
    draft_epigraph: "认识你自己。\n——德尔斐箴言",
    display_epigraph: "认识你自己。\n——德尔斐箴言",
    epigraph_updated_at: "2026-07-10T00:00:00.000Z",
    title_updated_at: "2026-07-10T00:00:00.000Z",
    entries: [
      {
        id: 7,
        group_id: 1,
        draft_group_id: 1,
        body: "第一条。",
        draft_body: "第一条。",
        display_body: "第一条。",
        is_public: 1,
        draft_is_public: 1,
        body_updated_at: "2026-07-10T00:00:00.000Z",
        draft_updated_at: "2026-07-10T00:00:00.000Z",
      },
      {
        id: 8,
        group_id: 1,
        draft_group_id: 1,
        body: "第二条。",
        draft_body: "第二条。",
        display_body: "第二条。",
        is_public: 1,
        draft_is_public: 1,
        body_updated_at: "2026-07-09T00:00:00.000Z",
        draft_updated_at: "2026-07-09T00:00:00.000Z",
      },
    ],
  };
  const html = farewellEditorMarkup({
    state: {
      ...emptyEditor,
      draft_groups: [group],
      formal_groups: [group],
      draft_updated_at: "2026-07-10T00:00:00.000Z",
    },
  });
  assert.match(html, /01 · 总则/);
  assert.match(html, /2 条/);
  assert.match(html, /data-entry-select="7"/);
  assert.match(html, /data-entry-select="8"/);
  assert.match(html, /章首题辞/);
  assert.match(html, /name="epigraph"/);
  assert.match(html, /认识你自己/);
  assert.match(html, /移动到分组/);
  assert.match(html, /置顶/);
  assert.match(html, /置底/);
  assert.match(html, /本条正文最后更新：2026-07-10 08:00 \(UTC\+8\)/);
  assert.doesNotMatch(html, /归属标题/);
  assert.doesNotMatch(html, /显示顺序/);
});

test("admin page shows the release grace period before content can be released", async () => {
  const response = homePage(base({
    owner: { state: "READY_TO_RELEASE", last_checkin_at: "2026-07-09T00:00:00.000Z", release_suspended: 0, release_ready_at: "2026-07-10T00:00:00.000Z" },
  }));
  const html = await response.text();
  assert.match(html, /仍在 72 小时缓冲期/);
  assert.match(html, /最早释放：2026-07-13 08:00 \(UTC\+8\)/);
});


test("admin page explains a live state newer than the stored cron state", async () => {
  const response = homePage(base({
    owner: { state: "OVERDUE", stored_state: "NORMAL", last_checkin_at: "2026-07-30T00:00:00.000Z", release_suspended: 0 },
  }));
  const html = await response.text();
  assert.match(html, /等待本人签到/);
  assert.match(html, /按最后签到时间实时计算/);
  assert.match(html, /数据库上一状态为 NORMAL/);
});

test("admin page makes temporary owner-only mail and operational failures explicit", async () => {
  const response = homePage(base({
    owner: { state: "NORMAL", last_checkin_at: "2026-08-08T00:00:00.000Z", release_suspended: 1 },
    mailProvider: "gmail",
    mailInboundEnabled: false,
    contactNotificationsEnabled: false,
    releaseLockedByConfig: true,
    operationalHealth: {
      latestScheduled: { created_at: new Date().toISOString(), details_json: '{"inbox_status":"disabled"}' },
      maxCronGapHours: 34,
      latestDelivery: { status: "failed", last_error: "Token has been expired or revoked.", created_at: "2026-08-05T05:17:39.161Z" },
      latestSuccessfulDelivery: { status: "sent", created_at: "2026-07-18T18:17:17.453Z" },
    },
  }));
  const html = await response.text();
  assert.match(html, /临时邮件模式/);
  assert.match(html, /只允许向本人发送 48 小时签到提醒/);
  assert.match(html, /邮件回复核验：已关闭；联系人通知：已关闭/);
  assert.match(html, /最长约 34\.0 小时/);
  assert.match(html, /Token has been expired or revoked/);
  assert.match(html, /自动释放已由部署配置暂停/);
  assert.match(html, /部署配置已强制冻结自动释放/);
});
