// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {GmailMailProvider} from '../src/mail.js';
import {createInvocationBudget} from '../src/invocation-budget.js';

function fixture() {
  const budget=createInvocationBudget();
  const provider=new GmailMailProvider({INVOCATION_BUDGET:budget,BACKGROUND_EXECUTION_MODE:'staged',GMAIL_CLIENT_ID:'test-client',GMAIL_CLIENT_SECRET:'test-secret',GMAIL_REFRESH_TOKEN:'test-refresh',FROM_EMAIL:'sender@example.invalid'});
  return {provider,budget};
}

test('mock transport exercises the actual OAuth refresh, budget and cache before inbox access',async()=>{
  const {provider,budget}=fixture(),calls=[];
  provider.transport=async(url,init)=>{
    calls.push(String(url));
    if(String(url)==='https://oauth2.googleapis.com/token') {
      assert.equal(init.method,'POST');assert.ok(init.signal);
      assert.deepEqual(Object.fromEntries(init.body),{client_id:'test-client',client_secret:'test-secret',refresh_token:'test-refresh',grant_type:'refresh_token'});
      return Response.json({access_token:'test-access',expires_in:3600});
    }
    assert.equal(init.headers.Authorization,'Bearer test-access');
    return Response.json({messages:[]});
  };
  await provider.listInboundPage();await provider.listInboundPage();
  assert.equal(calls.filter(url=>url.endsWith('/token')).length,1);
  assert.equal(calls.length,3);assert.equal(budget.usedExternal,3);
  provider.tokenExpiresAt=Date.now()+30000;
  await provider.listInboundPage();assert.equal(calls.filter(url=>url.endsWith('/token')).length,2);
  assert.equal(budget.usedExternal,5);
});

test('OAuth refresh failure prevents mail API access and does not cache failed responses',async()=>{
  const {provider,budget}=fixture();let attempts=0;
  provider.transport=async(url)=>{assert.equal(String(url),'https://oauth2.googleapis.com/token');attempts++;return Response.json({error:'invalid_grant'},{status:400});};
  await assert.rejects(provider.listInboundPage(),/OAuth unavailable/);
  await assert.rejects(provider.listInboundPage(),/OAuth unavailable/);
  assert.equal(attempts,2);assert.equal(budget.usedExternal,2);assert.equal(provider.cachedToken,undefined);
});

test('independent provider invocations never inherit another request token or budget',async()=>{
  const a=fixture(),b=fixture();
  for(const [value,token] of [[a,'token-a'],[b,'token-b']])value.provider.transport=async()=>Response.json({access_token:token,expires_in:3600});
  const values=await Promise.all([a.provider.getAccessToken(),b.provider.getAccessToken()]);
  assert.deepEqual(values.map(value=>value.accessToken),['token-a','token-b']);
  assert.equal(a.budget.usedExternal,1);assert.equal(b.budget.usedExternal,1);
});
