// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import { layout,escapeHtml as esc } from './ui.js';
import { t,REPLY_COMMANDS,formatTime } from './i18n.js';
import { parseEpigraph } from './epigraph.js';
import { readingVersionInfo } from './reading-metadata.js';

function readingEpigraph(group) {
  if(group.epigraph_fragment)return `<div class="farewell-epigraph-wrap"><blockquote class="farewell-epigraph"><span class="farewell-epigraph-quote reader-epigraph-fragment">${esc(group.display_epigraph)}</span></blockquote></div>`;
  if (!String(group.display_epigraph || '').trim()) return '';
  const {quote,source}=parseEpigraph(group.display_epigraph);
  return `<div class="farewell-epigraph-wrap"><blockquote class="farewell-epigraph"><span class="farewell-epigraph-quote">${esc(quote)}</span>${source?`<cite class="farewell-epigraph-source">${esc(source)}</cite>`:''}</blockquote></div>`;
}
function readerScript(preferences){
  return `<script>
    let size=${preferences.font_size};
    const setSize=()=>document.body.style.setProperty('--reader-size',size+'px');
    try{const saved=Number(sessionStorage.getItem('afterme-reader-size'));if(Number.isInteger(saved)&&saved>=14&&saved<=28)size=saved;const theme=sessionStorage.getItem('afterme-reader-theme');if(theme==='paper'||theme==='night'){document.body.classList.remove('reader-system','reader-contrast');document.body.classList.toggle('reader-light',theme==='paper')}}catch{}
    setSize();
    const changeSize=delta=>{size=Math.max(14,Math.min(28,size+delta));setSize();try{sessionStorage.setItem('afterme-reader-size',String(size))}catch{}};
    document.getElementById('reader-smaller').onclick=()=>changeSize(-1);
    document.getElementById('reader-larger').onclick=()=>changeSize(1);
    document.getElementById('reader-theme').onclick=()=>{const classes=document.body.classList,light=classes.contains('reader-light')||(classes.contains('reader-system')&&matchMedia('(prefers-color-scheme: light)').matches);classes.remove('reader-system','reader-contrast');classes.toggle('reader-light',!light);try{sessionStorage.setItem('afterme-reader-theme',light?'night':'paper')}catch{}};
    document.getElementById('reader-print').onclick=()=>print();
  </script>`;
}
export function verificationPage({contact,owner,rules,preferences,proofRequired=false,expired=false}) {
  const l=contact.locale||preferences.locale,labels=REPLY_COMMANDS[l]||REPLY_COMMANDS.zh;
  const proofCopy={zh:['邮箱验证','获取验证码','发送到该联系人已保存的邮箱。10 分钟有效，最多尝试 5 次。','8 位验证码','原链接已过期；通过邮箱验证码重新验证身份后才能提交。'],en:['Email verification','Send code','Sent to this contact’s saved email. Valid for 10 minutes, up to 5 attempts.','8-digit code','The original link expired. Verify your email before submitting.'],ru:['Проверка почты','Отправить код','Код придёт на сохранённую почту контакта. 10 минут, до 5 попыток.','8-значный код','Ссылка истекла. Подтвердите почту перед отправкой.']}[l]||[];
  const proof=proofRequired?`<fieldset><legend>${esc(proofCopy[0])}</legend><p>${esc(expired?proofCopy[4]:proofCopy[2])}</p><button type="button" id="verification-send">${esc(proofCopy[1])}</button><p role="status" id="verification-message"></p><input type="hidden" name="challenge_id" id="verification-challenge"><label for="verification-code">${esc(proofCopy[3])}</label><input id="verification-code" name="verification_code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{8}" maxlength="8" required></fieldset>`:'';
  return layout({title:t(l,'verify'),locale:l,pageClass:'external verify-page',body:`<section class="external-shell"><p class="eyebrow">AFTERME</p><h1>${esc(t(l,'verify'))}</h1><p>${esc(contact.name)} · ${esc(owner.display_name)}</p><p>${esc(t(l,'verifyHelp'))}</p><p>${esc(t(l,'verify_hours'))}: ${rules.verify_hours} ${esc(t(l,'hours'))}</p><section class="panel"><form method="post"><fieldset><legend>${esc(t(l,'status'))}</legend>${['unable_to_reach','confirmed_death','false_alarm'].map((status,i)=>`<div class="choice"><input id="v-${i}" type="radio" name="status" value="${status}" ${i===0?'checked':''}><label for="v-${i}">${esc(labels[i])}</label></div>`).join('')}</fieldset><p>${esc(t(l,'effective'))}</p>${['private','public'].map(k=>`<p>${esc(t(l,k))}: ${rules[k].quorum} · ${rules[k].grace_hours} ${esc(t(l,'hours'))}</p>`).join('')}<label for="verify-note">${esc(t(l,'note'))}</label><textarea id="verify-note" name="note" maxlength="4000"></textarea>${proof}<button type="submit">${esc(t(l,'submit'))}</button></form></section></section>${proofRequired?`<script>const send=document.getElementById("verification-send");send.onclick=async()=>{send.disabled=true;try{const r=await fetch(location.pathname+"/challenge",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});const d=await r.json();if(!r.ok)throw Error(d.message||d.error);document.getElementById("verification-challenge").value=d.challenge_id;document.getElementById("verification-message").textContent=${JSON.stringify(proofCopy[2])};document.getElementById("verification-code").focus();}catch(e){document.getElementById("verification-message").textContent=e.message;}finally{send.disabled=false;}};</script>`:""}`});
}
export function verificationResult({locale='zh',status,release}) {
  return layout({title:t(locale,'recorded'),locale,pageClass:'external verify-page',body:`<section class="external-shell"><p class="eyebrow">AFTERME</p><h1>${esc(t(locale,'recorded'))}</h1><p>${esc(status==='false_alarm'?t(locale,'NORMAL'):t(locale,'confirmations'))}</p>${(release?.progress||[]).map(p=>`<p>${esc(t(locale,p.channel))}: ${esc(p.released_at?t(locale,'released'):p.ready_at?t(locale,'releaseReady'):t(locale,'remaining'))}</p>`).join('')}</section>`});
}
export function publicReadingPage({publicFarewell,groups=[],updatedAt,preferences,preview=false,navigation}) {
  const l=preferences.locale, date=v=>formatTime(v,l,preferences.timezone),visible=publicFarewell?.status==='PUBLIC_RELEASE';
  const link=(item,className='')=>item?`<a${className?` class="${className}"`:''} href="${esc(item.href)}">${esc(item.label)}</a>`:'';
  const reading=visible?`
    ${preview?`<p class="preview-banner">${esc(t(l,'preview'))} · ${esc(t(l,'formal'))}</p>`:''}
    <div class="reader-tools">
      <button class="secondary" id="reader-smaller" aria-label="${esc(t(l,'font'))} −">A −</button>
      <button class="secondary" id="reader-larger" aria-label="${esc(t(l,'font'))} +">A +</button>
      <button class="secondary" id="reader-theme">${esc(t(l,'theme'))}</button>
      ${preview?`<a href="/api/public-farewell/pdf" target="_blank" rel="noopener">${esc(t(l,'previewPdf'))}</a>`:''}
      <button class="secondary" id="reader-print">${esc(navigation?.printLabel||t(l,'print'))}</button>
    </div>
    <nav class="reader-toc"><details><summary>${esc(t(l,'chapter'))} · ${navigation?navigation.directory.length:groups.length}</summary><ol>${navigation?navigation.directory.map(g=>`<li><a href="${esc(g.href)}">${esc(g.title)}</a></li>`).join(''):groups.map((g,i)=>`<li><a href="#chapter-${i}">${esc(g.display_title)}</a></li>`).join('')}</ol>${navigation?`<p>${link(navigation.first)} ${link(navigation.more,'reader-more-chapters')}</p>`:''}</details></nav>
    ${navigation?.partLabel?`<p class="reader-part-label">${esc(navigation.partLabel)}</p>`:''}
    <div class="reader-content">${groups.map((g,i)=>`<article class="farewell-item" id="chapter-${i}">
      <p class="eyebrow">${String(g.reading_index||i+1).padStart(2,'0')}</p><h2>${esc(g.display_title)}</h2>
      ${readingEpigraph(g)}
      ${g.entries.map(e=>`<section class="farewell-entry"><div class="letter">${esc(e.display_body)}</div></section>`).join('')}
    </article>`).join('')}</div>
    ${navigation?`<nav class="reader-pagination" aria-label="${esc(t(l,'chapter'))}"><p>${link(navigation.continue,'reader-continuation')}</p><p>${link(navigation.chapterStart)}</p></nav>`:''}
    ${readingVersionInfo({groups,updatedAt:updatedAt||publicFarewell.updated_at,locale:l,date})}
  `:`<p>${esc(t(l,'unpublished'))}</p>`;
  return layout({title:t(l,'publicTitle'),locale:l,pageClass:'external public-page'+({paper:' reader-light',contrast:' reader-contrast',system:' reader-system'}[preferences.theme]||''),body:`<section class="external-shell"><p class="eyebrow">AFTERME</p><h1>${esc(t(l,'publicTitle'))}</h1>${navigation?.notice?`<p role="status">${esc(navigation.notice)}</p>${link(navigation.restart)}`:''}${reading}</section>${visible?readerScript(preferences):''}`});
}
