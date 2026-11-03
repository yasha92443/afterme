// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from "node:test";
import assert from "node:assert/strict";
import { mailPreviewPage, publicFarewellPage, verifyPage } from "../src/ui.js";
import { buildContactAlertMail, buildContactVerifyMail, buildPrivateReleaseMail, buildPublicReleaseMail } from "../src/mail-copy.js";
import worker from '../src/worker.js';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import {publicReadingPage} from '../src/external-pages.js';
import {buildPublicFarewellPdf,base64ToBytes,testFontAssets} from './helpers/pdf-fonts.js';
import {issueSession} from '../src/request-security.js';

test('formal reading pages preserve epigraphs and put metadata after uninterrupted content in every locale/theme',async()=>{
  const updatedAt='2026-07-10T00:00:00.000Z';
  const groups=[{display_title:'Example <b>',display_epigraph:'第一行 <script>\n\nSecond line\nТретья строка\n——作者 <b>',title_updated_at:updatedAt,epigraph_updated_at:updatedAt,entries:[{display_body:'第一段',body_updated_at:updatedAt},{display_body:'Second paragraph',body_updated_at:updatedAt}]}];
  for(const locale of ['zh','en','ru'])for(const theme of ['night','paper','contrast'])for(const preview of [true,false]){
    const html=await publicReadingPage({publicFarewell:{status:'PUBLIC_RELEASE'},groups,updatedAt,preview,preferences:{locale,theme,timezone:'UTC',font_size:18}}).text();
    assert.match(html,/<span class="farewell-epigraph-quote">第一行 &lt;script&gt;\n\nSecond line\nТретья строка<\/span>/);
    assert.match(html,/<cite class="farewell-epigraph-source">作者 &lt;b&gt;<\/cite>/);
    assert.match(html,/\.farewell-epigraph-quote\s*\{[^}]*white-space:\s*pre-wrap/);
    assert.equal(html.includes('href="/api/public-farewell/pdf"'),preview);
    assert.equal((html.match(/<details class="reader-version-info">/g)||[]).length,1);
    assert.doesNotMatch(html,/<details[^>]*reader-version-info[^>]*\sopen\b/);
    const article=html.match(/<article class="farewell-item"[\s\S]*?<\/article>/)[0];
    assert.doesNotMatch(article,/<details|<summary|class="meta"/);
    assert.ok(html.indexOf('<details class="reader-version-info">')>html.lastIndexOf('</article>'));
    assert.match(html.slice(html.indexOf('<details class="reader-version-info">')),/Example &lt;b&gt;/);
  }
});

test('unpublished farewell exposes neither content nor version metadata',async()=>{
  const html=await publicReadingPage({publicFarewell:{status:'DRAFT'},groups:[{display_title:'PRIVATE_CHAPTER',title_updated_at:'2026-07-10T00:00:00.000Z',entries:[{display_body:'PRIVATE_BODY'}]}],updatedAt:'2026-07-10T00:00:00.000Z',preferences:{locale:'zh',theme:'night',timezone:'UTC',font_size:18}}).text();
  assert.doesNotMatch(html,/PRIVATE_CHAPTER|PRIVATE_BODY|<details class="reader-version-info"/);
});

test('public PDF preview is authenticated, uses only formal cached content and never releases or sends',async t=>{
  const db=database();t.after(()=>db.close());
  const repo=new Repository(db),env={PDF_FONTS:testFontAssets,DB:db,ALLOW_LOCAL_RATE_LIMIT_FALLBACK:true,ADMIN_TOKEN:'pdf-fixture',CONTENT_ENCRYPTION_KEY:'pdf-content',MAIL_PROVIDER:'dry-run',INBOUND_PROVIDER:'web'},now=new Date().toISOString();
  await repo.setupOwner({displayName:'Example',email:'owner@example.invalid',now});
  const id=await repo.farewell.createGroup({title:'Formal chapter',now});
  await repo.farewell.saveGroupDraft({id,title:'Formal chapter',epigraph:'第一行\nSecond line\n——Автор',now});
  await repo.farewell.createEntry({groupId:id,body:'Formal body',isPublic:true,now});
  await repo.farewell.applyDraft({now});
  await repo.farewell.saveGroupDraft({id,title:'UNAPPLIED DRAFT',epigraph:'UNAPPLIED EPIGRAPH',now});
  const settings=await repo.getSettings(env),owner=await repo.getOwner(),document=await repo.getPublicFarewell(),draftState=await repo.farewell.rawState();
  const expected=buildPublicFarewellPdf({ownerName:owner.display_name,groups:await repo.farewell.listFormalGroups(),updatedAt:document.updated_at,locale:settings.preferences.locale,timezone:settings.preferences.timezone,style:settings.preferences.pdf_style});
  const url='https://example.test/api/public-farewell/pdf';
  for(const method of ['GET','POST'])assert.equal((await worker.fetch(new Request(url,{method}),env)).status,401);
  const session=await issueSession(env);
  assert.equal((await worker.fetch(new Request(url,{method:'POST',headers:{Cookie:'afterme_session='+session.token,'Content-Type':'application/json'},body:'{}'}),env)).status,403);
  for(const method of ['GET','POST']){
    const response=await worker.fetch(new Request(url,{method,headers:{Authorization:'Bearer '+env.ADMIN_TOKEN}}),env);
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/pdf');
    assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('content-disposition'),/^inline;/);
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.equal(response.headers.get('x-frame-options'),'DENY');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()),expected);
  }
  assert.deepEqual(base64ToBytes((await repo.getDocumentArtifact('public_farewell')).content_base64),expected);
  assert.deepEqual(await repo.getOwner(),owner);assert.deepEqual(await repo.getPublicFarewell(),document);
  assert.deepEqual(await repo.farewell.rawState(),draftState);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM delivery_log').first()).count,0);
  const html=await (await worker.fetch(new Request('https://example.test/api/public-farewell/preview',{headers:{Authorization:'Bearer '+env.ADMIN_TOKEN}}),env)).text();
  assert.match(html,/<span class="farewell-epigraph-quote">第一行\nSecond line<\/span>/);
  assert.doesNotMatch(html,/UNAPPLIED/);
  for(const method of ['GET','POST']){
    const sourceUrl='https://example.test/api/public-farewell/pdf-source';
    assert.equal((await worker.fetch(new Request(sourceUrl,{method}),env)).status,401);
    const response=await worker.fetch(new Request(sourceUrl,{method,headers:{Authorization:'Bearer '+env.ADMIN_TOKEN}}),env);
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    const doc=await response.json();assert.equal(doc.kind,'public');assert.equal(doc.formal,true);
    assert.doesNotMatch(JSON.stringify(doc),/UNAPPLIED|draft_|encrypted_payload/);
    assert.deepEqual(buildPublicFarewellPdf(doc.options),expected);
  }
});

test('private local PDF source decrypts only the requested saved letter and retains recipient locale',async t=>{
  const db=database();t.after(()=>db.close());const repo=new Repository(db),env={PDF_FONTS:testFontAssets,DB:db,ALLOW_LOCAL_RATE_LIMIT_FALLBACK:true,ADMIN_TOKEN:'local-pdf-fixture',CONTENT_ENCRYPTION_KEY:'local-content',MAIL_PROVIDER:'dry-run'},now=new Date().toISOString();
  await repo.setupOwner({displayName:'Example',email:'owner@example.invalid',now});
  const recipient=await repo.createRecipient({name:'Friend',email:'friend@example.invalid',now});
  await db.prepare("UPDATE recipients SET locale='ru' WHERE id=?").bind(recipient).run();
  const {buildStoredPayload}=await import('../src/content.js');
  const payload=await buildStoredPayload({body:{plaintext:'正文 123. Привет.'},env});
  const id=await repo.createEncryptedItem({kind:'letter',title:'Private',recipientId:recipient,encryptedPayload:payload,payloadSize:payload.length,vaultToken:'fixture-token',vaultTokenHash:'fixture-hash',updatedAt:now});
  const path='https://example.test/api/items/'+id+'/pdf-source';
  assert.equal((await worker.fetch(new Request(path),env)).status,401);
  const response=await worker.fetch(new Request(path,{headers:{Authorization:'Bearer '+env.ADMIN_TOKEN}}),env);assert.equal(response.status,200);
  const doc=await response.json();assert.equal(doc.kind,'private');assert.equal(doc.options.body,'正文 123. Привет.');assert.equal(doc.options.locale,'ru');assert.equal(doc.options.recipientName,'Friend');
  assert.equal((await worker.fetch(new Request('https://example.test/api/items/99999/pdf-source',{headers:{Authorization:'Bearer '+env.ADMIN_TOKEN}}),env)).status,404);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM delivery_log').first()).count,0);
});

test('HTML previews remain authenticated and render without sending or publishing', async () => {
  const db=database(),repo=new Repository(db),env={PDF_FONTS:testFontAssets,DB:db,ALLOW_LOCAL_RATE_LIMIT_FALLBACK:true,ADMIN_TOKEN:'preview-fixture',MAIL_PROVIDER:'dry-run',INBOUND_PROVIDER:'web'};
  try {
    await repo.setupOwner({displayName:'Example',email:'owner@example.invalid',now:new Date().toISOString()});
    const before=await repo.getOwner();
    for(const route of ['/api/mail/preview','/api/public-farewell/preview']) {
      const denied=await worker.fetch(new Request('https://afterme.example'+route),env);
      assert.equal(denied.status,401);
      const response=await worker.fetch(new Request('https://afterme.example'+route,{headers:{Authorization:'Bearer '+env.ADMIN_TOKEN}}),env);
      assert.equal(response.status,200);
      assert.match(response.headers.get('content-type'),/text\/html/);
      assert.ok(response.headers.get('content-security-policy'));
    }
    assert.deepEqual(await repo.getOwner(),before);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM delivery_log').first()).count,0);
    assert.notEqual((await repo.getPublicFarewell())?.status,'PUBLIC_RELEASE');
  } finally {db.close();}
});

test("legacy public farewell keeps all timestamp labels in a single collapsed footer", async () => {
  const response = publicFarewellPage({
    publicFarewell: {
      title: "旧的自定义标题",
      status: "PUBLIC_RELEASE",
      updated_at: "2026-07-10T00:00:00.000Z",
    },
    updatedAt: "2026-07-10T00:00:00.000Z",
    groups: [{
      id: 1,
      display_title: "关于朋友",
      display_epigraph: "真正严肃的哲学问题只有一个。\n——加缪",
      epigraph_updated_at: "2026-07-08T12:00:00.000Z",
      title_updated_at: "2026-07-09T00:00:00.000Z",
      entries: [{
        id: 4,
        display_body: "谢谢。",
        body_updated_at: "2026-07-08T00:00:00.000Z",
      }],
    }],
  });
  const html = await response.text();
  assert.match(html, /<h1>公开遗言<\/h1>/);
  assert.doesNotMatch(html, /旧的自定义标题/);
  assert.match(html, /公开内容最后更新：2026-07-10 08:00 \(UTC\+8\)/);
  assert.match(html, /分组标题最后更新：2026-07-09 08:00 \(UTC\+8\)/);
  assert.match(html, /真正严肃的哲学问题只有一个/);
  assert.match(html, /class="farewell-epigraph-source">加缪<\/cite>/);
  assert.doesNotMatch(html, />——加缪</);
  assert.match(html, /text-align: right/);
  assert.match(html, /章首题辞最后更新：2026-07-08 20:00 \(UTC\+8\)/);
  assert.match(html, /本条正文最后更新：2026-07-08 08:00 \(UTC\+8\)/);
  assert.match(html, /谢谢。/);
  assert.equal((html.match(/<details class="reader-version-info">/g)||[]).length,1);
  assert.ok(html.indexOf('<details class="reader-version-info">')>html.lastIndexOf('</article>'));
  assert.doesNotMatch(html.match(/<article class="farewell-item"[\s\S]*?<\/article>/)[0],/<details|class="meta"/);
});

test("public farewell preview is clearly marked as a formal private preview", async () => {
  const response = publicFarewellPage({
    publicFarewell: { status: "PUBLIC_RELEASE", updated_at: "2026-07-10T00:00:00.000Z" },
    groups: [],
    updatedAt: "2026-07-10T00:00:00.000Z",
    preview: true,
  });
  const html = await response.text();
  assert.match(html, /正式版本预览/);
  assert.match(html, /仅供管理页查看/);
});

test("public farewell follows explicit group and entry order", async () => {
  const response = publicFarewellPage({
    publicFarewell: { status: "PUBLIC_RELEASE", updated_at: "2026-07-10T00:00:00.000Z" },
    groups: [
      {
        id: 2,
        display_title: "关于朋友们",
        title_updated_at: "2026-07-10T00:00:00.000Z",
        entries: [
          { id: 3, display_body: "后来补充的第二段。", body_updated_at: "2026-07-10T00:00:00.000Z" },
          { id: 1, display_body: "最早添加的第一段。", body_updated_at: "2026-07-09T00:00:00.000Z" },
        ],
      },
      {
        id: 1,
        display_title: "关于家人",
        title_updated_at: "2026-07-10T00:00:00.000Z",
        entries: [{ id: 2, display_body: "另一组。", body_updated_at: "2026-07-10T00:00:00.000Z" }],
      },
    ],
    updatedAt: "2026-07-10T00:00:00.000Z",
  });
  const html = await response.text();
  assert.equal((html.match(/<h2>关于朋友们<\/h2>/g) || []).length, 1);
  assert.ok(html.indexOf("后来补充的第二段。") < html.indexOf("最早添加的第一段。"));
  assert.ok(html.indexOf("关于朋友们") < html.indexOf("关于家人"));
});

test("mail preview renders the exact production templates without sending", async () => {
  const response = mailPreviewPage({
    alert: buildContactAlertMail({ ownerName: "示例用户", contactName: "联系人姓名" }),
    verify: buildContactVerifyMail({
      ownerName: "示例用户",
      contactName: "联系人姓名",
      verificationUrl: "https://afterme.example/verify/[专属链接]",
    }),
    publicMail: buildPublicReleaseMail({ ownerName: "示例用户", contactName: "联系人姓名" }),
    privateMail: buildPrivateReleaseMail({
      ownerName: "示例用户",
      recipientName: "收件人姓名",
      vaultUrl: "https://afterme.example/vault/[私人信件链接]",
    }),
  });
  const html = await response.text();
  assert.match(html, /以下标题和正文直接由正式发送所使用的模板生成/);
  assert.match(html, /请尝试联系示例用户/);
  assert.match(html, /关于示例用户：请提交您掌握的情况/);
  assert.match(html, /公开遗言送达/);
  assert.match(html, /示例用户的公开遗言/);
  assert.match(html, /示例用户留给您的一封信/);
  assert.match(html, /供您逐项核对/);
});

test("contact verification page shows the 120-hour verification threshold", async () => {
  const response = verifyPage({
    contact: { name: "测试联系人" },
    owner: { display_name: "示例用户" },
  });
  const html = await response.text();
  assert.match(html, /示例用户已经连续 120 小时没有完成状态确认/);
  assert.doesNotMatch(html, /72小时联系不上/);
});
