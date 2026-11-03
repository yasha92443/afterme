// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {GmailMailProvider,buildGmailMimeMessage,buildGmailRawMessage,parseContactReplyCommand,scanContactReplyCommand} from '../src/mail.js';
import {createMimeDescriptor,readMimeRange,startUpload,probeUpload,uploadPart,MAIL_UPLOAD_CHUNK_BYTES,GMAIL_MAX_MIME_BYTES} from '../src/mail-upload.js';
import {REPLY_COMMANDS} from '../src/i18n.js';

const chunk=MAIL_UPLOAD_CHUNK_BYTES;
const provider={env:{},async getAccessToken(){return {ok:true,accessToken:'synthetic-access'};}};
const uri='https://gmail.googleapis.com/resumable/upload/gmail/v1/users/me/messages/send?uploadType=resumable&upload_id=synthetic-session';
const message={from:'sender@example.invalid',to:'reader@example.invalid',replyTo:'reply@example.invalid',subject:'Unicode 文🙂',text:'Body 文🙂\r\nSecond line'};
const identity={boundary:'afterme_synthetic_boundary',messageId:'<synthetic-message@afterme.invalid>'};
const binary=length=>Uint8Array.from({length},(_,i)=>(i*71)%256);
async function consume(init){return new Uint8Array(await new Response(init.body).arrayBuffer());}

test('MIME ranges reconstruct the synchronous compatible message with bounded raw reads at every base64 edge',async()=>{
  for(const length of [0,1,2,3,56,57,58,113,114,115,chunk+71,2*chunk+3]){
    const data=binary(length),attachment={filename:'中文🙂.pdf',contentType:'application/pdf',byteLength:length};
    const descriptor=createMimeDescriptor({...message,attachment},identity),restored=JSON.parse(JSON.stringify(descriptor));
    const expected=Buffer.from(buildGmailMimeMessage({...message,...identity,attachments:[{...attachment,data}]}),'utf8');
    assert.equal(descriptor.totalBytes,expected.length);assert.equal(Buffer.from(buildGmailRawMessage({...message,...identity,attachments:[{...attachment,data}]}),'base64url').toString(),expected.toString());
    const read=async(start,size)=>{assert.ok(size<=Math.ceil(chunk/78)*57+114);return data.subarray(start,start+size);};
    const output=[];for(let offset=0;offset<expected.length;offset+=chunk)output.push(await readMimeRange(restored,offset,Math.min(chunk,expected.length-offset),read));
    assert.deepEqual(Buffer.concat(output),expected);
    const begin=Buffer.byteLength(descriptor.prefix);for(const relative of [0,1,74,75,76,77,78,79,151,152,153,154]){const offset=begin+relative;if(offset>=expected.length)continue;assert.deepEqual(Buffer.from(await readMimeRange(restored,offset,Math.min(13,expected.length-offset),read)),expected.subarray(offset,offset+13));}
  }
});

test('range validation checks callback length, bounded reads, descriptor totals and MIME injection',async()=>{
  const descriptor=createMimeDescriptor({...message,attachment:{filename:'safe.pdf',byteLength:100}},identity);
  await assert.rejects(readMimeRange(descriptor,0,chunk+1,()=>new Uint8Array()),/Invalid/);
  await assert.rejects(readMimeRange({...descriptor,totalBytes:1},0,1,()=>new Uint8Array()),/Invalid/);
  await assert.rejects(readMimeRange(descriptor,Buffer.byteLength(descriptor.prefix),10,()=>new Uint8Array()),/Invalid/);
  assert.throws(()=>createMimeDescriptor({...message,attachment:{filename:'safe.pdf',byteLength:1}},{...identity,boundary:'bad\r\nHeader: injected'}),/Invalid/);
  assert.throws(()=>createMimeDescriptor({...message,attachment:{filename:'safe.pdf',contentType:'application/pdf\r\nBcc: victim',byteLength:1}},identity),/Invalid/);
});

test('wire size uses the discovery 35 MiB MIME ceiling rather than the configured PDF cap',async()=>{
  assert.equal(GMAIL_MAX_MIME_BYTES,36700160);
  const descriptor=createMimeDescriptor({...message,attachment:{filename:'large.pdf',byteLength:18*1024*1024}},identity);assert.ok(descriptor.totalBytes<GMAIL_MAX_MIME_BYTES);
  assert.throws(()=>createMimeDescriptor({...message,attachment:{filename:'too-large.pdf',byteLength:27*1024*1024}},identity),/Invalid/);
  await assert.rejects(startUpload(provider,GMAIL_MAX_MIME_BYTES+1,{transport(){throw Error('Must not dispatch');}}),/Invalid/);
});

test('resumable initiation sends an empty body and preserves only an allowlisted session',async()=>{
  let calls=0;
  const result=await startUpload(provider,chunk+5,{transport:async(url,init)=>{calls++;assert.match(url,/\/resumable\/upload\//);assert.equal(init.redirect,'manual');assert.equal(init.headers['X-Upload-Content-Length'],String(chunk+5));assert.equal(init.headers['X-Upload-Content-Type'],'message/rfc822');assert.equal((await consume(init)).length,0);return new Response(null,{status:200,headers:{Location:uri}});}});
  assert.deepEqual(result,{status:'uploading',session:{uri,totalBytes:chunk+5},offset:0});assert.equal(calls,1);
  const refused=await startUpload(provider,100,{transport:async()=>new Response(null,{status:200,headers:{Location:'https://attacker.example/upload?upload_id=secret'}})});assert.equal(refused.status,'failed');assert.ok(!JSON.stringify(refused).includes('attacker'));
});

test('non-final chunks do not claim or release and acknowledge the authoritative received offset',async()=>{
  const session={uri,totalBytes:2*chunk+5},data=binary(chunk);let claims=0,guards=0;
  const result=await uploadPart(provider,session,0,data,{beforeFinal(){claims++;return true;},canSend(){guards++;return true;},transport:async(_url,init)=>{assert.equal(init.headers['Content-Range'],`bytes 0-${chunk-1}/${session.totalBytes}`);assert.deepEqual(await consume(init),data);return new Response(null,{status:308,headers:{Range:'bytes=0-131071'}});}});
  assert.equal(result.status,'uploading');assert.equal(result.offset,131072);assert.equal(result.final,false);assert.equal(claims,0);assert.equal(guards,0);
  await assert.rejects(uploadPart(provider,session,0,new Uint8Array(10),{}),/Invalid/);
});

test('the final chunk requires a durable claim and checks eligibility again after claiming',async()=>{
  const session={uri,totalBytes:chunk+3},trace=[];
  const result=await uploadPart(provider,session,chunk,new Uint8Array([1,2,3]),{canSend:async()=>{trace.push('guard');return true;},beforeFinal:async()=>{trace.push('claim');return true;},transport:async(_url,init)=>{trace.push('put');assert.deepEqual(await consume(init),new Uint8Array([1,2,3]));return Response.json({id:'synthetic-sent',threadId:'synthetic-thread'});}});
  assert.deepEqual(trace,['guard','claim','guard','put']);assert.equal(result.status,'sent');assert.equal(result.claimed,true);assert.equal(result.final,true);
  let guards=0,puts=0;const stopped=await uploadPart(provider,session,chunk,new Uint8Array(3),{canSend:async()=>++guards===1,beforeFinal:async()=>true,transport:async()=>{puts++;throw Error('Must not dispatch');}});assert.equal(stopped.status,'skipped');assert.equal(stopped.claimed,true);assert.equal(puts,0);
  const denied=await uploadPart(provider,session,chunk,new Uint8Array(3),{canSend:async()=>true,beforeFinal:async()=>false,transport:async()=>{throw Error('Must not dispatch');}});assert.equal(denied.reason,'claimed-or-cap');
  await assert.rejects(uploadPart(provider,session,chunk,new Uint8Array(3),{}),/Invalid/);
});

test('lost final response is probed without replaying the final body or creating another session',async()=>{
  const session={uri,totalBytes:chunk+3},puts=[];
  const transport=async(url,init)=>{assert.equal(url,uri);puts.push(init.headers['Content-Range']);await consume(init);if(puts.length===1)throw Error('Synthetic accepted response lost');assert.equal(init.headers['Content-Range'],'bytes */'+session.totalBytes);assert.equal((await consume(init)).length,0);return Response.json({id:'already-sent',threadId:'same-thread'},{status:201});};
  const lost=await uploadPart(provider,session,chunk,new Uint8Array(3),{canSend:async()=>true,beforeFinal:async()=>true,transport});assert.equal(lost.status,'probe_required');assert.equal(lost.needsProbe,true);assert.equal(lost.claimed,true);
  const recovered=await probeUpload(provider,session,{transport});assert.equal(recovered.status,'sent');assert.equal(recovered.id,'already-sent');assert.equal(puts.length,2);
});

test('probes distinguish incomplete, lost and invalid receipts without automatic retries',async()=>{
  const session={uri,totalBytes:chunk+3};
  for(const [response,status] of [[new Response(null,{status:308}),'uploading'],[new Response(null,{status:308,headers:{Range:'bytes=0-12'}}),'uploading'],[new Response(null,{status:308,headers:{Range:'bytes=4-12'}}),'probe_required'],[new Response(null,{status:308,headers:{Range:'bytes=0-'+(session.totalBytes-1)}}),'probe_required'],[new Response(null,{status:404}),'session_lost'],[new Response(null,{status:410}),'session_lost'],[new Response(null,{status:503}),'probe_required'],[Response.json({}),'probe_required'],[new Response('x'.repeat(17000)),'probe_required']]){
    let calls=0;const result=await probeUpload(provider,session,{transport:async()=>{calls++;return response;}});assert.equal(result.status,status);assert.equal(calls,1);
  }
  let calls=0;await assert.rejects(probeUpload(provider,{uri:'https://gmail.googleapis.com.attacker.example/upload',totalBytes:1},{transport:async()=>{calls++;}}),/Invalid/);assert.equal(calls,0);
});

test('staged Gmail media consumes RFC822 bytes while the compatibility provider keeps JSON raw',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let staged=true;
  globalThis.fetch=async(url,init)=>{assert.equal(init.method,'POST');const body=await consume(init);if(staged){assert.match(String(url),/uploadType=media/);assert.equal(init.headers['Content-Type'],'message/rfc822');assert.ok(Buffer.from(body).toString().includes('Body 文🙂'));assert.ok(!Buffer.from(body).toString().startsWith('{'));}else{assert.doesNotMatch(String(url),/uploadType=media/);assert.ok(JSON.parse(Buffer.from(body).toString()).raw);}return Response.json({id:'mock-sent',threadId:'mock-thread'});};
  const env={GMAIL_CLIENT_ID:'synthetic',GMAIL_CLIENT_SECRET:'synthetic',GMAIL_REFRESH_TOKEN:'synthetic',FROM_EMAIL:message.from,BACKGROUND_EXECUTION_MODE:'staged'},gmail=new GmailMailProvider(env);gmail.cachedToken='synthetic';gmail.tokenExpiresAt=Date.now()+3600000;
  assert.equal((await gmail.send(message)).status,'sent');staged=false;delete env.BACKGROUND_EXECUTION_MODE;assert.equal((await gmail.send(message)).status,'sent');
});

test('reply scanning is bounded and never accepts an ambiguous truncated prefix',()=>{
  const command=REPLY_COMMANDS.en[1],opposite=REPLY_COMMANDS.en[2];
  assert.equal(parseContactReplyCommand(command).status,'confirmed_death');
  assert.deepEqual(scanContactReplyCommand(command+'\n'+(' '.repeat(20000))+opposite),{complete:false,command:null});
  assert.equal(parseContactReplyCommand(command+'\n'+opposite),null);
  assert.deepEqual(scanContactReplyCommand(command,{truncated:true}),{complete:false,command:null});
  assert.equal(scanContactReplyCommand(command+'\n> quoted\n'+'x'.repeat(2*1024*1024)).command.status,'confirmed_death');
  assert.equal(scanContactReplyCommand(command+'\n'+'\n'.repeat(19)+'x'.repeat(2*1024*1024)).command.status,'confirmed_death');
});

test('staged inbound detail limits actual response bytes and retains an incomplete message ID',async()=>{
  const gmail=new GmailMailProvider({BACKGROUND_EXECUTION_MODE:'staged'});
  const normal={id:'synthetic-inbound',threadId:'thread',internalDate:'1893456000000',payload:{headers:[{name:'From',value:'reader@example.invalid'}],mimeType:'text/plain',body:{data:Buffer.from(REPLY_COMMANDS.en[2]).toString('base64url')}}};
  const parsed=await gmail.readInboundDetail(Response.json(normal),{id:normal.id,threadId:'thread'});assert.equal(parsed.incomplete,undefined);assert.equal(parseContactReplyCommand(parsed.body).status,'false_alarm');
  let cancelled=false;const oversized=new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(65537).fill(65));},cancel(){cancelled=true;}}));
  const blocked=await gmail.readInboundDetail(oversized,{id:'oversized-id',threadId:'oversized-thread'});assert.equal(blocked.id,'oversized-id');assert.equal(blocked.threadId,'oversized-thread');assert.equal(blocked.incomplete,true);assert.equal(blocked.body,'');assert.equal(cancelled,true);
  const malformed=await gmail.readInboundDetail(new Response('{ malformed'),{id:'bad-json'});assert.equal(malformed.incomplete,true);assert.equal(malformed.id,'bad-json');
  const mismatch=await gmail.readInboundDetail(Response.json(normal),{id:'different-id'});assert.equal(mismatch.incomplete,true);assert.equal(mismatch.id,'different-id');
  const missingText=await gmail.readInboundDetail(Response.json({...normal,payload:{mimeType:'text/plain',body:{size:90000,attachmentId:'separate-text-part'}}}),{id:normal.id});assert.equal(missingText.incomplete,true);assert.equal(missingText.body,'');
  const legacy=new GmailMailProvider({});let jsonCalls=0;await legacy.readInboundDetail({async json(){jsonCalls++;return normal;}},{id:normal.id});assert.equal(jsonCalls,1);
});

test('staged inbound reads only one bounded list page and leaves remaining pages as backlog',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let lists=0;
  const gmail=new GmailMailProvider({BACKGROUND_EXECUTION_MODE:'staged',GMAIL_CLIENT_ID:'synthetic',GMAIL_CLIENT_SECRET:'synthetic',GMAIL_REFRESH_TOKEN:'synthetic',FROM_EMAIL:'synthetic@example.invalid'});gmail.cachedToken='synthetic';gmail.tokenExpiresAt=Date.now()+3600000;
  const repo={async getCursor(){return '';},async pendingInboundIds(){return [];},async completedInboundIds(ids){return new Set(ids);}};
  globalThis.fetch=async input=>{const url=new URL(input);lists++;assert.equal(url.pathname,'/gmail/v1/users/me/messages');assert.equal(url.searchParams.get('fields'),'messages(id,threadId),nextPageToken');return Response.json({messages:[{id:'already-complete',threadId:'thread'}],nextPageToken:'page-two'});};
  const messages=await gmail.listInboundMessages({maxResults:1,repo});assert.equal(messages.length,0);assert.equal(messages.backlog,true);assert.equal(messages.nextPageToken,'page-two');assert.equal(lists,1);
  let cancelled=false;globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(65537).fill(65));},cancel(){cancelled=true;}}));
  await assert.rejects(gmail.listInboundMessages({maxResults:1,repo}),/incomplete/);assert.equal(cancelled,true);
});
