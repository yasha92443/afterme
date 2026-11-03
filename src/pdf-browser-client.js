// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
const pending=new Map();let worker,sequence=0,apiCall,apiOwnsTimeouts=false,assetVersion='',paused=false,epoch=0;
const requestTimes=[],waits=new Set();
const isActive=currentEpoch=>!paused&&epoch===currentEpoch;
function assertActive(currentEpoch){if(!isActive(currentEpoch))throw Error('PDF preparation paused; sign in again to resume');}
function wait(ms,currentEpoch,download){
  assertActive(currentEpoch);
  if(download?.cancelled)throw Error('PDF download cancelled');
  return new Promise((resolve,reject)=>{
    const clean=()=>{waits.delete(task);download?.handlers.delete(cancel);clearTimeout(task.timer);};
    const cancel=()=>{clean();reject(Error('PDF download cancelled'));};
    const task={reject:error=>{clean();reject(error);},timer:setTimeout(()=>{clean();resolve();},ms)};
    waits.add(task);download?.handlers.add(cancel);
  });
}
async function request(path,method,body,currentEpoch=epoch,background=false,raw=false,download){
  // Generation, uploads and all observers share this sliding-window budget.
  // Recheck after each wait: many observers may wake at the same instant.
  while(true){
    assertActive(currentEpoch);
    if(download?.cancelled)throw Error('PDF download cancelled');
    const now=Date.now();while(requestTimes.length&&now-requestTimes[0]>=60000)requestTimes.shift();
    // Status observers leave room for new work; during an upload they yield
    // most of the budget rather than starving its next chunk indefinitely.
    const limit=background?(uploads.size||downloads.size?8:32):40;
    if(requestTimes.length<limit){requestTimes.push(now);break;}
    await wait(Math.max(1,60001-(now-requestTimes[0])),currentEpoch,download);
  }
  const call=()=>apiCall(path,method,body,raw,true,download?{signal:download.controller.signal,timeoutMs:20000}:undefined);
  const result=download?await downloadRequest(call,download,apiOwnsTimeouts?0:20000):await call();assertActive(currentEpoch);return result;
}
function notify(target,status,message){window.dispatchEvent(new CustomEvent('afterme:pdf',{detail:{...target,status,message}}));}
function generate(source){
  if(!worker){
    const currentWorker=worker=new Worker('/static/pdf-worker.js'+(assetVersion?'?v='+encodeURIComponent(assetVersion):''));
    currentWorker.onmessage=event=>{if(worker!==currentWorker)return;const {id,bytes,sha256,error}=event.data,task=pending.get(id);if(!task)return;pending.delete(id);error?task.reject(Error(error)):task.resolve({bytes:new Uint8Array(bytes),sha256});};
    currentWorker.onerror=()=>{if(worker!==currentWorker)return;for(const task of pending.values())task.reject(Error('PDF worker failed; the saved text is safe'));pending.clear();currentWorker.terminate();worker=null;};
  }
  const id=++sequence;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});worker.postMessage({id,source});});
}
function encode(bytes){const parts=[];for(let i=0;i<bytes.length;i+=32768)parts.push(String.fromCharCode(...bytes.subarray(i,i+32768)));return btoa(parts.join(''));}
const active=new Map(),uploads=new Set(),observers=new Map(),downloads=new Set();let queue=Promise.resolve();
const targetKey=target=>JSON.stringify([target.kind,target.id||0,target.locale||'',target.revision??null]);
function artifactTarget(target,artifact){
  if(target.kind!=='public'||target.revision!=null||typeof artifact.source_revision!=='string'||artifact.source_revision.length>256)return target;
  try{
    const source=JSON.parse(artifact.source_revision);
    if(Array.isArray(source)&&source.length===2&&Number.isSafeInteger(source[0])&&source[0]>=0&&(source[1]===null||(typeof source[1]==='string'&&source[1].length<=80)))return {...target,revision:source[0]};
  }catch{}
  return target;
}
async function readSource(artifact,call){
  let source=await call('/api/pdf-artifacts/'+artifact.id+'/source');
  if(!Array.isArray(source.fragments))return source;
  const initial=source,groups=new Map(),offsets=new Map(),cursors=new Set();
  while(true){
    if(source.kind!=='public'||source.source_revision!==initial.source_revision||source.layout_key!==initial.layout_key)throw Error('PDF source changed while loading; prepare the current saved version');
    for(const fragment of source.fragments){
      if(!['display_title','display_epigraph','display_body'].includes(fragment.field)||!Number.isSafeInteger(fragment.offset)||!Number.isSafeInteger(fragment.end_offset)||fragment.end_offset<fragment.offset||typeof fragment.text!=='string')throw Error('Invalid PDF source page');
      let group=groups.get(fragment.group_id);if(!group){group={id:fragment.group_id,display_title:'',display_epigraph:'',title_updated_at:fragment.title_updated_at,epigraph_updated_at:fragment.epigraph_updated_at,entries:[],entryMap:new Map()};groups.set(fragment.group_id,group);}
      let target=group;
      if(fragment.field==='display_body'){
        target=group.entryMap.get(fragment.entry_id);if(!target){target={id:fragment.entry_id,display_body:'',body_updated_at:fragment.body_updated_at};group.entryMap.set(fragment.entry_id,target);group.entries.push(target);}
      }
      const key=fragment.group_id+':'+fragment.entry_id+':'+fragment.field,expected=offsets.get(key)||0;
      if(fragment.offset!==expected)throw Error('PDF source page is incomplete');
      target[fragment.field]+=fragment.text;offsets.set(key,fragment.end_offset);
    }
    if(source.next_cursor===null)break;
    if(typeof source.next_cursor!=='string'||cursors.has(source.next_cursor))throw Error('PDF source cursor did not advance');
    cursors.add(source.next_cursor);source=await call('/api/pdf-artifacts/'+artifact.id+'/source?cursor='+encodeURIComponent(source.next_cursor));
  }
  return {...initial,options:{...initial.options,groups:[...groups.values()].map(({entryMap,...group})=>group)}};
}
function observeValidation(target,artifact,currentEpoch){
  assertActive(currentEpoch);
  if(!['pending','validating'].includes(artifact.status))throw Error(artifact.last_error||'PDF validation failed; the saved text is safe');
  const id=String(artifact.id),key=targetKey(target);let observer=observers.get(id);
  if(observer?.epoch===currentEpoch){if(!observer.targets.has(key)){observer.targets.set(key,target);notify(target,'validating');}return;}
  observer={epoch:currentEpoch,targets:new Map([[key,target]])};observers.set(id,observer);notify(target,'validating');
  const announce=(status,message)=>{if(isActive(currentEpoch))for(const target of observer.targets.values())notify(target,status,message);};
  // Server validation is durable. It must not hold the generation/upload queue
  // or prevent closing the tab; an open tab observes it without an attempt cap.
  observer.task=(async()=>{
    let interval=15000;
    try{
      while(isActive(currentEpoch)){
        await wait(interval,currentEpoch);
        let result;
        try{result=await request('/api/pdf-artifacts/'+id,undefined,undefined,currentEpoch,true);}
        catch(error){
          assertActive(currentEpoch);
          if(error.status>=400&&error.status<500&&error.status!==408&&error.status!==429)throw error;
          announce('validating',error.message);interval=60000;continue;
        }
        if(result.status==='ready'){announce('ready');return;}
        if(!['pending','validating'].includes(result.status))throw Error(result.last_error||'PDF validation failed; the saved text is safe');
        interval=Math.min(60000,interval*2);
      }
    }catch(error){if(isActive(currentEpoch))announce('failed',error.message);}
    finally{if(observers.get(id)===observer)observers.delete(id);}
  })();
}
async function prepareNow(target,currentEpoch){
  assertActive(currentEpoch);
  const call=(path,method,body)=>request(path,method,body,currentEpoch),upload={};
  notify(target,'pending');
  try{
    const artifact=await call('/api/pdf-artifacts','POST',target);
    target=artifactTarget(target,artifact);
    if(artifact.status==='ready'){notify(target,'ready');return artifact;}
    if(artifact.status==='validating'){observeValidation(target,artifact,currentEpoch);return artifact;}
    if(artifact.status!=='pending')throw Error(artifact.last_error||'PDF preparation failed; the saved text is safe');
    uploads.add(upload);
    const source=await readSource(artifact,call);
    const {bytes,sha256}=await generate(source);
    assertActive(currentEpoch);
    if(bytes.length>artifact.max_bytes)throw Error('PDF is too large for automatic delivery; the text remains saved');
    const count=Math.ceil(bytes.length/artifact.chunk_bytes);
    for(let i=0;i<count;i++){
      await call('/api/pdf-artifacts/'+artifact.id+'/chunks/'+i,'PUT',{data:encode(bytes.subarray(i*artifact.chunk_bytes,(i+1)*artifact.chunk_bytes))});
    }
    const result=await call('/api/pdf-artifacts/'+artifact.id+'/complete','POST',{total_bytes:bytes.length,chunk_count:count,sha256});
    if(result.status!=='ready'){observeValidation(target,{...result,id:artifact.id},currentEpoch);return result;}
    notify(target,'ready');return result;
  }catch(error){if(isActive(currentEpoch))notify(target,'failed',error.message);throw error;}
  finally{uploads.delete(upload);}
}
function prepare(target){
  if(!apiCall||paused)return Promise.resolve();
  const key=targetKey(target),currentEpoch=epoch;
  if(active.has(key))return active.get(key);
  const task=queue.then(()=>prepareNow(target,currentEpoch));queue=task.catch(()=>{});
  active.set(key,task);task.finally(()=>{if(active.get(key)===task)active.delete(key);}).catch(()=>{});return task;
}
let resuming;
function resume(){
  paused=false;
  if(!apiCall)return Promise.resolve();
  if(resuming)return resuming;
  const currentEpoch=epoch,task=(async()=>{
    let cursor=0;
    do{
      const page=await request('/api/pdf-artifacts/targets?cursor='+cursor,undefined,undefined,currentEpoch);
      for(const target of page.results){if(!isActive(currentEpoch))return;try{await prepare(target);}catch(error){if(!isActive(currentEpoch)||/sign|login|expired|登录|限流|Too many/i.test(error.message))return;}}
      cursor=page.next_cursor;
    }while(cursor!==null&&isActive(currentEpoch));
  })().finally(()=>{if(resuming===task)resuming=null;});resuming=task;task.catch(()=>{});return task;
}
function downloadRequest(call,download,timeoutMs=20000){
  if(download.cancelled)return Promise.reject(Error('PDF download cancelled'));
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(error,value)=>{
      if(settled){if(value?.body?.cancel)value.body.cancel().catch(()=>{});return;}
      settled=true;clearTimeout(timer);download.handlers.delete(cancel);error?reject(error):resolve(value);
    };
    const cancel=()=>finish(Error('PDF download cancelled'));
    const timer=timeoutMs?setTimeout(()=>{finish(Error('PDF download request timed out'));download.controller.abort();},timeoutMs):undefined;download.handlers.add(cancel);
    Promise.resolve().then(()=>{if(download.cancelled)throw Error('PDF download cancelled');return call();}).then(value=>finish(null,value),error=>finish(error));
  });
}
function previewDescriptor(value,target){
  const hash=text=>typeof text==='string'&&/^[a-f0-9]{64}$/.test(text);
  if(!value||typeof value.artifact_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.artifact_id)||!Number.isSafeInteger(value.upload_revision)||value.upload_revision<0||!Number.isSafeInteger(value.total_bytes)||value.total_bytes<16||value.total_bytes>64*1024*1024||![16384,32768,65536,131072].includes(value.chunk_bytes)||value.chunk_count!==Math.ceil(value.total_bytes/value.chunk_bytes)||!hash(value.sha256)||!(value.manifest_sha256===null||hash(value.manifest_sha256))||value.kind!==target.kind||value.item_id!==(target.kind==='private'?Number(target.id):0)||!['zh','en','ru'].includes(value.locale)||typeof value.source_revision!=='string'||value.source_revision.length>32768||typeof value.layout_key!=='string'||value.layout_key.length>4096||typeof value.filename!=='string'||value.filename.length>1024)throw Error('Invalid PDF preview descriptor');
  return value;
}
const previewIdentity=value=>JSON.stringify([value.artifact_id,value.upload_revision,value.manifest_sha256,value.sha256,value.total_bytes,value.chunk_bytes,value.chunk_count,value.source_revision,value.layout_key,value.kind,value.item_id,value.locale]);
async function source(target,{signal}={}){
  if(!apiCall)throw Error('PDF source export is unavailable');
  const currentEpoch=epoch;assertActive(currentEpoch);
  if(!['private','public'].includes(target?.kind)||target.kind==='private'&&(!Number.isSafeInteger(Number(target.id))||Number(target.id)<1))throw Error('Invalid PDF source target');
  target={kind:target.kind,...(target.kind==='private'?{id:Number(target.id)}:{}),...(target.locale?{locale:target.locale}:{})};
  const context={cancelled:false,controller:new AbortController(),handlers:new Set(),cancel(){this.cancelled=true;this.controller.abort();for(const cancel of [...this.handlers])cancel();}},abort=()=>context.cancel();
  downloads.add(context);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)context.cancel();
  const call=(path,method,body)=>request(path,method,body,currentEpoch,false,false,context);
  try{
    const artifact=await call('/api/pdf-artifacts','POST',target);
    if(typeof artifact?.id!=='string'||typeof artifact.source_revision!=='string'||typeof artifact.layout_key!=='string')throw Error('Invalid PDF source version');
    const document=await readSource(artifact,call);
    if(document.kind!==target.kind||document.source_revision!==artifact.source_revision||document.layout_key!==artifact.layout_key)throw Error('PDF source or layout changed; restart the export');
    const after=await call('/api/pdf-artifacts','POST',target);
    if(after.source_revision!==artifact.source_revision||after.layout_key!==artifact.layout_key)throw Error('PDF source or layout changed; restart the export');
    if(target.kind==='public')return {kind:'public',options:document.options,formal:true};
    let revision;try{revision=JSON.parse(artifact.source_revision)[0];}catch{}
    if(!Number.isSafeInteger(revision)||revision<0)throw Error('Invalid PDF source revision');
    return {kind:'private',options:document.options,revision};
  }finally{context.cancel();signal?.removeEventListener('abort',abort);downloads.delete(context);}
}
async function download(target,{signal,onProgress}={}){
  if(!apiCall)throw Error('PDF preview is unavailable');
  const currentEpoch=epoch;assertActive(currentEpoch);
  if(!['private','public'].includes(target?.kind)||target.kind==='private'&&(!Number.isSafeInteger(Number(target.id))||Number(target.id)<1))throw Error('Invalid PDF preview target');
  target={kind:target.kind,...(target.kind==='private'?{id:Number(target.id)}:{}),...(target.locale?{locale:target.locale}:{})};
  const context={cancelled:false,controller:new AbortController(),handlers:new Set(),cancel(){this.cancelled=true;this.controller.abort();for(const cancel of [...this.handlers])cancel();}},abort=()=>context.cancel();
  downloads.add(context);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)context.cancel();
  const check=()=>{assertActive(currentEpoch);if(context.cancelled)throw Error('PDF download cancelled');};
  const call=(path,method,body,raw=false)=>request(path,method,body,currentEpoch,false,raw,context);
  try{
    const descriptor=previewDescriptor(await call('/api/pdf-artifacts/preview','POST',target),target),pin=descriptor.manifest_sha256||descriptor.sha256,parts=[];
    const tag='"'+descriptor.upload_revision+'-'+pin+'"';let received=0;
    onProgress?.(0,descriptor.total_bytes);
    for(let index=0;index<descriptor.chunk_count;index++){
      check();
      const path='/api/pdf-artifacts/'+descriptor.artifact_id+'/chunks/'+index+'?revision='+descriptor.upload_revision+'&pin='+pin;
      const response=await call(path,'GET',undefined,true);
      if(!response?.headers||!response.headers.get('Content-Type')?.startsWith('application/octet-stream')||response.headers.get('X-AfterMe-Artifact')!==descriptor.artifact_id||response.headers.get('X-AfterMe-Chunk')!==String(index)||response.headers.get('ETag')!==tag)throw Error('PDF chunk version changed; restart the preview');
      const bytes=new Uint8Array(await downloadRequest(()=>response.arrayBuffer(),context));check();
      const expected=Math.min(descriptor.chunk_bytes,descriptor.total_bytes-received);
      if(bytes.byteLength!==expected||response.headers.get('Content-Range')!==`bytes ${received}-${received+expected-1}/${descriptor.total_bytes}`)throw Error('PDF chunk is incomplete; restart the preview');
      parts.push(bytes);received+=bytes.length;onProgress?.(received,descriptor.total_bytes);
    }
    if(received!==descriptor.total_bytes)throw Error('PDF download is incomplete');
    // A current descriptor is read again AFTER every byte arrives. A changed
    // source/layout never produces a partial or mixed-version preview Blob.
    const after=previewDescriptor(await call('/api/pdf-artifacts/preview','POST',target),target);check();
    if(previewIdentity(after)!==previewIdentity(descriptor))throw Error('PDF source or layout changed; restart the preview');
    const blob=new Blob(parts,{type:'application/pdf'});
    if(!descriptor.manifest_sha256){
      // Earlier ready artifacts were authenticated by their original whole-file
      // digest. Preserve that legacy proof in the browser rather than rereading
      // the entire file in one server invocation.
      const digest=await crypto.subtle.digest('SHA-256',await downloadRequest(()=>blob.arrayBuffer(),context));check();
      const actual=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
      if(actual!==descriptor.sha256)throw Error('PDF integrity check failed; restart the preview');
    }
    return blob;
  }finally{context.cancel();signal?.removeEventListener('abort',abort);downloads.delete(context);}
}
function pause(){
  paused=true;epoch++;worker?.terminate();worker=null;
  for(const download of downloads)download.cancel();downloads.clear();
  for(const task of pending.values())task.reject(Error('PDF preparation paused'));pending.clear();
  for(const task of waits){clearTimeout(task.timer);task.reject(Error('PDF preparation paused'));}waits.clear();
  observers.clear();uploads.clear();active.clear();queue=Promise.resolve();resuming=null;
}
window.aftermePdf={prepare,resume,pause,source,download,configure({api,version,networkTimeouts=false}){pause();apiCall=api;apiOwnsTimeouts=networkTimeouts===true;assetVersion=typeof version==='string'?version:'';paused=false;}};
window.addEventListener('beforeunload',event=>{if(!paused&&uploads.size){event.preventDefault();event.returnValue='PDF upload is not complete; the text is saved.';}});
