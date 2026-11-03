// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {GmailMailProvider} from '../src/mail.js';
function fixture(transport){const provider=new GmailMailProvider({BACKGROUND_EXECUTION_MODE:'staged',GMAIL_CLIENT_ID:'synthetic',GMAIL_CLIENT_SECRET:'synthetic',GMAIL_REFRESH_TOKEN:'synthetic',FROM_EMAIL:'sender@example.invalid'});provider.getAccessToken=async()=>({ok:true,accessToken:'synthetic'});provider.transport=transport;return provider;}
test('page-only stage requests bounded identifiers and never downloads message details',async()=>{
  const calls=[],provider=fixture(async(url,options)=>{calls.push({url:String(url),options});return Response.json({messages:[{id:'synthetic',threadId:'thread'}],nextPageToken:'page2'});});
  assert.deepEqual(await provider.listInboundPage({pageToken:'page1'}),{messages:[{id:'synthetic',threadId:'thread'}],nextPageToken:'page2'});assert.equal(calls.length,1);const url=new URL(calls[0].url);assert.equal(url.pathname,'/gmail/v1/users/me/messages');assert.equal(url.searchParams.get('pageToken'),'page1');assert.equal(url.searchParams.get('fields'),'messages(id,threadId),nextPageToken');
});
test('page stage rejects duplicate identifiers and oversized responses',async()=>{
  for(const body of [{messages:[{id:'same'},{id:'same'}]},{messages:[],padding:'X'.repeat(70000)}])await assert.rejects(fixture(async()=>Response.json(body)).listInboundPage(),/incomplete/);
  await assert.rejects(fixture(async()=>new Response(null,{status:400})).listInboundPage({pageToken:'old'}),error=>error.statusCode===400);
});
test('detail stage binds response identity and preserves incomplete input as retryable',async()=>{
  const payload={id:'synthetic',threadId:'thread',internalDate:'1000',payload:{mimeType:'text/plain',headers:[{name:'From',value:'Reader <reader@example.invalid>'}],body:{data:Buffer.from('Synthetic body 文').toString('base64url')}}};
  const provider=fixture(async()=>Response.json(payload)),message=await provider.fetchInboundDetail({id:'synthetic',threadId:'thread'});assert.equal(message.body,'Synthetic body 文');assert.equal(message.from,'reader@example.invalid');
  payload.id='wrong';const invalid=await provider.fetchInboundDetail({id:'synthetic',threadId:'thread'});assert.equal(invalid.id,'synthetic');assert.equal(invalid.incomplete,true);
});
