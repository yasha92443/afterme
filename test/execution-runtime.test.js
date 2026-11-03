// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {createEdgeHandler,createDurableRuntimeClass,RUNTIME_OBJECT_NAME} from '../src/execution-runtime.js';
import {database} from './helpers/database.js';

class Base {constructor(ctx,env){this.ctx=ctx;this.env=env;}}
function fixture(t) {
  const db=database();t.after(()=>db.close());
  const calls={limits:0,objects:[],rejections:0};
  const env={DB:db,ADMIN_TOKEN:'runtime-synthetic-admin',EXECUTION_RUNTIME:'durable-object',MAIL_PROVIDER:'dry-run'};
  const limiter={async limit(){calls.limits++;return {success:true};}};
  Object.assign(env,{LOGIN_LIMITER:limiter,API_LIMITER:limiter,READ_LIMITER:limiter,VERIFY_LIMITER:limiter,EXPENSIVE_LIMITER:limiter});
  const Runtime=createDurableRuntimeClass(Base),object=new Runtime({},env);
  env.APP_RUNTIME={getByName(name){calls.objects.push(name);return object;}};
  return {env,db,calls,object,edge:createEdgeHandler()};
}

test('DO login uses one native edge limit and the real revocable session path',async t=>{
  const {env,db,calls,edge}=fixture(t);
  const response=await edge.fetch(new Request('https://afterme.example/api/session',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://afterme.example'},body:JSON.stringify({admin_token:env.ADMIN_TOKEN})}),env);
  assert.equal(response.status,200);
  assert.equal(calls.limits,1);
  assert.deepEqual(calls.objects,[RUNTIME_OBJECT_NAME]);
  assert.match(response.headers.get('Set-Cookie'),/HttpOnly; SameSite=Strict/);
  const body=await response.json();assert.ok(body.csrf&&body.token);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM admin_sessions').first()).n,1);
});

test('caller headers cannot bypass edge rate limiting or create per-user objects',async t=>{
  const {env,calls,edge}=fixture(t);env.LOGIN_LIMITER={async limit(){return {success:false};}};
  for(const name of ['x-rate-limited','x-afterme-runtime','x-internal-tick']) {
    const request=new Request('https://afterme.example/api/session?EXECUTION_RUNTIME=worker',{method:'POST',headers:{[name]:'true','Content-Type':'application/json'},body:'{}'});
    assert.equal((await edge.fetch(request,env)).status,429);
  }
  assert.deepEqual(calls.objects,[]);
});

test('edge rejects unavailable native binding and unavailable DO without direct fallback',async t=>{
  const {env,calls,edge}=fixture(t);delete env.LOGIN_LIMITER;
  assert.equal((await edge.fetch(new Request('https://afterme.example/api/session'),env)).status,503);
  assert.deepEqual(calls.objects,[]);
  delete env.APP_RUNTIME;
  assert.equal((await edge.fetch(new Request('https://afterme.example/health'),env)).status,503);
});

test('misspelled runtime mode fails closed instead of silently returning to the CPU-limited worker',async t=>{
  const {env,edge,calls}=fixture(t);env.EXECUTION_RUNTIME='durable-objects';
  assert.equal((await edge.fetch(new Request('https://afterme.example/health'),env)).status,503);
  await assert.rejects(edge.scheduled({cron:'* * * * *'},env),/Invalid application runtime/);
  assert.deepEqual(calls.objects,[]);
});

test('DO preserves cookie CSRF and origin checks while streaming the request body',async t=>{
  const {env,edge}=fixture(t),origin='https://afterme.example';
  const login=await edge.fetch(new Request(origin+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({admin_token:env.ADMIN_TOKEN})}),env);
  const {token}=await login.json();
  const response=await edge.fetch(new Request(origin+'/api/checkin',{method:'POST',headers:{Cookie:'afterme_session='+token,Origin:origin,'Content-Type':'application/json'},body:'{}'}),env);
  assert.equal(response.status,403);
  assert.match((await response.json()).message,/CSRF/);
  const crossOrigin=await edge.fetch(new Request(origin+'/api/session',{method:'POST',headers:{Origin:'https://elsewhere.example','Content-Type':'application/json'},body:JSON.stringify({admin_token:env.ADMIN_TOKEN})}),env);
  assert.equal(crossOrigin.status,403);
});

test('Cron is a binding RPC and HTTP cannot select a scheduled method',async t=>{
  const {env,edge}=fixture(t),received=[];
  env.APP_RUNTIME={getByName(name){assert.equal(name,RUNTIME_OBJECT_NAME);return {runScheduled(controller){received.push(controller);}};}};
  await edge.scheduled({cron:'*/2 * * * *',scheduledTime:1234},env);
  assert.deepEqual(received,[{cron:'*/2 * * * *',scheduledTime:1234}]);
  const separate=fixture(t);
  for(const path of ['/runScheduled','/__tick','/stage/tick'])assert.equal((await separate.edge.fetch(new Request('https://afterme.example'+path),separate.env)).status,404);
});

test('overlapping DO requests and Cron receive independent invocation environments',async()=>{
  const seen=[],releases=[];
  const app={async fetch(req,env,options){env.INVOCATION_BUDGET={id:req.url};seen.push({env,options});await new Promise(resolve=>releases.push(resolve));return new Response('ok');},async scheduled(controller,env){env.INVOCATION_BUDGET={id:controller.cron};seen.push({env});}};
  const Runtime=createDurableRuntimeClass(Base,app),original={DB:{},MAIL_PROVIDER:'dry-run'},object=new Runtime({},original);
  const a=object.fetch(new Request('https://afterme.example/a')),b=object.fetch(new Request('https://afterme.example/b'));
  await object.runScheduled({cron:'* * * * *'});
  assert.equal(new Set(seen.map(row=>row.env)).size,3);
  assert.equal(new Set(seen.map(row=>row.env.INVOCATION_BUDGET)).size,3);
  assert.equal(original.INVOCATION_BUDGET,undefined);
  assert.deepEqual(seen[0].options,{rateLimited:true});
  releases.forEach(resolve=>resolve());await Promise.all([a,b]);
});

test('a rejected burst schedules at most one sampled security RPC per edge minute',async t=>{
  const {env,edge}=fixture(t),pending=[];let reports=0;
  env.LOGIN_LIMITER={async limit(){return {success:false};}};
  env.APP_RUNTIME={getByName(){return {recordRejection(){reports++;return Promise.resolve();}};}};
  for(let n=0;n<20;n++)assert.equal((await edge.fetch(new Request('https://afterme.example/api/session'),env,{waitUntil(p){pending.push(p);}})).status,429);
  await Promise.all(pending);assert.equal(reports,1);
});

test('direct compatibility mode retains rate limiting and does not require a DO binding',async t=>{
  const {env,edge,calls}=fixture(t);delete env.EXECUTION_RUNTIME;delete env.APP_RUNTIME;
  assert.equal((await edge.fetch(new Request('https://afterme.example/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({admin_token:env.ADMIN_TOKEN})}),env)).status,200);
  assert.equal(calls.limits,1);assert.deepEqual(calls.objects,[]);
});
