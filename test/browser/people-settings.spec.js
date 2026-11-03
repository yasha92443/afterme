// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {test,expect} from '@playwright/test';

let ids,people,errors;
async function login(page){await page.goto('/');await page.getByLabel('管理口令',{exact:true}).fill('synthetic-browser-admin');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.locator('.am-app')).toBeVisible();}
async function navigate(page,section){await page.locator('[data-nav="'+section+'"]').click();await expect(page.locator('#view-'+section+' .am-view-body')).toHaveAttribute('data-loaded','1');}
async function state(page){return (await page.request.get('/api/settings')).json();}
async function roster(page){return (await(await page.request.get('/api/people')).json()).results;}
async function changeLanguage(page,locale,selector='#settings-language'){
  const response=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname==='/api/settings');
  await page.locator(selector).selectOption(locale);expect((await response).status()).toBe(200);
  await expect(page.locator('html')).toHaveAttribute('lang',locale);
}
async function openPerson(page,id){
  const details=page.locator('#people-directory details[data-person-id="'+id+'"]');
  if(!await details.evaluate(el=>el.open))await details.locator('summary').click();
  return details.locator('form[data-person-form]');
}
async function saveSettings(page){
  const response=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname==='/api/settings');
  await page.locator('#settings-form button[type="submit"]').click();expect((await response).status()).toBe(200);
}
const checkbox=(page,name,value)=>page.locator('#settings-form input[name="'+name+'"][value="'+value+'"]');

test.beforeEach(async({page,request})=>{
  ids=await(await request.post('/__fixture/reset',{data:{people:true}})).json();
  people=ids.people;errors=[];page.on('pageerror',error=>errors.push(error.message));
});
test.afterEach(async()=>{expect(errors).toEqual([]);});

test('visible interface language persists Chinese, English and Russian without saving dirty settings',async({page})=>{
  await login(page);await navigate(page,'settings');
  const language=page.locator('#settings-language');await expect(language).toBeVisible();
  expect(await language.evaluate(el=>el.closest('#settings-form'))).toBe(null);
  expect(await language.locator('option').allTextContents()).toEqual(['中文','English','Русский']);
  await page.screenshot({path:'output/playwright/people-settings-language-desktop.png'});
  const initial=await state(page),name='UNSAVED_PROFILE_LANGUAGE',font=initial.preferences.font_size===21?22:21,theme=initial.preferences.theme==='paper'?'night':'paper';
  await page.locator('#settings-form [name="display_name"]').fill(name);
  await page.locator('#settings-form [name="theme"]').selectOption(theme);
  await page.locator('#settings-form [name="font_size"]').fill(String(font));
  await page.locator('#settings-form [name="private.grace_hours"]').fill('96');
  for(const [locale,label,accessibleName] of [['en','Settings','Interface language'],['ru','Настройки','Язык интерфейса'],['zh','设置','界面语言']]){
    await changeLanguage(page,locale);await expect(page.locator('[data-nav="settings"]')).toContainText(label);
    await expect(language).toHaveAccessibleName(accessibleName);
    await expect(page.locator('#quick-locale')).toHaveValue(locale);
    const saved=await state(page);expect(saved.preferences.locale).toBe(locale);expect(saved.preferences.theme).toBe(initial.preferences.theme);expect(saved.preferences.font_size).toBe(initial.preferences.font_size);expect(saved.owner.display_name).toBe(initial.owner.display_name);expect(saved.pending).toEqual(initial.pending);
    await expect(page.locator('#settings-form [name="display_name"]')).toHaveValue(name);await expect(page.locator('#settings-form [name="theme"]')).toHaveValue(theme);await expect(page.locator('#settings-form [name="font_size"]')).toHaveValue(String(font));await expect(page.locator('#settings-form [name="private.grace_hours"]')).toHaveValue('96');
  }
  await navigate(page,'home');await navigate(page,'settings');await expect(page.locator('#settings-form [name="display_name"]')).toHaveValue(name);
  await page.reload();await navigate(page,'settings');await expect(language).toHaveValue('zh');await expect(page.locator('html')).toHaveAttribute('lang','zh');
});

test('rapid language changes serialize with a later settings save and survive reload',async({page,request})=>{
  await request.post('/__fixture/delays',{data:{'PUT /api/settings':500}});await login(page);await navigate(page,'settings');
  await page.locator('#settings-form [name="display_name"]').fill('PROFILE_AFTER_QUEUED_LANGUAGE');
  const responses=[];page.on('response',response=>{if(response.request().method()==='PUT'&&new URL(response.url()).pathname==='/api/settings')responses.push(response);});
  await page.locator('#settings-language').selectOption('en');await page.locator('#quick-locale').selectOption('ru');
  await page.locator('#settings-form button[type="submit"]').click();
  await expect.poll(async()=>{const saved=await state(page);return [saved.owner.display_name,saved.preferences.locale];}).toEqual(['PROFILE_AFTER_QUEUED_LANGUAGE','ru']);
  expect(responses).toHaveLength(3);expect(responses.map(response=>response.status())).toEqual([200,200,200]);
  await page.reload();await navigate(page,'settings');await expect(page.locator('#settings-language')).toHaveValue('ru');await expect(page.locator('#quick-locale')).toHaveValue('ru');await expect(page.locator('html')).toHaveAttribute('lang','ru');
});

test('language switching preserves unsaved private text and lets the farewell draft save independently',async({page,request})=>{
  await login(page);await navigate(page,'letters');await page.locator('[data-letter="'+ids.letter+'"]').click();
  await page.locator('#letter-form [name="plaintext"]').fill('PRIVATE_UNSAVED_LANGUAGE_TEXT');await changeLanguage(page,'en','#quick-locale');
  await expect(page.locator('#letter-form [name="plaintext"]')).toHaveValue('PRIVATE_UNSAVED_LANGUAGE_TEXT');
  const original=await(await page.request.get('/api/items/'+ids.letter+'/content')).json();expect(original.plaintext).toBe('Private fixture letter');
  await navigate(page,'farewell');const body=page.locator('.farewell-entry-editor.is-selected textarea[name="body"]');await expect(body).toBeVisible();
  await body.fill('FAREWELL_DRAFT_DURING_LANGUAGE_SWITCH');await changeLanguage(page,'ru','#quick-locale');
  await expect(body).toHaveValue('FAREWELL_DRAFT_DURING_LANGUAGE_SWITCH');
  await expect.poll(async()=>{const snapshot=await(await request.get('/__fixture/state')).json();return snapshot.entry.draft_body;}).toBe('FAREWELL_DRAFT_DURING_LANGUAGE_SWITCH');
  const snapshot=await(await request.get('/__fixture/state')).json();expect(snapshot.entry.body).toBe('Entry 1');
  expect(snapshot.calls.some(call=>call.method==='POST'&&/\/(?:apply|checkin|resume)$/.test(call.path))).toBe(false);
  await navigate(page,'letters');await expect(page.locator('#letter-form [name="plaintext"]')).toHaveValue('PRIVATE_UNSAVED_LANGUAGE_TEXT');
});

test('one directory edit updates the shared identity and all three independent purposes',async({page})=>{
  await login(page);await navigate(page,'people');const primary=(await roster(page)).find(person=>person.email==='recipient@example.invalid');
  await page.screenshot({path:'output/playwright/people-directory-desktop.png'});
  expect(primary.id).not.toBe(primary.recipient_id);
  await expect(page.locator('#people-directory details[data-person-id="'+primary.id+'"]')).toHaveCount(1);
  const form=await openPerson(page,primary.id);await form.locator('[name="name"]').fill('Edited once for every purpose');await form.locator('[name="email"]').fill('edited-once@example.invalid');await form.locator('[name="locale"]').selectOption('en');
  const patch=page.waitForResponse(response=>response.request().method()==='PATCH'&&new URL(response.url()).pathname==='/api/people/'+primary.id);await form.locator('button[type="submit"]').click();const saved=await patch;expect(saved.status()).toBe(200);expect(saved.request().postDataJSON()).not.toHaveProperty('active');
  const updated=(await roster(page)).find(person=>person.id===primary.id);expect(updated.name).toBe('Edited once for every purpose');expect(updated.contact_name).toBe(updated.recipient_name);expect(updated.contact_locale).toBe('en');expect(updated.recipient_locale).toBe('en');
  await navigate(page,'settings');
  for(const [name,value] of [['private.contact_ids',primary.id],['public.contact_ids',primary.id],['public.audience','contact:'+primary.id]]){const field=checkbox(page,name,value);await expect(field).toHaveCount(1);await expect(field.locator('..')).toContainText('Edited once for every purpose');}
  const onlyRecipient=(await roster(page)).find(person=>person.email==='recipient-only@example.invalid');
  await checkbox(page,'private.contact_ids',onlyRecipient.id).check();await expect(checkbox(page,'public.contact_ids',onlyRecipient.id)).not.toBeChecked();await checkbox(page,'public.audience','contact:'+onlyRecipient.id).check();
  await saveSettings(page);const rules=(await state(page)).pending;
  expect(rules.private.contact_ids).toContain(onlyRecipient.id);expect(rules.public.contact_ids).not.toContain(onlyRecipient.id);expect(rules.public.audience).toContain('contact:'+onlyRecipient.id);expect(rules.public.audience).toContain('recipient:'+people.primary.recipient_id);
});

test('unchanged legacy PDF aliases and both private recipient relations survive navigation and language changes',async({page})=>{
  await login(page);await navigate(page,'settings');const before=await state(page);
  await page.locator('#settings-form [name="display_name"]').fill('Alias round trip');await saveSettings(page);
  const after=await state(page);expect((after.pending||after.active).public.audience).toEqual((before.pending||before.active).public.audience);
  await navigate(page,'letters');await page.locator('[data-letter="'+ids.letter+'"]').click();await expect(page.locator('#letter-form [name="recipient_id"]')).toHaveValue(String(people.primary.recipient_id));
  await page.locator('[data-letter="'+people.contact_letter+'"]').click();await expect(page.locator('#letter-form [name="recipient_id"]')).toHaveValue(String(people.contact_only.recipient_id));
  await changeLanguage(page,'en','#quick-locale');await expect(page.locator('#letter-form [name="recipient_id"]')).toHaveValue(String(people.contact_only.recipient_id));
  const original=await(await page.request.get('/api/items/'+ids.letter+'/content')).json(),legacy=await(await page.request.get('/api/items/'+people.contact_letter+'/content')).json();
  expect(original.recipient_id).toBe(people.primary.recipient_id);expect(legacy.recipient_id).toBe(null);expect(legacy.recipient_contact_id).toBe(people.contact_only.id);
  await navigate(page,'settings');const publicBox=checkbox(page,'public.audience','contact:'+people.primary.id);await publicBox.uncheck();await publicBox.check();await saveSettings(page);
  const edited=(await state(page)).pending;expect(edited.public.audience).toContain('contact:'+people.primary.id);expect(edited.public.audience).not.toContain('recipient:'+people.primary.recipient_id);
});

test('editing a mixed legacy profile sends only dirty fields and preserves untouched differences',async({page})=>{
  await login(page);await navigate(page,'people');const mixed=(await roster(page)).find(person=>person.email==='mixed@example.invalid');
  expect(mixed.active).toBe(null);expect(mixed.profile_conflicts.length).toBeGreaterThan(0);const form=await openPerson(page,mixed.id);
  expect(await form.locator('[name="active"]').evaluate(el=>el.indeterminate)).toBe(true);
  await form.locator('[name="note"]').fill('Only the shared note changed');
  const response=page.waitForResponse(response=>response.request().method()==='PATCH'&&new URL(response.url()).pathname==='/api/people/'+mixed.id);await form.locator('button[type="submit"]').click();const saved=await response;expect(saved.status()).toBe(200);
  const sent=saved.request().postDataJSON();expect(Object.keys(sent).sort()).toEqual(['expected_revision','note']);
  const updated=(await roster(page)).find(person=>person.id===mixed.id);expect(updated.contact_active).toBe(mixed.contact_active);expect(updated.recipient_active).toBe(mixed.recipient_active);expect(updated.contact_locale).toBe(mixed.contact_locale);expect(updated.recipient_locale).toBe(mixed.recipient_locale);expect(updated.contact_name).toBe(mixed.contact_name);expect(updated.recipient_name).toBe(mixed.recipient_name);
});

test('a person is created once and private letter addressing remains separate from role selection',async({page})=>{
  await login(page);await navigate(page,'people');const form=page.locator('#new-person form[data-person-form][data-id=""]');await form.locator('..').locator('summary').click();
  await form.locator('[name="name"]').fill('One newly shared person');await form.locator('[name="email"]').fill('new-shared@example.invalid');await form.locator('[name="locale"]').selectOption('en');
  const create=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/people');await form.locator('button[type="submit"]').click();expect((await create).status()).toBe(201);
  const created=(await roster(page)).filter(person=>person.email==='new-shared@example.invalid');expect(created).toHaveLength(1);const person=created[0];expect(person.recipient_id).toBeGreaterThan(0);
  await expect(page.locator('#people-directory details[data-person-id="'+person.id+'"]')).toHaveCount(1);
  await navigate(page,'settings');for(const [name,value] of [['private.contact_ids',person.id],['public.contact_ids',person.id],['public.audience','contact:'+person.id]])await checkbox(page,name,value).check();await saveSettings(page);
  await navigate(page,'letters');await page.locator('[data-letter="'+ids.letter+'"]').click();await expect(page.locator('#letter-form [name="recipient_id"]')).toHaveValue(String(people.primary.recipient_id));
  await page.locator('#letter-form [name="recipient_id"]').selectOption(String(person.recipient_id));const save=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/items/'+ids.letter);await page.locator('#letter-form button[type="submit"]').click();expect((await save).status()).toBe(200);
  const letter=await(await page.request.get('/api/items/'+ids.letter+'/content')).json(),other=await(await page.request.get('/api/items/'+people.contact_letter+'/content')).json();expect(letter.recipient_id).toBe(person.recipient_id);expect(other.recipient_id).toBe(null);expect(other.recipient_contact_id).toBe(people.contact_only.id);
});

test('mobile Russian labels and shared role checkboxes remain visible and operable',async({page})=>{
  await page.setViewportSize({width:390,height:844});await login(page);await navigate(page,'settings');await changeLanguage(page,'ru');
  await page.screenshot({path:'output/playwright/people-settings-russian-mobile.png'});
  await expect(page.locator('#settings-language')).toBeVisible();const person=(await roster(page)).find(person=>person.email==='recipient-only@example.invalid');
  for(const [name,value] of [['private.contact_ids',person.id],['public.contact_ids',person.id],['public.audience','contact:'+person.id]]){
    const field=checkbox(page,name,value);await field.scrollIntoViewIfNeeded();await field.check();await expect(field).toBeChecked();const box=await field.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(391);
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await navigate(page,'people');const form=await openPerson(page,person.id);await expect(form.locator('[name="locale"]')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test('an in-flight person PATCH prevents editing until its response finishes',async({page,request})=>{
  await request.post('/__fixture/delays',{data:{['PATCH /api/people/'+people.primary.id]:1800}});await login(page);await navigate(page,'people');
  const form=await openPerson(page,people.primary.id),name=form.locator('[name="name"]');await name.fill('FIRST_PROFILE_SAVE');
  const started=page.waitForRequest(request=>request.method()==='PATCH'&&new URL(request.url()).pathname==='/api/people/'+people.primary.id),completed=page.waitForResponse(response=>response.request().method()==='PATCH'&&new URL(response.url()).pathname==='/api/people/'+people.primary.id);
  await form.locator('button[type="submit"]').click();await started;await expect(form).toHaveAttribute('aria-busy','true');expect(await form.evaluate(el=>el.inert)).toBe(true);
  await name.scrollIntoViewIfNeeded();const box=await name.boundingBox();await page.mouse.click(box.x+Math.min(20,box.width/2),box.y+box.height/2);await page.keyboard.type('IN_FLIGHT_INPUT_MUST_BE_BLOCKED');
  await expect(name).not.toBeFocused();await expect(name).toHaveValue('FIRST_PROFILE_SAVE');await expect(form).toHaveAttribute('aria-busy','true');
  expect((await completed).status()).toBe(200);await expect(form).not.toHaveAttribute('aria-busy','true');expect(await form.evaluate(el=>el.inert)).toBe(false);await expect(name).toHaveValue('FIRST_PROFILE_SAVE');
  await name.fill('SECOND_PROFILE_SAVE');const second=page.waitForResponse(response=>response.request().method()==='PATCH'&&new URL(response.url()).pathname==='/api/people/'+people.primary.id);await form.locator('button[type="submit"]').click();expect((await second).status()).toBe(200);
  await expect.poll(async()=>((await roster(page)).find(person=>person.id===people.primary.id)).name).toBe('SECOND_PROFILE_SAVE');
});

test('saving a legacy contact-bound letter preserves its original recipient tuple and effective profile',async({page})=>{
  await login(page);const before=await(await page.request.get('/api/items/'+people.mixed_contact_letter+'/content')).json();
  expect(before.recipient_id).toBe(null);expect(before.recipient_contact_id).toBe(people.mixed.id);expect(before.recipient_name).toBe('Mixed contact name');expect(before.recipient_locale).toBe('zh');
  expect(people.mixed.contact_active).toBe(1);expect(people.mixed.recipient_active).toBe(0);expect(people.mixed.recipient_locale).toBe('ru');
  await navigate(page,'letters');await page.locator('[data-letter="'+people.mixed_contact_letter+'"]').click();await expect(page.locator('#letter-form [name="recipient_id"]')).toHaveValue(String(people.mixed.recipient_id));
  await page.locator('#letter-form [name="plaintext"]').fill('SAVED_BODY_KEEP_ORIGINAL_CONTACT_DELIVERY');
  const save=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/items/'+people.mixed_contact_letter);await page.locator('#letter-form button[type="submit"]').click();const response=await save;expect(response.status()).toBe(200);expect(response.request().postDataJSON().preserve_recipient).toBe(true);
  await expect(page.locator('#letter-form [name="plaintext"]')).toHaveValue('SAVED_BODY_KEEP_ORIGINAL_CONTACT_DELIVERY');
  const after=await(await page.request.get('/api/items/'+people.mixed_contact_letter+'/content')).json();expect(after.recipient_id).toBe(null);expect(after.recipient_contact_id).toBe(before.recipient_contact_id);expect(after.recipient_name).toBe(before.recipient_name);expect(after.recipient_locale).toBe(before.recipient_locale);expect(after.plaintext).toBe('SAVED_BODY_KEEP_ORIGINAL_CONTACT_DELIVERY');
  const person=(await roster(page)).find(person=>person.id===people.mixed.id);expect(person.contact_active).toBe(1);expect(person.recipient_active).toBe(0);expect(person.contact_locale).toBe('zh');expect(person.recipient_locale).toBe('ru');
});

test('a public PDF choice uses the active recipient side of a reverse mixed legacy profile',async({page})=>{
  await login(page);await navigate(page,'settings');const person=(await roster(page)).find(person=>person.id===people.reverse_mixed.id);expect(person.contact_active).toBe(0);expect(person.recipient_active).toBe(1);
  const field=checkbox(page,'public.audience','contact:'+person.id);await expect(field).not.toBeChecked();await expect(field).toHaveAttribute('data-delivery-value','recipient:'+person.recipient_id);await field.check();
  await saveSettings(page);const rules=(await state(page)).pending;expect(rules.public.audience).toContain('recipient:'+person.recipient_id);expect(rules.public.audience).not.toContain('contact:'+person.id);expect(rules.public.audience).toContain('recipient:'+people.primary.recipient_id);
  await page.reload();await navigate(page,'settings');await expect(checkbox(page,'public.audience','contact:'+person.id)).toBeChecked();
});
