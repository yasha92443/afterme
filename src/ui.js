// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import { farewellEditorStyles } from "./farewell-editor-ui.js";
import { parseEpigraph } from "./epigraph.js";
import { adminEnhancementsMarkup } from './admin-ui.js';
import { readingVersionInfo } from './reading-metadata.js';
export function layout({ title, body, pageClass = "",locale='zh',bare=false }) {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  body = body.replace(/<script\b(?![^>]*\bnonce=)([^>]*)>/g,`<script nonce="${nonce}"$1>`);
  return new Response(`<!doctype html>
<html lang="${['zh','en','ru'].includes(locale)?locale:'zh'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${bare?'':`<style>
    :root {
      color-scheme: dark;
      --bg: #0a0a0a;
      --ink: #f1f1ee;
      --muted: #a8a8a3;
      --line: #343434;
      --panel: #151515;
      --accent: #f4f4f0;
      --danger: #d4d4d0;
      --on-accent: #0a0a0a;
      --field: #0d0d0d;
      --inset: #0b0b0b;
      --secondary: #2b2b2b;
      --secondary-line: var(--secondary);
      --selected: #242424;
      --epigraph: #d2d2ce;
      --status-normal: #a1d8bd;
      --status-alert: #f0c387;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; scroll-padding-top: var(--admin-nav-height, 88px); }
    button, .admin-nav a, .reader-tools a { min-height: 44px; }
    button:disabled { opacity: .55; cursor: wait; }
    .admin-nav { display: flex; gap: 8px; flex-wrap: wrap; position: sticky; top: 0; z-index: 10; padding: 10px 0; background: var(--bg); border-bottom: 1px solid var(--line); }
    .admin-nav a { display: inline-flex; align-items: center; padding: 8px 12px; border-radius: 6px; text-decoration: none; font-size: 14px; }
    .admin-nav a:hover { background: var(--panel); }
    .admin-nav .logout { margin-left: auto; color: var(--muted); }
    .readiness { display: flex; gap: 12px 24px; flex-wrap: wrap; padding: 12px 0; font-size: 14px; color: var(--muted); }
    .status.state-normal { color: var(--status-normal); } .status.state-alert { color: var(--status-alert); }
    [hidden] { display: none !important; }
    .admin-nav a[aria-current="page"] { background: var(--panel); box-shadow: inset 0 -2px var(--accent); }
    .admin-dialog { width: min(720px, calc(100% - 24px)); max-height: calc(100dvh - 32px); overflow: auto; background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 10px; padding: 24px; }
    .admin-dialog::backdrop { background: rgba(0,0,0,.8); }
    .conflict-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .conflict-columns textarea { min-height: 220px; }
    .admin-nav { overflow-x: auto; flex-wrap: nowrap !important; scrollbar-width: none; }
    .admin-nav::-webkit-scrollbar { display: none; }
    .admin-nav a { white-space: nowrap; flex-shrink: 0; }
    @media (max-width: 600px) { .conflict-columns { grid-template-columns: 1fr; } .admin-dialog { padding: 16px; } }
    .table-scroll { overflow-x: auto; max-width: 100%; }
    .public-page .external-shell { max-width: 800px; }
    body.external.public-page { background: var(--bg); }
    body.external.public-page .panel { border: 0; padding: 0; background: transparent; }
    body.external.public-page .letter { font-family: 'Noto Serif SC', 'Songti SC', SimSun, Georgia, serif; font-size: var(--reader-size, 19px); line-height: 2; overflow-wrap: anywhere; }
    .public-page .farewell-item { padding-top: 40px; margin-top: 48px; }
    .public-page .farewell-item h2 { font-family: 'Noto Serif SC', 'Songti SC', SimSun, Georgia, serif; font-size: clamp(24px, 4vw, 32px); margin: 10px 0 28px; line-height: 1.5; }
    .reader-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 24px 0; }
    .reader-tools button { margin-top: 0; }
    .reader-toc { border-block: 1px solid var(--line); padding: 18px 0; }
    .reader-toc ol { columns: 2; padding-left: 24px; }
    .reader-toc li { break-inside: avoid; margin: 8px 0; padding-right: 16px; }
    .reader-version-info { margin: 64px 0 0; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; line-height: 1.8; overflow-wrap: anywhere; }
    .reader-version-info > summary { cursor: pointer; padding: 18px 0; min-height: 44px; width: fit-content; }
    .reader-version-info > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
    .reader-version-body { padding: 0 0 16px; }
    .reader-version-body p { margin: 6px 0; }
    .reader-version-groups { list-style: none; margin: 20px 0 0; padding: 0; }
    .reader-version-groups > li + li { margin-top: 24px; }
    .reader-version-groups h3 { font: inherit; color: var(--ink); margin: 0 0 8px; }
    .public-page.reader-light { --bg: #faf8f3; --panel: #fffdf7; --ink: #262421; --muted: #706c64; --line: #d8d3c9; --accent: #282521; --on-accent: #faf8f3; --field: var(--bg); --inset: var(--bg); --secondary: #e9e5dc; --secondary-line: var(--line); --selected: var(--secondary); --epigraph: #635c51; --danger: #9b3025; color-scheme: light; }
    @media (prefers-color-scheme: light) {
      .public-page.reader-system { --bg: #faf8f3; --panel: #fffdf7; --ink: #262421; --muted: #706c64; --line: #d8d3c9; --accent: #282521; --on-accent: #faf8f3; --field: var(--bg); --inset: var(--bg); --secondary: #e9e5dc; --secondary-line: var(--line); --selected: var(--secondary); --epigraph: #635c51; --danger: #9b3025; color-scheme: light; }
    }
    .public-page.reader-contrast { --bg: #000; --panel: #000; --ink: #fff; --muted: #fff; --line: #fff; --accent: #ffef00; --on-accent: #000; --field: #000; --inset: #000; --secondary: #000; --secondary-line: #fff; --selected: #000; --epigraph: #fff; color-scheme: dark; }
    @media (max-width: 600px) { .reader-toc ol { columns: 1; } .admin-nav { gap: 0; } .admin-nav a { padding: 8px; } body.external.public-page .letter { font-size: var(--reader-size, 18px); } }
    @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
    @media print { .reader-tools, .reader-toc, .preview-banner, .reader-version-info { display: none !important; } .public-page { --bg: white; --ink: black; --muted: #555; --line: #bbb; } .public-page main { width: 100%; margin: 0; } .farewell-item h2 { break-after: avoid; } .letter { orphans: 3; widows: 3; } }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
      line-height: 1.55;
    }
    main { width: min(980px, calc(100% - 32px)); margin: 32px auto 56px; }
    header { margin-bottom: 24px; }
    h1 { font-size: 28px; line-height: 1.18; margin: 0 0 8px; letter-spacing: 0; }
    h2 { font-size: 18px; margin: 28px 0 12px; }
    p { margin: 0 0 12px; color: var(--muted); }
    a { color: var(--accent); text-underline-offset: 3px; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      margin: 16px 0;
    }
    .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    label { display: block; font-size: 13px; font-weight: 650; margin: 10px 0 6px; }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px 11px;
      font: inherit;
      background: var(--field);
      color: var(--ink);
    }
    textarea { min-height: 140px; resize: vertical; }
    button {
      border: 1px solid var(--accent);
      background: var(--accent);
      color: var(--on-accent);
      border-radius: 6px;
      padding: 10px 14px;
      font: 650 14px/1 ui-sans-serif, system-ui, sans-serif;
      cursor: pointer;
      margin-top: 12px;
    }
    button.secondary { background: var(--secondary); border-color: var(--secondary-line); color: var(--ink); }
    button:hover:not(:disabled) { filter: brightness(.9); }
    button.danger { background: transparent; border-color: var(--danger); color: var(--danger); }
    code, pre { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--inset); border: 1px solid var(--line); padding: 12px; border-radius: 6px; }
    .status { font-weight: 750; color: var(--accent); }
    .warning { color: var(--danger); font-weight: 650; }
    .notice { border-left: 3px solid var(--accent); padding-left: 12px; }
    .letter { white-space: pre-wrap; color: var(--ink); }
    .meta { color: var(--muted); font-size: 13px; }
    .farewell-item { border-top: 1px solid var(--line); padding-top: 16px; margin-top: 16px; }
    .farewell-item h2 { margin-top: 0; }
    .farewell-epigraph-wrap { width: min(88%, 680px); margin: 22px 0 28px auto; }
    .farewell-epigraph { margin: 0; color: var(--epigraph); font-family: "Noto Serif SC", "Songti SC", Georgia, serif; font-size: 16px; line-height: 1.85; }
    .farewell-epigraph-quote { display: block; white-space: pre-wrap; }
    .farewell-epigraph-source { display: block; margin-top: 8px; text-align: right; font-style: normal; }
    .farewell-epigraph-source::before { content: ""; display: inline-block; width: 2em; border-top: 1px solid currentColor; margin-right: .5em; vertical-align: .35em; }
    .farewell-epigraph-updated { margin-top: 7px; text-align: right; }
    .farewell-entry + .farewell-entry { border-top: 1px solid var(--line); margin-top: 18px; padding-top: 18px; }
    .public-page .farewell-entry + .farewell-entry { border-top: 0; padding-top: 0; margin-top: 1.8em; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 8px 6px; vertical-align: top; }
    .contact-list { border-top: 1px solid var(--line); }
    .contact-editor { display: grid; grid-template-columns: repeat(5, minmax(110px, 1fr)); gap: 8px; padding: 14px 0; border-bottom: 1px solid var(--line); align-items: end; }
    .contact-editor label { margin: 0; }
    .contact-editor .contact-name { grid-column: span 1; }
    .contact-editor button { margin-top: 0; }
    .public-composer h3 { font-size: 16px; margin: 24px 0 10px; }
${farewellEditorStyles}
    .public-overview { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 16px; align-items: start; border-bottom: 1px solid var(--line); padding-bottom: 16px; }
    .public-overview h2 { margin: 0 0 8px; }
    .public-overview p { margin-bottom: 4px; }
    .public-overview form { margin: 0; }
    .public-overview button { margin-top: 0; }
    .public-item-list { margin-top: 20px; border-top: 1px solid var(--line); }
    .public-group-entry { padding: 4px 0 18px; }
    .public-group-entry + .public-group-entry { border-top: 1px solid var(--line); padding-top: 18px; }
    .public-group-entry h4 { font-size: 14px; margin: 0 0 10px; color: var(--muted); }
    .entry-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-bottom: 10px; }
    .entry-heading h4 { margin: 0; }
    .entry-controls { display: flex; gap: 8px; margin: 0 0 12px; }
    .entry-controls form { margin: 0; }
    .entry-controls button { margin: 0; padding: 7px 10px; font-size: 13px; }
    .group-title-editor { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: end; margin: 4px 0 20px; }
    .group-title-fields, .group-title-actions, .group-title-actions form { margin: 0; }
    .group-title-fields label { margin: 0; }
    .group-title-actions { display: flex; gap: 8px; align-items: center; }
    .group-title-actions button { margin: 0; white-space: nowrap; }
    .group-title-actions .icon-button { width: 40px; height: 40px; padding: 0; font-size: 18px; line-height: 1; }
    .save-status { min-height: 20px; margin: 12px 0 0; font-size: 13px; }
    .mail-template-list { border-top: 1px solid var(--line); margin-top: 18px; }
    .mail-template-editor { border-bottom: 1px solid var(--line); }
    .mail-template-editor > summary { cursor: pointer; padding: 16px 0; display: flex; justify-content: space-between; gap: 12px; font-weight: 700; }
    .mail-template-editor > summary small { color: var(--muted); font-weight: 400; }
    .mail-template-body { padding: 0 0 20px; }
    .mail-template-body textarea { min-height: 280px; line-height: 1.65; }
    .mail-template-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .mail-template-actions button { margin-top: 12px; }
    .mail-template-actions form { margin: 0; }
    .private-letter-list { border-top: 1px solid var(--line); margin-top: 16px; }
    .private-letter-editor { border-bottom: 1px solid var(--line); }
    .private-letter-editor > summary { cursor: pointer; padding: 16px 0; display: flex; justify-content: space-between; gap: 16px; align-items: baseline; }
    .private-letter-editor > summary strong { color: var(--ink); }
    .private-letter-editor > summary span { color: var(--muted); font-size: 13px; text-align: right; }
    .private-letter-body { padding: 0 0 20px; }
    .private-letter-body textarea { min-height: 240px; line-height: 1.7; }
    .private-letter-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .private-letter-actions button { margin-top: 12px; }
    .private-pdf-preview-form { margin-top: 8px; }
    .private-pdf-preview-form button { margin-top: 0; }
    .private-letter-readonly { white-space: pre-wrap; color: var(--ink); border-left: 2px solid var(--line); padding-left: 14px; }
    .placeholder-list { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 12px; }
    .placeholder-list code { border: 1px solid var(--line); background: var(--inset); padding: 3px 7px; border-radius: 4px; }
    details.editor { border-bottom: 1px solid var(--line); padding: 0; }
    details.editor > summary { cursor: pointer; padding: 15px 0; font-weight: 700; display: flex; justify-content: space-between; gap: 12px; }
    details.editor > summary::marker { color: var(--muted); }
    .editor-body { padding: 0 0 18px; }
    .compact-grid { display: grid; grid-template-columns: 120px minmax(180px, 1fr); gap: 12px; }
    .preview-banner { border: 1px solid var(--line); padding: 12px 14px; margin-bottom: 22px; color: var(--muted); }
    body.external { background: #080808; color: var(--ink); }
    body.external main { width: min(760px, calc(100% - 32px)); margin: 52px auto 64px; }
    .external-shell { border-top: 4px solid var(--accent); padding-top: 22px; }
    .external .panel { background: #131313; border-color: #3d3d3d; box-shadow: none; }
    .external h1 { font-family: Georgia, "Noto Serif SC", "Songti SC", serif; font-size: clamp(30px, 5vw, 46px); font-weight: 600; line-height: 1.24; margin-bottom: 14px; }
    .external h2 { font-family: Georgia, "Noto Serif SC", "Songti SC", serif; font-size: 20px; }
    .eyebrow { color: var(--muted); font-size: 12px; font-weight: 750; letter-spacing: 0; text-transform: uppercase; }
    .external .letter { font-family: Georgia, "Noto Serif SC", "Songti SC", serif; font-size: 17px; line-height: 1.85; color: var(--ink); }
    .external .meta { font-size: 13px; }
    .choice { display: grid; grid-template-columns: 22px 1fr; gap: 10px; align-items: start; padding: 14px 0; border-top: 1px solid var(--line); }
    .choice input { width: 18px; height: 18px; margin: 3px 0 0; accent-color: var(--accent); }
    .choice label { margin: 0; font-size: 15px; font-weight: 650; }
    .choice small { display: block; color: var(--muted); font-weight: 400; margin-top: 3px; }
    .external fieldset { border: 0; padding: 0; margin: 0; }
    .external legend { font-weight: 750; margin-bottom: 8px; }
    .external-footer { margin-top: 34px; color: var(--muted); font-size: 13px; }
    @media (max-width: 720px) {
      .contact-editor { grid-template-columns: 1fr 1fr; }
      .contact-editor .contact-name { grid-column: span 2; }
      .contact-editor button { grid-column: span 2; }
      .compact-grid { grid-template-columns: 1fr; }
      .group-title-editor { grid-template-columns: 1fr; }
    }
  </style>`}
</head>
<body class="${escapeHtml(pageClass)}">
  ${bare?body:`<main>${body}</main>`}
</body>
</html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": `default-src 'self'; script-src 'nonce-${nonce}'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    },
  });
}

export function lockedHomePage() {
  return layout({
    title: "AfterMe",
    body: `<header>
      <h1>AfterMe</h1>
      <p>失联预警、私人信件和公开遗言系统。公开首页提供登录入口与公开内容入口。</p>
    </header>
    <section class="panel">
      <h2>公开遗言</h2>
      <p><a href="/farewell">查看公开页面</a>。页面会显示当前发布状态。</p>
    </section>
    <section class="panel">
      <h2>管理入口</h2>
      <form method="post" action="/admin">
        <label>Admin token</label>
        <input name="admin_token" type="password" autocomplete="current-password">
        <button type="submit">进入管理面板</button>
      </form>
    </section>`,
  });
}

export function homePage({ owner, contacts, recipients, confirmations, items, privateItems = null, deliveries, farewellEditor, legalWill, mailTemplates = {}, operationalHealth = null, adminToken = "", mailProvider = "dry-run", mailInboundEnabled = true, contactNotificationsEnabled = true, releaseLockedByConfig = false, requiredConfirmations = 3, releaseGraceHours = 72 }) {
  const isSetup = Boolean(owner);
  const contactRows = contacts?.results || [];
  const recipientRows = recipients?.results || [];
  const activeRecipientRows = recipientRows.filter((recipient) => Number(recipient.active) === 1);
  const itemRows = items?.results || [];
  const privateItemRows = privateItems || itemRows;
  const releaseAt = releaseAtFor(owner?.release_ready_at, releaseGraceHours);
  const tokenInput = hiddenAdmin(adminToken);
  const releaseSuspended = Boolean(owner?.release_suspended) || releaseLockedByConfig;
  const latestScheduledAt = operationalHealth?.latestScheduled?.created_at || null;
  const cronAgeHours = latestScheduledAt ? (Date.now() - new Date(latestScheduledAt).getTime()) / 3600_000 : Infinity;
  const cronStale = !Number.isFinite(cronAgeHours) || cronAgeHours > 2.5;
  const maxCronGapHours = Number(operationalHealth?.maxCronGapHours || 0);
  const latestDelivery = operationalHealth?.latestDelivery || null;
  const latestSuccessfulDelivery = operationalHealth?.latestSuccessfulDelivery || null;
  const temporaryOwnerOnly = mailProvider === "gmail" && !mailInboundEnabled && !contactNotificationsEnabled;
  return layout({
    title: "AfterMe",
    pageClass: "admin-page",
    body: `<header>
      <h1>AfterMe</h1>
      <p>失联预警、私人信件和公开留言的个人准备系统。任何内容都需要 <span class="status">${escapeHtml(requiredConfirmations)}</span> 名联系人明确确认死亡，并经过 <span class="status">${escapeHtml(releaseGraceHours)}</span> 小时缓冲后才会释放。</p>
    </header>

    <nav class="admin-nav" aria-label="管理导航">
      <a href="#owner-status">签到与状态</a><a href="#contacts-editor">联系人</a><a href="#private-items-editor">私人信件</a><a href="#public-farewell-v2">公开遗言</a><a href="#mail-template-editor">通知文案</a><a class="logout" href="/">退出登录</a>
    </nav>
    <div class="readiness"><span>有效联系人 ${contactRows.filter(c => Number(c.active) === 1).length} / 至少 ${requiredConfirmations} 人</span><span>私人信件 ${privateItemRows.length} 封</span><span data-readiness-pending>待应用修改 ${farewellEditor?.pending_count || 0} 项</span><span>本轮有效死亡确认 ${(confirmations?.results || []).filter(c => c.status === 'confirmed_death').length} / ${requiredConfirmations}</span></div>
    ${mailProvider === "dry-run" ? `<section class="panel notice">
      <h2>目前处于演练模式</h2>
      <p>演练模式将计划发送的邮件记入日志。您可以录入资料、测试签到和确认流程；实际通知通过配置并启用的邮件通道发送。</p>
    </section>` : temporaryOwnerOnly ? `<section class="panel notice">
      <h2>临时邮件模式</h2>
      <p>当前只允许向本人发送 48 小时签到提醒。联系人通知、邮件回复核验和内容释放邮件均已关闭；自动释放应保持暂停，直到专用邮箱恢复。</p>
    </section>` : `<section class="panel notice">
      <p>邮件通道：<span class="status">${escapeHtml(mailProvider)}</span>。请定期使用下方“邮件通道测试”确认它仍能正常发信。</p>
    </section>`}

    <section class="panel" id="operations-status">
      <h2>系统运行状况</h2>
      ${privateItemRows.some(item => item.decrypt_failed) ? `<p class="warning">有 ${privateItemRows.filter(item => item.decrypt_failed).length} 封私人信件无法解密，请检查内容密钥与完整备份。</p>` : ''}
      ${!operationalHealth?.latestBackup ? `<p class="warning" data-no-complete-backup>尚无完整备份生成记录，请到“备份与维护”导出完整备份并验证恢复。</p>` : ''}
      <p>最近一次定时检查：${escapeHtml(formatDate(latestScheduledAt))}</p>
      ${cronStale ? `<p class="warning">定时检查已超过 2.5 小时没有成功记录，请立即检查 Cloudflare Cron。</p>` : `<p>定时检查当前按计划运行。</p>`}
      ${maxCronGapHours > 2 ? `<p class="warning">最近 7 天检测到最长约 ${escapeHtml(maxCronGapHours.toFixed(1))} 小时的定时任务空档。</p>` : ""}
      <p>邮件回复核验：${mailInboundEnabled ? "启用" : "已关闭"}；联系人通知：${contactNotificationsEnabled ? "启用" : "已关闭"}。</p>
      ${latestDelivery ? `<p class="${latestDelivery.status === "failed" ? "warning" : ""}">最近一次邮件结果：${escapeHtml(deliveryStatusLabel(latestDelivery.status))}，${escapeHtml(formatDate(latestDelivery.created_at))}${latestDelivery.last_error ? `；${escapeHtml(latestDelivery.last_error)}` : ""}</p>` : `<p class="warning">尚无邮件投递记录。</p>`}
      <p>最近一次成功邮件：${escapeHtml(formatDate(latestSuccessfulDelivery?.created_at))}</p>
      <p>最近一次月度发信自检：${escapeHtml(formatDate(operationalHealth?.latestMailHealthcheck?.created_at))}</p>
      ${operationalHealth?.privateDeliveryProblemCount ? `<p class="warning">有 ${Number(operationalHealth.privateDeliveryProblemCount)} 封私人信件尚未完成投递，健康检查会保持异常。</p>` : ''}
      ${(operationalHealth?.privateDeliveries || []).map(item => `<p class="${['sent','dry_run','manual'].includes(item.status) ? 'meta' : 'warning'}">给 ${escapeHtml(item.recipient_name || '收件人')} 的信：${escapeHtml(deliveryStatusLabel(item.status))}${item.reason === 'decrypt-failed' ? '；无法解密，请检查内容密钥与备份' : ''}</p>`).join('')}
      ${operationalHealth?.outboundProblemCount || operationalHealth?.inboundProblemCount ? `<p class="warning">待处理发信故障 ${Number(operationalHealth.outboundProblemCount || 0)} 项；收信处理故障 ${Number(operationalHealth.inboundProblemCount || 0)} 项。健康检查会保持异常，直到故障解决。</p>` : ''}
      ${(operationalHealth?.blockedMail || []).map(mail => `<form method="post" action="/api/mail/reconcile">${tokenInput}<input type="hidden" name="dedupe_key" value="${escapeHtml(mail.dedupe_key)}"><p class="warning">邮件发送结果不明，已暂停自动重发：${escapeHtml(mail.dedupe_key)}</p><p>请先到发件邮箱核对发送记录。确认没有送达后才选择允许重试。</p><select name="resolution"><option value="delivered">已核实送达，标为完成</option><option value="retry">已核实未送达，允许下次任务重试</option></select><button type="submit">记录核对结果</button></form>`).join('')}
    </section>

    <section class="panel" id="owner-status">
      <h2>当前状态</h2>
      ${isSetup ? `
        <p>状态：<span class="status ${owner.state === 'NORMAL' ? 'state-normal' : 'state-alert'}">${escapeHtml(({ NORMAL: '正常', OVERDUE: '等待本人签到', ALERT: '请联系人尝试联系', VERIFY: '人工核验中', READY_TO_RELEASE: '释放缓冲期', PRIVATE_RELEASE: '私人内容已释放', PUBLIC_RELEASE: '公开内容已释放' })[owner.state] || owner.state)}</span> <small>${escapeHtml(owner.state)}</small></p>
        ${owner.stored_state && owner.stored_state !== owner.state ? `<p class="warning">这是按最后签到时间实时计算的状态；数据库上一状态为 ${escapeHtml(owner.stored_state)}，等待定时任务写回。</p>` : ""}
        <p>最后签到：${escapeHtml(formatDate(owner.last_checkin_at))}</p>
        ${nextReminderAt(owner) ? `<p>下次提醒：${escapeHtml(formatDate(nextReminderAt(owner)))}</p>` : ''}
        <p>释放暂停：${releaseSuspended ? '<span class="warning">是</span>' : '否'}</p>
        ${releaseLockedByConfig ? `<p class="warning">部署配置已强制冻结自动释放；仅在恢复完整邮件通道并重新部署后才能解除。</p>` : ""}
        ${owner.state === "READY_TO_RELEASE" && releaseAt ? `<p class="warning">已满足死亡确认，仍在 ${escapeHtml(releaseGraceHours)} 小时缓冲期。最早释放：${escapeHtml(formatDate(releaseAt))}；在此之前重新签到可取消。</p>` : ""}
      ` : `<p class="warning">尚未初始化 owner。先调用 <code>POST /api/setup</code>。</p>`}
      <form method="post" action="/api/checkin">
        ${tokenInput}
        ${adminToken ? "" : adminTokenField()}
        <button type="submit">我很好，立即签到</button>
      </form>
      <p class="meta">签到会结束本轮核验，并撤回公开页面和私人链接访问。已经送出的邮件及附件无法撤回。</p>
      <p id="checkin-feedback" role="status"></p>
    </section>

    <section class="panel" id="release-protection">
      <h2>自动释放保护</h2>
      ${!isSetup ? "<p>初始化后可使用暂停保护。</p>" : releaseLockedByConfig ? `
        <p class="warning">自动释放已由部署配置暂停。签到和内容编辑可照常进行。</p>
        <p>请在部署配置中检查邮件通道，并按启用步骤解除这层暂停。</p>
      ` : releaseSuspended ? `
        <p class="warning">自动释放已暂停，私人内容与公开页面保持当前状态。联系人提醒继续按规则处理。</p>
        <p>恢复前必须重新签到；这会清空旧确认，避免它们立即触发释放。</p>
        <form method="post" action="/api/checkin">
          ${tokenInput}
          ${adminToken ? "" : adminTokenField()}
          <input type="hidden" name="resume_release" value="1">
          <button type="submit">重新签到并解除暂停</button>
        </form>
      ` : `
        <p>暂停期间，私人内容释放与公开页面发布保持暂停；联系人可照常尝试联系你。</p>
        <form method="post" action="/api/suspend-release">
          ${tokenInput}
          ${adminToken ? "" : adminTokenField()}
          <input type="hidden" name="release_suspended" value="1">
          <button class="danger" type="submit">暂停自动释放</button>
        </form>
      `}
    </section>

    <div id="contacts-editor">
    <section class="panel">
      <h2>核验联系人管理</h2>
      <p>核验联系人会收到 72 小时和 120 小时失联通知，并可提交情况。私人信件按每封信指定的收件人投递。</p>
      <p>停用后，该联系人的旧确认链接立即失效，后续核验通知暂停；既有记录保留。</p>
      ${contactRows.length ? `<div class="contact-list">${contactRows.map((contact) => contactEditor(contact, tokenInput, adminToken ? "" : adminTokenField())).join("")}</div>` : "<p>请添加第一位核验联系人。</p>"}
    </section>

    <section class="panel">
      <h2>新增核验联系人</h2>
      <form data-contact-form method="post" action="/api/contacts">
        ${tokenInput}
        ${adminToken ? "" : adminTokenField()}
        <div class="grid">
          <div><label>姓名</label><input name="name" required></div>
          <div><label>邮箱</label><input name="email" type="email" required></div>
          <div><label>你的内部备注（仅管理页可见）</label><input name="role" value="contact"></div>
          <div><label>通知顺序（数字越小越靠前）</label><input name="priority" type="number" value="100"></div>
        </div>
        <button type="submit">保存联系人</button>
      </form>
    </section>
    <p class="save-status" id="contact-save-status" aria-live="polite"></p>
    </div>

    <div id="recipients-editor">
    <section class="panel">
      <h2>私人信件收件人</h2>
      <p>这里的人按每封信的安排接收私人信件。失联核验由核验联系人名单负责；同一个人可以同时加入两份名单。</p>
      ${recipientRows.length ? `<div class="contact-list">${recipientRows.map((recipient) => recipientEditor(recipient, tokenInput, adminToken ? "" : adminTokenField())).join("")}</div>` : "<p>请添加第一位私人信件收件人。</p>"}
    </section>

    <section class="panel">
      <h2>新增私人信件收件人</h2>
      <form data-recipient-form method="post" action="/api/recipients">
        ${tokenInput}
        ${adminToken ? "" : adminTokenField()}
        <div class="grid">
          <div><label>姓名</label><input name="name" required></div>
          <div><label>邮箱</label><input name="email" type="email" required></div>
          <div><label>你的内部备注（仅管理页可见）</label><input name="note"></div>
        </div>
        <button type="submit">保存收件人</button>
      </form>
    </section>
    <p class="save-status" id="recipient-save-status" aria-live="polite"></p>
    </div>

    <section class="panel">
      <h2>确认记录</h2>
      ${table(confirmations?.results || [], ["name", "status", "created_at"])}
    </section>

    <section class="panel">
      <h2>演练与故障备用</h2>
      <p>正常情况下，系统在失联后自动通知联系人：先请对方尝试联系你；只有进入人工确认阶段才发送确认链接。这里仅用于你想演练流程，或邮件通道失效时需要人工补发。生成新链接会让旧链接失效。</p>
      <form method="post" action="/api/contacts/rotate-token">
        ${tokenInput}
        ${adminToken ? "" : adminTokenField()}
        <label>联系人</label>
        <select name="contact_id" required>
          <option value="">选择联系人</option>
          ${contactRows.map((contact) => `<option value="${escapeHtml(contact.id)}">${escapeHtml(contact.name)} · ${escapeHtml(contact.email)}</option>`).join("")}
        </select>
        <button type="submit">生成一份演练/备用通知</button>
      </form>
    </section>

    <div id="private-items-editor">
      <section class="panel">
        <h2>私人信件</h2>
        <p>点击一封信即可编辑收件人和正文。未释放的普通私人信件保存后会重新加密，并覆盖对应的 PDF；已经释放的信件保持只读。</p>
        ${privateItemRows.length ? `<div class="private-letter-list">${privateItemRows.map((item) => privateLetterEditor(item, activeRecipientRows, tokenInput, adminToken ? "" : adminTokenField())).join("")}</div>` : "<p>请创建第一封私人信件。</p>"}
      </section>
      <section class="panel">
        <h2>新增私人信件</h2>
        <form method="post" action="/api/items" data-private-item-form>
          ${tokenInput}
          ${adminToken ? "" : adminTokenField()}
          <label>收件人</label>
          <select name="recipient_id" required>
            <option value="">请选择收件人</option>
            ${activeRecipientRows.map((recipient) => `<option value="${escapeHtml(recipient.id)}">${escapeHtml(recipient.name)} · ${escapeHtml(recipient.email)}</option>`).join("")}
          </select>
          <label>正文</label>
          <textarea name="plaintext" required></textarea>
          <button type="submit">保存私人信件</button>
        </form>
      </section>
      <p class="save-status" id="private-item-save-status" aria-live="polite"></p>
    </div>

    <section class="panel public-composer" id="public-farewell-v2" data-legacy-farewell-link>
      <h2>公开遗言</h2><p>公开遗言的分组、条目、草稿核对和预览统一在新版编辑器中管理。</p>
      <p>待应用修改：${Number(farewellEditor?.pending_count||0)} 项</p><a href="/admin#farewell">打开公开遗言编辑器</a>
    </section>

    <section class="panel">
      <h2>法律遗嘱位置</h2>
      <form method="post" action="/api/legal-will">
        ${tokenInput}
        ${adminToken ? "" : adminTokenField()}
        <label>状态</label>
        <select name="status">
          ${option("not_started", legalWill?.status || "not_started", "未开始")}
          ${option("drafted", legalWill?.status || "not_started", "已起草")}
          ${option("signed", legalWill?.status || "not_started", "已签署")}
          ${option("notarized", legalWill?.status || "not_started", "已公证")}
        </select>
        <label>位置</label>
        <input name="location" value="${escapeHtml(legalWill?.location || "")}">
        <label>保管/联系人</label>
        <input name="custodian" value="${escapeHtml(legalWill?.custodian || "")}">
        <label>备注</label>
        <textarea name="notes">${escapeHtml(legalWill?.notes || "")}</textarea>
        <button type="submit">保存法律遗嘱位置</button>
      </form>
    </section>

    <section class="panel">
      <h2>备份导出</h2>
      <p>最近一次完整备份生成：<span id="last-complete-backup">${escapeHtml(formatDate(operationalHealth?.latestBackup?.created_at))}</span>。请保存下载的文件，并完成独立恢复校验。</p>
      <form method="post" action="/api/export" data-backup-form data-backup-kind="complete">
        ${tokenInput}
        ${adminToken ? "" : adminTokenField()}
        <input name="include_payloads" type="hidden" value="1">
        <button type="submit">下载完整恢复备份</button>
      </form>
      <form method="post" action="/api/export" data-backup-form data-backup-kind="metadata">${tokenInput}${adminToken ? '' : adminTokenField()}<button class="secondary" type="submit">导出资料（不含私人内容）</button></form>
      <p class="meta">完整备份包含联系人和内容，请保存到可信位置；内容密钥另行保管。完整恢复请使用“完整备份”文件。</p><p id="backup-status" role="status"></p>
    </section>

    <section class="panel">
      <h2>PDF 维护</h2>
      <p>字体或版式升级后，可重新生成公开遗言和所有普通私人信件的已保存 PDF。重建沿用已保存的正文、收件人与内容更新时间。</p>
      <form method="post" action="/api/pdf/rebuild">
        ${tokenInput}
        ${adminToken ? "" : adminTokenField()}
        <button type="submit">重建全部 PDF</button>
      </form>
    </section>

    <section class="panel" id="mail-template-editor">
      <h2>实际邮件文案</h2>
      <p>修改后会直接用于后续正式邮件。请保留花括号中的姓名占位符；发送时会自动替换为对应姓名。</p>
      ${mailTemplateEditorMarkup(mailTemplates, tokenInput, adminToken ? "" : adminTokenField())}
      <form method="post" action="/api/mail/preview" target="_blank">
        ${tokenInput}
        ${adminToken ? "" : adminTokenField()}
        <button class="secondary" type="submit">预览四封实际邮件</button>
      </form>
    </section>

    <section class="panel">
      <h2>邮件通道测试</h2>
      <p>用于确认发信通道仍然可用。演练模式将自检结果写入日志；正式自检通过已配置的邮件通道发送。</p>
      <form method="post" action="/api/mail/test">
        ${tokenInput}
        ${adminToken ? "" : adminTokenField()}
        <label>测试收件邮箱（留空则发给 owner 邮箱）</label>
        <input name="email" type="email">
        <button type="submit">发送测试邮件</button>
      </form>
    </section>

    <section class="panel">
      <h2>投递日志</h2>
      ${table(deliveries?.results || [], ["event_type", "recipient_email", "status", "created_at"])}
    </section>

    <section class="panel">
      <h2>高敏感口令密文草稿</h2>
      <p>普通私人信件由系统按收件安排交付。需要独立口令保护的内容可在这里加密，再用 API 提交 <code>access_mode=passphrase</code>。</p>
      <label>明文</label>
      <textarea id="plain"></textarea>
      <label>口令</label>
      <input id="passphrase" type="password">
      <button type="button" id="encrypt-draft">生成高敏感密文 JSON</button>
      <pre id="cipherOut"></pre>
    </section>

    ${adminEnhancementsMarkup()}
    <script>
      async function encryptDraft() {
        const plain = document.getElementById('plain').value;
        const passphrase = document.getElementById('passphrase').value;
        if (!plain || !passphrase) {
          document.getElementById('cipherOut').textContent = '需要明文和口令。';
          return;
        }
        const enc = new TextEncoder();
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
        const key = await crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' },
          keyMaterial,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt']
        );
        const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain));
        const payload = {
          v: 1,
          alg: 'AES-GCM',
          kdf: 'PBKDF2-SHA256',
          iterations: 210000,
          salt: b64(salt),
          iv: b64(iv),
          ciphertext: b64(new Uint8Array(cipher))
        };
        document.getElementById('cipherOut').textContent = JSON.stringify(payload, null, 2);
      }
      function b64(bytes) {
        return btoa(String.fromCharCode(...bytes));
      }

      function bindContactEditor() {
        const editor = document.getElementById('contacts-editor');
        if (!editor) return;
        for (const form of editor.querySelectorAll('form[data-contact-form]')) {
          form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const status = editor.querySelector('#contact-save-status');
            const submitter = event.submitter;
            const originalLabel = submitter?.textContent;
            const creating = form.action.endsWith('/api/contacts');
            if (submitter) {
              submitter.disabled = true;
              submitter.textContent = '保存中...';
            }
            if (status) status.textContent = '';
            const formData = new FormData(form);
            try {
              const response = await fetch(form.action, { method: 'POST', body: formData });
              const result = await response.json().catch(() => ({}));
              if (!response.ok || !result.ok) {
                throw new Error(result.message || result.error || '保存失败，请重试。');
              }
              const token = formData.get('admin_token');
              const refreshed = await fetch('/admin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ admin_token: token || '' }),
              });
              if (!refreshed.ok) throw new Error('已保存联系人。列表刷新失败，请重新载入。');
              const documentAfterSave = new DOMParser().parseFromString(await refreshed.text(), 'text/html');
              const nextEditor = documentAfterSave.getElementById('contacts-editor');
              if (!nextEditor) throw new Error('已保存联系人。列表刷新失败，请重新载入。');
              replacePreservingEdits(editor, nextEditor, form, formData);
              bindContactEditor();
              const nextStatus = document.getElementById('contact-save-status');
              if (nextStatus) nextStatus.textContent = creating ? '联系人已保存。' : '联系人修改已保存。';
            } catch (error) {
              if (status) status.textContent = error.message || '保存失败，请重试。';
              if (submitter) {
                submitter.disabled = false;
                submitter.textContent = originalLabel;
              }
            }
          });
        }
      }
      function bindRecipientEditor() {
        const editor = document.getElementById('recipients-editor');
        if (!editor) return;
        for (const form of editor.querySelectorAll('form[data-recipient-form]')) {
          form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const status = editor.querySelector('#recipient-save-status');
            const submitter = event.submitter;
            const originalLabel = submitter?.textContent;
            const creating = form.action.endsWith('/api/recipients');
            if (submitter) {
              submitter.disabled = true;
              submitter.textContent = '保存中...';
            }
            if (status) status.textContent = '';
            const formData = new FormData(form);
            try {
              const response = await fetch(form.action, { method: 'POST', body: formData });
              const result = await response.json().catch(() => ({}));
              if (!response.ok || !result.ok) throw new Error(result.message || result.error || '保存失败，请重试。');
              const token = formData.get('admin_token');
              const refreshed = await fetch('/admin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ admin_token: token || '' }),
              });
              if (!refreshed.ok) throw new Error('已保存收件人。列表刷新失败，请重新载入。');
              const documentAfterSave = new DOMParser().parseFromString(await refreshed.text(), 'text/html');
              const nextEditor = documentAfterSave.getElementById('recipients-editor');
              if (!nextEditor) throw new Error('已保存收件人。列表刷新失败，请重新载入。');
              replacePreservingEdits(editor, nextEditor, form, formData);
              const options = documentAfterSave.querySelector('form[action="/api/items"] select[name="recipient_id"]');
              if (options) document.querySelectorAll('#private-items-editor select[name="recipient_id"]').forEach(select => {
                const previous = select.value;
                const oldOption = [...select.options].find(option => option.value === previous)?.cloneNode(true);
                select.replaceChildren(...[...options.options].map(option => option.cloneNode(true)));
                if (previous && ![...select.options].some(option => option.value === previous) && oldOption) { oldOption.textContent += '（已停用，请重新选择）'; select.append(oldOption); }
                select.value = previous;
              });
              bindRecipientEditor();
              const nextStatus = document.getElementById('recipient-save-status');
              if (nextStatus) nextStatus.textContent = creating ? '收件人已保存。' : '收件人修改已保存。';
            } catch (error) {
              if (status) status.textContent = error.message || '保存失败，请重试。';
              if (submitter) {
                submitter.disabled = false;
                submitter.textContent = originalLabel;
              }
            }
          });
        }
      }
      function bindMailTemplateEditor() {
        const editor = document.getElementById('mail-template-editor');
        if (!editor) return;
        for (const form of editor.querySelectorAll('form[data-mail-template-form]')) {
          form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const status = editor.querySelector('#mail-template-save-status');
            const submitter = event.submitter;
            const originalLabel = submitter?.textContent;
            if (submitter) { submitter.disabled = true; submitter.textContent = '处理中...'; }
            if (status) status.textContent = '';
            const formData = new FormData(form);
            try {
              const response = await fetch(form.action, { method: 'POST', body: formData });
              const result = await response.json().catch(() => ({}));
              if (!response.ok || !result.ok) throw new Error(result.message || result.error || '保存失败，请重试。');
              const token = formData.get('admin_token');
              const refreshed = await fetch('/admin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ admin_token: token || '' }),
              });
              if (!refreshed.ok) throw new Error('文案操作已完成。列表刷新失败，请重新载入。');
              const nextDocument = new DOMParser().parseFromString(await refreshed.text(), 'text/html');
              const nextEditor = nextDocument.getElementById('mail-template-editor');
              if (!nextEditor) throw new Error('文案操作已完成。列表刷新失败，请重新载入。');
              replacePreservingEdits(editor, nextEditor, form, formData);
              bindMailTemplateEditor();
              const nextStatus = document.getElementById('mail-template-save-status');
              if (nextStatus) nextStatus.textContent = result.reset ? '已恢复默认文案。' : '文案已保存，后续邮件将使用此版本。';
            } catch (error) {
              if (status) status.textContent = error.message || '保存失败，请重试。';
              if (submitter) { submitter.disabled = false; submitter.textContent = originalLabel; }
            }
          });
        }
      }
      function bindPrivateItemEditor() {
        const editor = document.getElementById('private-items-editor');
        if (!editor) return;
        for (const form of editor.querySelectorAll('form[data-private-item-form]')) {
          form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const status = editor.querySelector('#private-item-save-status');
            const submitter = event.submitter;
            const originalLabel = submitter?.textContent;
            const creating = form.action.endsWith('/api/items');
            if (submitter) { submitter.disabled = true; submitter.textContent = '保存中...'; }
            if (status) status.textContent = '';
            let formData = new FormData(form);
            try {
              const submission = await window.aftermeSubmit(form, formData);
              const { response, result } = submission;
              formData = submission.data;
              if (!response.ok || !result.ok) throw new Error(result.message || result.error || '保存失败，请重试。');
              const token = formData.get('admin_token');
              const refreshed = await fetch('/admin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ admin_token: token || '' }),
              });
              if (!refreshed.ok) throw new Error('私人信件已保存。列表刷新失败，请重新载入。');
              const nextDocument = new DOMParser().parseFromString(await refreshed.text(), 'text/html');
              const nextEditor = nextDocument.getElementById('private-items-editor');
              if (!nextEditor) throw new Error('私人信件已保存。列表刷新失败，请重新载入。');
              replacePreservingEdits(editor, nextEditor, form, formData);
              bindPrivateItemEditor();
              const nextStatus = document.getElementById('private-item-save-status');
              if (nextStatus) nextStatus.textContent = form.action.endsWith('/revoke') ? '信件已撤回，已关闭后续投递和链接访问。' : form.action.endsWith('/restore') ? '信件已恢复资格，仍需满足核验与释放条件。' : creating ? '私人信件已保存。' : '私人信件修改已保存，PDF 已同步更新。';
            } catch (error) {
              if (status) status.textContent = error.message || '保存失败，请重试。';
              if (submitter) { submitter.disabled = false; submitter.textContent = originalLabel; }
            }
          });
        }
      }
      function replacePreservingEdits(editor, next, submitted, sentData) {
        const signature = data => JSON.stringify([...data.entries()].filter(([name]) => !['admin_token','expected_revision'].includes(name)));
        for (const oldForm of editor.querySelectorAll('form')) {
          if (oldForm === submitted && signature(new FormData(oldForm)) === signature(sentData)) continue;
          const newForm = [...next.querySelectorAll('form')].find(candidate => candidate.getAttribute('action') === oldForm.getAttribute('action'));
          if (!newForm) continue;
          for (const field of oldForm.elements) {
            if (!field.name || field.name === 'admin_token') continue;
            const target = newForm.elements.namedItem(field.name);
            if (!target) continue;
            target.value = field.value;
            if ('checked' in field) target.checked = field.checked;
          }
          if (oldForm.dataset.unsaved) newForm.dataset.unsaved = oldForm.dataset.unsaved;
          if (oldForm.closest('details')?.open && newForm.closest('details')) newForm.closest('details').open = true;
        }
        editor.replaceWith(next);
        window.aftermeBindFields(next);
      }
      document.getElementById('encrypt-draft')?.addEventListener('click', encryptDraft);
      window.addEventListener('pageshow', event => { if (event.persisted) location.replace('/'); });
      document.addEventListener('input', event => {
        const form = event.target.closest('form');
        if (form && form.id !== 'admin-session-form' && event.target.name !== 'admin_token') form.dataset.unsaved = '1';
      });
      document.addEventListener('submit', event => {
        const preview = event.target.matches('.private-pdf-preview-form');
        if (preview && event.target.closest('details')?.querySelector('[data-unsaved="1"]')) {
          event.preventDefault(); alert('请先保存这封信，再预览对应的 PDF。');
        }
      }, true);
      bindContactEditor();
      bindRecipientEditor();
      bindPrivateItemEditor();
      bindMailTemplateEditor();
    </script>`,
  });
}

export function mailPreviewPage({ alert, verify, publicMail, privateMail }) {
  return layout({
    title: "实际邮件文案预览",
    body: `<header>
      <h1>实际邮件文案预览</h1>
      <p>以下标题和正文直接由正式发送所使用的模板生成。这里展示正式邮件的标题和正文，供您逐项核对。</p>
    </header>
    ${mailPreviewCard("失联 72 小时", alert)}
    ${mailPreviewCard("失联 120 小时，联系人核验", verify)}
    ${mailPreviewCard("公开遗言送达", publicMail)}
    ${mailPreviewCard("私人信件送达", privateMail)}
    <p class="meta">公开遗言和普通私人信件以 PDF 附件发送；独立口令内容由您另行安排交付。</p>`,
  });
}

export function verifyPage({ contact, owner }) {
  const ownerName = escapeHtml(owner?.display_name || "本人");
  return layout({
    title: "失联情况确认",
    pageClass: "external verify-page",
    body: `<section class="external-shell">
      <p class="eyebrow">AfterMe / 联系人核验</p>
      <h1>请先尝试联系 ${ownerName}</h1>
      <p>${escapeHtml(contact.name)}，您好。${ownerName}已经连续 120 小时没有完成状态确认。请先通过电话、微信或者您平时使用的其他方式尝试联系他，并根据您掌握的情况如实选择。</p>
      <section class="panel">
        <form method="post">
          <fieldset>
            <legend>目前您知道的情况</legend>
            <div class="choice">
              <input id="unable" name="status" type="radio" value="unable_to_reach" checked>
              <label for="unable">暂时联系不上本人<small>我们将记录失联情况。</small></label>
            </div>
            <div class="choice">
              <input id="confirmed" name="status" type="radio" value="confirmed_death">
              <label for="confirmed">我已从可靠来源确认本人死亡<small>请只在您确定消息属实时选择。当有三名联系人确认后，72 小时之后如果情况未发生变化，系统将公布他的公开遗言与私人遗言，感谢您的配合。</small></label>
            </div>
            <div class="choice">
              <input id="safe" name="status" type="radio" value="false_alarm">
              <label for="safe">我确认本人安全，或这是误报<small>系统会恢复正常状态并清除当前确认记录。</small></label>
            </div>
          </fieldset>
          <label>补充说明（选填）</label>
          <textarea name="note" placeholder="例如：最后一次联系的时间，或已核实消息的来源"></textarea>
          <button type="submit">提交情况</button>
        </form>
      </section>
      <p class="external-footer">此链接仅用于确认情况，请不要转发。</p>
    </section>`,
  });
}

export function verificationResultPage({ status, qualifyingCount, release }) {
  const falseAlarm = status === "false_alarm";
  const publicMessage = release?.publicRelease?.published
    ? "公开页面已按预设内容发布。"
    : release?.publicRelease?.retracted
      ? "此前由系统自动发布的公开页面已恢复为未发布。"
      : "公开页面保持待发布状态。";
  const heading = falseAlarm ? "已记录为误报" : "情况已记录";
  const summary = falseAlarm
    ? "系统已恢复正常状态，当前确认记录已清除。"
    : release?.reason === "release-grace-period"
      ? `三名联系人确认死亡的条件已满足。系统将在 ${formatDate(release.releaseAt)} 之后公布公开遗言与私人遗言，感谢您的配合。`
      : `当前有效确认数：${qualifyingCount}。${release?.released ? "私人内容释放流程已触发。" : "尚未达到死亡确认与缓冲期条件。"}`;
  return layout({
    title: heading,
    pageClass: "external verify-page",
    body: `<section class="external-shell"><p class="eyebrow">AfterMe / 联系人核验</p><h1>${heading}</h1><section class="panel"><p>${summary}</p><p>${publicMessage}</p></section><p class="external-footer">本次提交已完成。</p></section>`,
  });
}

export function vaultPage(item, opened) {
  if (opened.mode === "link") {
    return layout({
      title: item.title,
      pageClass: "external vault-page",
      body: `<section class="external-shell">
        <p class="eyebrow">AfterMe / 一份留给你的内容</p>
        <h1>${escapeHtml(item.title)}</h1>
        <section class="panel"><div class="letter">${escapeHtml(opened.plaintext)}</div></section>
        <p class="external-footer">这份内容仅交给你。请按信中安排处理，并妥善保管。</p>
      </section>`,
    });
  }

  return layout({
    title: item.title,
    pageClass: "external vault-page",
    body: `<section class="external-shell">
      <p class="eyebrow">AfterMe / 高敏感内容</p>
      <h1>${escapeHtml(item.title)}</h1>
      <p>这份内容还需要口令才能打开。</p>
      <section class="panel">
        <label>口令</label>
        <input id="passphrase" type="password" autocomplete="current-password">
        <button type="button" id="decrypt-vault">打开内容</button>
        <pre id="plain"></pre>
        <pre id="cipher" hidden>${escapeHtml(opened.encryptedPayload)}</pre>
      </section>
      <p class="external-footer">请仅向指定收件人提供链接与口令。</p>
    </section>
    <script>
      async function decryptVault() {
        const payload = JSON.parse(document.getElementById('cipher').textContent);
        const passphrase = document.getElementById('passphrase').value;
        const enc = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
        const key = await crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: fromB64(payload.salt), iterations: payload.iterations, hash: 'SHA-256' },
          keyMaterial,
          { name: 'AES-GCM', length: 256 },
          false,
          ['decrypt']
        );
        try {
          const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(payload.iv) }, key, fromB64(payload.ciphertext));
          document.getElementById('plain').textContent = new TextDecoder().decode(plain);
        } catch {
          document.getElementById('plain').textContent = '无法打开内容：口令不对或内容已损坏。';
        }
      }
      document.getElementById('decrypt-vault').addEventListener('click', decryptVault);
      function fromB64(value) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
    </script>`,
  });
}

function publicEpigraphMarkup(value) {
  if (!String(value || "").trim()) return "";
  const epigraph = parseEpigraph(value);
  return `<div class="farewell-epigraph-wrap"><blockquote class="farewell-epigraph"><span class="farewell-epigraph-quote">${escapeHtml(epigraph.quote)}</span>${epigraph.source ? `<cite class="farewell-epigraph-source">${escapeHtml(epigraph.source)}</cite>` : ""}</blockquote></div>`;
}

export function publicFarewellPage({ publicFarewell, groups = [], updatedAt, preview = false }) {
  if (!publicFarewell || publicFarewell.status !== "PUBLIC_RELEASE") {
    return layout({
      title: "公开遗言",
      pageClass: "external public-page",
      body: `<section class="external-shell"><p class="eyebrow">AfterMe</p><h1>此页面暂未公开内容</h1><p>页面当前显示发布状态；公开后可在这里阅读。</p></section>`,
    });
  }

  return layout({
    title: "公开遗言",
    pageClass: "external public-page",
    body: `<section class="external-shell">
      ${preview ? `<div class="preview-banner">这是仅供管理页查看的正式版本预览。</div>` : ""}
      <p class="eyebrow">公开遗言</p>
      <h1>公开遗言</h1>
      <div class="reader-tools" aria-label="阅读设置"><button class="secondary" id="reader-smaller" aria-label="缩小字号">字 −</button><button class="secondary" id="reader-larger" aria-label="放大字号">字 ＋</button><button class="secondary" id="reader-theme">切换明暗</button><button class="secondary" id="reader-print">打印 / 保存 PDF</button></div>
      ${groups.length > 1 ? `<nav class="reader-toc" aria-label="章节目录"><details><summary>目录 · ${groups.length} 章</summary><ol>${groups.map((group, index) => `<li><a href="#chapter-${index + 1}">${escapeHtml(group.display_title)}</a></li>`).join('')}</ol></details></nav>` : ''}
      <section class="panel">
        ${groups.length ? groups.map((group, index) => `<article class="farewell-item" id="chapter-${index + 1}">
          <p class="eyebrow">${String(index + 1).padStart(2, "0")}</p>
          <h2>${escapeHtml(group.display_title)}</h2>
          ${publicEpigraphMarkup(group.display_epigraph)}
          ${group.entries.map((entry) => `<section class="farewell-entry">
            <div class="letter">${escapeHtml(entry.display_body)}</div>
          </section>`).join("")}
        </article>`).join("") : `<p>当前公开条目：0。</p>`}
      </section>
      ${readingVersionInfo({groups,updatedAt:updatedAt||publicFarewell.updated_at,date:formatDate})}
    </section><script>
      let readerSize = 19;
      document.getElementById('reader-smaller').addEventListener('click', () => { readerSize = Math.max(16, readerSize - 1); document.body.style.setProperty('--reader-size', readerSize + 'px'); });
      document.getElementById('reader-larger').addEventListener('click', () => { readerSize = Math.min(26, readerSize + 1); document.body.style.setProperty('--reader-size', readerSize + 'px'); });
      document.getElementById('reader-theme').addEventListener('click', () => document.body.classList.toggle('reader-light'));
      document.getElementById('reader-print').addEventListener('click', () => window.print());
    </script>`,
  });
}
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}


function mailPreviewCard(label, message) {
  return `<section class="panel">
    <p class="eyebrow">${escapeHtml(label)}</p>
    <h2>标题</h2>
    <pre>${escapeHtml(message.subject)}</pre>
    <h2>正文</h2>
    <pre>${escapeHtml(message.text)}</pre>
  </section>`;
}

function mailTemplateEditorMarkup(templates, tokenInput, adminField) {
  const entries = Object.values(templates || {});
  if (!entries.length) return `<p class="warning">邮件模板尚未初始化。</p>`;
  return `<div class="mail-template-list">
    ${entries.map((template, index) => {
      const recipientPlaceholder = template.key === "private_release" ? "{收件人姓名}" : "{联系人姓名}";
      return `<details class="mail-template-editor"${index === 0 ? " open" : ""}>
        <summary><span>${escapeHtml(template.label)}</span><small>${template.customized ? `自定义 · ${formatDate(template.updated_at)}` : "默认文案"}</small></summary>
        <div class="mail-template-body">
          <div class="placeholder-list"><code>{本人姓名}</code><code>${escapeHtml(recipientPlaceholder)}</code></div>
          <form method="post" action="/api/mail/templates" data-mail-template-form>
            ${tokenInput}${adminField}
            <input type="hidden" name="template_key" value="${escapeHtml(template.key)}">
            <label>邮件标题</label>
            <input name="subject_template" maxlength="200" value="${escapeHtml(template.subject_template)}" required>
            <label>邮件正文</label>
            <textarea name="body_template" maxlength="10000" required>${escapeHtml(template.body_template)}</textarea>
            <div class="mail-template-actions"><button type="submit">保存这封文案</button></div>
          </form>
          ${template.customized ? `<form method="post" action="/api/mail/templates/reset" data-mail-template-form>
            ${tokenInput}${adminField}
            <input type="hidden" name="template_key" value="${escapeHtml(template.key)}">
            <button class="secondary" type="submit">恢复默认</button>
          </form>` : ""}
        </div>
      </details>`;
    }).join("")}
    <p class="save-status" id="mail-template-save-status" aria-live="polite"></p>
  </div>`;
}

function hiddenAdmin(token) {
  return token ? `<input type="hidden" name="admin_token" value="${escapeHtml(token)}">` : "";
}

function adminTokenField() {
  return `<label>Admin token</label><input name="admin_token" type="password" autocomplete="current-password" required>`;
}

function option(value, current, label) {
  return `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(label)}</option>`;
}
function formatDate(value) {
  if (!value) return "暂无";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (UTC+8)`;
}
function releaseAtFor(releaseReadyAt, graceHours) {
  if (!releaseReadyAt) return null;
  const start = new Date(releaseReadyAt).getTime();
  return Number.isFinite(start) ? new Date(start + Number(graceHours) * 3600_000).toISOString() : null;
}
function contactEditor(contact, tokenInput, adminTokenFieldHtml) {
  const isActive = Number(contact.active) === 1;
  return `<form class="contact-editor" data-contact-form method="post" action="/api/contacts/${escapeHtml(contact.id)}">
    ${tokenInput}${adminTokenFieldHtml}
    <label class="contact-name">姓名<input name="name" value="${escapeHtml(contact.name)}" required></label>
    <label>邮箱<input name="email" type="email" value="${escapeHtml(contact.email)}" required></label>
    <label>内部备注<input name="role" value="${escapeHtml(contact.role)}"></label>
    <label>通知顺序<input name="priority" type="number" value="${escapeHtml(contact.priority)}"></label>
    <label>状态<select name="active"><option value="1"${isActive ? " selected" : ""}>启用</option><option value="0"${isActive ? "" : " selected"}>停用</option></select></label>
    <button type="submit">保存修改</button>
  </form>`;
}

function recipientEditor(recipient, tokenInput, adminTokenFieldHtml) {
  const isActive = Number(recipient.active) === 1;
  return `<form class="contact-editor" data-recipient-form method="post" action="/api/recipients/${escapeHtml(recipient.id)}">
    ${tokenInput}${adminTokenFieldHtml}
    <label class="contact-name">姓名<input name="name" value="${escapeHtml(recipient.name)}" required></label>
    <label>邮箱<input name="email" type="email" value="${escapeHtml(recipient.email)}" required></label>
    <label>内部备注<input name="note" value="${escapeHtml(recipient.note || "")}"></label>
    <label>状态<select name="active"><option value="1"${isActive ? " selected" : ""}>启用</option><option value="0"${isActive ? "" : " selected"}>停用</option></select></label>
    <button type="submit">保存修改</button>
  </form>`;
}

function privateLetterEditor(item, activeRecipients, tokenInput, adminTokenFieldHtml) {
  const recipientLabel = item.recipient_name || item.recipient_email || "未指定收件人";
  const savedAt = item.updated_at || item.created_at;
  const released = Boolean(item.released_at);
  const editable = !released && item.access_mode === "link" && typeof item.plaintext === "string";
  const previewable = item.access_mode === "link" && typeof item.plaintext === "string";
  const stateLabel = item.revoked_at ? '已撤回 · 后续投递已停止' : released ? `已释放 · ${formatDate(item.released_at)}` : item.decrypt_failed ? "内容读取失败" : item.access_mode !== "link" ? "独立口令密文 · 使用解锁工具处理" : `最后保存 · ${formatDate(savedAt)}`;
  const previewForm = previewable ? `<form class="private-pdf-preview-form" method="post" action="/api/items/${escapeHtml(item.id)}/pdf">
    ${tokenInput}${adminTokenFieldHtml}
    <button class="secondary" type="submit">在当前标签页预览 PDF</button>
  </form>` : "";
  return `<details class="private-letter-editor">
    <summary><strong>写给 ${escapeHtml(recipientLabel)}</strong><span>${escapeHtml(stateLabel)}</span></summary>
    <div class="private-letter-body">
      ${editable ? `<form method="post" action="/api/items/${escapeHtml(item.id)}" data-private-item-form>
        ${tokenInput}${adminTokenFieldHtml}
        <input type="hidden" name="expected_revision" value="${Number(item.revision || 0)}">
        <label>收件人</label>
        <select name="recipient_id" required>
          ${!activeRecipients.some(r => Number(r.id) === Number(item.recipient_id)) ? '<option value="" selected disabled>原收件人已停用，请重新选择</option>' : ''}
          ${activeRecipients.map((recipient) => `<option value="${escapeHtml(recipient.id)}"${Number(recipient.id) === Number(item.recipient_id) ? " selected" : ""}>${escapeHtml(recipient.name)} · ${escapeHtml(recipient.email)}</option>`).join("")}
        </select>
        <label>正文</label>
        <textarea name="plaintext" required>${escapeHtml(item.plaintext)}</textarea>
        <div class="private-letter-actions">
          <button type="submit">保存修改</button>
        </div>
      </form>${previewForm}` : previewable ? `<p class="private-letter-readonly">${escapeHtml(item.plaintext)}</p>${previewForm}` : `<p class="warning">请先核对信件状态与内容密钥，再使用对应工具处理。</p>`}
    </div>
    <form data-private-item-form method="post" action="/api/items/${escapeHtml(item.id)}/${item.revoked_at ? 'restore' : 'revoke'}">${tokenInput}${adminTokenFieldHtml}<p class="meta">撤回会关闭链接并停止后续投递，已经寄出的附件无法撤回。恢复后仍需满足释放条件。</p><button class="secondary" type="submit">${item.revoked_at ? '恢复这封信的释放资格' : '撤回这封信'}</button></form>
  </details>`;
}

function table(rows, columns) {
  if (!rows.length) return "<p>暂无。</p>";
  const labels = { name: '姓名', status: '状态', created_at: '时间', recipient_email: '收件邮箱', event_type: '事项', provider: '通道', last_error: '错误详情' };
  return `<div class="table-scroll"><table><thead><tr>${columns.map((c) => `<th>${escapeHtml(labels[c] || c)}</th>`).join("")}</tr></thead><tbody>
    ${rows.map((row) => `<tr>${columns.map((c) => `<td>${escapeHtml(c === 'created_at' ? formatDate(row[c]) : c === 'status' ? deliveryStatusLabel(row[c]) : c === 'event_type' ? ({ owner_overdue: '本人签到提醒', contact_alert: '联系人提醒', contact_verify: '联系人核验', private_letter_release: '私人信件送达', public_farewell_release: '公开遗言送达', mail_test: '发信测试', mail_healthcheck: '月度自检' })[row[c]] || row[c] : row[c] ?? "")}</td>`).join("")}</tr>`).join("")}
  </tbody></table></div>`;
}

function deliveryStatusLabel(status) {
  return ({ sent: '邮件服务已接收', dry_run: '演练已记录', pending: '等待投递', failed: '投递失败', uncertain: '结果不明，待核对', sending: '正在投递', skipped: '等待重新投递', cancelled: '已取消本次投递', manual: '需人工交付口令', confirmed_death: '已确认离世', unable_to_reach: '仍无法联系', false_alarm: '已确认安全' })[status] || status || '暂无';
}

function nextReminderAt(owner) {
  const hours = ({ NORMAL: 48, OVERDUE: 72, ALERT: 120 })[owner?.state];
  const last = new Date(owner?.last_checkin_at).getTime();
  return hours && Number.isFinite(last) ? new Date(last + hours * 3600_000).toISOString() : null;
}
