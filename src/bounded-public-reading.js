// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {publicReadingPage} from './external-pages.js';

export const READING_PAGE_MAX_BYTES=64*1024;
const DIRECTORY_LIMIT=20,TITLE_BYTES=512,EPIGRAPH_BYTES=2048,BODY_BYTES=16384;
const encoder=new TextEncoder();
const copy={
  zh:{continue:'继续阅读',chapters:'更多章节',first:'目录首页',restart:'从本章开头阅读',changed:'正式版本已更新，请从开头重新阅读。',versionRestart:'阅读最新版本',title:'标题续页',epigraph:'题辞续页',print:'打印当前页'},
  en:{continue:'Continue reading',chapters:'More chapters',first:'First chapter directory',restart:'Read this chapter from the beginning',changed:'The formal version changed. Please restart reading.',versionRestart:'Read the latest version',title:'Title continued',epigraph:'Epigraph continued',print:'Print this page'},
  ru:{continue:'Продолжить чтение',chapters:'Следующие главы',first:'Начало оглавления',restart:'Читать главу с начала',changed:'Опубликованная версия изменилась. Начните чтение заново.',versionRestart:'Читать новую версию',title:'Продолжение заголовка',epigraph:'Продолжение эпиграфа',print:'Печать этой страницы'},
};
const rows=result=>result?.results||[];
function invalid(){throw Object.assign(Error('Invalid reading cursor'),{status:400});}
function numbers(value,count){
  if(typeof value!=='string'||value.length>100||!new RegExp('^\\d+'+':\\d+'.repeat(count-1)+'$').test(value))invalid();
  const values=value.split(':').map(Number);if(values.some(n=>!Number.isSafeInteger(n)||n<0))invalid();return values;
}
function utf8(hex){
  if(typeof hex!=='string'||hex.length%2||!/^[\da-f]*$/i.test(hex))throw Error('Invalid reading data');
  const bytes=Uint8Array.from(hex.match(/../g)||[],value=>parseInt(value,16));
  // SQL cuts bytes, so retain the incomplete final code point for the next page.
  for(let trim=0;trim<=Math.min(3,bytes.length);trim++){
    try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,bytes.length-trim));}catch{}
  }
  invalid();
}
function allowed(owner,rules,env){
  return Boolean(owner&&rules?.public.enabled&&rules.public.web&&!owner.pause_mode&&!owner.release_suspended&&env.RELEASE_SUSPENDED!=='true'&&env.RELEASE_SUSPENDED!==true&&['PRIVATE_RELEASE','PUBLIC_RELEASE'].includes(owner.state));
}
function readingUrl(url,values={}){
  const query=new URLSearchParams();
  for(const key of ['revision','toc','chapter','part','text_offset','entry_cursor']){
    const value=values[key];if(value!==undefined&&value!==null&&value!=='')query.set(key,String(value));
  }
  return url.pathname+(query.size?'?'+query.toString():'');
}
async function limitedResponse(options,status=200){
  const rendered=publicReadingPage(options),html=await rendered.text();
  if(encoder.encode(html).byteLength>READING_PAGE_MAX_BYTES)throw Error('Reading page exceeded its byte budget');
  return new Response(html,{status,headers:rendered.headers});
}

// Each SELECT returns at most one bounded text window (two for entry lookahead).
// A revision fence prevents joining text from different formal publications.
export async function boundedPublicReading(repo,env,url,{preview=false}={}){
  const settings=await repo.getSettings(env),preferences=settings.preferences,l=preferences.locale,labels=copy[l]||copy.zh;
  let owner=null,rules=null;
  if(!preview){
    owner=await repo.getOwner();rules=owner?await repo.getRoundRules(owner):null;
    if(!allowed(owner,rules,env))return limitedResponse({publicFarewell:null,preferences});
  }
  const [versionResult,documentResult]=await repo.db.batch([
    repo.db.prepare('SELECT formal_revision FROM farewell_document_versions WHERE id=1'),
    repo.db.prepare('SELECT status,updated_at FROM public_farewell WHERE id=1'),
  ]);
  const version=rows(versionResult)[0]?.formal_revision,document=rows(documentResult)[0];
  if(!Number.isSafeInteger(version)||version<0)throw Error('Missing formal revision');
  if(!preview&&document?.status!=='PUBLIC_RELEASE')return limitedResponse({publicFarewell:null,preferences});
  const changed=()=>limitedResponse({publicFarewell:null,preferences,navigation:{notice:labels.changed,restart:{href:readingUrl(url),label:labels.versionRestart}}},409);
  const requestedRevision=url.searchParams.get('revision');
  if(requestedRevision!==null&&numbers(requestedRevision,1)[0]!==version)return changed();
  const directoryCursor=url.searchParams.get('toc'),after=directoryCursor?numbers(directoryCursor,2):null;
  const chapterParam=url.searchParams.get('chapter'),chapter=chapterParam?numbers(chapterParam,1)[0]:null;
  const part=url.searchParams.get('part')||'start';if(!['start','title','epigraph','body'].includes(part))invalid();
  const offsetValue=url.searchParams.get('text_offset'),offset=offsetValue?numbers(offsetValue,1)[0]:0;
  const entryValue=url.searchParams.get('entry_cursor'),entryCursor=entryValue?numbers(entryValue,3):null;
  if((offset&& !['title','epigraph'].includes(part))||(entryCursor&&part!=='body'))invalid();
  const directory=rows(await repo.db.prepare(`SELECT id,sort_order,substr(title,1,80) AS title,length(title)>80 AS abbreviated FROM public_farewell_groups_v2 WHERE is_deleted=0 ${after?'AND (sort_order,id)>(?,?)':''} ORDER BY sort_order,id LIMIT ?`).bind(...(after||[]),DIRECTORY_LIMIT+1).all());
  const selected=chapter??directory[0]?.id;
  const base={revision:version,...(directoryCursor?{toc:directoryCursor}:{})};
  const directoryItems=directory.slice(0,DIRECTORY_LIMIT).map(g=>({title:g.title+(g.abbreviated?'…':''),href:readingUrl(url,{...base,chapter:g.id})}));
  const last=directoryItems.length?directory[DIRECTORY_LIMIT-1]||directory.at(-1):null;
  const navigation={directory:directoryItems,printLabel:labels.print,first:{label:labels.first,href:readingUrl(url,{revision:version})},...(directory.length>DIRECTORY_LIMIT?{more:{label:labels.chapters,href:readingUrl(url,{revision:version,toc:last.sort_order+':'+last.id})}}:{})};
  let group=null,entry=null,body='',entryLookahead=false,nextChapter=null,stage=part;
  if(selected!==undefined&&selected!==null){
    const titleOffset=part==='title'?offset:0,epigraphOffset=part==='epigraph'?offset:0;
    group=await repo.db.prepare(`SELECT g.id,g.sort_order,g.title_updated_at,g.epigraph_updated_at,length(CAST(g.title AS BLOB)) AS title_bytes,length(CAST(g.epigraph AS BLOB)) AS epigraph_bytes,hex(substr(CAST(g.title AS BLOB),?,?)) AS title_hex,hex(substr(CAST(g.epigraph AS BLOB),?,?)) AS epigraph_hex,substr(g.title,1,80) AS context_title,(SELECT COUNT(*)+1 FROM public_farewell_groups_v2 p WHERE p.is_deleted=0 AND (p.sort_order,p.id)<(g.sort_order,g.id)) AS reading_index FROM public_farewell_groups_v2 g WHERE g.id=? AND g.is_deleted=0`).bind(titleOffset+1,TITLE_BYTES,epigraphOffset+1,EPIGRAPH_BYTES,selected).first();
    if(!group)throw Object.assign(Error('Chapter not found'),{status:404});
    group.title= utf8(group.title_hex);group.epigraph=utf8(group.epigraph_hex);
    if((part==='title'&&offset>=group.title_bytes)||(part==='epigraph'&&offset>=group.epigraph_bytes))invalid();
    nextChapter=await repo.db.prepare('SELECT id FROM public_farewell_groups_v2 WHERE is_deleted=0 AND (sort_order,id)>(?,?) ORDER BY sort_order,id LIMIT 1').bind(group.sort_order,group.id).first();
    if(part==='start')stage=encoder.encode(group.title).length<group.title_bytes?'title':encoder.encode(group.epigraph).length<group.epigraph_bytes?'epigraph':'body';
    if(stage==='body'){
      const entries=rows(await repo.db.prepare(`SELECT e.id,e.sort_order,e.body_updated_at,length(CAST(e.body AS BLOB)) AS body_bytes,hex(substr(CAST(e.body AS BLOB),CASE WHEN e.id=? THEN ? ELSE 1 END,?)) AS body_hex,(SELECT COUNT(*)+1 FROM public_farewell_entries_v2 p WHERE p.group_id=e.group_id AND p.is_deleted=0 AND p.is_public=1 AND (p.sort_order,p.id)<(e.sort_order,e.id)) AS reading_index FROM public_farewell_entries_v2 e WHERE e.group_id=? AND e.is_deleted=0 AND e.is_public=1 ${entryCursor?'AND ((e.sort_order,e.id)>(?,?) OR ((e.sort_order,e.id)=(?,?) AND length(CAST(e.body AS BLOB))>?))':''} ORDER BY e.sort_order,e.id LIMIT 2`).bind(entryCursor?.[1]||0,(entryCursor?.[2]||0)+1,BODY_BYTES,group.id,...(entryCursor?[...entryCursor.slice(0,2),...entryCursor.slice(0,2),entryCursor[2]]:[])).all());
      entry=entries[0];entryLookahead=entries.length>1;body=entry?utf8(entry.body_hex):'';
    }
    navigation.chapterStart={label:labels.restart,href:readingUrl(url,{...base,chapter:group.id})};
    if(part==='title'||part==='epigraph')navigation.partLabel=labels[part];
  }
  function options(){
    if(!group)return {publicFarewell:{status:'PUBLIC_RELEASE',updated_at:document?.updated_at},groups:[],preferences,preview,navigation};
    const titleOffset=part==='title'?offset:0,epigraphOffset=part==='epigraph'?offset:0;
    const bodyStart=entry&&entryCursor&&entry.id===entryCursor[1]?entryCursor[2]:0;
    const next={...base,chapter:group.id};
    if(stage==='title'){
      const end=titleOffset+encoder.encode(group.title).length;
      Object.assign(next,end<group.title_bytes?{part:'title',text_offset:end}:group.epigraph_bytes?{part:'epigraph',text_offset:0}:{part:'body'});
    }else if(stage==='epigraph'){
      const end=epigraphOffset+encoder.encode(group.epigraph).length;
      Object.assign(next,end<group.epigraph_bytes?{part:'epigraph',text_offset:end}:{part:'body'});
    }else if(entry&&(bodyStart+encoder.encode(body).length<entry.body_bytes||entryLookahead)){
      Object.assign(next,{part:'body',entry_cursor:entry.sort_order+':'+entry.id+':'+(bodyStart+encoder.encode(body).length)});
    }else if(nextChapter)Object.assign(next,{chapter:nextChapter.id});
    else navigation.continue=null;
    if(stage!=='body'||entry&&(bodyStart+encoder.encode(body).length<entry.body_bytes||entryLookahead)||nextChapter)navigation.continue={href:readingUrl(url,next),label:labels.continue};
    const fullTitle=part==='title'||part==='start'||group.title_bytes<=TITLE_BYTES;
    const displayGroup={...group,display_title:fullTitle?group.title:group.context_title+'…',display_epigraph:stage==='title'?'':stage==='epigraph'||group.epigraph_bytes<=EPIGRAPH_BYTES?group.epigraph:'',epigraph_fragment:stage==='epigraph',entries:stage==='body'&&entry?[{display_body:body,body_updated_at:entry.body_updated_at,reading_index:entry.reading_index}]:[]};
    return {publicFarewell:{status:'PUBLIC_RELEASE',updated_at:document?.updated_at},groups:[displayGroup],updatedAt:document?.updated_at,preferences,preview,navigation};
  }
  let response;
  // HTML escaping can expand a byte sixfold. Fit the rendered page, then advance
  // only by the exact UTF-8 bytes actually displayed, never by the SQL window.
  for(;;){
    const rendered=publicReadingPage(options()),html=await rendered.text();
    if(encoder.encode(html).byteLength<=READING_PAGE_MAX_BYTES){response=new Response(html,{headers:rendered.headers});break;}
    const points=[...body];if(points.length<=1)throw Error('Reading page exceeded its byte budget');
    body=points.slice(0,Math.ceil(points.length/2)).join('');
  }
  const [versionAfter,documentAfter,ownerAfter]=await repo.db.batch([
    repo.db.prepare('SELECT formal_revision FROM farewell_document_versions WHERE id=1'),
    repo.db.prepare('SELECT status FROM public_farewell WHERE id=1'),
    repo.db.prepare('SELECT state,pause_mode,release_suspended,confirmation_round FROM owner WHERE id=1'),
  ]);
  if(!preview&&(!allowed(rows(ownerAfter)[0],rules,env)||rows(ownerAfter)[0]?.confirmation_round!==owner.confirmation_round||rows(documentAfter)[0]?.status!=='PUBLIC_RELEASE'))return limitedResponse({publicFarewell:null,preferences});
  if(rows(versionAfter)[0]?.formal_revision!==version)return changed();
  return response;
}
