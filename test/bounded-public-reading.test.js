// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import worker from '../src/worker.js';
import {READING_PAGE_MAX_BYTES} from '../src/bounded-public-reading.js';

const now='2026-10-21T00:00:00.000Z';
const allow={async limit(){return {success:true};}};
async function fixture(t,chapters=[{title:'Formal chapter',epigraph:'Quote\n——Author',bodies:['Formal body']}]){
  const db=database();t.after(()=>db.close());
  const repo=new Repository(db),env={DB:db,ADMIN_TOKEN:'reading-fixture',MAIL_PROVIDER:'dry-run',LOGIN_LIMITER:allow,API_LIMITER:allow,VERIFY_LIMITER:allow,EXPENSIVE_LIMITER:allow,READ_LIMITER:allow};
  await repo.setupOwner({displayName:'Example',email:'owner@example.invalid',now});
  await repo.getSettings(env);await repo.getRoundRules(await repo.getOwner());
  const ids=[];
  for(const chapter of chapters){
    const id=await repo.farewell.createGroup({title:chapter.title,now});ids.push(id);
    await repo.farewell.saveGroupDraft({id,title:chapter.title,epigraph:chapter.epigraph||'',now});
    for(const body of chapter.bodies||[])await repo.farewell.createEntry({groupId:id,body,isPublic:true,now});
  }
  await repo.farewell.applyDraft({now});
  await db.prepare("UPDATE owner SET state='PUBLIC_RELEASE',release_suspended=0 WHERE id=1").run();
  await db.prepare("UPDATE public_farewell SET status='PUBLIC_RELEASE' WHERE id=1").run();
  return {db,repo,env,ids};
}
function observe(db,read){return {
  prepare(sql){const statement=db.prepare(sql);return {bind(...args){statement.bind(...args);return this;},async first(){const result=await statement.first();read(sql);return result;},async all(){const result=await statement.all();read(sql);return result;},run(){const result=statement.run();read(sql);return result;}};},
  batch(statements){return db.batch(statements);},
};}
const decode=value=>value.replace(/&(amp|lt|gt|quot|#39);/g,(_all,key)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[key]));
const href=(html,className)=>{const match=html.match(new RegExp('<a class="'+className+'" href="([^"]+)"'));return match?decode(match[1]):null;};
const letters=html=>[...html.matchAll(/<div class="letter">([\s\S]*?)<\/div>/g)].map(match=>decode(match[1]));
async function page(env,path='/farewell',{admin=false}={}){
  const response=await worker.fetch(new Request('https://example.test'+path,{headers:admin?{Authorization:'Bearer '+env.ADMIN_TOKEN}:{}}),env);
  const html=await response.text();assert.ok(Buffer.byteLength(html)<=READING_PAGE_MAX_BYTES);return {response,html};
}

test('public release and preview authentication gates precede all formal chapter reads',async t=>{
  const f=await fixture(t),queries=[];const env={...f.env,DB:observe(f.db,sql=>queries.push(sql))};
  for(const update of ["state='NORMAL'","state='PUBLIC_RELEASE',pause_mode='indefinite'","pause_mode=NULL,release_suspended=1"]){
    await f.db.prepare('UPDATE owner SET '+update+' WHERE id=1').run();queries.length=0;
    const result=await page(env);assert.equal(result.response.status,200);assert.doesNotMatch(result.html,/Formal body|Formal chapter|Quote/);
    assert.equal(queries.some(sql=>/FROM public_farewell_(?:groups|entries)_v2/.test(sql)),false);
  }
  queries.length=0;assert.equal((await page(env,'/api/public-farewell/preview')).response.status,401);
  assert.equal(queries.some(sql=>/FROM public_farewell_(?:groups|entries)_v2/.test(sql)),false);
  await f.db.prepare("UPDATE owner SET state='PUBLIC_RELEASE',release_suspended=0 WHERE id=1").run();
  await f.db.prepare("UPDATE round_rules SET rules_json=json_set(rules_json,'$.public.enabled',0)").run();queries.length=0;
  assert.doesNotMatch((await page(env)).html,/Formal body/);assert.equal(queries.some(sql=>/FROM public_farewell_(?:groups|entries)_v2/.test(sql)),false);
});

test('published and admin reading preserve all UTF-8 text through bounded pages and escape markup',async t=>{
  const source=('中🙂<&>"\'\n'.repeat(7000))+'END';
  const f=await fixture(t,[{title:'Chapter',epigraph:'Quote\n——Author',bodies:[source,'Second entry']}]);
  await f.repo.farewell.saveGroupDraft({id:f.ids[0],title:'UNAPPLIED_TITLE',epigraph:'UNAPPLIED_EPIGRAPH',now});
  for(const route of ['/farewell','/api/public-farewell/preview']){
    let path=route,text='',count=0;
    while(path){
      const {response,html}=await page(f.env,path,{admin:route.includes('/api/')});assert.equal(response.status,200);
      assert.doesNotMatch(html,/UNAPPLIED|\uFFFD/);assert.match(html,/id="reader-larger"/);
      assert.match(html,/<details class="reader-version-info">/);assert.ok(html.indexOf('reader-version-info">')>html.lastIndexOf('</article>'));
      text+=letters(html).join('');path=href(html,'reader-continuation');assert.ok(++count<100);
    }
    assert.ok(count>5);assert.equal(text,source+'Second entry');
  }
});

test('chapter directories page independently and chapter continuation keeps formal order',async t=>{
  const chapters=Array.from({length:45},(_,i)=>({title:'Chapter '+String(i).padStart(2,'0'),bodies:['Body '+i+'\n']})),f=await fixture(t,chapters);
  let path='/farewell',directoryTitles=[],pages=0;
  while(path){const {html}=await page(f.env,path),directory=html.match(/<nav class="reader-toc">([\s\S]*?)<\/nav>/)[1];directoryTitles.push(...[...directory.matchAll(/<li><a [^>]+>(.*?)<\/a><\/li>/g)].map(match=>decode(match[1])));path=href(html,'reader-more-chapters');assert.ok(++pages<5);}
  assert.deepEqual(directoryTitles,chapters.map(chapter=>chapter.title));
  path='/farewell';let content='';pages=0;
  while(path){const {html}=await page(f.env,path);content+=letters(html).join('');path=href(html,'reader-continuation');assert.ok(++pages<50);}
  assert.equal(content,chapters.map(chapter=>chapter.bodies.join('')).join(''));assert.equal(pages,45);
});

test('oversized titles and epigraphs have lossless continuation instead of silent truncation',async t=>{
  const title='题🙂<&>'.repeat(380),epigraph='  \n'.repeat(900)+'题辞🙂<&>\n'.repeat(1500)+'——Author';
  const f=await fixture(t,[{title,epigraph,bodies:['Body after metadata']}]);
  let path='/farewell',readTitle='',readEpigraph='',body='',count=0;
  while(path){
    const current=new URL('https://example.test'+path),part=current.searchParams.get('part')||'start';
    const {response,html}=await page(f.env,path);assert.equal(response.status,200);
    const article=html.match(/<article class="farewell-item"[\s\S]*?<\/article>/)[0];
    if(part==='start'||part==='title')readTitle+=decode(article.match(/<h2>([\s\S]*?)<\/h2>/)[1]);
    const fragment=article.match(/<span class="farewell-epigraph-quote reader-epigraph-fragment">([\s\S]*?)<\/span>/);if(fragment)readEpigraph+=decode(fragment[1]);
    body+=letters(html).join('');path=href(html,'reader-continuation');assert.ok(++count<150);
  }
  assert.equal(readTitle,title);assert.equal(readEpigraph,epigraph);assert.equal(body,'Body after metadata');
});

test('the page budget includes escaped headings, a full directory, metadata and every locale',async t=>{
  const source='&'.repeat(20000),chapters=Array.from({length:21},(_,i)=>({title:'&'.repeat(i?80:500),epigraph:i?'':"'".repeat(2048),bodies:[i?'next':source]})),f=await fixture(t,chapters);
  for(const [locale,theme] of [['zh','paper'],['en','contrast'],['ru','system']]){
    await f.db.prepare("UPDATE user_settings SET preferences_json=json_set(preferences_json,'$.locale',?,'$.theme',?) WHERE id=1").bind(locale,theme).run();
    const {response,html}=await page(f.env);assert.equal(response.status,200);assert.match(html,new RegExp('<html lang="'+locale+'"'));assert.match(html,/id="reader-theme"/);assert.match(html,/reader-continuation/);
  }
  let path='/farewell',text='',count=0;
  while(path){const {response,html}=await page(f.env,path);assert.equal(response.status,200);text+=letters(html).join('');path=href(html,'reader-continuation');assert.ok(++count<80);}
  assert.equal(text,source+'next'.repeat(20));
});

test('reading version changes and release withdrawal never return mixed or withdrawn bodies',async t=>{
  const f=await fixture(t),first=await page(f.env),oldPath=href(first.html,'reader-continuation')||'/farewell?revision='+(await f.repo.farewell.getVersions()).formal_revision;
  await f.db.prepare('UPDATE farewell_document_versions SET formal_revision=formal_revision+1 WHERE id=1').run();
  const stale=await page(f.env,oldPath);assert.equal(stale.response.status,409);assert.doesNotMatch(stale.html,/Formal body/);assert.match(stale.html,/正式版本已更新/);
  for(const mutate of [()=>f.db.prepare('UPDATE farewell_document_versions SET formal_revision=formal_revision+1 WHERE id=1').run(),()=>f.db.prepare("UPDATE owner SET state='NORMAL',confirmation_round=confirmation_round+1 WHERE id=1").run(),()=>f.db.prepare('UPDATE owner SET release_suspended=1 WHERE id=1').run()]){
    await f.db.prepare("UPDATE owner SET state='PUBLIC_RELEASE',release_suspended=0 WHERE id=1").run();await f.repo.getRoundRules(await f.repo.getOwner());
    let fired=false;const env={...f.env,DB:observe(f.db,sql=>{if(!fired&&sql.includes(' AS body_hex')){fired=true;mutate();}})};
    const result=await page(env);assert.equal(fired,true);assert.ok([200,409].includes(result.response.status));assert.doesNotMatch(result.html,/Formal body/);
  }
});

test('invalid, oversized and mid-code-point cursors fail safely without leaking database errors',async t=>{
  const f=await fixture(t,[{title:'🙂'.repeat(300),bodies:['🙂'.repeat(10000)]}]);
  for(const query of ['chapter=NaN','toc=1:2:3','part=unknown','entry_cursor=0:1:1','part=title&text_offset=1','part=epigraph&text_offset=999999','revision='+('9'.repeat(110))]){
    const result=await page(f.env,'/farewell?'+query+'&chapter='+f.ids[0]);assert.equal(result.response.status,400,query);assert.doesNotMatch(result.html,/SELECT|SQLITE|body_hex/);
  }
});
