// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from "node:test";
import assert from "node:assert/strict";
import { buildGmailRawMessage } from "../src/mail.js";
import { buildPrivateLetterPdf } from "./helpers/pdf-fonts.js";

test("Gmail raw message contains a standards-compliant PDF attachment", () => {
  const pdf = buildPrivateLetterPdf({ ownerName: "示例用户", recipientName: "朋友", body: "正文" });
  const raw = buildGmailRawMessage({
    from: "afterme.fixture@gmail.com",
    to: "recipient@example.com",
    subject: "示例用户留给您的一封信",
    text: "请查看附件。",
    attachments: [{ filename: "示例用户留给您的一封信.pdf", contentType: "application/pdf", data: pdf }],
  });
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  assert.match(mime, /Content-Type: multipart\/mixed/);
  assert.match(mime, /Content-Type: application\/pdf/);
  assert.ok(mime.includes(`Content-Disposition: attachment; filename="attachment.pdf"; filename*=UTF-8''${encodeURIComponent('示例用户留给您的一封信.pdf')}`));
  const encoded = mime.match(/Content-Disposition: attachment[^\r\n]*\r\n\r\n([A-Za-z0-9+/=\r\n]+)\r\n--afterme_/);
  assert.ok(encoded, mime);
  assert.match(Buffer.from(encoded[1].replace(/\s/g, ""), "base64").toString("utf8"), /^%PDF-1.7/);
});

test('native MIME encoding preserves binary attachments and 76-character line boundaries',()=>{
  for(const length of [57,58,512*1024+1]){
    const bytes=Uint8Array.from({length},(_,i)=>i%256);
    const raw=buildGmailRawMessage({from:'sender@example.invalid',to:'reader@example.invalid',subject:'Unicode 文🙂',text:'Text 文🙂',attachments:[{filename:'example.pdf',contentType:'application/pdf',data:bytes}]});
    assert.match(raw,/^[A-Za-z0-9_-]+$/);
    const mime=Buffer.from(raw,'base64url').toString('utf8');assert.ok(mime.includes('Text 文🙂'));
    const encoded=mime.match(/Content-Disposition: attachment[^\r\n]*\r\n\r\n([A-Za-z0-9+/=\r\n]+)\r\n--afterme_/)[1];
    assert.ok(encoded.split('\r\n').every(line=>line.length<=76));
    assert.deepEqual(new Uint8Array(Buffer.from(encoded.replaceAll('\r\n',''),'base64')),bytes);
  }
});
