// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';

async function login(page){
  await page.route('**/api/pdf-artifacts/targets*',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({results:[],next_cursor:null})}));
  await page.goto('/');await page.getByLabel('管理口令',{exact:true}).fill('synthetic-browser-admin');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.am-app')).toBeVisible();
}
test('built compressed browser PDF waits for server validation under the actual CSP',async({page,request})=>{
  const ids=await(await request.post('/__fixture/reset')).json();await request.post('/__fixture/pdf',{data:{enabled:true,staged:true}});
  await page.route('**/api/pdf-artifacts/targets*',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({results:[],next_cursor:null})}));
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');await page.getByLabel('管理口令',{exact:true}).fill('synthetic-browser-admin');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.am-app')).toBeVisible();
  await page.locator('[data-nav="letters"]').click();await page.locator('[data-letter="'+ids.letter+'"]').click();
  await page.locator('#letter-pdf-retry').click();
  await expect(page.locator('#letter-pdf-status')).toContainText('PDF 已准备好',{timeout:30000});
  const state=await(await request.get('/__fixture/state')).json();
  expect(state.calls.some(call=>call.path.endsWith('/complete')&&call.status===202)).toBe(true);
  expect(state.calls.some(call=>/^\/api\/pdf-artifacts\/[a-f0-9-]{36}$/.test(call.path)&&call.method==='GET'&&call.status===200)).toBe(true);
  expect(errors).toEqual([]);
});

test('management PDF preview uses authenticated pinned chunks and survives an interactive login longer than its network deadline',async({page,request})=>{
  test.setTimeout(90000);
  const ids=await(await request.post('/__fixture/reset',{data:{pdfSmall:true}})).json();await request.post('/__fixture/pdf',{data:{enabled:true,staged:true}});
  await page.addInitScript(()=>{const original=URL.createObjectURL;window.__pdfPreviews=[];URL.createObjectURL=function(blob){const url=original.call(this,blob);if(blob.type==='application/pdf')window.__pdfPreviews.push({url,blob});return url;};});
  const errors=[],chunks=[];let expired=false;page.on('pageerror',error=>errors.push(error.message));
  await page.route(/\/api\/pdf-artifacts\/[a-f0-9-]{36}\/chunks\/\d+\?/,async route=>{
    if(route.request().method()!=='GET')return route.continue();chunks.push(route.request().url());
    if(!expired){expired=true;return route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({message:'Synthetic expired session'})});}return route.continue();
  });
  await page.route(/\/api\/items\/\d+\/pdf$/,route=>route.abort());
  await login(page);await page.locator('[data-nav="letters"]').click();await page.locator('[data-letter="'+ids.letter+'"]').click();await page.locator('#letter-pdf-retry').click();await expect(page.locator('#letter-pdf-status')).toContainText('PDF 已准备好',{timeout:30000});
  const opened=page.waitForEvent('popup');await page.locator('#letter-preview').click();const popup=await opened;
  await expect(page.locator('#am-auth')).toBeVisible();await page.waitForTimeout(21000);await expect(page.locator('#am-auth')).toBeVisible();expect(popup.isClosed()).toBe(false);
  await page.locator('#am-secret').fill('synthetic-browser-admin');await page.locator('#am-auth-form').getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('#am-auth')).not.toBeVisible();
  await expect.poll(()=>page.evaluate(()=>window.__pdfPreviews.length)).toBe(1);
  const preview=await page.evaluate(async()=>{const {url,blob}=window.__pdfPreviews[0];return {url,size:blob.size,header:new TextDecoder().decode((await blob.arrayBuffer()).slice(0,8))};});
  expect(preview.url).toMatch(/^blob:/);expect(preview.size).toBeGreaterThan(16);expect(preview.header).toMatch(/^%PDF-/);expect(chunks.length).toBeGreaterThanOrEqual(2);expect(chunks[0]).toBe(chunks[1]);
  const state=await(await request.get('/__fixture/state')).json();expect(state.calls.filter(call=>call.path==='/api/pdf-artifacts/preview'&&call.status===200)).toHaveLength(2);expect(state.calls.some(call=>call.path==='/api/items/'+ids.letter+'/pdf')).toBe(false);expect(errors).toEqual([]);await popup.close();
});

test('management private and public local source buttons use paged artifact sources without fonts or the bulk compatibility routes',async({page,request})=>{
  const ids=await(await request.post('/__fixture/reset',{data:{pdfSmall:true}})).json();await request.post('/__fixture/pdf',{data:{enabled:true,staged:true}});
  await page.route(/\/api\/(?:items\/\d+|public-farewell)\/pdf-source$/,route=>route.abort());
  await login(page);await page.locator('[data-nav="letters"]').click();await page.locator('[data-letter="'+ids.letter+'"]').click();
  let pending=page.waitForEvent('download');await page.locator('#letter-pdf-source').click();let download=await pending;
  const privateDoc=JSON.parse(await readFile(await download.path(),'utf8'));expect(privateDoc.kind).toBe('private');expect(privateDoc.revision).toBeGreaterThanOrEqual(0);expect(privateDoc.options.body).toBe('Private fixture letter');
  await page.locator('[data-nav="farewell"]').click();pending=page.waitForEvent('download');await page.locator('form[action="/api/public-farewell/pdf-source"] button[type="submit"]').click();download=await pending;
  const publicDoc=JSON.parse(await readFile(await download.path(),'utf8'));expect(publicDoc.kind).toBe('public');expect(publicDoc.formal).toBe(true);expect(publicDoc.options.groups).toHaveLength(1);expect(publicDoc.options.groups[0].display_title).toBe('Chapter 1');expect(publicDoc.options.groups[0].entries.map(entry=>entry.display_body)).toEqual(['Entry 1','Entry 2','Entry 3']);
  const state=await(await request.get('/__fixture/state')).json();expect(state.calls.filter(call=>/\/api\/pdf-artifacts\/[^/]+\/source$/.test(call.path))).toHaveLength(7);expect(state.calls.some(call=>/\/pdf-source$/.test(call.path))).toBe(false);expect(state.calls.some(call=>/^\/static\/pdf-(worker\.js|font\.ttf)$/.test(call.path))).toBe(false);
});
