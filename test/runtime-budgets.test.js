// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import worker,{runScheduledCheck} from '../src/worker.js';
import {issueSession} from '../src/request-security.js';
import {measureDatabase} from '../src/metrics.js';
const allow={async limit(){return {success:true};}};
async function fixture(t){const db=database();t.after(()=>db.close());const env={DB:db,ADMIN_TOKEN:'runtime-fixture-admin',CONTENT_ENCRYPTION_KEY:'runtime-fixture-content',MAIL_PROVIDER:'dry-run',INBOUND_PROVIDER:'web',PDF_GENERATION_MODE:'browser',LOGIN_LIMITER:allow,VERIFY_LIMITER:allow,API_LIMITER:allow,READ_LIMITER:allow,EXPENSIVE_LIMITER:allow};const repo=new Repository(db);await repo.setupOwner({displayName:'Example',email:'owner@example.invalid',now:new Date().toISOString()});await repo.getSettings(env);await repo.getRoundRules(await repo.getOwner());return {db,repo,env};}
test('cookie-authenticated dashboard and settings need no more than three database round trips',async t=>{
 const {env}=await fixture(t),session=await issueSession(env);
 for(const path of ['/admin','/api/settings']){const response=await worker.fetch(new Request('https://example.test'+path,{headers:{Cookie:'afterme_session='+session.token}}),env);assert.equal(response.status,200);assert.ok(Number(response.headers.get('X-AfterMe-DB-Roundtrips'))<=3);assert.match(response.headers.get('Server-Timing'),/db_total;dur=/);if(path==='/admin')assert.ok((await response.arrayBuffer()).byteLength<=150*1024);}
});
test('public health reads one snapshot and reports stale snapshots as unavailable',async t=>{
 const {db,repo,env}=await fixture(t);await runScheduledCheck(repo,env,new Date());
 let calls=0;const original=db.prepare;db.prepare=function(sql){calls++;return original.call(db,sql);};
 let response=await worker.fetch(new Request('https://example.test/health/operational'),env);assert.equal(response.status,200);assert.equal(calls,1);assert.equal((await response.json()).checks.worker_reachable,true);
 const old=JSON.parse(await repo.getCursor('public-health'));old.snapshot_at=new Date(Date.now()-16*60000).toISOString();await repo.setCursor('public-health',JSON.stringify(old));calls=0;
 response=await worker.fetch(new Request('https://example.test/health/operational'),env);assert.equal(response.status,503);assert.ok(calls<=2);assert.equal((await response.json()).checks.cron_fresh,false);
});
test('database wall time does not double count concurrent reads',async()=>{
 const raw={prepare(){return {async all(){await new Promise(resolve=>setTimeout(resolve,20));return {results:[{value:1}]};}};}};
 const {db,stats}=measureDatabase(raw);await Promise.all([db.prepare('one').all(),db.prepare('two').all()]);assert.equal(stats.roundtrips,2);assert.equal(stats.queries,2);assert.ok(stats.db_ms>=stats.db_wall_ms*1.5);assert.ok(stats.db_wall_ms>=15);
});
