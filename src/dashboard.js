// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import { CATALOG, REPLY_COMMANDS, t } from './i18n.js';
import {backupCryptoFactory} from './backup-crypto.js';
import { farewellEditorScript,farewellEditorStyles } from './farewell-editor-ui.js';
import { PRESETS } from './settings.js';
import { PDF_VERSION } from './pdf-layout.js';
import { escapeHtml, layout } from './ui.js';

// Bump the client suffix when browser preparation protocol behavior changes.
const PDF_ASSET_VERSION=PDF_VERSION+'-client-v3';

export function loginPage() {
  return layout({title:'AfterMe',bare:true,body:`<style>${styles}</style><main class="am-login"><h1>AfterMe<span>.</span></h1><form id="login-form"><label id="login-label" for="login-password">管理口令</label><input id="login-password" type="password" autocomplete="current-password" required><label for="login-mfa">验证器动态码 / 一次性恢复码（已启用时）</label><input id="login-mfa" autocomplete="one-time-code" maxlength="100"><button id="login-button">登录</button><p role="alert" id="login-error"></p></form><select id="login-locale" aria-label="Language"><option value="zh">中文</option><option value="en">English</option><option value="ru">Русский</option></select><p><a href="/farewell">Public farewell</a></p></main><script>const catalog=${safe(CATALOG)};const choice=document.getElementById('login-locale');let remembered;try{remembered=localStorage.getItem('afterme-locale')}catch{};choice.value=['zh','en','ru'].includes(remembered)?remembered:'zh';function labels(){const c=catalog[choice.value];document.documentElement.lang=choice.value;document.getElementById('login-label').textContent=c.password;document.getElementById('login-button').textContent=c.login;}choice.onchange=()=>{try{localStorage.setItem('afterme-locale',choice.value)}catch{};labels()};labels();document.getElementById('login-form').onsubmit=async e=>{e.preventDefault();const button=document.getElementById('login-button');button.disabled=true;document.getElementById('login-error').textContent='';try{const r=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({admin_token:document.getElementById('login-password').value,mfa_code:document.getElementById('login-mfa').value})});const d=await r.json();if(!r.ok)throw Error(d.message||d.error);document.getElementById('login-password').value='';location.href='/admin';}catch(err){document.getElementById('login-error').textContent=err.message}finally{button.disabled=false}};</script>`});
}
export function dashboardPage(data) {
  data={...data,pdf_asset_version:PDF_ASSET_VERSION};
  const l=data.settings.preferences.locale;
  return layout({title:'AfterMe',bare:true,body:`<style>${styles}${peopleStyles}${farewellEditorStyles}${editorThemeStyles}</style><div class="am-app"><aside class="am-sidebar"><a class="am-brand" href="#home">AfterMe<span>.</span></a><nav aria-label="AfterMe">${['home','letters','farewell','people','settings','maintenance'].map((key,i)=>`<a href="#${key}" data-nav="${key}"><span class="am-index">0${i+1}</span><span data-i18n="${key}">${escapeHtml(t(l,key))}</span></a>`).join('')}</nav><div class="am-sidebar-foot"><div class="am-locale-control"><label class="am-language-label" for="quick-locale" data-i18n="interfaceLanguage">界面语言</label><select id="quick-locale"><option value="zh">中文</option><option value="en">English</option><option value="ru">Русский</option></select></div><button type="button" id="logout" data-i18n="logout">${t(l,'logout')}</button></div></aside><main class="am-main"><header class="am-top"><button type="button" id="dirty-indicator" hidden aria-controls="am-unsaved" aria-haspopup="dialog"></button><select id="quick-theme" aria-label="Theme">${['night','paper','contrast','system'].map(k=>`<option value="${k}" data-i18n="${k}">${t(l,k)}</option>`).join('')}</select></header><p id="toast" role="status" aria-live="polite"></p>${['home','letters','farewell','people','settings','maintenance'].map(key=>`<section id="view-${key}" class="am-view" ${key!=='home'?'hidden':''}><h1 data-i18n="${key}">${t(l,key)}</h1><div class="am-view-body"></div></section>`).join('')}</main></div><dialog id="am-unsaved"><h2 data-i18n="showUnsaved">${t(l,'showUnsaved')}</h2><p data-i18n="unsavedHelp">${t(l,'unsavedHelp')}</p><div id="am-unsaved-list"></div><button type="button" id="am-unsaved-close" data-i18n="back">${t(l,'back')}</button></dialog><dialog id="am-auth"><form id="am-auth-form"><h2 data-i18n="relogin">${t(l,'relogin')}</h2><p id="am-auth-reason"></p><label for="am-secret" data-i18n="password">${t(l,'password')}</label><input id="am-secret" type="password" autocomplete="current-password" required><label for="am-mfa">验证器动态码 / 一次性恢复码（已启用时）</label><input id="am-mfa" autocomplete="one-time-code" maxlength="100"><p role="alert" id="am-auth-error"></p><button data-i18n="login">${t(l,'login')}</button><button type="button" id="am-auth-cancel" data-i18n="cancel">${t(l,'cancel')}</button></form></dialog><dialog id="am-conflict"><h2 data-i18n="conflict">${t(l,'conflict')}</h2><pre id="am-remote"></pre><button type="button" id="am-conflict-merge" data-i18n="merge">${t(l,'merge')}</button><button type="button" id="am-conflict-close" data-i18n="back">${t(l,'back')}</button></dialog><dialog id="am-apply"><h2>应用前核对</h2><p>以下草稿修改将保存为正式版本；公开状态按释放规则推进。</p><ul id="am-apply-list"></ul><button type="button" id="am-apply-confirm">应用这些修改</button><button type="button" id="am-apply-cancel">返回编辑</button></dialog><dialog id="am-backup"><form id="am-backup-form"><h2>加密备份 / Encrypted backup</h2><p>备份口令只在浏览器中使用，不发送给服务器。请与内容密钥分开保管，遗失后无法解密备份。</p><label>备份口令 / Backup passphrase<input id="backup-password" type="password" autocomplete="new-password" minlength="12" required></label><label>再次输入 / Repeat passphrase<input id="backup-repeat" type="password" autocomplete="new-password" minlength="12" required></label><p id="backup-error" role="alert"></p><button type="submit">加密并下载 / Encrypt and download</button><button type="button" id="backup-cancel">取消 / Cancel</button></form></dialog><script>window.aftermeBackupCrypto=(${backupCryptoFactory.toString()})();</script><script>${farewellEditorScript()}</script><script src="/static/pdf-client.js?v=${encodeURIComponent(data.pdf_asset_version)}"></script><script>(${dashboardClient.toString()})(${safe(data)},${safe(CATALOG)},${safe(PRESETS)});</script>`});
}
function safe(value){return JSON.stringify(value).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');}
function dashboardClient(initial,catalog,presets) {
  let data=initial, csrf=initial.csrf, locale=initial.settings.preferences.locale, theme=initial.settings.preferences.theme, section='home', people=null, peopleRequest=null, letterCursor=null, logCursor=null, chapterCursor=null;
  const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
  const tr=k=>catalog[locale][k]||k, esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const text=k=>`<span data-i18n="${k}">${esc(tr(k))}</span>`;
  const button=(k,id,extra='')=>`<button type="button" ${id?`id="${id}"`:''} ${extra}>${text(k)}</button>`;
  const field=(k,name,value,type='text',extra='')=>`<label>${text(k)}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  const check=(k,name,value)=>`<label class="am-check"><input type="checkbox" name="${name}" ${value?'checked':''}>${text(k)}</label>`;
  const select=(k,name,value,options)=>`<label>${text(k)}<select name="${name}">${options.map(([v,label])=>`<option value="${esc(v)}" ${String(value)===String(v)?'selected':''} ${Object.hasOwn(catalog[locale],v)?'data-i18n="'+esc(v)+'"':''}>${esc(label)}</option>`).join('')}</select></label>`;
  let dateFormatter, dateFormatKey;
  const dateLabel=v=>{const key=locale+':'+data.settings.preferences.timezone;if(key!==dateFormatKey){dateFormatter=new Intl.DateTimeFormat(locale,{timeZone:data.settings.preferences.timezone,dateStyle:'medium',timeStyle:'short'});dateFormatKey=key;}return dateFormatter.format(new Date(v));};
  const time=v=>v?`<time datetime="${esc(new Date(v).toISOString())}">${dateLabel(v)}</time>`:'—';
  let preferenceQueue=Promise.resolve();
  function persistDisplay(changes){preferenceQueue=preferenceQueue.catch(()=>{}).then(async()=>{const preferences={...data.settings.preferences,...changes};const result=await api('/api/settings','PUT',{revision:data.settings.revision,preferences,rules:data.settings.pending||data.settings.active});data.settings=result;const revision=$('#settings-revision');if(revision)revision.textContent=result.revision;return result;});return preferenceQueue;}
  const content=k=>$(`#view-${k} .am-view-body`);
  function labels(){
    document.documentElement.lang=locale;
    $$('[data-i18n]').forEach(el=>{const value=tr(el.dataset.i18n);if(el.textContent!==value)el.textContent=value;});
    $$('time[datetime]').forEach(el=>{const value=dateLabel(el.dateTime);if(el.textContent!==value)el.textContent=value;});
    $('#quick-locale').value=locale;$('#quick-theme').value=theme;if($('#settings-language')){$('#settings-language').value=locale;$('#settings-language').setAttribute('aria-label',tr('interfaceLanguage'));}
    document.documentElement.dataset.amTheme=theme==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'night':'paper'):theme;
    document.documentElement.style.setProperty('--am-font',(Number($('#settings-form [name=font_size]')?.value)||data.settings.preferences.font_size)+'px');
    $('#settings-form')?.updateSafety?.();dirtyStatus();
  }
  const formStates=new WeakMap();let editOrder=0;
  const controls=f=>[...f.elements].filter(el=>el.name&&!el.disabled&&!['hidden','submit','button','reset','password'].includes(el.type));
  const fieldKey=el=>el.name+(['checkbox','radio'].includes(el.type)?':'+el.value:'');
  const fieldValue=el=>JSON.stringify(['checkbox','radio'].includes(el.type)?[el.checked,Boolean(el.indeterminate)]:el.multiple?[...el.selectedOptions].map(o=>o.value):el.value);
  const fieldStates=f=>new Map(controls(f).map(el=>[fieldKey(el),fieldValue(el)]));
  function snapshot(f){return f.dirtySnapshot?f.dirtySnapshot():JSON.stringify(controls(f).filter(el=>!['checkbox','radio'].includes(el.type)||el.checked||el.indeterminate).map(el=>[fieldKey(el),fieldValue(el)]));}
  function registerForm(f){if(!formStates.has(f)&&!f.matches('#mfa-enable,#mfa-disable'))formStates.set(f,{saved:snapshot(f),fields:fieldStates(f),edits:new Map(),order:0});}
  function formChanged(f,field){const state=formStates.get(f);if(!state)return false;if(field?.name){state.order=++editOrder;state.edits.set(fieldKey(field),state.order);}return Boolean(state.uncertain)||snapshot(f)!==state.saved;}
  function markDirty(f,field){if(formChanged(f,field))f.dataset.dirty='1';else delete f.dataset.dirty;dirtyStatus();}
  function formSaved(f,value=snapshot(f)){const state=formStates.get(f);if(state){state.saved=value;state.uncertain=false;state.fields=f.dirtySnapshot?fieldStates(f):new Map(JSON.parse(value));}if(!f.matches('.farewell-autosave'))markDirty(f);}
  function unsavedForms(){return $$('form[data-dirty],form[data-unsaved="1"]').filter(f=>formStates.has(f)).sort((a,b)=>formStates.get(b).order-formStates.get(a).order);}
  function dirtyStatus(){const count=unsavedForms().length,el=$('#dirty-indicator');el.hidden=!count;el.textContent=count?tr('unsaved')+' · '+count:'';el.title=tr('showUnsaved');el.setAttribute('aria-label',tr('showUnsaved')+(count?' · '+count:''));}
  function dirtyField(f){const state=formStates.get(f),fields=controls(f);return fields.filter(el=>f.dirtyFieldChanged?f.dirtyFieldChanged(el,state.saved):fieldValue(el)!==(state?.fields.get(fieldKey(el))??(['checkbox','radio'].includes(el.type)?'[false,false]':''))).sort((a,b)=>(state?.edits.get(fieldKey(b))||0)-(state?.edits.get(fieldKey(a))||0))[0]||fields[0];}
  async function locateUnsaved(f){
    $('#am-unsaved').close();if(!f.isConnected){dirtyStatus();return;}
    const view=f.closest('.am-view')?.id.slice(5);if(view)await navigate(view);
    const row=f.closest('[data-person-id]');if(row){row.hidden=false;$('#people-search').value='';$$('#people-directory [data-person-id]').forEach(el=>el.hidden=false);}
    for(let el=f.parentElement;el;el=el.parentElement)if(el.tagName==='DETAILS')el.open=true;
    const root=f.closest('#public-farewell-v2');if(root){const editor=f.closest('[data-entry-editor]');if(editor){root.querySelectorAll('[data-entry-editor]').forEach(el=>el.classList.toggle('is-selected',el===editor));root.querySelectorAll('[data-entry-select]').forEach(el=>el.classList.toggle('is-selected',el.dataset.entrySelect===editor.dataset.entryEditor));}root.querySelector('[data-farewell-tab="'+(f.matches('.farewell-create-group')?'outline':'edit')+'"]')?.click();}
    const field=dirtyField(f)||f;field.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'});field.focus({preventScroll:true});
  }
  $('#dirty-indicator').onclick=()=>{const forms=unsavedForms();if(forms.length===1){locateUnsaved(forms[0]).catch(error=>toast(error.message,true));return;}if(!forms.length)return;const list=$('#am-unsaved-list');list.replaceChildren();for(const f of forms){const field=dirtyField(f),view=f.closest('.am-view')?.id.slice(5),b=document.createElement('button');b.type='button';b.dataset.unsavedView=view||'';b.dataset.fieldName=field?.name||'';const label=field?.labels?.[0]?.querySelector('[data-i18n]')?.textContent||field?.getAttribute('aria-label')||field?.name||tr('body');b.textContent=[tr(view),f.closest('[data-person-id]')?.querySelector('strong')?.textContent,f.dataset.template,label].filter(Boolean).join(' · ');b.onclick=()=>locateUnsaved(f).catch(error=>toast(error.message,true));list.append(b);}$('#am-unsaved').showModal();};
  $('#am-unsaved-close').onclick=()=>$('#am-unsaved').close();
  function toast(message,error=false){$('#toast').textContent=message;$('#toast').classList.toggle('am-error',error);}
  function rememberLocale(){try{localStorage.setItem('afterme-locale',locale)}catch{}}
  async function preview(path,html=false){
    const popup=window.open('about:blank','_blank');if(!popup)throw Error(tr('popupBlocked'));
    popup.opener=null;popup.document.body.textContent=tr('loading');let cancellation;
    try{
      if(html){await api('/api/settings');popup.location.replace(path);return;}
      const privatePdf=path.match(/^\/api\/items\/(\d+)\/pdf$/),target=privatePdf?{kind:'private',id:Number(privatePdf[1])}:path==='/api/public-farewell/pdf'?{kind:'public'}:null;
      let blob;
      if(target){
        if(!window.aftermePdf?.download)throw Error('PDF preview is unavailable; reload management and retry');
        const controller=new AbortController();cancellation=setInterval(()=>{if(popup.closed)controller.abort();},1000);
        blob=await window.aftermePdf.download(target,{signal:controller.signal,onProgress:(done,total)=>{if(popup.closed){controller.abort();return;}popup.document.body.textContent=tr('loading')+' '+Math.floor(done*100/total)+'%';}});
      }else{const response=await api(path,'POST',{},true);blob=await response.blob();}
      if(popup.closed)throw Error('PDF preview closed');
      const url=URL.createObjectURL(blob);popup.location.replace(url);
      // A PDF viewer may request later pages after its first render. Retain the
      // backing Blob while the preview remains open, with a bounded lifetime.
      const expires=Date.now()+3600000,cleanup=setInterval(()=>{if(popup.closed||Date.now()>=expires){clearInterval(cleanup);URL.revokeObjectURL(url);}},1000);
    }catch(error){popup.close();throw error;}
    finally{if(cancellation)clearInterval(cancellation);}
  }
  async function downloadPdfSource(path,filename){
    const privateSource=path.match(/^\/api\/items\/(\d+)\/pdf-source$/),target=privateSource?{kind:'private',id:Number(privateSource[1])}:path==='/api/public-farewell/pdf-source'?{kind:'public'}:null;
    if(target&&!window.aftermePdf?.source)throw Error('PDF source export is unavailable; reload management and retry');
    const doc=target?await window.aftermePdf.source(target):await api(path,'POST',{}),url=URL.createObjectURL(new Blob([JSON.stringify(doc,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  const approvedRevisions=new Map();let conflictData=null;let authPromise=null;
  async function unlock(reason){
    if(authPromise)return authPromise;
    const dialog=$('#am-auth');$('#am-auth-reason').textContent=tr(reason);$('#am-auth-error').textContent='';dialog.showModal();$('#am-secret').focus();
    authPromise=new Promise((resolve,reject)=>{
      const cancel=()=>{dialog.close();$('#am-secret').value='';authPromise=null;reject(Error(tr('cancel')));};
      $('#am-auth-cancel').onclick=cancel;dialog.oncancel=e=>{e.preventDefault();cancel();};
      $('#am-auth-form').onsubmit=async e=>{e.preventDefault();try{const r=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({admin_token:$('#am-secret').value,mfa_code:$('#am-mfa').value})});const d=await r.json();if(!r.ok)throw Error(d.message||d.error);csrf=d.csrf;$('#am-secret').value='';$('#am-mfa').value='';dialog.close();authPromise=null;resolve();window.aftermePdf?.resume();}catch(err){$('#am-auth-error').textContent=err.message;}};
    });return authPromise;
  }
  async function api(path,method='GET',body,raw=false,retry=true,options={}){
    if(body&&approvedRevisions.has(path))body.expected_revision=approvedRevisions.get(path);
    let controller,timer,timedOut=false,rawReturned=false;
    const cleanup=()=>{if(timer)clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);};
    const cancel=()=>{controller?.abort();cleanup();};
    if(options.signal?.aborted)throw Error('PDF download cancelled');
    if(options.signal||options.timeoutMs){controller=new AbortController();options.signal?.addEventListener('abort',cancel,{once:true});if(options.timeoutMs)timer=setTimeout(()=>{timedOut=true;controller.abort();cleanup();},options.timeoutMs);}
    try{
      const r=await fetch(path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':csrf||''},body:body?JSON.stringify(body):undefined,...(controller?{signal:controller.signal}:{})});
      if((r.status===401||r.status===428)&&retry){cleanup();await r.body?.cancel();await unlock(r.status===401?'expired':'reauth');return api(path,method,body,raw,false,options);}
      if(!r.ok){const d=await r.json().catch(()=>({})),pdfRead=path==='/api/pdf-artifacts/preview'||path==='/api/pdf-artifacts'&&method==='POST'||method==='GET'&&/^\/api\/pdf-artifacts\/[a-f0-9-]+\/(?:chunks\/|source(?:\?|$))/.test(path),editingConflict=r.status===409&&!pdfRead;if(editingConflict){conflictPath=path;conflictBody=body;conflictData=d.current;$('#am-conflict-merge').hidden=path!=='/api/settings'&&!Number.isSafeInteger(conflictData?.revision);$('#am-remote').textContent=JSON.stringify(d.current||d,null,2);$('#am-conflict').showModal();}const e=Error(editingConflict?tr('conflict'):d.message||d.error||r.status);e.status=r.status;e.data=d;throw e;}
      approvedRevisions.delete(path);if(raw){rawReturned=true;return r;}return await r.json();
    }catch(error){if(options.signal?.aborted)throw Error('PDF download cancelled');if(timedOut)throw Error('PDF preview request timed out');throw error;}
    finally{if(!rawReturned)cleanup();}
  }
  window.aftermePdf?.configure({api,version:data.pdf_asset_version,networkTimeouts:true});
  const pdfStates=new Map();
  function pdfKey(target){return target.kind+':'+(target.id||0)+(target.kind==='public'?':'+(target.locale||data.settings.preferences.locale):'');}
  function pdfStatus(target){
    if(target.kind==='public'){
      const revision=Number(target.revision??$('#public-farewell-v2')?.dataset.formalRevision),states=['zh','en','ru'].map(locale=>pdfStates.get(pdfKey({kind:'public',locale}))).filter(state=>state&&Number(state.revision)===revision);
      const failures=states.filter(state=>state.status==='failed');if(failures.length)return '正文已保存，PDF 待重试：'+failures.map(state=>(state.locale||data.settings.preferences.locale)+' · '+state.message).join('；');
      if(states.length===3&&states.every(state=>state.status==='ready'))return '三种语言的 PDF 已准备好';
      if(states.length)return '正文已保存，PDF 准备中（'+states.filter(state=>state.status==='ready').length+'/3）…';
    }
    const state=pdfStates.get(pdfKey(target));return state?.status==='ready'?'PDF 已准备好':state?.status==='validating'?'PDF 已上传，后台正在校验…':state?.status==='pending'?'正文已保存，PDF 准备中…':state?.status==='failed'?'正文已保存，PDF 待重试：'+state.message:'正文已保存，PDF 准备状态可在维护页查看';
  }
  function preparePdf(target){pdfStates.set(pdfKey(target),{...target,status:'pending'});return window.aftermePdf?.prepare(target).catch(()=>{});}
  window.aftermePreparePdf=preparePdf;
  window.addEventListener('afterme:pdf',event=>{const target=event.detail,previous=pdfStates.get(pdfKey(target));if(Number(previous?.revision)>Number(target.revision))return;pdfStates.set(pdfKey(target),target);const el=$(target.kind==='private'?'#letter-pdf-status':'#public-pdf-status');if(el&&(target.kind!=='private'||el.dataset.item===String(target.id)))el.textContent=pdfStatus(target);});
  function action(el,fn){el.onclick=async()=>{el.disabled=true;try{await fn();}catch(e){toast(e.message,true);}finally{el.disabled=false;}};}
  function form(el,fn){registerForm(el);el.onsubmit=async e=>{e.preventDefault();const b=el.querySelector('[type=submit]'),wasInert=el.inert,displayControls=el.id==='settings-form'?['#quick-theme','#quick-locale','#settings-language'].map(selector=>$(selector)).filter(Boolean).map(control=>[control,control.disabled]):[];displayControls.forEach(([control])=>control.disabled=true);if(b)b.disabled=true;el.inert=true;el.setAttribute('aria-busy','true');try{await fn();formSaved(el);toast(tr('saved'));}catch(e){const state=formStates.get(el);if(state&&(!e.status||e.status>=500)){state.uncertain=true;markDirty(el);}toast(e.message,true);}finally{el.inert=wasInert;el.removeAttribute('aria-busy');displayControls.forEach(([control,disabled])=>control.disabled=disabled);if(b)b.disabled=false;}};}
  for(const event of ['input','change'])document.addEventListener(event,e=>{const f=e.target.closest('form');if(f&&!f.matches('.farewell-autosave'))markDirty(f,e.target);});
  addEventListener('beforeunload',e=>{if(unsavedForms().length){e.preventDefault();e.returnValue='';}});
  async function changeLocale(value){locale=value;labels();rememberLocale();const status=$('#settings-language-status');if(status)status.textContent=tr('saving');try{await persistDisplay({locale:value});if(status)status.textContent=tr('saved');}catch(error){if(locale===value){locale=data.settings.preferences.locale;labels();rememberLocale();}if(status)status.textContent=tr('languageSaveFailed');toast(error.message,true);}}
  $('#quick-locale').onchange=e=>changeLocale(e.target.value);
  $('#quick-theme').onchange=async e=>{const value=theme=e.target.value,p=$('#settings-form [name=theme]'),f=p?.form;if(p){p.value=theme;markDirty(f,p);}labels();try{await persistDisplay({theme:value});const state=f&&formStates.get(f);if(state){const saved=JSON.parse(state.saved);saved.preferences.theme=value;state.saved=JSON.stringify(saved);state.fields.set(fieldKey(p),JSON.stringify(value));markDirty(f);}}catch(error){if(theme===value){theme=data.settings.preferences.theme;if(p){p.value=theme;markDirty(f);}labels();}toast(error.message,true);}};
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(theme==='system')labels();});
  action($('#logout'),async()=>{if($$('form[data-dirty]').length&&!confirm(tr('discardUnsaved')))return;window.aftermePdf?.pause();await api('/api/logout','POST',{});$$('form[data-dirty]').forEach(f=>delete f.dataset.dirty);location.href='/';});
  let conflictPath=null,conflictBody=null;$('#am-conflict-merge').onclick=async()=>{try{if(conflictPath==='/api/settings'){const latest=await api('/api/settings');data.settings=latest;const el=$('#settings-revision');if(el)el.textContent=latest.revision;}else if(Number.isSafeInteger(conflictData?.revision)){approvedRevisions.set(conflictPath,conflictData.revision);}else{throw Error(tr('conflict'));}$('#am-conflict').close();toast(tr('merged'));}catch(e){toast(e.message,true);}};$('#am-conflict-close').onclick=()=>$('#am-conflict').close();
  async function refreshStatus(){if(!$('#settings-form[data-dirty]'))delete content('settings').dataset.loaded;const s=await api('/api/settings');data.settings=s;data.owner=s.owner;data.progress=s.progress;data.rules=s.round;data.counts=s.counts||data.counts;renderHome();}
  function ruleSummary(r){if(!r)return text('empty');return `<div class="am-rule-summary"><p>${text('overdue_hours')} ${r.overdue_hours}h · ${text('alert_hours')} ${r.alert_hours}h · ${text('verify_hours')} ${r.verify_hours}h</p>${['private','public'].map(k=>`<p>${text(k)}: ${r[k].quorum} / ${r[k].contact_ids.length} · ${r[k].grace_hours}h</p>`).join('')}</div>`;}
  function renderHome(){const previous=$('#pause-form'),draft=previous?.dataset.dirty?{until:previous.elements.until.value,mode:previous.elements.mode.value,open:previous.closest('details').open}:null;const o=data.owner;if(!o){content('home').innerHTML='<form id="first-owner">'+field('owner','display_name','','text','required')+field('email','email','','email','required')+'<button type="submit">'+text('save')+'</button></form>';form($('#first-owner'),async()=>{await api('/api/setup','POST',Object.fromEntries(new FormData($('#first-owner'))));await refreshStatus();});labels();return;}const r=data.rules||data.settings.active;const anchor=o?.timer_anchor_at||o?.last_checkin_at;const thresholds=[['overdue_hours',r.overdue_hours],['alert_hours',r.alert_hours],['verify_hours',r.verify_hours]];const next=thresholds.find(([,h])=>Date.parse(anchor)+h*3600000>Date.now());const deadlines=(data.progress||[]).filter(p=>p.ready_at&&!p.released_at&&r[p.channel].enabled).map(p=>({channel:p.channel,at:Date.parse(p.ready_at)+r[p.channel].grace_hours*3600000})).sort((a,b)=>a.at-b.at);const upcoming=deadlines[0];
    content('home').innerHTML=`<div class="am-hero"><p class="am-kicker">${esc(o?.display_name||'AfterMe')}</p><h2 data-i18n="${esc(o?.pause_mode?'paused':o?.state||'NORMAL')}">${esc(o?.pause_mode?tr('paused'):tr(o?.state||'NORMAL'))}</h2><p>${text('last')} ${time(o?.last_checkin_at)}</p>${button('checkin','owner-checkin','class="am-primary"')}</div><div class="am-grid"><article class="am-card"><h2>${text('next')}</h2><p class="am-big">${o?.pause_mode?time(o.pause_until):upcoming?time(new Date(upcoming.at)):next?time(new Date(Date.parse(anchor)+next[1]*3600000)):tr('confirmations')}</p><p>${upcoming?text(upcoming.channel)+' · '+text('releaseReady'):next?text(next[0]):''}</p><p class="am-muted">${text('cadence')}</p></article><article class="am-card"><h2>${text('notice')}</h2><ul>${(data.notices||[]).map(n=>`<li>${text(n)}</li>`).join('')||`<li>${text('none')}</li>`}</ul>${data.settings.pending?`<p class="am-warning">${text('pending')}</p>`:''}</article></div><article class="am-card"><h2>${text('confirmations')}</h2><div class="am-grid">${['private','public'].map(k=>{const p=(data.progress||[]).find(p=>p.channel===k);return `<div><h3>${text(k)}</h3><p>${data.counts?.[k]||0} / ${r[k].quorum}</p><p>${p?.released_at?text('released')+' '+time(p.released_at):p?.ready_at?text('releaseReady')+' '+time(p.ready_at):text('remaining')}</p><p>${r[k].grace_hours} ${text('hours')}</p></div>`;}).join('')}</div></article><details class="am-card"><summary>${text('pause')}</summary><form id="pause-form"><p>${text('pauseHelp')}</p><p>${text('timezone')}: ${esc(data.settings.preferences.timezone)}</p>${field('pauseUntil','until','','datetime-local','required')}${select('resume','mode','automatic',[['automatic',tr('automatic')],['manual',tr('manual')]])}<button type="submit">${text('pause')}</button></form>${button('resume','resume-pause')}</details>`;
    action($('#owner-checkin'),async()=>{await api('/api/checkin','POST',{resume_release:true});await refreshStatus();});
    action($('#resume-pause'),async()=>{await api('/api/resume','POST',{});await refreshStatus();});
    form($('#pause-form'),async()=>{await api('/api/pause','POST',{mode:$('#pause-form [name=mode]').value,until:zonedInputToISO($('#pause-form [name=until]').value)});delete $('#pause-form').dataset.dirty;await refreshStatus();});if(draft){const f=$('#pause-form');f.elements.until.value=draft.until;f.elements.mode.value=draft.mode;f.closest('details').open=draft.open;markDirty(f);}labels();
  }
  function zonedInputToISO(value){const target=Date.parse(value+'Z');let stamp=target;const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:data.settings.preferences.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});const wall=n=>{const p=Object.fromEntries(fmt.formatToParts(new Date(n)).map(v=>[v.type,v.value]));return Date.parse(p.year+'-'+p.month+'-'+p.day+'T'+p.hour+':'+p.minute+'Z');};for(let i=0;i<3;i++)stamp+=target-wall(stamp);if(!Number.isFinite(stamp)||wall(stamp)!==target)throw Error(tr('timezone'));return new Date(stamp).toISOString();}
  function invalidatePeople(){people=null;peopleRequest=null;}
  async function getPeople(){
    if(people)return people;
    if(!peopleRequest){
      const request=api('/api/people').then(({results})=>{
        const result={directory:results,contacts:results.map(p=>({id:p.id,name:p.name,email:p.email,active:p.contact_active,locale:p.contact_locale})),recipients:results.map(p=>({id:p.recipient_id,name:p.recipient_name,email:p.email,active:p.recipient_active,locale:p.recipient_locale}))};
        if(peopleRequest===request)people=result;
        return result;
      }).finally(()=>{if(peopleRequest===request)peopleRequest=null;});
      peopleRequest=request;
    }
    return peopleRequest;
  }
  function personChoices(directory,key,r){
    const audience=key==='audience';
    return directory.map(person=>{
      const original=audience?r.public.audience.filter(value=>value==='contact:'+person.id||value==='recipient:'+person.recipient_id):[];
      const checked=audience?original.length>0:r[key].contact_ids.includes(person.id),available=audience?Boolean(person.contact_active||person.recipient_active):Boolean(person.contact_active);
      const deliveryValue=person.contact_active?'contact:'+person.id:person.recipient_active?'recipient:'+person.recipient_id:'contact:'+person.id;
      return `<label class="am-person-choice"><input type="checkbox" name="${audience?'public.audience':key+'.contact_ids'}" value="${audience?'contact:'+person.id:person.id}" data-person-choice="${person.id}" data-initial-checked="${checked?'1':'0'}" ${audience?`data-original-values="${esc(JSON.stringify(original))}" data-delivery-value="${deliveryValue}"`:''} ${checked?'checked':''}><span><strong>${esc(person.name)}</strong><small>${esc(person.email)}${available?'':' · '+tr('inactive')}</small></span></label>`;
    }).join('')||`<p class="am-muted">${text('noPeople')}</p>`;
  }
  async function renderSettings(){
    let people=await getPeople();const s=data.settings,p=s.preferences,r=s.pending||s.active,target=content('settings');
    const picker=key=>`<div class="am-person-picker" data-people-picker="${key}">${personChoices(people.directory,key,r)}</div>`;
    target.innerHTML=`<article class="am-card am-language-card"><div><h2>${text('interfaceLanguage')}</h2><p class="am-muted">${text('interfaceLanguageHelp')}</p></div><div><label for="settings-language">${text('chooseLanguage')}</label><select id="settings-language" aria-label="${esc(tr('interfaceLanguage'))}"><option value="zh" ${locale==='zh'?'selected':''}>中文</option><option value="en" ${locale==='en'?'selected':''}>English</option><option value="ru" ${locale==='ru'?'selected':''}>Русский</option></select><p id="settings-language-status" class="am-muted" role="status">${text('languageAutoSave')}</p></div></article>
    <form id="settings-form"><article class="am-card"><h2>${text('basic')}</h2><div class="am-grid">${field('owner','display_name',data.owner?.display_name||'')}${field('email','email',data.owner?.email||'','email')}${field('timezone','timezone',p.timezone)}${select('theme','theme',p.theme,['night','paper','contrast','system'].map(k=>[k,tr(k)]))}${field('font','font_size',p.font_size,'number','min="14" max="24"')}${select('pdf','pdf_style',p.pdf_style,['night','paper'].map(k=>[k,tr(k)]))}</div></article>
    <article class="am-card"><h2>${text('rules')}</h2><p>${text('effective')}</p><div class="am-grid am-rule-state"><div><h3>${text('active')}</h3><p>${text('revision')}: ${s.active_rule_version||0}</p>${ruleSummary(data.rules||s.active)}</div><div><h3>${text('pending')}</h3><p>${text('revision')}: <span id="pending-rule-version">${s.pending_rule_version??'—'}</span></p><div id="pending-summary">${s.pending?ruleSummary(s.pending):text('empty')}</div></div></div>
    <div class="am-toolbar">${['short','current','long'].map(k=>button(k,'preset-'+k)).join('')}${button('defaults','reset-rules')}</div><div class="am-grid">${['overdue_hours','alert_hours','verify_hours'].map(k=>`<label>${text(k)}<div class="am-inline"><input type="number" name="${k}" value="${r[k]}" min="1" max="8760" required><select name="${k}_unit"><option value="1" data-i18n="hours">${tr('hours')}</option><option value="24" data-i18n="days">${tr('days')}</option></select></div></label>`).join('')}</div><p>${text('cadence')}</p>
    <div class="am-directory-note"><p>${text('sharedDirectoryHelp')}</p>${button('managePeople','settings-manage-people')}</div>
    ${['private','public'].map(key=>`<fieldset><legend>${text(key)}</legend>${check('enabled',key+'.enabled',r[key].enabled)}<div class="am-grid">${field('quorum',key+'.quorum',r[key].quorum,'number','min="1" max="100" required')}${field('grace_hours',key+'.grace_hours',r[key].grace_hours,'number','min="0" max="8760" required')}</div><h3>${text(key==='private'?'privateVerifiers':'publicVerifiers')}</h3><p class="am-muted">${text('verifiersHelp')}</p>${picker(key)}<p id="available-${key}"></p>${key==='private'?`<p class="am-muted">${text('privateRecipientsHelp')}</p>`:`${check('web','public.web',r.public.web)}${check('pdfChannel','public.pdf',r.public.pdf)}<h3>${text('publicRecipients')}</h3><p class="am-muted">${text('publicRecipientsHelp')}</p>${picker('audience')}`}</fieldset>`).join('')}
    <div id="rule-changes"></div><p id="rule-risk" class="am-warning" hidden>${text('risk')}</p>${button('previewTimeline','preview-rules')}<div id="rule-preview" aria-live="polite"></div></article>
    <details class="am-card"><summary>${text('advanced')}</summary><div class="am-grid">${check('selfcheck','selfcheck',p.selfcheck)}${field('backup_reminder_days','backup_reminder_days',p.backup_reminder_days,'number','min="1" max="365"')}${field('daily_email_limit','daily_email_limit',p.daily_email_limit,'number',`min="1" max="${s.mail_cap}"`)}<p>${text('cap')}: ${s.mail_cap}</p></div><p class="am-muted">${text('personLanguageLocation')}</p></details>
    <div class="am-sticky"><button type="submit" class="am-primary">${text('save')}</button>${button('undoPending','undo-pending')}<span>${text('revision')}: <b id="settings-revision">${s.revision}</b></span></div></form>`;
    const f=$('#settings-form');$('#settings-language').onchange=event=>changeLocale(event.target.value);action($('#settings-manage-people'),()=>navigate('people'));
    function readRules(){
      const result={};for(const key of ['overdue_hours','alert_hours','verify_hours']){const hours=Number(f.elements[key].value)*Number(f.elements[key+'_unit'].value);result[key]=Math.abs(hours-Math.round(hours))<1e-7?Math.round(hours):hours;}
      for(const key of ['private','public'])result[key]={enabled:f.elements[key+'.enabled'].checked,quorum:Number(f.elements[key+'.quorum'].value),grace_hours:Number(f.elements[key+'.grace_hours'].value),contact_ids:$$(`#settings-form [name="${key}.contact_ids"]:checked`).map(input=>Number(input.value))};
      result.public.web=f.elements['public.web'].checked;result.public.pdf=f.elements['public.pdf'].checked;
      result.public.audience=$$('#settings-form [name="public.audience"]:checked').flatMap(input=>input.dataset.initialChecked==='1'?JSON.parse(input.dataset.originalValues):[input.dataset.deliveryValue||input.value]);return result;
    }
    function safety(){
      const next=readRules(),active=data.settings.active,changes=[];
      for(const key of ['overdue_hours','alert_hours','verify_hours'])if(active[key]!==next[key])changes.push(tr(key)+': '+active[key]+' → '+next[key]+' '+tr('hours'));
      for(const key of ['private','public'])for(const field of ['enabled','quorum','grace_hours','contact_ids',...(key==='public'?['web','pdf','audience']:[])])if(JSON.stringify(active[key][field])!==JSON.stringify(next[key][field])){
        const names=(value,isAudience)=>[...new Set(value.map(id=>{const person=people.directory.find(p=>isAudience?(id==='contact:'+p.id||id==='recipient:'+p.recipient_id):p.id===id);return person?.name||String(id);}))].join('、')||tr('empty');
        const before=['contact_ids','audience'].includes(field)?names(active[key][field],field==='audience'):String(active[key][field]),after=['contact_ids','audience'].includes(field)?names(next[key][field],field==='audience'):String(next[key][field]);
        changes.push(tr(key)+' · '+tr(({contact_ids:'voters',pdf:'pdfChannel',audience:'publicRecipients'})[field]||field)+': '+before+' → '+after);
      }
      $('#rule-changes').innerHTML='<h3>'+text('changed')+'</h3>'+(changes.length?'<ul>'+changes.map(value=>'<li>'+esc(value)+'</li>').join('')+'</ul>':text('noChanges'));
      $('#rule-risk').hidden=!['private','public'].some(key=>next[key].enabled&&(next[key].quorum===1||next[key].grace_hours===0));
      for(const key of ['private','public'])$('#available-'+key).textContent=tr('available')+': '+next[key].contact_ids.filter(id=>people.contacts.some(person=>person.id===id&&person.active)).length+' / '+next[key].quorum;
    }
    f.refreshPeople=updated=>{
      const old=new Map($$('#settings-form [data-person-choice]').map(input=>[input.name+':'+input.dataset.personChoice,{checked:input.checked,initial:input.dataset.initialChecked,original:input.dataset.originalValues}]));people=updated;
      for(const key of ['private','public','audience'])f.querySelector('[data-people-picker="'+key+'"]').innerHTML=personChoices(people.directory,key,r);
      for(const input of $$('#settings-form [data-person-choice]')){const state=old.get(input.name+':'+input.dataset.personChoice);if(state){input.checked=state.checked;input.dataset.initialChecked=state.initial;if(state.original!==undefined)input.dataset.originalValues=state.original;}}
      safety();labels();
    };
    for(const key of ['overdue_hours','alert_hours','verify_hours']){const unit=f.elements[key+'_unit'],input=f.elements[key];unit.dataset.previous=unit.value;unit.addEventListener('change',()=>{const hours=Number(input.value)*Number(unit.dataset.previous);input.value=String(hours/Number(unit.value));unit.dataset.previous=unit.value;input.min=String(1/Number(unit.value));input.max=String(8760/Number(unit.value));input.step=unit.value==='1'?'1':'any';markDirty(f);safety();});}
    f.updateSafety=safety;f.addEventListener('input',safety);f.addEventListener('change',event=>{if(event.target.name==='public.audience')event.target.dataset.initialChecked='0';safety();});safety();
    for(const key of Object.keys(presets))action($('#preset-'+key),async()=>{const values=presets[key];['overdue_hours','alert_hours','verify_hours'].forEach((name,i)=>{f.elements[name].value=values[i];f.elements[name+'_unit'].value='1';f.elements[name+'_unit'].dataset.previous='1';f.elements[name].min='1';f.elements[name].max='8760';f.elements[name].step='1';});for(const name of ['private','public'])f.elements[name+'.grace_hours'].value=values[3];markDirty(f);safety();});
    action($('#reset-rules'),async()=>{$('#preset-current').click();for(const key of ['private','public']){f.elements[key+'.quorum'].value=3;f.elements[key+'.enabled'].checked=true;}f.elements['public.web'].checked=true;f.elements['public.pdf'].checked=true;markDirty(f);safety();});
    action($('#preview-rules'),async()=>{const result=await api('/api/settings/preview','POST',{rules:readRules(),daily_email_limit:Number(f.elements.daily_email_limit.value)});$('#rule-preview').innerHTML=`<ol>${Object.entries(result.timeline).map(([key,value])=>`<li>${text(key)} · ${time(value)}</li>`).join('')}</ol><ul>${(result.issues||[]).map(value=>`<li>${text(value.channel)} · ${text(value.code)} ${value.available??''} / ${value.quorum??''}</li>`).join('')}</ul>`;});
    const readPreferences=()=>Object.fromEntries(Object.keys(p).filter(key=>key!=='locale'&&f.elements[key]).map(key=>[key,key==='selfcheck'?f.elements[key].checked:['font_size','backup_reminder_days','daily_email_limit'].includes(key)?Number(f.elements[key].value):f.elements[key].value]));
    f.dirtySnapshot=()=>JSON.stringify({profile:{display_name:f.elements.display_name.value,email:f.elements.email.value},rules:readRules(),preferences:readPreferences()});
    f.dirtyFieldChanged=(el,baseline)=>{const before=JSON.parse(baseline),after=JSON.parse(f.dirtySnapshot()),name=el.name.replace(/_unit$/,''),keys=name.split('.'),read=s=>Object.hasOwn(s.profile,name)?s.profile[name]:Object.hasOwn(s.preferences,name)?s.preferences[name]:keys.length===2?s.rules[keys[0]]?.[keys[1]]:s.rules[name];let a=read(before),b=read(after);if(keys[1]==='contact_ids'){a=a.includes(Number(el.value));b=b.includes(Number(el.value));}if(name==='public.audience'){const aliases=['contact:'+el.dataset.personChoice,...JSON.parse(el.dataset.originalValues||'[]'),el.dataset.deliveryValue];a=a.filter(v=>aliases.includes(v));b=b.filter(v=>aliases.includes(v));}return JSON.stringify(a)!==JSON.stringify(b);};
    form(f,async()=>{
      await preferenceQueue.catch(()=>{});const preferences={...data.settings.preferences,...readPreferences()};
      const result=await api('/api/settings','PUT',{revision:data.settings.revision,preferences,rules:readRules(),profile:{display_name:f.elements.display_name.value,email:f.elements.email.value}});
      data.settings=result;data.owner.display_name=f.elements.display_name.value;data.owner.email=f.elements.email.value;theme=preferences.theme;$('#settings-revision').textContent=result.revision;$('#pending-rule-version').textContent=result.pending_rule_version??'—';$('#pending-summary').innerHTML=result.pending?ruleSummary(result.pending):text('empty');if(!content('people').querySelector('form[data-dirty]'))delete content('people').dataset.loaded;else for(const row of $$('#people-directory [data-person-id]')){const person=people.directory.find(person=>person.id===Number(row.dataset.personId));if(person)row.querySelector('.am-person-uses').innerHTML=personUses(person);}labels();window.aftermePdf?.resume();
    });
    action($('#undo-pending'),async()=>{if(f.dataset.dirty&&!confirm(tr('discardUnsaved')))return;const result=await api('/api/settings','PUT',{revision:data.settings.revision,preferences:data.settings.preferences,rules:data.settings.active});data.settings=result;delete f.dataset.dirty;await renderSettings();});
    for(const name of ['theme','font_size'])f.elements[name].onchange=()=>{theme=f.elements.theme.value;document.documentElement.style.setProperty('--am-font',f.elements.font_size.value+'px');labels();};labels();
  }

  async function renderLetters(append=false){const page=await api('/api/items/directory'+(append?'?cursor='+letterCursor:''));letterCursor=page.next_cursor;const target=content('letters');if(!append)target.innerHTML=`<div class="am-toolbar"><a href="/admin/legacy">${text('legacy')}</a>${button('new','new-letter')}</div><div id="letter-directory"></div><div id="letter-editor"></div>${button('more','letters-more')}`;$('#letter-directory').insertAdjacentHTML('beforeend',page.results.map(i=>`<article class="am-row"><div><h3>${esc(i.recipient_name||i.title)}</h3><p>${time(i.updated_at)} · ${i.payload_size} B ${i.revoked_at?' · '+tr('revoke'):''}</p></div>${button('open','',`data-letter="${i.id}"`)}</article>`).join('')||(!append?text('empty'):''));$('#letters-more').hidden=!letterCursor;action($('#letters-more'),()=>renderLetters(true));$$('[data-letter]').forEach(el=>action(el,async()=>{if($('#letter-editor form[data-dirty]'))throw Error(tr('unsaved'));const [item]=await Promise.all([api('/api/items/'+el.dataset.letter+'/content'),getPeople()]);await editLetter(item);}));action($('#new-letter'),async()=>{if($('#letter-editor form[data-dirty]'))throw Error(tr('unsaved'));await editLetter(null);});labels();}
  function refreshLetterRow(item){const opener=$$('[data-letter]').find(el=>Number(el.dataset.letter)===item.id);if(opener){const row=opener.closest('.am-row');row.querySelector('h3').textContent=item.recipient_name||item.title;row.querySelector('p').innerHTML=time(item.updated_at)+' · '+item.payload_size+' B '+(item.revoked_at?' · '+tr('revoke'):'');}else{const row=document.createElement('article');row.className='am-row';row.innerHTML='<div><h3>'+esc(item.recipient_name||item.title)+'</h3><p>'+time(item.updated_at)+'</p></div>'+button('open','',`data-letter="${item.id}"`);$('#letter-directory').prepend(row);action(row.querySelector('[data-letter]'),async()=>{if($('#letter-editor form[data-dirty]'))throw Error(tr('unsaved'));const [opened]=await Promise.all([api('/api/items/'+item.id+'/content'),getPeople()]);await editLetter(opened);});}}
  async function editLetter(item){const people=await getPeople(),selectedRecipient=item?.recipient_id??people.directory.find(person=>person.id===item?.recipient_contact_id)?.recipient_id;const target=$('#letter-editor');target.innerHTML=`<article class="am-card"><h2>${text('privateTitle')}</h2><form id="letter-form">${select('recipient','recipient_id',selectedRecipient,people.recipients.filter(r=>r.active||r.id===selectedRecipient).map(r=>[r.id,r.name+(r.active?'':' · '+tr('inactive'))]))}<label>${text('body')}<textarea name="plaintext" rows="14" ${item&&item.access_mode!=='link'?'disabled':''}>${esc(item?.plaintext||'')}</textarea></label><p>${text('revision')}: ${item?.revision||0}</p><button type="submit" ${item?.released_at?'disabled':''}>${text('save')}</button><p id="letter-pdf-status" data-item="${item?.id||''}" role="status">${item?esc(pdfStatus({kind:'private',id:item.id})):''}</p>${item?button('previewPdf','letter-preview')+button('localPdfSource','letter-pdf-source')+button('retry','letter-pdf-retry')+button(item.revoked_at?'restore':'revoke','letter-revoke'):''}</form></article>`;target.scrollIntoView({behavior:'smooth',block:'start'});const f=$('#letter-form');f.elements.recipient_id.required=true;if(item&&(item.access_mode!=='link'||item.decrypt_failed)){f.querySelector('button[type=submit]').disabled=true;const note=document.createElement('p');note.className='am-warning';note.textContent=tr(item.decrypt_failed?'decryptFailed':'passphraseHelp');f.prepend(note);}if(!f.elements.recipient_id.options.length){const note=document.createElement('p');note.textContent=tr('recipientRequired');f.prepend(note);}form(f,async()=>{const result=await api(item?'/api/items/'+item.id:'/api/items','POST',{recipient_id:f.elements.recipient_id.value,preserve_recipient:Boolean(item)&&f.elements.recipient_id.value===String(selectedRecipient),plaintext:f.elements.plaintext.value,expected_revision:item?.revision,kind:'letter'});item=await api('/api/items/'+(item?.id||result.id)+'/content');refreshLetterRow(item);await editLetter(item);preparePdf({kind:'private',id:item.id,revision:item.revision});});if(item){action($('#letter-pdf-retry'),()=>preparePdf({kind:'private',id:item.id,revision:item.revision}));action($('#letter-pdf-source'),async()=>{await downloadPdfSource('/api/items/'+item.id+'/pdf-source','afterme-private-'+item.id+'-pdf-source.json');});action($('#letter-preview'),async()=>{await preview('/api/items/'+item.id+'/pdf');});action($('#letter-revoke'),async()=>{if(f.dataset.dirty&&!confirm(tr('discardUnsaved')))return;await api('/api/items/'+item.id+'/'+(item.revoked_at?'restore':'revoke'),'POST',{});delete f.dataset.dirty;item=await api('/api/items/'+item.id+'/content');refreshLetterRow(item);await editLetter(item);});}labels();}
  function personUses(person){
    const rules=data.settings.pending||data.settings.active,uses=[];
    if(rules.private.contact_ids.includes(person.id))uses.push('privateVerifiers');if(rules.public.contact_ids.includes(person.id))uses.push('publicVerifiers');if(rules.public.audience.some(value=>value==='contact:'+person.id||value==='recipient:'+person.recipient_id))uses.push('publicRecipients');
    return uses.map(key=>'<span class="am-person-use">'+text(key)+'</span>').join('');
  }
  function personForm(person){
    return `<form data-person-form data-id="${person?.id||''}">${field('name','name',person?.name||'','text','required')}${field('email','email',person?.email||'','email','required')}${field('note','note',person?.note||'')}${select('personLanguage','locale',person?.locale||'zh',[['zh','中文'],['en','English'],['ru','Русский']])}<p class="am-muted">${text('personLanguageHelp')}</p>${check('activePerson','active',person?person.active!==0:true)}${person?.profile_conflicts?.length?`<p class="am-muted">${text('personHistoryHelp')}</p>`:''}<button type="submit">${text('save')}</button></form>`;
  }
  async function renderPeople(){
    const people=await getPeople(),target=content('people');
    target.innerHTML=`<article class="am-card"><div class="am-toolbar"><div><h2>${text('peopleDirectory')}</h2><p class="am-muted">${text('peopleDirectoryHelp')}</p></div>${button('manageSelections','people-manage-selections')}</div><label for="people-search">${text('searchPeople')}</label><input id="people-search" type="search" autocomplete="off"><div id="people-directory">${people.directory.map(person=>`<details data-person-id="${person.id}"><summary><span class="am-person-heading"><strong>${esc(person.name)}</strong><small>${esc(person.email)}</small></span><span class="am-person-uses">${personUses(person)}</span></summary>${personForm(person)}</details>`).join('')||`<p>${text('noPeople')}</p>`}</div><details id="new-person"><summary>${text('newPerson')}</summary>${personForm(null)}</details></article>`;
    for(const person of people.directory){const f=target.querySelector('[data-person-form][data-id="'+person.id+'"]');bindPersonForm(f,person);}
    bindPersonForm($('#new-person [data-person-form]'),null);action($('#people-manage-selections'),()=>navigate('settings'));
    $('#people-search').oninput=event=>{const value=event.target.value.trim().toLocaleLowerCase();for(const row of $$('#people-directory [data-person-id]'))row.hidden=!row.querySelector('.am-person-heading').textContent.toLocaleLowerCase().includes(value);};labels();
  }
  function bindPersonForm(f,person){
    const changed=new Set();if(person?.active===null)f.elements.active.indeterminate=true;
    let original=fieldStates(f);const track=event=>{const el=event.target;if(el.name){if(fieldValue(el)===original.get(fieldKey(el)))changed.delete(el.name);else changed.add(el.name);}};
    f.addEventListener('input',track);f.addEventListener('change',track);
    form(f,async()=>{
      const body={};for(const name of ['name','email','note','locale','active'])if(!person||changed.has(name))body[name]=name==='active'?f.elements.active.checked:f.elements[name].value;
      if(person)body.expected_revision=person.revision;
      const result=await api('/api/people'+(person?'/'+person.id:''),person?'PATCH':'POST',body),saved=result.person;
      invalidatePeople();const updated=await getPeople(),settings=$('#settings-form');if(settings?.dataset.dirty)settings.refreshPeople?.(updated);else delete content('settings').dataset.loaded;
      if(person){person=saved;changed.clear();f.closest('[data-person-id]').querySelector('summary').innerHTML='<span class="am-person-heading"><strong>'+esc(saved.name)+'</strong><small>'+esc(saved.email)+'</small></span><span class="am-person-uses">'+personUses(saved)+'</span>';for(const name of ['name','email','note','locale'])f.elements[name].value=saved[name]??'';f.elements.active.checked=saved.active!==0;f.elements.active.indeterminate=saved.active===null;}
      else{const row=document.createElement('details');row.dataset.personId=String(saved.id);row.innerHTML='<summary><span class="am-person-heading"><strong>'+esc(saved.name)+'</strong><small>'+esc(saved.email)+'</small></span><span class="am-person-uses">'+personUses(saved)+'</span></summary>'+personForm(saved);$('#people-directory').append(row);bindPersonForm(row.querySelector('form'),saved);row.open=true;f.reset();changed.clear();$('#new-person').open=false;row.scrollIntoView({behavior:'smooth',block:'nearest'});}
      original=fieldStates(f);if(!$('#letter-editor form[data-dirty]'))delete content('letters').dataset.loaded;labels();window.aftermePdf?.resume();
    });
  }

  let farewellDirectory=[];
  window.aftermeDirtyStatus=dirtyStatus;
  window.aftermeFormSnapshot=snapshot;window.aftermeFormChanged=formChanged;window.aftermeFormSaved=formSaved;window.aftermeRegisterForm=registerForm;
  window.aftermeBindFields=()=>labels();
  window.aftermeSubmit=async form=>{
    const path=new URL(form.action).pathname,body=Object.fromEntries(new FormData(form));
    delete body.admin_token;delete body.csrf;
    const result=await api(path,'POST',body);const root=$('#public-farewell-v2');if(root){if(/\/(?:apply|discard)$/.test(path)&&Number.isSafeInteger(result.draft_revision))root.dataset.draftRevision=result.draft_revision;else if(/^\/api\/public-farewell-v2\/(groups|entries)\/\d+$/.test(path)&&result.changed)root.dataset.draftRevision=Number(root.dataset.draftRevision)+1;root.querySelectorAll('[name=expected_draft_revision]').forEach(input=>input.value=root.dataset.draftRevision);}
    const revision=form.elements.expected_revision;
    if(revision&&Number.isSafeInteger(result.revision??result.current?.revision))revision.value=result.revision??result.current.revision;
    return {response:{ok:true},result};
  };
  window.aftermeReviewApply=async()=>{
    const result=await api('/api/public-farewell-v2/changes','POST',{});const root=$('#public-farewell-v2');root.dataset.draftRevision=result.draft_revision;root.querySelectorAll('[name=expected_draft_revision]').forEach(input=>input.value=result.draft_revision);if(!result.pending_count)return true;
    const dialog=$('#am-apply'),list=$('#am-apply-list');list.replaceChildren();result.changes.forEach(change=>{const li=document.createElement('li');li.textContent=change.label+'：'+change.changes.join('、');list.append(li);});dialog.showModal();
    return new Promise(resolve=>{const close=choice=>{dialog.close();resolve(choice);};$('#am-apply-confirm').onclick=()=>close(true);$('#am-apply-cancel').onclick=()=>close(false);dialog.oncancel=event=>{event.preventDefault();close(false);};});
  };
  function updateFarewellDirectory(root){
    const more=root.querySelector('[data-editor-more-groups]');root.querySelectorAll('[data-group-select]').forEach(b=>b.remove());
    farewellDirectory.forEach((g,i)=>{const b=document.createElement('button');b.type='button';b.className='group-selector';b.dataset.groupSelect=g.id;b.dataset.groupNumber=String(i+1).padStart(2,'0');b.classList.toggle('is-selected',String(g.id)===root.dataset.loadedGroup);b.innerHTML='<span>'+b.dataset.groupNumber+' · '+esc(g.draft_title)+'</span><small>'+g.entry_count+' 条</small>';more.before(b);});
    root.querySelector('.farewell-pane-title span').textContent=farewellDirectory.length+(root.dataset.nextGroup?' +':'');
    root.querySelectorAll('select[name=group_id]').forEach(select=>{const current=select.value||select.dataset.current,options=new Map([...select.options].map(option=>[option.value,option]));farewellDirectory.forEach(g=>{let o=options.get(String(g.id));if(!o){o=document.createElement('option');o.value=g.id;select.append(o);}o.textContent=g.draft_title;});select.value=current;});
  }
  let entryLoadId=0;
  window.aftermeLoadEntry=async(root,id)=>{
    const stage=root.querySelector('.farewell-entry-stage');if(!stage||!id)return;
    const loadId=++entryLoadId;
    if(stage.querySelector('[data-entry-editor="'+id+'"]')){stage.inert=false;return;}
    stage.inert=true;root.querySelector('#farewell-autosave').textContent=tr('loading');
    try{
      const result=await api('/api/public-farewell-v2/entries/'+Number(id)+'/content');
      if(loadId!==entryLoadId||!root.isConnected)return;
      if(Number(result.entry.draft_group_id)!==Number(root.dataset.loadedGroup))throw Error('条目已移动，请刷新章节后继续。');
      stage.innerHTML=result.html;const form=stage.querySelector('form.farewell-autosave');
      form.elements.body.value=result.entry.draft_body;form.elements.group_id.dataset.current=result.entry.draft_group_id;
      updateFarewellDirectory(root);form.elements.group_id.value=result.entry.draft_group_id;
      registerForm(form);
      if(!root.querySelector('[data-entry-select="'+id+'"]')){const button=document.createElement('button');button.type='button';button.className='entry-selector';button.dataset.entrySelect=id;button.dataset.extraEntry='1';const label=document.createElement('span');label.textContent='条目 '+id;const excerpt=document.createElement('small');excerpt.textContent=result.entry.draft_body.slice(0,80);button.append(label,excerpt);root.querySelector('.farewell-create-entry').before(button);}
      const preview=root.querySelector('[data-preview-document="draft"] [data-preview-group]');
      if(preview){preview.querySelectorAll('[data-preview-entry]').forEach(el=>el.remove());if(result.entry.draft_is_public){const entry=document.createElement('section');entry.dataset.previewEntry=id;entry.className='farewell-preview-entry';const body=document.createElement('div');body.className='letter';body.textContent=result.entry.draft_body;entry.append(body);preview.append(entry);}}
      root.querySelectorAll('[data-entry-select]').forEach(button=>button.classList.toggle('is-selected',button.dataset.entrySelect===String(id)));
      root.querySelector('#farewell-autosave').textContent='草稿已保存';labels();
    }catch(error){if(loadId===entryLoadId&&root.isConnected){root.querySelector('#farewell-autosave').textContent=error.message;throw error;}}
    finally{if(loadId===entryLoadId&&root.isConnected)stage.inert=false;}
  };
  window.aftermeFarewellFormal=async root=>{
    const cursor=root.dataset.nextFormal;if(!cursor)return;
    if(root.dataset.formalBusy==='1')return;root.dataset.formalBusy='1';
    try{
    const result=await api('/api/chapters/'+root.dataset.loadedGroup+'/formal?cursor='+encodeURIComponent(cursor)+'&revision='+root.dataset.formalRevision);
    if(!root.isConnected)return;
    const group=root.querySelector('[data-preview-document="formal"] [data-preview-group]');
    if(group)for(const row of result.results){let section=group.querySelector('[data-preview-entry="'+row.id+'"]');if(!section){section=document.createElement('section');section.dataset.previewEntry=row.id;section.className='farewell-preview-entry';const letter=document.createElement('div');letter.className='letter';section.append(letter);group.append(section);}section.querySelector('.letter').append(document.createTextNode(row.body));}
    root.dataset.nextFormal=result.next_cursor||'';const more=root.querySelector('[data-editor-more-formal]');more.hidden=!result.next_cursor;more.textContent='加载更多正式内容';
    }finally{delete root.dataset.formalBusy;}
  };
  window.aftermeFarewellTrash=async(root,button)=>{
    const kind=button.dataset.editorMoreTrash,result=await api('/api/public-farewell-v2/trash?kind='+kind+'&cursor='+button.dataset.cursor);
    if(!root.isConnected)return;root.querySelector('[data-trash-list="'+kind+'"]').insertAdjacentHTML('beforeend',result.html);button.dataset.cursor=result.next_cursor||'';button.hidden=!result.next_cursor;
  };
  let farewellLoadId=0;
  window.aftermeLoadFarewell=async(group=0,options={})=>{
    const loadId=++farewellLoadId,previous=$('#public-farewell-v2');
    const panels=previous?[...previous.querySelectorAll('.farewell-group-panel')]:[];
    if(previous){previous.setAttribute('aria-busy','true');previous.querySelector('#farewell-autosave').textContent=tr('loading');panels.forEach(panel=>panel.inert=true);}
    try {
    const result=await api('/api/public-farewell-v2/editor?group='+Number(group));
    if(loadId!==farewellLoadId)return false;
    const directory=result.directory;
    const preserve=options.preserveDirectory&&previous;
    const nextCursor=preserve?previous.dataset.nextGroup:directory.next_cursor;
    const groups=new Map((preserve?farewellDirectory:[]).map(g=>[g.id,g]));
    directory.results.forEach(g=>groups.set(g.id,g));
    if(directory.selected)groups.set(directory.selected.id,directory.selected);
    farewellDirectory=[...groups.values()].sort((a,b)=>a.draft_sort_order-b.draft_sort_order||a.id-b.id);
    if(previous?.isConnected)window.aftermeCaptureFarewellForms?.(previous);
    content('farewell').innerHTML=result.html;
    const root=$('#public-farewell-v2');
    root.querySelector('#public-pdf-status').textContent=pdfStatus({kind:'public',revision:Number(root.dataset.formalRevision)});
    root.querySelector('form[action="/api/public-farewell/preview"]').onsubmit=e=>{e.preventDefault();preview('/api/public-farewell/preview',true).catch(e=>toast(e.message,true));};
    root.querySelector('form[action="/api/public-farewell/pdf"]').onsubmit=e=>{e.preventDefault();preview('/api/public-farewell/pdf').catch(e=>toast(e.message,true));};
    root.querySelector('form[action="/api/public-farewell/pdf-source"]').onsubmit=e=>{e.preventDefault();downloadPdfSource('/api/public-farewell/pdf-source','afterme-public-pdf-source.json').catch(e=>toast(e.message,true));};
    root.dataset.nextGroup=nextCursor||'';root.querySelector('[data-editor-more-groups]').hidden=!nextCursor;
    updateFarewellDirectory(root);window.bindFarewellEditor();
    const selected=options.selectedEntry&&(options.forceEntry||root.querySelector('[data-entry-select="'+options.selectedEntry+'"]'))?options.selectedEntry:root.querySelector('.farewell-entry-stage')?.dataset.firstEntry;
    if(selected&&root.dataset.lazyEntries==='1')await window.aftermeLoadEntry(root,selected);
    if(options.mobilePane)root.querySelector('[data-farewell-tab="'+options.mobilePane+'"]')?.click();
    if(options.forceEntry)root.querySelector('.farewell-entry-editor.is-selected textarea[name="body"]')?.focus();else if(options.focusGroup)root.querySelector('.group-title-form [name="title"]')?.focus();
    if(options.message)root.querySelector('#farewell-autosave').textContent=options.message;
    dirtyStatus();labels();
    return true;
    } catch(error) {
      if(loadId!==farewellLoadId)return false;
      throw error;
    } finally {
      if(loadId===farewellLoadId&&previous?.isConnected){previous.removeAttribute('aria-busy');panels.forEach(panel=>panel.inert=false);}
    }
  };
  window.aftermeFarewellMore=async(root,kind)=>{
    if(kind==='groups'){
      const d=await api('/api/chapters?cursor='+root.dataset.nextGroup);if(!root.isConnected)return;farewellDirectory=[...new Map([...farewellDirectory,...d.results].map(g=>[g.id,g])).values()].sort((a,b)=>a.draft_sort_order-b.draft_sort_order||a.id-b.id);root.dataset.nextGroup=d.next_cursor||'';updateFarewellDirectory(root);root.querySelector('[data-editor-more-groups]').hidden=!d.next_cursor;
    }else{
      const d=await api('/api/chapters/'+root.dataset.loadedGroup+'?cursor='+root.dataset.nextEntry),panel=root.querySelector('.farewell-group-panel');
      if(!root.isConnected)return;
      for(const row of d.results)panel.querySelector('[data-extra-entry][data-entry-select="'+row.id+'"]')?.remove();
      (panel.querySelector('[data-extra-entry]')||panel.querySelector('.farewell-create-entry')).insertAdjacentHTML('beforebegin',d.html.selectors);
      const selected=panel.querySelector('[data-entry-editor]')?.dataset.entryEditor;panel.querySelectorAll('[data-entry-select]').forEach(button=>button.classList.toggle('is-selected',button.dataset.entrySelect===selected));
      root.dataset.nextEntry=d.next_cursor||'';root.querySelector('[data-editor-more-entries]').hidden=!d.next_cursor;updateFarewellDirectory(root);labels();
    }
  };
  async function renderFarewell(){await window.aftermeLoadFarewell();}
  function inboundProblemMarkup(problems){return `<article class="am-card"><h2>本轮收信待处理 / Inbound review</h2><p>仅处理本轮失败记录；处理说明会保存到审计记录。</p>${problems.length?problems.map(row=>`<div data-inbound-problem><p>${esc(row.subject||row.gmail_message_id)} · ${esc(row.status)}</p><form data-inbound-reconcile><input type="hidden" name="gmail_message_id" value="${esc(row.gmail_message_id)}"><input type="hidden" name="expected_round" value="${Number(row.confirmation_round)}"><label>处理方式<select name="resolution"><option value="retry">重新处理</option><option value="ignore">确认无关并忽略</option></select></label><label>处理说明<textarea name="note" required maxlength="2000" rows="2"></textarea></label><button type="submit">记录处理决定</button></form></div>`).join(''):'<p>本轮待处理收信记录：0。</p>'}</article>`;}
  async function resumePdfs(){if(!window.aftermePdf)return;$('#job-progress').textContent='正在本机准备 PDF；正文已保存。';await window.aftermePdf.resume();$('#job-progress').textContent='准备任务已运行；请核对各份 PDF 的状态，失败项目可以重试。';}
  async function renderMaintenance(){const [health,jobs,templates,security,logs]=await Promise.all([api('/api/maintenance/status'),api('/api/pdf/jobs'),api('/api/mail/templates'),api('/api/security'),api('/api/logs')]);content('maintenance').innerHTML=`<article class="am-card"><h2>登录安全 / Login security</h2><p id="mfa-status"></p><button type="button" id="mfa-start">绑定验证器 / Set up authenticator</button><div id="mfa-enrollment"></div><form id="mfa-disable" hidden><label>管理口令<input name="admin_password" type="password" autocomplete="current-password" required></label><label>新的动态码或恢复码<input name="mfa_code" autocomplete="one-time-code" required></label><button type="submit">关闭双重验证 / Disable MFA</button></form></article><article class="am-card"><h2>${text('health')}</h2><p>${text('mail')}: ${esc(data.mailProvider)} · ${text('inbound')}: ${esc(data.inbound)}</p><pre>${esc(JSON.stringify(health,null,2))}</pre></article>${inboundProblemMarkup(health.inboundProblems||[])}<article class="am-card"><h2>${text('backup')}</h2>${button('backup','backup-complete')}${button('metadata','backup-metadata')}</article><article class="am-card"><h2>${text('jobs')}</h2><pre id="job-progress">${esc(JSON.stringify(jobs,null,2))}</pre>${button('rebuild','rebuild-pdfs')}${button('continueBatch','advance-jobs')}${button('refresh','poll-jobs')}</article><article class="am-card"><h2>${text('templates')}</h2>${button('mailPreview','preview-mail')}<p>${templates.results.some(c=>c.legacy_timing_warning)?text('customWarning'):''}</p>${templates.results.map(c=>`<details><summary>${esc(c.key)}</summary><form data-template="${c.key}">${field('title','subject_template',c.subject_template)}<label>${text('body')}<textarea name="body_template" rows="10">${esc(c.body_template)}</textarea></label><button type="submit">${text('save')}</button>${button('defaults','',`data-template-reset="${c.key}"`)}</form></details>`).join('')}</article><article class="am-card"><h2>${text('logs')}</h2><div id="delivery-logs"></div>${button('more','logs-more')}</article>`;for(const kind of ['complete','metadata'])action($('#backup-'+kind),async()=>{const password=await backupPassword();const r=await api('/api/export','POST',{include_payloads:kind==='complete'}),envelope=await window.aftermeBackupCrypto.encrypt(r,password),url=URL.createObjectURL(new Blob([JSON.stringify(envelope)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='afterme-'+kind+'-encrypted-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);});action($('#rebuild-pdfs'),async()=>{if(window.aftermePdf)return resumePdfs();$('#job-progress').textContent=JSON.stringify(await api('/api/pdf/rebuild','POST',{}),null,2);});action($('#advance-jobs'),async()=>{if(window.aftermePdf)return resumePdfs();$('#job-progress').textContent=JSON.stringify(await api('/api/pdf/jobs/advance','POST',{}),null,2);});action($('#poll-jobs'),async()=>{$('#job-progress').textContent=JSON.stringify(await api('/api/pdf/jobs'),null,2);});action($('#preview-mail'),async()=>{await preview('/api/mail/preview',true);});$$('[data-template]').forEach(f=>form(f,()=>api('/api/mail/templates','POST',{template_key:f.dataset.template,...Object.fromEntries(new FormData(f))})));$$('[data-template-reset]').forEach(el=>action(el,async()=>{const key=el.dataset.templateReset;const f=$$('[data-template]').find(f=>f.dataset.template===key);if(f.dataset.dirty&&!confirm(tr('discardUnsaved')))return;await api('/api/mail/templates/reset','POST',{template_key:key});const templates=await api('/api/mail/templates');const current=templates.results.find(v=>v.key===key);f.elements.subject_template.value=current.subject_template;f.elements.body_template.value=current.body_template;formSaved(f);toast(tr('saved'));}));$$('form[data-inbound-reconcile]').forEach(f=>form(f,async()=>{const body=Object.fromEntries(new FormData(f));body.expected_round=Number(body.expected_round);await api('/api/inbound/reconcile','POST',body);f.closest('[data-inbound-problem]').textContent='处理决定已记录。请刷新维护状态以核对结果。';}));await bindMfa(security);await loadLogs(false,logs);labels();}
  function backupPassword(){
    const dialog=$('#am-backup');$('#backup-error').textContent='';dialog.showModal();$('#backup-password').focus();
    return new Promise((resolve,reject)=>{const clear=()=>{$('#backup-password').value='';$('#backup-repeat').value='';dialog.close();};const cancel=()=>{clear();reject(Error(tr('cancel')));};$('#backup-cancel').onclick=cancel;dialog.oncancel=e=>{e.preventDefault();cancel();};$('#am-backup-form').onsubmit=e=>{e.preventDefault();if($('#backup-password').value!==$('#backup-repeat').value){$('#backup-error').textContent='两次口令不一致 / Passphrases do not match';return;}const password=$('#backup-password').value;clear();resolve(password);};});
  }
  async function bindMfa(security){
    security=security||await api('/api/security');$('#mfa-status').textContent=security.enabled?'双重验证已启用 / MFA enabled · '+security.recovery_remaining+' recovery codes':'尚未启用双重验证 / MFA is not enabled';$('#mfa-start').hidden=security.enabled;$('#mfa-disable').hidden=!security.enabled;
    action($('#mfa-start'),async()=>{
      const enrollment=await api('/api/security/mfa/start','POST',{}),host=$('#mfa-enrollment');
      host.innerHTML='<p>在验证器中添加 TOTP 密钥。先将一次性恢复码保存到安全的位置，避免与口令存放在同一处。</p><label>密钥 / Secret<input id="mfa-enrollment-secret" readonly></label><label>一次性恢复码 / Recovery codes<textarea id="mfa-recovery" readonly rows="10"></textarea></label><form id="mfa-enable"><label>6 位动态码<input name="mfa_code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" required></label><label class="am-check"><input type="checkbox" name="acknowledged" required>我已另行保存恢复码 / I saved my recovery codes</label><button type="submit">启用双重验证 / Enable MFA</button></form>';
      $('#mfa-enrollment-secret').value=enrollment.secret;$('#mfa-recovery').value=enrollment.recovery_codes.join('\n');
      form($('#mfa-enable'),async()=>{const d=await api('/api/security/mfa/enable','POST',{enrollment_id:enrollment.enrollment_id,mfa_code:$('#mfa-enable [name=mfa_code]').value,acknowledged:true});csrf=d.csrf;host.replaceChildren();await bindMfa();});
    });
    form($('#mfa-disable'),async()=>{const d=await api('/api/security/mfa/disable','POST',Object.fromEntries(new FormData($('#mfa-disable'))));csrf=d.csrf;$('#mfa-disable').reset();await bindMfa();});
  }
  async function loadLogs(append=false,page=null){const d=page||await api('/api/logs'+(append?'?cursor='+logCursor:''));logCursor=d.next_cursor;if(!append)$('#delivery-logs').innerHTML='';$('#delivery-logs').insertAdjacentHTML('beforeend',d.results.map(row=>`<p>${time(row.created_at)} · ${esc(row.event_type)} · ${esc(row.status)}</p>`).join(''));$('#logs-more').hidden=!logCursor;action($('#logs-more'),()=>loadLogs(true));}
  $('.am-brand').onclick=e=>{e.preventDefault();navigate('home');};
  const loaders={letters:renderLetters,people:renderPeople,settings:renderSettings,farewell:renderFarewell,maintenance:renderMaintenance};
  const sectionLoads=new Map();
  async function navigate(key){
    section=key;document.querySelector('.am-app').dataset.section=key;
    $$('.am-view').forEach(el=>el.hidden=el.id!=='view-'+key);
    $$('[data-nav]').forEach(el=>el.setAttribute('aria-current',el.dataset.nav===key?'page':'false'));
    history.replaceState(null,'','#'+key);
    if(key==='home'&&!content('home').querySelector('form[data-dirty]'))renderHome();
    const target=content(key);
    if(target.dataset.loaded)return;
    if(!sectionLoads.has(key)){
      let status=$('#load-'+key);
      if(!status){status=document.createElement('p');status.id='load-'+key;status.className='am-muted';status.setAttribute('role','status');target.before(status);}
      status.hidden=false;status.innerHTML=text('loading');target.setAttribute('aria-busy','true');
      const task=Promise.resolve().then(()=>loaders[key]?.()).then(()=>{target.dataset.loaded='1';status.hidden=true;}).catch(e=>{
        status.innerHTML=text('loadFailed')+' '+button('retry','retry-'+key);
        action($('#retry-'+key),()=>navigate(key));if(section===key)toast(e.message,true);
      }).finally(()=>{target.removeAttribute('aria-busy');sectionLoads.delete(key);});
      sectionLoads.set(key,task);
    }
    await sectionLoads.get(key);
  }
  $$('[data-nav]').forEach(el=>{el.onclick=e=>{e.preventDefault();navigate(el.dataset.nav);};});renderHome();content('home').dataset.loaded='1';labels();window.aftermePdf?.resume();navigate(Object.hasOwn(loaders,location.hash.slice(1))?location.hash.slice(1):'home');
}

const peopleStyles=`
.am-language-card{display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,300px);gap:32px;align-items:center}.am-language-card h2{margin-bottom:8px}.am-language-card p{margin:8px 0}.am-language-card select{margin-bottom:0}.am-rule-state{border-bottom:1px solid var(--am-line);padding-bottom:24px;margin-bottom:28px}.am-directory-note{border-left:3px solid var(--am-accent);padding:4px 0 4px 18px;margin:28px 0}.am-person-picker{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:8px;margin:16px 0}.am-person-choice{display:flex;align-items:flex-start;gap:12px;margin:0;padding:12px;border:1px solid var(--am-line);min-width:0;cursor:pointer}.am-person-choice:has(input:checked){border-color:var(--am-accent);box-shadow:inset 2px 0 var(--am-accent)}.am-person-choice input{flex:none;width:auto;min-height:0;margin:6px 0}.am-person-choice span{min-width:0}.am-person-choice strong{font-size:.9em;font-weight:normal}.am-person-choice small,.am-person-heading small{display:block;color:var(--am-muted);font-size:12px;overflow-wrap:anywhere}.am-person-heading{display:inline-grid;min-width:0;gap:3px}.am-person-heading strong{font-weight:normal;overflow-wrap:anywhere}.am-person-uses{display:flex;flex-wrap:wrap;gap:5px}.am-person-use{font-size:11px;padding:2px 7px;border:1px solid var(--am-line);color:var(--am-muted)}#people-directory summary{display:flex;align-items:center;flex-wrap:wrap;gap:12px;list-style:none;padding:16px 0}#people-directory summary::after{content:'+';margin-left:auto;color:var(--am-muted)}#people-directory details[open]>summary::after{content:'−'}#people-directory details{border-bottom:1px solid var(--am-line)}#people-directory [data-person-form]{padding:0 0 24px}#people-directory [hidden]{display:none!important}.am-locale-control{min-width:0}.am-language-label{font-size:11px;letter-spacing:.03em;color:var(--am-muted)}
@media(max-width:850px){.am-language-card{grid-template-columns:minmax(0,1fr);gap:12px}.am-sidebar-foot .am-locale-control{display:grid}.am-sidebar-foot .am-language-label{font-size:9px;line-height:1;margin:0 0 3px}.am-sidebar-foot .am-locale-control select{margin:0;min-height:28px}.am-sidebar-foot{align-items:flex-end!important}.am-person-picker{grid-template-columns:minmax(0,1fr)}#people-directory summary{align-items:flex-start}.am-person-uses{width:100%;order:2}.am-person-use{font-size:10px}.am-person-heading{max-width:calc(100% - 24px)}}
`;
const styles=`
/* The dashboard and the embedded legacy editor share semantic colors. Keep the
   bridge at the document root so dialogs and inherited base styles follow too. */
:root{--bg:var(--am-bg);--panel:var(--am-panel);--ink:var(--am-ink);--muted:var(--am-muted);--line:var(--am-line);--accent:var(--am-accent);--danger:#ffb4a8;--on-accent:var(--am-bg);--field:var(--am-bg);--inset:var(--am-bg);--secondary:var(--am-panel);--secondary-line:var(--am-line);--selected:var(--am-panel);--epigraph:var(--am-muted)}
html[data-am-theme=paper]{--danger:#9b3025;--status-normal:#2c6244;--status-alert:#805000}
html[data-am-theme=contrast]{--danger:#ffb4a8;--status-normal:var(--am-accent);--status-alert:var(--am-accent)}
input::placeholder,textarea::placeholder{color:var(--am-muted);opacity:1}

:root{--am-bg:#171917;--am-panel:#20231f;--am-ink:#ecebe4;--am-muted:#adaf9f;--am-line:#414739;--am-accent:#d5dfad;--am-font:18px;color-scheme:dark}html[data-am-theme=paper]{--am-bg:#f5f1e7;--am-panel:#fffdf7;--am-ink:#292d24;--am-muted:#646956;--am-line:#c9cbb9;--am-accent:#3c502c;color-scheme:light}html[data-am-theme=contrast]{--am-bg:#000;--am-panel:#000;--am-ink:#fff;--am-muted:#fff;--am-line:#fff;--am-accent:#ffef00;color-scheme:dark}html,body{background:var(--am-bg);color:var(--am-ink);margin:0;font-size:var(--am-font)}body{max-width:none;padding:0;font-family:Georgia,'Noto Serif','Songti SC','SimSun',serif;line-height:1.65}*{box-sizing:border-box}.am-app{display:grid;grid-template-columns:245px minmax(0,1fr);min-height:100vh}.am-sidebar{position:sticky;top:0;height:100vh;padding:38px 25px;border-right:1px solid var(--am-line);display:flex;flex-direction:column}.am-brand{font-size:34px;letter-spacing:-1.5px;text-decoration:none;color:var(--am-ink)}.am-brand span,.am-login h1 span{color:var(--am-accent)}.am-kicker{font:11px/1.5 Verdana,sans-serif;letter-spacing:2px;color:var(--am-muted)}.am-sidebar nav{display:grid;gap:8px;margin-top:48px}.am-sidebar nav [data-nav]{font:inherit;text-decoration:none;display:flex;gap:16px;text-align:left;border:0;border-bottom:1px solid transparent;border-radius:0;background:none;padding:14px 0;color:var(--am-muted)}.am-sidebar nav [data-nav][aria-current=page]{color:var(--am-accent);border-color:var(--am-accent)}.am-index{font:11px Verdana,sans-serif;align-self:center}.am-sidebar-foot{margin-top:auto;display:grid;gap:12px}.am-main{width:100%;max-width:1180px;margin:auto;padding:25px 55px 90px;min-width:0}.am-top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;border-bottom:1px solid var(--am-line);padding:0 0 16px;margin:0 0 30px}.am-top select{margin-left:auto;width:auto;max-width:180px}.am-top #dirty-indicator{font-size:12px;color:var(--am-accent);margin:0;min-width:0;max-width:100%;overflow-wrap:anywhere}#am-unsaved-list{display:grid;gap:10px;margin-bottom:24px}#am-unsaved-list button{text-align:left;overflow-wrap:anywhere}input,textarea,select{scroll-margin-top:150px}.am-view h1{font-weight:normal;font-size:42px;margin:20px 0 32px;letter-spacing:-1px}.am-hero{padding:24px 0 36px;border-bottom:1px solid var(--am-line);margin-bottom:28px}.am-hero h2{font-weight:normal;font-size:36px;margin:8px 0}.am-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}.am-card{background:var(--am-panel);border:1px solid var(--am-line);padding:26px;margin-bottom:24px;border-radius:3px}.am-card h2{font-size:22px;font-weight:normal;margin:0 0 20px}.am-card h3{font-size:18px}.am-muted,.am-row p{color:var(--am-muted);font-size:14px}.am-big{font-size:24px;line-height:1.5}.am-warning,.am-error{color:var(--am-accent);border-left:3px solid currentColor;padding-left:16px}.am-row{display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:1px solid var(--am-line);padding:20px 0}.am-row h3,.am-row p{margin:0}.am-toolbar,.am-sticky{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:20px}.am-sticky{position:sticky;bottom:0;background:var(--am-bg);padding:18px 0;border-top:1px solid var(--am-line);z-index:2}.am-inline{display:flex;gap:8px}.am-inline input{min-width:0}.am-options{display:flex;flex-wrap:wrap;gap:14px 25px}.am-check{display:flex!important;align-items:center;gap:12px;margin:12px 0!important}.am-check input{width:20px;min-height:20px;margin:0;accent-color:var(--am-accent)}input,textarea,select{font:inherit;color:var(--am-ink);background:var(--am-bg);border:1px solid var(--am-line);border-radius:2px;padding:10px 12px;width:100%;margin:6px 0 12px;min-height:44px}textarea{resize:vertical;line-height:1.8}label{display:block;font-size:15px;margin:10px 0}button{font:15px/1.5 Verdana,'Microsoft YaHei',sans-serif;padding:11px 17px;min-height:44px;background:var(--am-panel);border:1px solid var(--am-line);color:var(--am-ink);border-radius:2px;cursor:pointer}button:hover{border-color:var(--am-accent)}button.am-primary{background:var(--am-accent);color:var(--am-bg);border-color:var(--am-accent)}button:disabled{opacity:1;cursor:not-allowed;color:var(--am-muted);background:var(--am-bg);border-color:var(--am-line);border-style:dashed}button[aria-busy=true]{cursor:wait}a{color:var(--am-accent)}:focus-visible{outline:3px solid var(--am-accent);outline-offset:3px}fieldset{border:1px solid var(--am-line);margin:28px 0;padding:20px}legend{padding:0 10px}details summary{cursor:pointer;min-height:44px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;color:var(--am-muted)}.am-entry{padding:18px 0;border-top:1px solid var(--am-line)}dialog{width:min(92vw,650px);background:var(--am-panel);color:var(--am-ink);border:1px solid var(--am-line);padding:28px}dialog::backdrop{background:#000b}.am-login{max-width:580px;margin:10vh auto;padding:35px}.am-login h1{font-size:72px;font-weight:normal;letter-spacing:-4px}.am-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}[hidden]{display:none!important}#toast:empty{display:none}#toast{padding:10px;border-bottom:1px solid var(--am-line)}@media(max-width:850px){.am-app{display:block}.am-sidebar{height:auto;position:sticky;z-index:3;background:var(--am-bg);padding:12px 16px;border-right:0;border-bottom:1px solid var(--am-line)}.am-sidebar .am-kicker{display:none}.am-brand{font-size:25px}.am-sidebar nav{margin:8px 0 0;display:flex;overflow-x:auto;gap:18px}.am-sidebar nav [data-nav]{flex-shrink:0;padding:8px 0;font-size:13px}.am-index{display:none}.am-sidebar-foot{position:absolute;right:16px;top:12px;display:flex;gap:8px;align-items:center}.am-sidebar-foot select{font-size:12px;min-height:32px;padding:3px;margin:0;width:85px}.am-sidebar-foot button{font-size:12px;min-height:32px;padding:3px 8px}.am-main{padding:20px 18px 70px}.am-view h1{font-size:32px}.am-grid{grid-template-columns:1fr;gap:0}.am-card{padding:20px}.am-hero h2{font-size:28px}.am-top .am-kicker{font-size:9px;letter-spacing:1px}.am-sticky{font-size:12px}.am-row{gap:10px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`;

const editorThemeStyles=`
.am-app[data-section=farewell] .am-main{max-width:1500px;padding-inline:28px}
#public-farewell-v2{--line:var(--am-line);--ink:var(--am-ink);--muted:var(--am-muted);border:1px solid var(--am-line);background:var(--am-panel)}
#public-farewell-v2 .farewell-workspace{grid-template-columns:190px minmax(280px,1fr) 290px}
#public-farewell-v2 .farewell-outline,#public-farewell-v2 .farewell-preview-pane{background:var(--am-bg)}
#public-farewell-v2 .farewell-outline{max-height:900px;overflow-y:auto}
#public-farewell-v2 .farewell-entry-editor textarea[name=body]{min-height:300px}
#public-farewell-v2 .is-selected,#public-farewell-v2 .preview-switch .is-active,#public-farewell-v2 .farewell-mobile-tabs .is-active{background:var(--am-panel);color:var(--am-accent)}
#public-farewell-v2 .farewell-epigraph{color:var(--am-muted)}
#public-farewell-v2 .meta,#public-farewell-v2 .eyebrow{font-size:12px;color:var(--am-muted)}
#public-farewell-v2 .letter{white-space:pre-wrap;overflow-wrap:anywhere}
#public-farewell-v2 .farewell-order{flex-wrap:wrap}#public-farewell-v2 .farewell-group-head{align-items:stretch;flex-direction:column}
#public-farewell-v2 .farewell-version-actions{justify-content:flex-start}
@media(max-width:1300px){#public-farewell-v2 .farewell-workspace{display:block;min-height:0}#public-farewell-v2 .farewell-mobile-tabs{display:grid}#public-farewell-v2 [data-farewell-pane]{display:none}#public-farewell-v2[data-mobile-pane=outline] [data-farewell-pane=outline],#public-farewell-v2[data-mobile-pane=edit] [data-farewell-pane=edit],#public-farewell-v2[data-mobile-pane=preview] [data-farewell-pane=preview]{display:block}}
@media(max-width:850px){.am-app[data-section=farewell] .am-main{padding-inline:16px}#public-farewell-v2 .farewell-v2-topbar{padding:16px}#public-farewell-v2 .farewell-fields-row{grid-template-columns:1fr}}
`;
