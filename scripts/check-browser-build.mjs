// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import assert from 'node:assert/strict';
import {loadWorkerForTests} from './load-worker-for-tests.mjs';
import {database} from '../test/helpers/database.js';
import {Repository} from '../src/repository.js';

// Check rendered HTML from the deployable bundle, not source-only renderers.
const {default:worker,AfterMeRuntime}=await loadWorkerForTests(process.argv[2]||'output/build/worker.js');
const db=database(),repo=new Repository(db);
const allow={async limit(){return {success:true};}};
const env={DB:db,ADMIN_TOKEN:'build-fixture-only',CONTENT_ENCRYPTION_KEY:'build-content-only',MAIL_PROVIDER:'dry-run',INBOUND_PROVIDER:'web',LOGIN_LIMITER:allow,VERIFY_LIMITER:allow,API_LIMITER:allow,READ_LIMITER:allow,EXPENSIVE_LIMITER:allow};
if(AfterMeRuntime){env.EXECUTION_RUNTIME='durable-object';const object=new AfterMeRuntime({},env);env.APP_RUNTIME={getByName(){return object;}};}
let fontReads=0;
env.PDF_FONTS={async fetch(){fontReads++;throw Error('Navigation must not load the PDF font');}};
await repo.setupOwner({displayName:'Example',email:'owner@example.invalid',now:new Date().toISOString()});
try {
 for(const route of ['/','/admin','/admin/legacy']) {
  const response=await worker.fetch(new Request('https://afterme.example'+route,{headers:{Authorization:'Bearer '+env.ADMIN_TOKEN}}),env);
  assert.equal(response.status,200,route);
  const html=await response.text(),scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length,route+' has browser scripts');
  for(const [,attributes,code] of scripts){
   // esbuild's server-side keepNames annotations have no browser global.
   assert.doesNotMatch(code,/\b__(?:name|defProp)\b/,route+' must be independent of Worker build helpers');
   new Function(code);
   const nonce=attributes.match(/\bnonce="([^"]+)"/)?.[1];
   assert.ok(nonce&&response.headers.get('content-security-policy')?.includes("'nonce-"+nonce+"'"),route+' script is allowed by its CSP');
  }
 }
 assert.equal(fontReads,0);
 console.log(JSON.stringify({ok:true,routes:3,runtime:env.EXECUTION_RUNTIME||'worker',bundled_browser_scripts:true,pdf_font_reads:fontReads}));
} finally {db.close();}
