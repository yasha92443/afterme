// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {t} from './i18n.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

// Keep metadata outside the reading flow. Native details also works without JS.
export function readingVersionInfo({groups=[],updatedAt,locale='zh',date}) {
  const separator=locale==='zh'?'：':': ';
  const row=(key,value)=>value?`<p>${escape(t(locale,key))}${separator}${escape(date(value))}</p>`:'';
  return `<details class="reader-version-info">
    <summary>${escape(t(locale,'versionInfo'))}</summary>
    <div class="reader-version-body">
      ${row('publicUpdated',updatedAt)}
      <ol class="reader-version-groups">${groups.map((group,index)=>`<li>
        <h3>${String(group.reading_index||index+1).padStart(2,'0')} · ${escape(group.display_title)}</h3>
        ${row('chapterUpdated',group.title_updated_at)}
        ${String(group.display_epigraph||'').trim()?row('epigraphUpdated',group.epigraph_updated_at):''}
        ${group.entries.map((entry,index)=>entry.body_updated_at?`<p>${escape(t(locale,'entryNumber',{number:entry.reading_index||index+1}))} · ${escape(t(locale,'entryUpdated'))}${separator}${escape(date(entry.body_updated_at))}</p>`:'').join('')}
      </li>`).join('')}</ol>
    </div>
  </details>`;
}
