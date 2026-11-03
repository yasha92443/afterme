// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {test,expect} from '@playwright/test';

let ids,errors;
const indicator=page=>page.locator('#dirty-indicator');
const entryBody=page=>page.locator('.farewell-entry-editor.is-selected textarea[name="body"]');
async function login(page){await page.goto('/');await page.getByLabel('管理口令',{exact:true}).fill('synthetic-browser-admin');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.am-app')).toBeVisible();}
async function navigate(page,section){await page.locator('[data-nav="'+section+'"]').click();await expect(page.locator('#view-'+section+' .am-view-body')).toHaveAttribute('data-loaded','1');}
async function openPerson(page,id){const row=page.locator('#people-directory details[data-person-id="'+id+'"]');if(!await row.evaluate(el=>el.open))await row.locator('summary').click();return row.locator('[data-person-form]');}
async function roster(page){return (await(await page.request.get('/api/people')).json()).results;}
async function openLetter(page){await navigate(page,'letters');await page.locator('[data-letter="'+ids.letter+'"]').click();await expect(page.locator('#letter-form [name="plaintext"]')).toBeVisible();}
async function clickUnsaved(page,view,field){
  await indicator(page).click();
  const dialog=page.locator('#am-unsaved');
  if(await dialog.isVisible()){
    const choice=dialog.locator('[data-unsaved-view="'+view+'"]'+(field?'[data-field-name="'+field+'"]':''));
    await expect(choice).toHaveCount(1);await choice.click();
  }
  await expect(page.locator('#view-'+view)).toBeVisible();
}

test.beforeEach(async({page,request})=>{ids=await(await request.post('/__fixture/reset',{data:{people:true}})).json();errors=[];page.on('pageerror',error=>errors.push(error.message));});
test.afterEach(async()=>{expect(errors).toEqual([]);});

test('login and dashboard omit decorative slogans in all login languages',async({page})=>{
  await page.goto('/');
  const slogans=/把想留下的话|YOUR WORDS[,.\s]+YOUR (?:TIME|DECISIONS)|A PLACE FOR YOUR WORDS|PERSONAL ARCHIVE|Ваши слова[.\s]+Ваши решения/i;
  for(const locale of ['en','ru','zh']){await page.locator('#login-locale').selectOption(locale);expect(await page.locator('body').innerText()).not.toMatch(slogans);}
  await page.screenshot({path:'output/playwright/dirty-login-clean.png'});
  await page.getByLabel('管理口令',{exact:true}).fill('synthetic-browser-admin');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.am-app')).toBeVisible();expect(await page.locator('body').innerText()).not.toMatch(slogans);
  await navigate(page,'settings');expect(await page.locator('body').innerText()).not.toMatch(slogans);await expect(indicator(page)).toBeHidden();
});

test('restored settings text and checkboxes become clean and navigation targets the remaining changed field',async({page})=>{
  await login(page);await navigate(page,'settings');const name=page.locator('#settings-form [name="display_name"]'),timezone=page.locator('#settings-form [name="timezone"]'),pdf=page.locator('#settings-form [name="public.pdf"]');
  const originalName=await name.inputValue(),originalTimezone=await timezone.inputValue(),originalPdf=await pdf.isChecked();await expect(indicator(page)).toBeHidden();
  await name.fill(originalName+' changed');await expect(indicator(page)).toBeVisible();await name.fill(originalName);await expect(indicator(page)).toBeHidden();
  await pdf.setChecked(!originalPdf);await expect(indicator(page)).toBeVisible();await pdf.setChecked(originalPdf);await expect(indicator(page)).toBeHidden();
  await name.fill('THE_REMAINING_UNSAVED_NAME');await timezone.fill('UTC');await timezone.fill(originalTimezone);await navigate(page,'home');await clickUnsaved(page,'settings','display_name');
  await expect(name).toBeFocused();await expect(name).toHaveValue('THE_REMAINING_UNSAVED_NAME');
  const saved=await(await page.request.get('/api/settings')).json();expect(saved.owner.display_name).toBe(originalName);
  await name.fill(originalName);await expect(indicator(page)).toBeHidden();const web=page.locator('#settings-form [name="public.web"]'),originalWeb=await web.isChecked();await pdf.setChecked(!originalPdf);await web.setChecked(!originalWeb);await web.setChecked(originalWeb);await navigate(page,'home');await clickUnsaved(page,'settings','public.pdf');await expect(pdf).toBeFocused();await pdf.setChecked(originalPdf);await expect(indicator(page)).toBeHidden();
});

test('equivalent hours-to-days conversion stays clean and unsaved navigation targets the actual profile change',async({page,request})=>{
  await login(page);await navigate(page,'settings');const name=page.locator('#settings-form [name="display_name"]'),hours=page.locator('#settings-form [name="alert_hours"]'),unit=page.locator('#settings-form [name="alert_hours_unit"]');await expect(hours).toHaveValue('72');await unit.selectOption('24');await expect(hours).toHaveValue('3');await expect(indicator(page)).toBeHidden();
  await name.fill('SEMANTIC_RULE_NAME_DRAFT');await unit.selectOption('1');await unit.selectOption('24');await navigate(page,'home');await clickUnsaved(page,'settings','display_name');await expect(name).toBeFocused();await expect(hours).toHaveValue('3');
  const dismissed=page.waitForEvent('dialog').then(async dialog=>{expect(dialog.type()).toBe('confirm');await dialog.dismiss();});await page.locator('#undo-pending').click();await dismissed;await expect(name).toHaveValue('SEMANTIC_RULE_NAME_DRAFT');await expect(hours).toHaveValue('3');await expect(indicator(page)).toBeVisible();
  await request.post('/__fixture/delays',{data:{'PUT /api/settings':1200}});const saved=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname==='/api/settings');await page.locator('#settings-form button[type="submit"]').click();for(const selector of ['#quick-theme','#quick-locale','#settings-language'])await expect(page.locator(selector)).toBeDisabled();expect((await saved).status()).toBe(200);await expect(indicator(page)).toBeHidden();for(const selector of ['#quick-theme','#quick-locale','#settings-language'])await expect(page.locator(selector)).toBeEnabled();const after=await(await page.request.get('/api/settings')).json();expect(after.owner.display_name).toBe('SEMANTIC_RULE_NAME_DRAFT');expect((after.pending||after.active).alert_hours).toBe(72);
});

test('reverted person fields are clean and a later note save does not unify an untouched legacy name',async({page})=>{
  await login(page);await navigate(page,'people');const mixed=ids.people.mixed,form=await openPerson(page,mixed.id),name=form.locator('[name="name"]');
  await name.fill('TEMPORARY_NAME_TO_UNDO');await expect(indicator(page)).toBeVisible();await name.fill(mixed.contact_name);await expect(indicator(page)).toBeHidden();
  const primary=await openPerson(page,ids.people.primary.id),active=primary.locator('[name="active"]'),original=await active.isChecked();
  await active.setChecked(!original);await expect(indicator(page)).toBeVisible();await active.setChecked(original);await expect(indicator(page)).toBeHidden();
  await form.locator('[name="note"]').fill('Only this note should persist');const response=page.waitForResponse(response=>response.request().method()==='PATCH'&&new URL(response.url()).pathname==='/api/people/'+mixed.id);await form.locator('button[type="submit"]').click();const saved=await response;expect(saved.status()).toBe(200);expect(Object.keys(saved.request().postDataJSON()).sort()).toEqual(['expected_revision','note']);
  await expect(indicator(page)).toBeHidden();const after=(await roster(page)).find(person=>person.id===mixed.id);expect(after.contact_name).toBe(mixed.contact_name);expect(after.recipient_name).toBe(mixed.recipient_name);
});

test('a failed private save keeps its text and unsaved navigation returns to the actual textarea',async({page})=>{
  await login(page);await openLetter(page);const text=page.locator('#letter-form [name="plaintext"]');await text.fill('PRIVATE_TEXT_AFTER_A_FAILED_SAVE');
  await page.route('**/api/items/'+ids.letter,route=>route.request().method()==='POST'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Synthetic save failure'})}):route.continue());
  const failure=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/items/'+ids.letter);await page.locator('#letter-form button[type="submit"]').click();expect((await failure).status()).toBe(503);await expect(page.locator('#toast')).toContainText('Synthetic save failure');await expect(indicator(page)).toBeVisible();
  await navigate(page,'home');await clickUnsaved(page,'letters','plaintext');await expect(text).toBeFocused();await expect(text).toHaveValue('PRIVATE_TEXT_AFTER_A_FAILED_SAVE');
  const dismissed=page.waitForEvent('dialog').then(async dialog=>{expect(dialog.type()).toBe('confirm');await dialog.dismiss();});await page.locator('#letter-revoke').click();await dismissed;await expect(text).toHaveValue('PRIVATE_TEXT_AFTER_A_FAILED_SAVE');await expect(indicator(page)).toBeVisible();expect((await(await page.request.get('/api/items/'+ids.letter+'/content')).json()).revoked_at).toBeNull();
  expect((await(await page.request.get('/api/items/'+ids.letter+'/content')).json()).plaintext).toBe('Private fixture letter');await page.unroute('**/api/items/'+ids.letter);
  const success=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/items/'+ids.letter);await page.locator('#letter-form button[type="submit"]').click();expect((await success).status()).toBe(200);await expect(indicator(page)).toBeHidden();
});

test('manual 503 and missing-response saves remain uncertain after reverting text until a successful retry',async({page})=>{
  await login(page);await openLetter(page);const path='/api/items/'+ids.letter;
  for(const mode of ['503','missing-response']){
    const text=page.locator('#letter-form [name="plaintext"]'),original=await text.inputValue();await text.fill('UNCERTAIN_PRIVATE_'+mode);
    await page.route('**'+path,route=>route.request().method()==='POST'?(mode==='503'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Synthetic uncertain save'})}):route.abort('failed')):route.continue());
    const failed=mode==='503'?page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===path):page.waitForEvent('requestfailed',request=>request.method()==='POST'&&new URL(request.url()).pathname===path);await page.locator('#letter-form button[type="submit"]').click();await failed;await expect(page.locator('#letter-form')).not.toHaveAttribute('aria-busy','true');await text.fill(original);await expect(indicator(page)).toBeVisible();await navigate(page,'home');await clickUnsaved(page,'letters');await expect(text).toHaveValue(original);await expect(indicator(page)).toBeVisible();
    await page.unroute('**'+path);const saved=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===path);await page.locator('#letter-form button[type="submit"]').click();expect((await saved).status()).toBe(200);await expect(indicator(page)).toBeHidden();expect((await(await page.request.get(path+'/content')).json()).plaintext).toBe(original);
  }
});

test('successful farewell autosave clears unsaved status while the saved draft remains unapplied',async({page,request})=>{
  await login(page);await navigate(page,'farewell');const body=entryBody(page);await expect(body).toBeVisible();await expect(indicator(page)).toBeHidden();const formal=await page.locator('#public-farewell-v2').getAttribute('data-formal-revision');
  await body.fill('PERSISTED_FAREWELL_DRAFT_NOT_APPLIED');await expect(indicator(page)).toBeVisible();
  await expect.poll(async()=>((await(await request.get('/__fixture/state')).json()).entry.draft_body)).toBe('PERSISTED_FAREWELL_DRAFT_NOT_APPLIED');await expect(indicator(page)).toBeHidden();
  await expect(page.locator('#public-farewell-v2')).toHaveAttribute('data-formal-revision',formal);expect((await(await request.get('/__fixture/state')).json()).entry.body).toBe('Entry 1');
  await body.fill('TEMPORARY_LOCAL_CHANGE');await body.fill('PERSISTED_FAREWELL_DRAFT_NOT_APPLIED');await expect(indicator(page)).toBeHidden();
});

test('an unsubmitted chapter title survives editor redraw and clears only after its own successful creation',async({page})=>{
  await login(page);await navigate(page,'farewell');const title=page.locator('.farewell-create-group [name="title"]');await title.fill('UNSUBMITTED_CHAPTER_TITLE');await expect(indicator(page)).toBeVisible();await page.locator('[data-group-select="2"]').click();await expect(page.locator('#public-farewell-v2')).toHaveAttribute('data-loaded-group','2');await expect(title).toHaveValue('UNSUBMITTED_CHAPTER_TITLE');await expect(indicator(page)).toBeVisible();await navigate(page,'home');await clickUnsaved(page,'farewell','title');await expect(title).toBeFocused();await expect(title).toHaveValue('UNSUBMITTED_CHAPTER_TITLE');
  const saved=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/public-farewell-v2/groups');await page.locator('.farewell-create-group button[type="submit"]').click();const response=await saved;expect(response.status()).toBe(200);const result=await response.json();await expect(page.locator('#public-farewell-v2')).toHaveAttribute('data-loaded-group',String(result.id));await expect(page.locator('.group-title-form [name="title"]')).toHaveValue('UNSUBMITTED_CHAPTER_TITLE');await expect(title).toHaveValue('');await expect(indicator(page)).toBeHidden();await page.locator('[data-group-select="3"]').click();await expect(page.locator('#public-farewell-v2')).toHaveAttribute('data-loaded-group','3');await expect(title).toHaveValue('');await expect(indicator(page)).toBeHidden();
});

test('failed farewell autosave remains locatable and retry clears its unsaved state',async({page,request})=>{
  await page.route('**/api/public-farewell-v2/entries/'+ids.entry,route=>route.request().method()==='POST'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Synthetic draft failure'})}):route.continue());
  await login(page);await navigate(page,'farewell');await entryBody(page).fill('FAREWELL_LOCAL_FAILURE_TEXT');await expect(page.locator('[data-retry-save]')).toBeVisible();await expect(indicator(page)).toBeVisible();
  await navigate(page,'home');await clickUnsaved(page,'farewell','body');await expect(entryBody(page)).toBeFocused();await expect(entryBody(page)).toHaveValue('FAREWELL_LOCAL_FAILURE_TEXT');expect((await(await request.get('/__fixture/state')).json()).entry.draft_body).toBe('Entry 1');
  const retry=page.locator('[data-retry-save]');await retry.scrollIntoViewIfNeeded();const stillFailed=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/public-farewell-v2/entries/'+ids.entry);await retry.click();expect((await stillFailed).status()).toBe(503);await expect(page.locator('#farewell-autosave')).toContainText('保存失败');
  await page.unroute('**/api/public-farewell-v2/entries/'+ids.entry);await retry.click();await expect.poll(async()=>((await(await request.get('/__fixture/state')).json()).entry.draft_body)).toBe('FAREWELL_LOCAL_FAILURE_TEXT');await expect(indicator(page)).toBeHidden();
});

test('multiple dirty views offer separate choices and focus the last changed field without discarding another draft',async({page})=>{
  await login(page);await navigate(page,'settings');await page.locator('#settings-form [name="timezone"]').fill('UTC');await page.locator('#settings-form [name="display_name"]').fill('SETTINGS_MULTI_VIEW_DRAFT');
  await openLetter(page);await page.locator('#letter-form [name="plaintext"]').fill('LETTER_MULTI_VIEW_DRAFT');await navigate(page,'people');const person=await openPerson(page,ids.people.primary.id);await person.locator('[name="name"]').fill('PERSON_MULTI_VIEW_DRAFT');await person.locator('..').locator('summary').click();await navigate(page,'home');
  await indicator(page).click();const dialog=page.locator('#am-unsaved');await expect(dialog).toBeVisible();await expect(dialog.locator('#am-unsaved-list [data-unsaved-view]')).toHaveCount(3);
  await page.screenshot({path:'output/playwright/dirty-desktop-chooser.png'});
  await expect(dialog.locator('[data-unsaved-view="settings"]')).toHaveAttribute('data-field-name','display_name');await page.locator('#am-unsaved-close').click();await expect(dialog).toBeHidden();
  await clickUnsaved(page,'settings','display_name');await expect(page.locator('#settings-form [name="display_name"]')).toBeFocused();
  await clickUnsaved(page,'people','name');await expect(person.locator('[name="name"]')).toBeFocused();await expect(person.locator('[name="name"]')).toHaveValue('PERSON_MULTI_VIEW_DRAFT');expect(await person.locator('..').evaluate(el=>el.open)).toBe(true);
  await clickUnsaved(page,'letters','plaintext');await expect(page.locator('#letter-form [name="plaintext"]')).toBeFocused();await expect(page.locator('#letter-form [name="plaintext"]')).toHaveValue('LETTER_MULTI_VIEW_DRAFT');await expect(page.locator('#settings-form [name="display_name"]')).toHaveValue('SETTINGS_MULTI_VIEW_DRAFT');
  expect((await(await page.request.get('/api/items/'+ids.letter+'/content')).json()).plaintext).toBe('Private fixture letter');expect((await roster(page)).find(row=>row.id===ids.people.primary.id).name).toBe(ids.people.primary.name);
});

test('jumping to an in-flight farewell save preserves a later undo back to its old baseline',async({page,request})=>{
  await request.post('/__fixture/delays',{data:{['POST /api/public-farewell-v2/entries/'+ids.entry]:1500}});await login(page);await navigate(page,'farewell');const body=entryBody(page),original=await body.inputValue();
  const firstRequest=page.waitForRequest(request=>request.method()==='POST'&&new URL(request.url()).pathname==='/api/public-farewell-v2/entries/'+ids.entry),firstResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/public-farewell-v2/entries/'+ids.entry);
  await body.fill('IN_FLIGHT_VALUE_TO_UNDO');await firstRequest;await navigate(page,'home');await clickUnsaved(page,'farewell','body');await expect(body).toBeFocused();await expect(body).toHaveValue('IN_FLIGHT_VALUE_TO_UNDO');await body.fill(original);
  expect((await firstResponse).status()).toBe(200);await expect.poll(async()=>{const state=await(await request.get('/__fixture/state')).json();return {body:state.entry.draft_body,saves:state.calls.filter(call=>call.method==='POST'&&call.path==='/api/public-farewell-v2/entries/'+ids.entry).length};},{timeout:15000}).toEqual({body:original,saves:2});await expect(body).toHaveValue(original);await expect(indicator(page)).toBeHidden();
});

test('mobile unsaved navigation opens a collapsed person form and focuses its changed input',async({page})=>{
  await page.setViewportSize({width:390,height:844});await login(page);await navigate(page,'people');const form=await openPerson(page,ids.people.primary.id),note=form.locator('[name="note"]');await note.fill('MOBILE_COLLAPSED_DRAFT_NOTE');await form.locator('..').locator('summary').click();await navigate(page,'home');await clickUnsaved(page,'people','note');await expect(note).toBeFocused();await expect(note).toHaveValue('MOBILE_COLLAPSED_DRAFT_NOTE');expect(await form.locator('..').evaluate(el=>el.open)).toBe(true);
  await expect.poll(async()=>note.evaluate(el=>{const r=el.getBoundingClientRect(),header=document.querySelector('.am-sidebar').getBoundingClientRect();return r.top>=header.bottom&&r.bottom<=innerHeight&&r.right<=innerWidth;})).toBe(true);await page.screenshot({path:'output/playwright/dirty-focus-mobile.png'});
});
