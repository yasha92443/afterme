// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from "node:test";
import assert from "node:assert/strict";
import { buildStoredPayload, inferAccessMode, openStoredPayload, storedPayloadMode } from "../src/content.js";

test("ordinary private items default to link mode and open without passphrase", async () => {
  const env = { ADMIN_TOKEN: "test-secret", CONTENT_ENCRYPTION_KEY: "independent-test-key" };
  const stored = await buildStoredPayload({ body: { title: "给朋友", plaintext: "一句普通真心话" }, env });
  assert.equal(storedPayloadMode(stored), "link");
  const opened = await openStoredPayload(stored, env);
  assert.deepEqual(opened, { mode: "link", plaintext: "一句普通真心话" });
});

test("sensitive items keep passphrase payloads", async () => {
  const encrypted = JSON.stringify({ v: 1, ciphertext: "abc" });
  const stored = await buildStoredPayload({ body: { access_mode: "passphrase", encrypted_payload: encrypted }, env: { ADMIN_TOKEN: "test-secret" } });
  assert.equal(inferAccessMode({ encrypted_payload: encrypted }), "passphrase");
  assert.equal(storedPayloadMode(stored), "passphrase");
  const opened = await openStoredPayload(stored, { ADMIN_TOKEN: "test-secret" });
  assert.equal(opened.mode, "passphrase");
  assert.equal(opened.encryptedPayload, encrypted);
});

test('chunk reads reuse an invocation key and still respect key replacement',async t=>{
  const original=crypto.subtle.importKey.bind(crypto.subtle);let imports=0;
  crypto.subtle.importKey=(...args)=>{imports++;return original(...args);};t.after(()=>{crypto.subtle.importKey=original;});
  const env={CONTENT_ENCRYPTION_KEY:'first content fixture key'},body={plaintext:'A'.repeat(128*1024)},stored=await buildStoredPayload({body,env});
  for(let i=0;i<10;i++)assert.equal((await openStoredPayload(stored,env)).plaintext,body.plaintext);
  assert.equal(imports,1);
  env.CONTENT_ENCRYPTION_KEY='replacement content fixture key';await buildStoredPayload({body,env});assert.equal(imports,2);
  await assert.rejects(openStoredPayload(stored,env),/内容密钥不匹配/);
  env.LEGACY_CONTENT_ENCRYPTION_KEY='first content fixture key';assert.equal((await openStoredPayload(stored,env)).plaintext,body.plaintext);
  assert.equal(imports,2);
  const malformed=JSON.parse(stored);malformed.ciphertext='!'+malformed.ciphertext;
  await assert.rejects(openStoredPayload(JSON.stringify(malformed),env));
});
