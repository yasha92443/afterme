// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('an old PDF worker event after pause and resume cannot terminate or complete a new worker task',async()=>{
  const source=await readFile(new URL('../src/pdf-browser-client.js',import.meta.url),'utf8'),workers=[];
  class FakeWorker{constructor(){workers.push(this);}postMessage(message){this.message=message;}terminate(){this.terminated=true;}}
  const window={dispatchEvent(){},addEventListener(){}};
  vm.runInNewContext(source,{window,Worker:FakeWorker,CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail;}},Uint8Array,Date,Map,Set,Promise,setTimeout,clearTimeout,btoa:value=>Buffer.from(value,'binary').toString('base64')});
  let id=0;window.aftermePdf.configure({api:async(path,method)=>{
    if(path.startsWith('/api/pdf-artifacts/targets'))return {results:[],next_cursor:null};
    if(path==='/api/pdf-artifacts')return {id:++id,status:'pending',max_bytes:1024,chunk_bytes:128};
    if(path.endsWith('/source'))return {kind:'private'};
    if(path.endsWith('/complete'))return {status:'ready'};
    if(method==='PUT')return {ok:true};
    throw Error('Unexpected fixture request');
  }});
  async function until(check){for(let i=0;i<30;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,0));}throw Error('Expected worker task was not started');}
  const first=window.aftermePdf.prepare({kind:'private',id:1});first.catch(()=>{});await until(()=>workers.length===1);
  window.aftermePdf.pause();await assert.rejects(first,/paused/);await window.aftermePdf.resume();
  const second=window.aftermePdf.prepare({kind:'private',id:2});await until(()=>workers.length===2);
  workers[0].onerror();assert.equal(workers[1].terminated,undefined);
  workers[0].onmessage({data:{id:workers[1].message.id,error:'obsolete worker message'}});
  workers[1].onmessage({data:{id:workers[1].message.id,bytes:new Uint8Array([1,2,3]).buffer,sha256:'synthetic'}});
  assert.equal((await second).status,'ready');assert.equal(workers[1].terminated,undefined);
});

async function clientFixture(api,{automaticWorker=true,version,networkTimeouts=false}={}){
  const source=await readFile(new URL('../src/pdf-browser-client.js',import.meta.url),'utf8');
  const workers=[],events=[],requests=[],listeners=new Map(),timers=new Map();let now=0,sequence=0;
  class FakeDate extends Date{static now(){return now;}}
  class FakeWorker{
    constructor(url){this.url=url;workers.push(this);}
    postMessage(message){this.message=message;if(automaticWorker)queueMicrotask(()=>this.complete());}
    complete(){this.onmessage({data:{id:this.message.id,bytes:new Uint8Array([1,2,3]).buffer,sha256:'synthetic'}});}
    terminate(){this.terminated=true;}
  }
  const window={dispatchEvent(event){events.push(event.detail);},addEventListener(name,callback){listeners.set(name,callback);}};
  vm.runInNewContext(source,{
    window,Worker:FakeWorker,CustomEvent:class{constructor(type,init){this.detail=init.detail;}},Uint8Array,Date:FakeDate,Map,Set,Promise,Blob,crypto,AbortController,
    setTimeout(callback,ms){const id=++sequence;timers.set(id,{callback,at:now+ms});return id;},clearTimeout(id){timers.delete(id);},
    btoa:value=>Buffer.from(value,'binary').toString('base64'),
  });
  window.aftermePdf.configure({api:async(path,method,body,raw,retry,options)=>{requests.push({path,method,body,raw,at:now});return api(path,method,body,raw,retry,options);},version,networkTimeouts});
  async function flush(){for(let i=0;i<100;i++)await Promise.resolve();}
  async function advance(ms){
    await flush();const end=now+ms;let steps=0;
    while(true){
      const next=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
      if(!next)break;assert.ok(++steps<10000,'fixture timer loop must remain bounded');
      now=next[1].at;timers.delete(next[0]);next[1].callback();await flush();
    }
    now=end;await flush();
  }
  function unload(){const event={preventDefault(){this.prevented=true;}};listeners.get('beforeunload')(event);return event;}
  return {window,workers,events,requests,timers,flush,advance,unload};
}

test('PDF client aggregates all public source fragments and announces ready only after server validation',async()=>{
  const paths=[],pages=[
    {fragments:[{group_id:7,entry_id:0,field:'display_title',text:'Chapter',offset:0,end_offset:7}],next_cursor:'title'},
    {fragments:[{group_id:7,entry_id:0,field:'display_epigraph',text:'Quote',offset:0,end_offset:5},{group_id:7,entry_id:8,field:'display_body',text:'First 😀',offset:0,end_offset:7}],next_cursor:'body'},
    {fragments:[{group_id:7,entry_id:8,field:'display_body',text:' second',offset:7,end_offset:14}],next_cursor:null},
  ];let poll=0;
  const f=await clientFixture(async(path,method)=>{
    paths.push(path);
    if(path==='/api/pdf-artifacts')return {id:'synthetic',status:'pending',max_bytes:1024,chunk_bytes:128};
    if(path.includes('/source'))return {kind:'public',source_revision:'revision',layout_key:'layout',options:{locale:'en'},...pages.shift()};
    if(method==='PUT')return {ok:true};
    if(path.endsWith('/complete'))return {status:'validating'};
    if(path==='/api/pdf-artifacts/synthetic')return {status:++poll>=2?'ready':'validating'};
    throw Error('Unexpected fixture request');
  });
  assert.equal((await f.window.aftermePdf.prepare({kind:'public',locale:'en'})).status,'validating');assert.equal(poll,0);
  await f.advance(15000);assert.equal(poll,1);await f.advance(30000);assert.equal(poll,2);
  const groups=f.workers[0].message.source.options.groups;assert.equal(groups.length,1);assert.equal(groups[0].display_title,'Chapter');assert.equal(groups[0].display_epigraph,'Quote');assert.equal(groups[0].entries[0].display_body,'First 😀 second');
  assert.ok(paths.includes('/api/pdf-artifacts/synthetic/source?cursor=body'));assert.deepEqual(f.events.map(e=>e.status),['pending','validating','ready']);
});

test('PDF client resumes validation without regenerating or uploading a frozen artifact',async()=>{
  const paths=[];let polls=0;
  const f=await clientFixture(async(path)=>{paths.push(path);if(path==='/api/pdf-artifacts')return {id:'frozen',status:'validating'};if(path==='/api/pdf-artifacts/frozen')return {status:++polls===2?'ready':'validating'};throw Error('A frozen artifact must only be polled');});
  assert.equal((await f.window.aftermePdf.prepare({kind:'private',id:1})).status,'validating');
  await f.window.aftermePdf.prepare({kind:'private',id:1});assert.equal(f.timers.size,1);
  await f.advance(45000);assert.equal(f.workers.length,0);assert.equal(polls,2);assert.equal(paths.length,4);
});

test('PDF client rejects a changed source snapshot or a missing fragment before generation',async()=>{
  for(const change of ['revision','offset']){
    let pages=0;
    const f=await clientFixture(async(path)=>{
      if(path==='/api/pdf-artifacts')return {id:'changed',status:'pending'};
      if(path.includes('/source')){pages++;return {kind:'public',source_revision:change==='revision'&&pages===2?'new':'old',layout_key:'layout',options:{},fragments:[{group_id:1,entry_id:2,field:'display_body',text:'text',offset:pages===1?0:change==='offset'?10:4,end_offset:pages===1?4:14}],next_cursor:pages===1?'next':null};}
      throw Error('Invalid pages must never be uploaded');
    });
    await assert.rejects(f.window.aftermePdf.prepare({kind:'public',locale:'en'}),change==='revision'?/source changed/:/page is incomplete/);assert.equal(f.workers.length,0);assert.equal(f.events.at(-1).status,'failed');
  }
});

function uploadApi(path,method){
  if(path.startsWith('/api/pdf-artifacts/targets'))return {results:[],next_cursor:null};
  if(path==='/api/pdf-artifacts')return {id:'synthetic',status:'pending',max_bytes:1024,chunk_bytes:128};
  if(path.endsWith('/source'))return {kind:'private'};
  if(path.endsWith('/complete'))return {status:'ready'};
  if(method==='PUT')return {ok:true};
  throw Error('Unexpected fixture request: '+path);
}

test('two uploaded PDFs validate independently and do not block the next generation or closing the tab',async()=>{
  let artifact=0;
  const f=await clientFixture((path,method)=>{
    if(path==='/api/pdf-artifacts')return {id:++artifact,status:'pending',max_bytes:1024,chunk_bytes:128};
    if(path.endsWith('/complete'))return {status:'validating'};
    if(/^\/api\/pdf-artifacts\/\d+$/.test(path))return {status:'validating'};
    return uploadApi(path,method);
  });
  const result=await Promise.all([f.window.aftermePdf.prepare({kind:'private',id:1}),f.window.aftermePdf.prepare({kind:'private',id:2})]);
  assert.deepEqual(result.map(r=>r.status),['validating','validating']);
  assert.equal(f.workers[0].message.id,2);assert.equal(f.requests.filter(r=>r.path.endsWith('/complete')).length,2);
  assert.equal(f.events.filter(e=>e.status==='validating').length,2);assert.equal(f.unload().prevented,undefined);
  await f.advance(15000);assert.equal(f.requests.filter(r=>/^\/api\/pdf-artifacts\/\d+$/.test(r.path)).length,2);
  f.window.aftermePdf.pause();assert.equal(f.timers.size,0);
});

test('resume subscribes all validating targets without waiting for any validation result',async()=>{
  const f=await clientFixture(path=>{
    if(path.startsWith('/api/pdf-artifacts/targets'))return {results:[{kind:'private',id:1},{kind:'public',locale:'ru'}],next_cursor:null};
    if(path==='/api/pdf-artifacts')return {id:'shared',status:'validating'};
    if(path==='/api/pdf-artifacts/shared')return {status:'ready'};
    throw Error('Unexpected fixture request');
  });
  await f.window.aftermePdf.resume();assert.equal(f.requests.length,3);assert.equal(f.timers.size,1);
  await f.advance(15000);assert.equal(f.events.filter(e=>e.status==='ready').length,2);assert.equal(f.workers.length,0);
});

test('validation continues beyond the former four-minute and 120-attempt limits',async()=>{
  let polls=0;
  const f=await clientFixture(path=>path==='/api/pdf-artifacts'?{id:'long',status:'validating'}:{status:++polls===130?'ready':'validating'});
  await f.window.aftermePdf.prepare({kind:'private',id:1});await f.advance(130*60000);
  assert.equal(polls,130);assert.equal(f.events.at(-1).status,'ready');assert.equal(f.timers.size,0);
  const requests=f.requests.filter(r=>r.path.endsWith('/long'));assert.deepEqual(requests.slice(0,3).map(r=>r.at),[15000,45000,105000]);
  assert.ok(requests.slice(3).every((r,i)=>r.at-requests[i+2].at===60000));
});

test('pause cancels observers and a late old response cannot overwrite the resumed artifact state',async()=>{
  let oldResponse,polls=0;
  const f=await clientFixture(path=>{
    if(path.startsWith('/api/pdf-artifacts/targets'))return {results:[{kind:'private',id:1}],next_cursor:null};
    if(path==='/api/pdf-artifacts')return {id:'same',status:'validating'};
    if(path==='/api/pdf-artifacts/same'&&++polls===1)return new Promise(resolve=>{oldResponse=resolve;});
    if(path==='/api/pdf-artifacts/same')return {status:'ready'};
    throw Error('Unexpected fixture request');
  });
  await f.window.aftermePdf.prepare({kind:'private',id:1});await f.advance(15000);
  f.window.aftermePdf.pause();await f.window.aftermePdf.resume();const count=f.events.length;
  oldResponse({status:'failed',last_error:'obsolete failure'});await f.flush();assert.equal(f.events.length,count);
  await f.advance(15000);assert.equal(f.events.at(-1).status,'ready');assert.equal(f.timers.size,0);
});

test('validation retries transient status errors but stops and reports a terminal artifact failure',async()=>{
  let polls=0;
  const f=await clientFixture(path=>{
    if(path==='/api/pdf-artifacts')return {id:'retry',status:'validating'};
    if(++polls===1)throw Error('temporary connection failure');
    return {status:'failed',last_error:'PDF integrity check failed'};
  });
  await f.window.aftermePdf.prepare({kind:'private',id:1});await f.advance(15000);
  assert.equal(f.events.at(-1).status,'validating');assert.match(f.events.at(-1).message,/temporary/);
  await f.advance(60000);assert.equal(f.events.at(-1).status,'failed');assert.match(f.events.at(-1).message,/integrity/);assert.equal(f.timers.size,0);
});

test('a terminal validation HTTP error is announced once and can be retried by resume',async()=>{
  let denied=true;
  const f=await clientFixture(path=>{
    if(path.startsWith('/api/pdf-artifacts/targets'))return {results:[{kind:'private',id:1}],next_cursor:null};
    if(path==='/api/pdf-artifacts')return {id:'denied',status:'validating'};
    if(denied)throw Object.assign(Error('artifact unavailable'),{status:404});
    return {status:'ready'};
  });
  await f.window.aftermePdf.prepare({kind:'private',id:1});await f.advance(15000);
  assert.equal(f.events.at(-1).status,'failed');assert.equal(f.timers.size,0);
  denied=false;await f.window.aftermePdf.resume();await f.advance(15000);assert.equal(f.events.at(-1).status,'ready');
});

test('all generation and observer requests share a strict 40 per minute sliding window',async()=>{
  const f=await clientFixture((path,method,body)=>path==='/api/pdf-artifacts'?{id:'artifact-'+body.id,status:'validating'}:{status:'validating'});
  const tasks=Array.from({length:41},(_,i)=>f.window.aftermePdf.prepare({kind:'private',id:i+1}));
  // Let the serial create calls reach the shared budget before advancing time.
  for(let i=0;i<10;i++)await f.flush();assert.equal(f.requests.length,40);
  await f.advance(120002);await Promise.all(tasks);
  for(const request of f.requests)assert.ok(f.requests.filter(r=>r.at<=request.at&&r.at>request.at-60000).length<=40);
  assert.equal(f.workers.length,0);f.window.aftermePdf.pause();assert.equal(f.timers.size,0);
});

test('beforeunload warns during local generation and incomplete upload, then clears after accepted validation',async()=>{
  const f=await clientFixture((path,method)=>path.endsWith('/complete')?{status:'validating'}:uploadApi(path,method),{automaticWorker:false});
  const task=f.window.aftermePdf.prepare({kind:'private',id:1});await f.flush();assert.equal(f.unload().prevented,true);
  f.workers[0].complete();assert.equal((await task).status,'validating');assert.equal(f.unload().prevented,undefined);
  f.window.aftermePdf.pause();
});

test('pause releases a stalled old resume and ignores its late targets page',async()=>{
  let oldPage,requests=0;
  const f=await clientFixture(path=>{
    assert.ok(path.startsWith('/api/pdf-artifacts/targets'));
    if(++requests===1)return new Promise(resolve=>{oldPage=resolve;});
    return {results:[],next_cursor:null};
  });
  const old=f.window.aftermePdf.resume();old.catch(()=>{});await f.flush();
  f.window.aftermePdf.pause();await f.window.aftermePdf.resume();assert.equal(requests,2);
  oldPage({results:[{kind:'private',id:99}],next_cursor:null});await assert.rejects(old,/paused/);assert.equal(f.events.length,0);
});

test('public resume notifications infer the formal revision only from a valid public source tuple',async()=>{
  for(const [source,expected] of [['[17,"2026-10-24T00:00:00.000Z"]',17],['[0,null]',0],['["17",null]',undefined],['[17]',undefined],['[17,null,"extra"]',undefined],['{"0":17}',undefined],['not json',undefined],['[-1,null]',undefined]]){
    const f=await clientFixture(path=>path==='/api/pdf-artifacts'?{id:'formal',status:'validating',source_revision:source}:{status:'ready'});
    const target={kind:'public',locale:'ru'};await f.window.aftermePdf.prepare(target);assert.equal(target.revision,undefined);
    await f.advance(15000);assert.equal(f.events.at(-1).status,'ready');assert.equal(f.events.at(-1).revision,expected);
  }
  for(const target of [{kind:'public',locale:'en',revision:12},{kind:'private',id:1}]){
    const f=await clientFixture(()=>({id:'ready',status:'ready',source_revision:'[17,null]'}));
    await f.window.aftermePdf.prepare(target);assert.equal(f.events.at(-1).revision,target.revision);
  }
});

test('many validation observers leave request capacity for the next PDF upload',async()=>{
  const f=await clientFixture((path,method,body)=>{
    if(path==='/api/pdf-artifacts'&&body.id<=40)return {id:'waiting-'+body.id,status:'validating'};
    if(path.startsWith('/api/pdf-artifacts/waiting-'))return {status:'validating'};
    if(path.endsWith('/complete'))return {status:'validating'};
    return uploadApi(path,method);
  });
  const existing=Array.from({length:40},(_,i)=>f.window.aftermePdf.prepare({kind:'private',id:i+1}));
  for(let i=0;i<10;i++)await f.flush();await Promise.all(existing);await f.advance(60001);
  assert.equal(f.requests.filter(r=>r.at===60001).length,32);
  assert.equal((await f.window.aftermePdf.prepare({kind:'private',id:41})).status,'validating');
  assert.equal(f.requests.at(-1).at,60001);assert.ok(f.requests.at(-1).path.endsWith('/complete'));
  f.window.aftermePdf.pause();
});

test('a late old upload cannot clear the new upload warning or delete its same-target task',async()=>{
  let oldSource,created=0;
  const f=await clientFixture((path,method)=>{
    if(path==='/api/pdf-artifacts')return {id:++created===1?'old':'new',status:'pending',max_bytes:1024,chunk_bytes:128};
    if(path==='/api/pdf-artifacts/old/source')return new Promise(resolve=>{oldSource=resolve;});
    return uploadApi(path,method);
  },{automaticWorker:false});
  const target={kind:'private',id:1},old=f.window.aftermePdf.prepare(target);old.catch(()=>{});await f.flush();
  f.window.aftermePdf.pause();await f.window.aftermePdf.resume();
  const current=f.window.aftermePdf.prepare(target);await f.flush();assert.equal(f.unload().prevented,true);
  oldSource({kind:'private'});await assert.rejects(old,/paused/);
  assert.equal(f.window.aftermePdf.prepare(target),current);assert.equal(f.unload().prevented,true);
  f.workers[0].complete();assert.equal((await current).status,'ready');assert.equal(f.unload().prevented,undefined);
  assert.equal(f.events.filter(event=>event.status==='failed').length,0);
});

test('PDF worker uses the configured encoded asset version and supports legacy callers without one',async()=>{
  const version='layout-8:client/2?x=1&locale=ru',f=await clientFixture(uploadApi,{version});
  await f.window.aftermePdf.prepare({kind:'private',id:1});
  assert.equal(f.workers[0].url,'/static/pdf-worker.js?v='+encodeURIComponent(version));
  f.window.aftermePdf.configure({api:uploadApi,version:'next-version'});
  await f.window.aftermePdf.prepare({kind:'private',id:1});
  assert.equal(f.workers[0].terminated,true);assert.equal(f.workers[1].url,'/static/pdf-worker.js?v=next-version');
  f.window.aftermePdf.configure({api:uploadApi});await f.window.aftermePdf.prepare({kind:'private',id:1});
  assert.equal(f.workers[2].url,'/static/pdf-worker.js');
});

test('authenticated dashboard HTML binds its PDF client URL and worker configuration to the current asset version',async t=>{
  const [{default:worker},{database},{Repository},{PDF_VERSION}]=await Promise.all([
    import('../src/worker.js'),import('./helpers/database.js'),import('../src/repository.js'),import('../src/pdf-layout.js'),
  ]);
  const db=database();t.after(()=>db.close());const repo=new Repository(db),allow={async limit(){return {success:true};}};
  const env={DB:db,ADMIN_TOKEN:'asset-version-fixture',MAIL_PROVIDER:'dry-run',LOGIN_LIMITER:allow,API_LIMITER:allow,VERIFY_LIMITER:allow,READ_LIMITER:allow,EXPENSIVE_LIMITER:allow};
  await repo.setupOwner({displayName:'Example',email:'owner@example.invalid',now:'2026-10-24T00:00:00.000Z'});
  const response=await worker.fetch(new Request('https://example.test/admin',{headers:{Authorization:'Bearer '+env.ADMIN_TOKEN}}),env);
  assert.equal(response.status,200);const html=await response.text(),src=html.match(/<script[^>]+src="([^\"]*pdf-client\.js[^\"]*)"/)?.[1];
  assert.ok(src);const url=new URL(src,'https://example.test'),version=url.searchParams.get('v');
  assert.equal(url.pathname,'/static/pdf-client.js');assert.equal(version,PDF_VERSION+'-client-v3');
  assert.ok(html.includes('"pdf_asset_version":'+JSON.stringify(version)));
  assert.match(html,/aftermePdf\?\.configure\(\{api,version:data\.pdf_asset_version,networkTimeouts:true\}\)/);
});

function previewBytes(size=16391){const bytes=new Uint8Array(size).fill(65);bytes.set(new TextEncoder().encode('%PDF-1.7\n'));bytes.set(new TextEncoder().encode('%%EOF\n'),size-6);return bytes;}
async function previewApi(bytes,{legacy=false,after,chunk}={}){
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
  const descriptor={artifact_id:'11111111-1111-4111-8111-111111111111',upload_revision:3,manifest_sha256:legacy?null:'a'.repeat(64),sha256:legacy?digest:'0'.repeat(64),total_bytes:bytes.length,chunk_bytes:16384,chunk_count:Math.ceil(bytes.length/16384),source_revision:'[1,"saved"]',layout_key:'saved-layout',kind:'private',item_id:1,locale:'en',filename:'synthetic.pdf'};
  let resolutions=0;
  const api=async(path,method,body,raw)=>{
    if(path==='/api/pdf-artifacts/preview'){assert.equal(method,'POST');assert.equal(body.kind,'private');return ++resolutions===1?descriptor:after?after(descriptor):{...descriptor};}
    const url=new URL(path,'https://example.invalid'),match=url.pathname.match(/\/chunks\/(\d+)$/);if(!match)throw Error('Unexpected preview request');
    const index=Number(match[1]),start=index*descriptor.chunk_bytes,data=bytes.subarray(start,Math.min(start+descriptor.chunk_bytes,bytes.length));
    assert.equal(raw,true);assert.equal(method,'GET');assert.equal(url.searchParams.get('revision'),String(descriptor.upload_revision));assert.equal(url.searchParams.get('pin'),descriptor.manifest_sha256||descriptor.sha256);
    const response=new Response(data,{headers:{'Content-Type':'application/octet-stream','X-AfterMe-Artifact':descriptor.artifact_id,'X-AfterMe-Chunk':String(index),ETag:`"${descriptor.upload_revision}-${descriptor.manifest_sha256||descriptor.sha256}"`,'Content-Range':`bytes ${start}-${start+data.length-1}/${bytes.length}`}});
    return chunk?chunk({index,response,descriptor,data}):response;
  };
  return {api,descriptor};
}

test('preview downloads pinned binary chunks and assembles a real PDF only after final source verification',async()=>{
  const bytes=previewBytes(),preview=await previewApi(bytes),f=await clientFixture(preview.api),progress=[];
  const blob=await f.window.aftermePdf.download({kind:'private',id:1},{onProgress:(done,total)=>progress.push([done,total])});
  assert.equal(blob.type,'application/pdf');assert.equal(blob.size,bytes.length);assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),bytes);
  assert.deepEqual(f.requests.map(request=>request.path.split('?')[0]),['/api/pdf-artifacts/preview','/api/pdf-artifacts/'+preview.descriptor.artifact_id+'/chunks/0','/api/pdf-artifacts/'+preview.descriptor.artifact_id+'/chunks/1','/api/pdf-artifacts/preview']);
  assert.equal(progress[0][0],0);assert.deepEqual(progress.at(-1),[bytes.length,bytes.length]);assert.equal(f.timers.size,0);assert.equal(f.unload().prevented,undefined);
});

test('a changed final source, wrong chunk epoch or incomplete block never returns a preview Blob',async()=>{
  for(const variant of ['source','epoch','short']){
    const bytes=previewBytes(),preview=await previewApi(bytes,{after:descriptor=>variant==='source'?{...descriptor,source_revision:'[2,"changed"]'}:descriptor,chunk:({index,response,descriptor,data})=>{
      if(index!==0)return response;
      if(variant==='epoch')response.headers.set('ETag','"different-artifact-epoch"');
      if(variant==='short')return new Response(data.subarray(0,-1),{headers:response.headers});
      return response;
    }}),f=await clientFixture(preview.api);
    await assert.rejects(f.window.aftermePdf.download({kind:'private',id:1}),variant==='source'?/source or layout changed/:variant==='epoch'?/chunk version changed/:/chunk is incomplete/);
    assert.equal(f.timers.size,0);
  }
});

test('legacy previews retain whole-file SHA256 verification in the browser',async()=>{
  const bytes=previewBytes(),preview=await previewApi(bytes,{legacy:true}),f=await clientFixture(preview.api);
  assert.deepEqual(new Uint8Array(await(await f.window.aftermePdf.download({kind:'private',id:1})).arrayBuffer()),bytes);
  const changed=await previewApi(bytes,{legacy:true,chunk:({index,response,data})=>{if(index===0){const altered=new Uint8Array(data);altered[100]=42;return new Response(altered,{headers:response.headers});}return response;}}),g=await clientFixture(changed.api);
  await assert.rejects(g.window.aftermePdf.download({kind:'private',id:1}),/integrity check failed/);
});

test('closing or pausing a download cancels it immediately and ignores a late binary response',async()=>{
  const bytes=previewBytes();let resolveChunk;
  const preview=await previewApi(bytes,{chunk:({response})=>new Promise(resolve=>{resolveChunk=()=>resolve(response);})}),f=await clientFixture(preview.api),controller=new AbortController();
  const pending=f.window.aftermePdf.download({kind:'private',id:1},{signal:controller.signal});pending.catch(()=>{});await f.flush();assert.equal(typeof resolveChunk,'function');controller.abort();await assert.rejects(pending,/cancelled/);resolveChunk();await f.flush();assert.equal(f.requests.length,2);assert.equal(f.timers.size,0);
  let complete;
  const again=await previewApi(bytes,{chunk:({response})=>new Promise(resolve=>{complete=()=>resolve(response);})}),g=await clientFixture(again.api),paused=g.window.aftermePdf.download({kind:'private',id:1});paused.catch(()=>{});await g.flush();g.window.aftermePdf.pause();await assert.rejects(paused,/cancelled|paused/);complete();await g.flush();assert.equal(g.requests.length,2);assert.equal(g.timers.size,0);
});

test('preview network deadlines are bounded without mistaking the shared rate-limit wait for a timeout',async()=>{
  const stalled=await clientFixture(()=>new Promise(()=>{})),pending=stalled.window.aftermePdf.download({kind:'private',id:1});pending.catch(()=>{});await stalled.flush();await stalled.advance(20001);await assert.rejects(pending,/timed out/);
  const bytes=previewBytes(42*16384),preview=await previewApi(bytes),f=await clientFixture(preview.api),download=f.window.aftermePdf.download({kind:'private',id:1});download.catch(()=>{});
  for(let i=0;i<30;i++)await f.flush();assert.equal(f.requests.length,40);assert.equal(f.timers.size,1,'only the shared request-budget wait remains');
  await f.advance(60001);const blob=await download;assert.equal(blob.size,bytes.length);assert.ok(f.requests.filter(request=>request.at===0).length<=40);assert.equal(f.timers.size,0);
});

test('the dashboard owns fetch deadlines so an interactive reauthentication wait can exceed twenty seconds',async()=>{
  const bytes=previewBytes(),preview=await previewApi(bytes);let resume;
  const f=await clientFixture((...args)=>args[0]==='/api/pdf-artifacts/preview'&&!resume?new Promise(resolve=>{resume=()=>resolve(preview.api(...args));}):preview.api(...args),{networkTimeouts:true});
  const download=f.window.aftermePdf.download({kind:'private',id:1});download.catch(()=>{});await f.flush();await f.advance(30000);
  assert.equal(f.requests.length,1);assert.equal(f.timers.size,0,'the API wrapper suspends its network deadline while showing login');resume();assert.equal((await download).size,bytes.length);
});

test('local public source export assembles every page without generating a PDF or requesting fonts',async()=>{
  const artifact={id:'source-version',source_revision:'[4,"saved"]',layout_key:'source-layout'},pages=[
    {fragments:[{group_id:7,entry_id:0,field:'display_title',text:'Chapter',offset:0,end_offset:7},{group_id:7,entry_id:8,field:'display_body',text:'First 😀',offset:0,end_offset:7}],next_cursor:'next'},
    {fragments:[{group_id:7,entry_id:8,field:'display_body',text:' second',offset:7,end_offset:14}],next_cursor:null},
  ];
  const f=await clientFixture(path=>path==='/api/pdf-artifacts'?{...artifact,status:'pending'}:{kind:'public',...artifact,options:{locale:'en',ownerName:'Example'},...pages.shift()});
  const doc=await f.window.aftermePdf.source({kind:'public'});assert.equal(doc.kind,'public');assert.equal(doc.formal,true);assert.equal(doc.options.groups[0].display_title,'Chapter');assert.equal(doc.options.groups[0].entries[0].display_body,'First 😀 second');assert.equal(f.workers.length,0);assert.equal(f.requests.length,4);assert.ok(f.requests[2].path.endsWith('/source?cursor=next'));assert.equal(f.timers.size,0);
});

test('local private source preserves its revision and source changes or pause never return a partial export',async()=>{
  const artifact={id:'private-source',source_revision:'[9,"saved","Reader","reader@example.invalid"]',layout_key:'layout'};
  const f=await clientFixture(path=>path==='/api/pdf-artifacts'?artifact:{kind:'private',...artifact,options:{body:'Saved letter'}}),doc=await f.window.aftermePdf.source({kind:'private',id:1});assert.equal(doc.kind,'private');assert.equal(doc.revision,9);assert.equal(doc.options.body,'Saved letter');assert.equal(f.workers.length,0);
  let reads=0;const changed=await clientFixture(path=>path==='/api/pdf-artifacts'?{...artifact,source_revision:++reads===1?artifact.source_revision:'[10,"changed"]'}:{kind:'private',...artifact,options:{body:'Saved letter'}});
  await assert.rejects(changed.window.aftermePdf.source({kind:'private',id:1}),/source or layout changed/);
  let finish;const paused=await clientFixture(path=>path==='/api/pdf-artifacts'?artifact:new Promise(resolve=>{finish=resolve;})),pending=paused.window.aftermePdf.source({kind:'private',id:1});pending.catch(()=>{});await paused.flush();paused.window.aftermePdf.pause();await assert.rejects(pending,/cancelled|paused/);finish({kind:'private',...artifact,options:{body:'Late'}});await paused.flush();assert.equal(paused.requests.length,2);
});
