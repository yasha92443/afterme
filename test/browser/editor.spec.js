// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {test,expect} from '@playwright/test';
let ids;
async function login(page){await page.goto('/');await page.getByLabel('管理口令',{exact:true}).fill('synthetic-browser-admin');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.am-app')).toBeVisible();}
async function editor(page){await page.locator('[data-nav="farewell"]').click();await expect(page.locator('[data-entry-editor]')).toHaveCount(1);}
const body=page=>page.locator('.farewell-entry-editor.is-selected textarea[name="body"]');
test.beforeEach(async({request})=>{ids=await(await request.post('/__fixture/reset')).json();});

test('built editor lazily loads bodies and reaches formal/trash records beyond page 50',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await login(page);await editor(page);
  await expect(page.locator('[data-group-select]')).toHaveCount(50);await expect(page.locator('[data-entry-select]')).toHaveCount(50);
  await page.locator('[data-editor-more-entries]').click();await expect(page.locator('[data-entry-select]')).toHaveCount(55);await expect(page.locator('[data-entry-editor]')).toHaveCount(1);
  await page.locator('[data-entry-select="55"]').click();await expect(body(page)).toHaveValue('Entry 55');
  await page.locator('[data-preview-mode="formal"]').click();
  await expect(page.locator('[data-preview-document="formal"] [data-preview-entry]')).toHaveCount(50);
  await page.locator('[data-editor-more-formal]').click();
  await expect(page.locator('[data-preview-document="formal"] [data-preview-entry]')).toHaveCount(55);
  await page.locator('.farewell-recycle summary').click();
  for(const kind of ['groups','entries']){const more=page.locator('[data-editor-more-trash="'+kind+'"]');await more.click();await expect(page.locator('[data-trash-kind="'+kind+'"]')).toHaveCount(55);await expect(more).toBeHidden();}
  await expect(page.locator('[data-trash-kind="groups"][data-trash-id="'+ids.trashGroups[0]+'"]')).toBeVisible();expect(errors).toEqual([]);
  const createdEntry=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/api/public-farewell-v2/entries'));
  await page.locator('.farewell-create-entry button').click();const entry=await(await createdEntry).json();
  await expect(page.locator('[data-entry-editor="'+entry.id+'"]')).toBeVisible();await expect(body(page)).toHaveValue('新条目');await expect(body(page)).toBeFocused();
  const createdGroup=page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/api/public-farewell-v2/groups'));
  await page.locator('.farewell-create-group input[name="title"]').fill('Created beyond first directory page');await page.locator('.farewell-create-group button').click();const group=await(await createdGroup).json();
  await expect(page.locator('#public-farewell-v2')).toHaveAttribute('data-loaded-group',String(group.id));await expect(page.locator('.group-title-form [name="title"]')).toHaveValue('Created beyond first directory page');
  await expect(page.locator('.group-title-form [name="title"]')).toBeFocused();expect(errors).toEqual([]);
});

test('single-flight autosave preserves typing while saving and latest chapter wins',async({page,request})=>{
  await request.post('/__fixture/delays',{data:{['POST /api/public-farewell-v2/entries/'+ids.entry]:900,['GET /api/public-farewell-v2/editor']:600}});
  await login(page);await editor(page);
  const firstRequest=page.waitForRequest(req=>req.method()==='POST'&&req.url().endsWith('/api/public-farewell-v2/entries/'+ids.entry));
  await body(page).fill('FIRST_BODY');await firstRequest;await body(page).fill('LATEST_BODY');
  await page.locator('[data-group-select="2"]').click();await page.locator('[data-group-select="3"]').click();
  await expect(page.locator('#public-farewell-v2')).toHaveAttribute('data-loaded-group','3');
  await page.locator('[data-group-select="1"]').click();await expect(body(page)).toHaveValue('LATEST_BODY');
  const state=await(await request.get('/__fixture/state')).json(),saves=state.calls.filter(call=>call.method==='POST'&&call.path==='/api/public-farewell-v2/entries/'+ids.entry);
  expect(saves.length).toBeGreaterThanOrEqual(2);for(let i=1;i<saves.length;i++)expect(saves[i].start).toBeGreaterThanOrEqual(saves[i-1].end);
  expect(state.entry.draft_body).toBe('LATEST_BODY');
});

test('409 keeps local input and aborts chapter switching',async({page,request})=>{
  await login(page);await editor(page);await request.post('/__fixture/edit',{data:{body:'REMOTE_WINNER'}});
  await body(page).fill('LOCAL_MUST_SURVIVE');await page.locator('[data-group-select="2"]').click();
  await expect(page.locator('#am-conflict')).toBeVisible();await expect(page.locator('#am-remote')).toContainText('REMOTE_WINNER');await page.locator('#am-conflict-close').click();
  await expect(page.locator('#public-farewell-v2')).toHaveAttribute('data-loaded-group','1');await expect(body(page)).toHaveValue('LOCAL_MUST_SURVIVE');await expect(body(page).locator('..').locator('..')).toHaveAttribute('data-unsaved','1');
});

test('saved text stays usable when background PDF generation fails',async({page})=>{
  await login(page);await page.locator('[data-nav="letters"]').click();await page.locator('[data-letter="'+ids.letter+'"]').click();
  await page.route('**/api/pdf-artifacts',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Synthetic PDF outage'})}));
  await page.locator('#letter-form textarea').fill('SAVED_WITHOUT_PDF');await page.locator('#letter-form button[type="submit"]').click();
  await expect(page.locator('#letter-form textarea')).toHaveValue('SAVED_WITHOUT_PDF');await expect(page.locator('#letter-pdf-status')).toContainText('PDF 待重试');await expect(page.locator('#letter-form button[type="submit"]')).toBeEnabled();
  await page.unroute('**/api/pdf-artifacts');
  await page.route('**/api/pdf-artifacts',route=>{const target=route.request().postDataJSON();return route.fulfill({status:target.locale==='en'?503:200,contentType:'application/json',body:JSON.stringify(target.locale==='en'?{message:'Synthetic English PDF outage'}:{status:'ready',id:'synthetic-ready'})});});
  await editor(page);await page.locator('form[action="/api/public-farewell-v2/apply"] button').click();await page.locator('#am-apply-confirm').click();
  await expect(page.locator('#public-pdf-status')).toContainText('en · Synthetic English PDF outage');
  await expect(page.locator('#public-pdf-status')).not.toContainText('三种语言的 PDF 已准备好');
});

test('mobile keyboard navigation preserves unsaved settings',async({page})=>{
  await page.setViewportSize({width:390,height:844});await login(page);await page.locator('[data-nav="settings"]').click();await page.locator('#settings-form [name="display_name"]').fill('UNSAVED_MOBILE');
  await page.locator('[data-nav="home"]').click();await page.locator('[data-nav="settings"]').focus();await page.keyboard.press('Enter');await expect(page.locator('#settings-form [name="display_name"]')).toHaveValue('UNSAVED_MOBILE');
});

test('the built PDF Web Worker runs under the real CSP and uploads a ready artifact',async({page,request})=>{
  await request.post('/__fixture/pdf',{data:{enabled:true}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await login(page);await page.locator('[data-nav="letters"]').click();await page.locator('[data-letter="'+ids.letter+'"]').click();
  await expect(page.locator('#letter-pdf-status')).toContainText('PDF 已准备好',{timeout:30000});
  const state=await(await request.get('/__fixture/state')).json();expect(state.calls.some(call=>call.path.includes('/chunks/')&&call.method==='PUT'&&call.status===200)).toBe(true);expect(errors).toEqual([]);
});

test('ordinary autosave debounces edits arriving during an in-flight request',async({page,request})=>{
  await request.post('/__fixture/delays',{data:{['POST /api/public-farewell-v2/entries/'+ids.entry]:1200}});await login(page);await editor(page);
  const started=page.waitForRequest(req=>req.method()==='POST'&&req.url().endsWith('/api/public-farewell-v2/entries/'+ids.entry));
  await body(page).fill('FIRST_AUTOSAVE');await started;await body(page).fill('DEBOUNCED_AUTOSAVE');
  await expect.poll(async()=>{const state=await(await request.get('/__fixture/state')).json();return state.entry.draft_body;},{timeout:10000}).toBe('DEBOUNCED_AUTOSAVE');
  const state=await(await request.get('/__fixture/state')).json(),saves=state.calls.filter(call=>call.method==='POST'&&call.path==='/api/public-farewell-v2/entries/'+ids.entry);
  expect(saves).toHaveLength(2);expect(saves[1].start-saves[0].end).toBeGreaterThanOrEqual(800);
});

test('fixed 200ms request latency meets first-load and cached-navigation budgets',async({page,request})=>{
  await request.post('/__fixture/delays',{data:{'GET /api/items/directory':200,'GET /api/public-farewell-v2/editor':200,['GET /api/public-farewell-v2/entries/'+ids.entry+'/content']:200}});
  await login(page);const first=[],cached=[],frames=[];
  for(let i=0;i<5;i++){
    if(i){await page.goto('/admin');await expect(page.locator('.am-app')).toBeVisible();}
    for(const key of ['letters','farewell']){
      first.push(await page.evaluate(key=>new Promise(resolve=>{const target=document.querySelector('#view-'+key+' .am-view-body'),start=performance.now();const observer=new MutationObserver(()=>{if(target.dataset.loaded==='1'){observer.disconnect();requestAnimationFrame(()=>resolve(performance.now()-start));}});observer.observe(target,{attributes:true,attributeFilter:['data-loaded']});document.querySelector('[data-nav="'+key+'"]').click();}),key));
      const sample=await page.evaluate(key=>new Promise(resolve=>{document.querySelector('[data-nav="home"]').click();const start=performance.now();document.querySelector('[data-nav="'+key+'"]').click();const target=document.querySelector('#view-'+key),ready=target.hidden===false&&target.querySelector('.am-view-body').dataset.loaded==='1';const controls_ms=performance.now()-start;requestAnimationFrame(()=>resolve({ready,controls_ms,next_frame_ms:performance.now()-start}));}),key);
      expect(sample.ready).toBe(true);cached.push(sample.controls_ms);frames.push(sample.next_frame_ms);
    }
  }
  const percentile=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
  const metrics={request_delay_ms:200,first_ready_next_frame_p95_ms:percentile(first),cached_controls_ready_p95_ms:percentile(cached),cached_next_frame_p95_ms:percentile(frames)};console.log(JSON.stringify(metrics));
  test.info().annotations.push({type:'performance',description:JSON.stringify(metrics)});
  expect(percentile(first)).toBeLessThanOrEqual(500);expect(percentile(cached)).toBeLessThanOrEqual(50);
});

test('maintenance reconciles a current inbound failure with an explicit audit note',async({page,request})=>{
  await request.post('/__fixture/inbound');await login(page);await page.locator('[data-nav="maintenance"]').click();
  const form=page.locator('form[data-inbound-reconcile]');await expect(form).toHaveCount(1);
  await expect(page.locator('[data-inbound-problem]')).toContainText('<img src=x onerror=alert(1)>');await expect(page.locator('[data-inbound-problem] img')).toHaveCount(0);
  await form.locator('[name="resolution"]').selectOption('ignore');await form.locator('[name="note"]').fill('Reviewed synthetic message and confirmed unrelated.');await form.locator('button[type="submit"]').click();
  await expect(page.locator('[data-inbound-problem]')).toContainText('处理决定已记录');
  const state=await(await request.get('/__fixture/state')).json();expect(state.inbound).toEqual({status:'ignored',reconciliation_note:'Reviewed synthetic message and confirmed unrelated.'});
});
