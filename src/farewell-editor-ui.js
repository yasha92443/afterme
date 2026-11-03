// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import { parseEpigraph } from "./epigraph.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replaceAll("/", "-")} (UTC+8)`;
}

function hidden(tokenInput, adminField) {
  return `${tokenInput}${adminField}`;
}

function commandForm({ action, tokenInput, adminField, fields = {}, label, ariaLabel = "", className = "secondary", confirm = "" }) {
  const inputs = Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`).join("");
  return `<form class="farewell-command" method="post" action="${escapeHtml(action)}"${confirm ? ` data-confirm="${escapeHtml(confirm)}"` : ""}>
    ${hidden(tokenInput, adminField)}${inputs}<button class="${escapeHtml(className)}" type="submit"${ariaLabel ? ` aria-label="${escapeHtml(ariaLabel)}"` : ""}>${label}</button>
  </form>`;
}

function orderControls(kind, id, tokenInput, adminField) {
  const collection = kind === "group" ? "groups" : "entries";
  return `<div class="farewell-order" aria-label="调整顺序">
    ${["top", "up", "down", "bottom"].map((direction) => commandForm({
      action: `/api/public-farewell-v2/${collection}/${id}/reorder`,
      tokenInput,
      adminField,
      fields: { direction },
      label: ({ top: "置顶", up: "↑", down: "↓", bottom: "置底" })[direction],
      ariaLabel: ({ top: "移到最前", up: "上移", down: "下移", bottom: "移到最后" })[direction],
      className: direction === "up" || direction === "down" ? "secondary icon-button" : "secondary compact-button",
    })).join("")}
  </div>`;
}

function entryEditor(entry, groups, selected, tokenInput, adminField) {
  return `<article class="farewell-entry-editor${selected ? " is-selected" : ""}" data-entry-editor="${escapeHtml(entry.id)}">
    <div class="farewell-editor-heading">
      <div><p class="eyebrow">条目 ${escapeHtml(entry.id)}</p><p class="meta">本条正文最后更新：${escapeHtml(formatDate(entry.body_updated_at))}</p></div>
      ${orderControls("entry", entry.id, tokenInput, adminField)}
    </div>
    <form class="farewell-autosave" data-kind="entry" method="post" action="/api/public-farewell-v2/entries/${escapeHtml(entry.id)}">
      ${hidden(tokenInput, adminField)}
      <input type="hidden" name="expected_revision" value="${Number(entry.revision || 0)}">
      <label>正文<textarea name="body" required>${escapeHtml(entry.draft_body)}</textarea></label>
      <div class="farewell-fields-row">
        <label>公开状态<select name="is_public"><option value="1"${Number(entry.draft_is_public) ? " selected" : ""}>用于公开</option><option value="0"${Number(entry.draft_is_public) ? "" : " selected"}>不公开</option></select></label>
        <label>移动到分组<select name="group_id">${groups.map((group) => `<option value="${escapeHtml(group.id)}"${Number(group.id) === Number(entry.draft_group_id) ? " selected" : ""}>${escapeHtml(group.draft_title)}</option>`).join("")}</select></label>
      </div>
      <p class="meta autosave-time">草稿保存：${escapeHtml(formatDate(entry.draft_updated_at))}</p>
    </form>
    <div class="farewell-danger-row">
      ${commandForm({ action: `/api/public-farewell-v2/entries/${entry.id}/trash`, tokenInput, adminField, label: "移入回收站", className: "danger", confirm: "将这一条移入回收站？应用修改时，正式版本将同步更新。" })}
    </div>
  </article>`;
}

export function farewellEntryEditorMarkup(entry,groups=[],tokenInput=''){
  // The body travels once as JSON and is assigned to textarea.value by the client.
  // Never interpolate a large body into HTML or duplicate it into hidden previews.
  return entryEditor({...entry,draft_body:''},groups,true,tokenInput,'');
}

export function farewellEntryPageMarkup(entries,groups,tokenInput='') {
  return {selectors:entries.map(entry=>`<button class="entry-selector" type="button" data-entry-select="${entry.id}"><span>条目 ${entry.id}</span><small>${escapeHtml((entry.excerpt??entry.draft_body??'').slice(0,80))}</small></button>`).join(''),editors:'',preview:''};
}

function groupPanel(group, groups, selected, tokenInput, adminField) {
  const firstEntryId = group.entries[0]?.id || "";
  return `<section class="farewell-group-panel${selected ? " is-selected" : ""}" data-group-panel="${escapeHtml(group.id)}">
    <div class="farewell-group-head">
      <form class="farewell-autosave group-title-form" data-kind="group" method="post" action="/api/public-farewell-v2/groups/${escapeHtml(group.id)}">
        ${hidden(tokenInput, adminField)}
        <input type="hidden" name="expected_revision" value="${Number(group.revision || 0)}">
        <label>分组标题<input name="title" value="${escapeHtml(group.draft_title)}" required></label>
        <p class="meta">分组标题最后更新：${escapeHtml(formatDate(group.title_updated_at))}</p>
        <label class="epigraph-field">章首题辞<textarea name="epigraph" placeholder="例如：一句引文&#10;——出处">${escapeHtml(group.draft_epigraph || "")}</textarea></label>
        <p class="meta">章首题辞最后更新：${escapeHtml(formatDate(group.epigraph_updated_at))}</p>
      </form>
      ${orderControls("group", group.id, tokenInput, adminField)}
    </div>
    <div class="farewell-entry-strip" role="list">
      ${group.entries.map((entry, index) => `<button class="entry-selector${index === 0 ? " is-selected" : ""}" type="button" data-entry-select="${escapeHtml(entry.id)}"><span>${String(index + 1).padStart(2, "0")}</span><small>${escapeHtml((entry.excerpt??entry.draft_body??'').slice(0,80) || "空白条目")}</small></button>`).join("")}
      <form class="farewell-create-entry" method="post" action="/api/public-farewell-v2/entries">
        ${hidden(tokenInput, adminField)}<input type="hidden" name="group_id" value="${escapeHtml(group.id)}"><input type="hidden" name="is_public" value="1"><input type="hidden" name="body" value="新条目"><button class="secondary" type="submit">+ 新增条目</button>
      </form>
    </div>
    <div class="farewell-entry-stage" data-first-entry="${escapeHtml(firstEntryId)}">
      ${group.entries.some(entry=>entry.draft_body!==undefined)?group.entries.map((entry, index) => entryEditor(entry, groups, index === 0, tokenInput, adminField)).join(""):'<p class="empty-state">'+(firstEntryId?'正在读取选中的条目…':'请为这个分组添加第一条内容。')+'</p>'}
    </div>
    <div class="farewell-danger-row">
      ${commandForm({ action: `/api/public-farewell-v2/groups/${group.id}/trash`, tokenInput, adminField, label: "将分组移入回收站", className: "danger", confirm: "将整个分组移入回收站？应用修改时，正式版本将同步更新。" })}
    </div>
  </section>`;
}

function epigraphPreviewMarkup(group) {
  const epigraph = parseEpigraph(group.display_epigraph);
  return `<div class="farewell-epigraph-wrap" data-preview-epigraph-wrap="${escapeHtml(group.id)}"${group.display_epigraph ? "" : " hidden"}><blockquote class="farewell-epigraph" data-preview-epigraph="${escapeHtml(group.id)}"><span class="farewell-epigraph-quote" data-preview-epigraph-quote>${escapeHtml(epigraph.quote)}</span><cite class="farewell-epigraph-source" data-preview-epigraph-source${epigraph.source ? "" : " hidden"}>${escapeHtml(epigraph.source)}</cite></blockquote></div>`;
}

export function farewellPreviewMarkup(groups, updatedAt, mode = "formal") {
  return `<div class="farewell-preview-document" data-preview-document="${escapeHtml(mode)}">
    <p class="eyebrow">公开遗言</p><h1>公开遗言</h1>
    ${groups.length ? groups.map((group, index) => `<article class="farewell-preview-group" data-preview-group="${escapeHtml(group.id)}">
      <p class="eyebrow">${String(index + 1).padStart(2, "0")}</p>
      <h2>${escapeHtml(group.display_title)}</h2>
      ${epigraphPreviewMarkup(group)}
      ${group.entries.filter((entry) => typeof entry.display_body==='string'&&(mode === "formal" || Number(entry.draft_is_public))).map((entry) => `<section class="farewell-preview-entry" data-preview-entry="${escapeHtml(entry.id)}"><div class="letter">${escapeHtml(entry.display_body)}</div></section>`).join("")}
    </article>`).join("") : '<p class="empty-state">暂无用于公开的内容。</p>'}
  </div>`;
}

export function farewellTrashPageMarkup({results=[],kind='groups'}={},tokenInput='',adminField=''){
  return results.map(item=>`<div class="recycle-row" data-trash-kind="${kind}" data-trash-id="${item.id}"><span>${escapeHtml(kind==='groups'?'分组：'+item.draft_title:'条目：'+(item.excerpt??item.draft_body??'').slice(0,80))}</span><div>
    ${commandForm({action:`/api/public-farewell-v2/${kind}/${item.id}/restore`,tokenInput,adminField,label:'恢复'})}
    ${commandForm({action:`/api/public-farewell-v2/${kind}/${item.id}/permanent`,tokenInput,adminField,label:'永久删除',className:'danger',confirm:'永久删除后无法恢复。确定继续？'})}
  </div></div>`).join('');
}

function recycleBin(state, tokenInput, adminField) {
  const groups = state.trashed_groups || [];
  const entries = state?.trashed_entries || [];
  if (!groups.length && !entries.length) return "";
  return `<details class="farewell-recycle"><summary>回收站</summary><div data-trash-list="groups">${farewellTrashPageMarkup({results:groups,kind:'groups'},tokenInput,adminField)}</div><button type="button" data-editor-more-trash="groups" data-cursor="${escapeHtml(state.next_trash_group_cursor||'')}" ${state.next_trash_group_cursor?'':'hidden'}>加载更多已删分组</button><div data-trash-list="entries">${farewellTrashPageMarkup({results:entries,kind:'entries'},tokenInput,adminField)}</div><button type="button" data-editor-more-trash="entries" data-cursor="${escapeHtml(state.next_trash_entry_cursor||'')}" ${state.next_trash_entry_cursor?'':'hidden'}>加载更多已删条目</button></details>`;
}

export function farewellEditorMarkup({ state, tokenInput='', adminField='', releaseGraceHours, releaseQuorum=3,embedded=false }) {
  const groups = state?.draft_groups || [];
  const selectedGroup = state.editor_group?.id || groups[0]?.id || "";
  const panelGroups=embedded?(state.editor_group?[state.editor_group]:[]):groups;
  const moveGroups=groups.some(g=>g.id===selectedGroup)?groups:[...groups,...panelGroups];
  const formalUpdatedAt = state?.document?.updated_at || null;
  const pending = Number(state?.pending_count || 0);
  const publicationStatus = state?.document?.status === "PUBLIC_RELEASE" ? "已公开" : "准备中 · 仅管理页可见";
  return `<section class="panel public-composer farewell-v2" id="public-farewell-v2" data-lazy-entries="${state.lazy_entries?'1':'0'}" data-draft-revision="${Number(state.draft_revision||0)}" data-formal-revision="${Number(state.formal_revision||0)}" data-embedded="${embedded?'1':'0'}" data-loaded-group="${escapeHtml(selectedGroup)}" data-selected-group="${escapeHtml(selectedGroup)}" data-next-group="${escapeHtml(state.next_group_cursor||'')}" data-next-entry="${escapeHtml(state.next_entry_cursor||'')}" data-next-formal="${escapeHtml(state.next_formal_cursor||'')}" data-mobile-pane="outline">
    <div class="farewell-v2-topbar">
      <div><p class="eyebrow">公开遗言编辑器</p><h2>公开遗言</h2><p class="meta">当前公开状态：${escapeHtml(publicationStatus)}</p><p class="meta">正式整体更新时间：${escapeHtml(formatDate(formalUpdatedAt))}</p></div>
      <div class="farewell-version-actions">
        <span class="pending-badge${pending ? " has-pending" : ""}" id="farewell-pending">${pending ? `${pending} 项修改尚未应用` : "正式版本已同步"}</span>
        ${commandForm({ action: "/api/public-farewell-v2/apply", tokenInput, adminField,fields:{expected_draft_revision:state.draft_revision||0}, label: "应用到正式版本", className: "" })}
        ${commandForm({ action: "/api/public-farewell-v2/discard", tokenInput, adminField,fields:{expected_draft_revision:state.draft_revision||0}, label: "放弃修改", className: "secondary", confirm: "放弃所有尚未应用的草稿修改？" })}
        <form method="post" action="/api/public-farewell/preview" target="_blank">${hidden(tokenInput, adminField)}<button class="secondary" type="submit">完整预览</button></form>
        <form method="post" action="/api/public-farewell/pdf" target="_blank">${hidden(tokenInput, adminField)}<button class="secondary" type="submit">预览正式 PDF</button></form>
        <form method="post" action="/api/public-farewell/pdf-source" target="_blank">${hidden(tokenInput, adminField)}<button class="secondary" type="submit">导出本机 PDF 源文件</button></form>
      </div>
      <p class="meta farewell-release-rule">${escapeHtml(releaseQuorum)} 名不同联系人确认死亡并经过 ${escapeHtml(releaseGraceHours)} 小时缓冲后，按当前有效渠道释放。自动释放只读取正式版本。</p>
      <p class="meta farewell-release-rule">${embedded?'侧栏预览当前章节的分页内容；“完整预览”和 PDF 显示完整正式版本。':'PDF 显示完整正式版本。'}如需预览新修改，请先“应用到正式版本”；预览用于检查正式版本的阅读效果。</p>
      <p class="meta farewell-release-rule">宋体＋Times New Roman 使用本机生成工具。导出的源文件包含正式正文；服务器预览及自动邮件 PDF 仍使用原字体。</p>
      <p class="meta" id="public-pdf-status" role="status">正文与 PDF 分别保存。PDF 准备状态可在维护页查看。</p><button type="button" data-prepare-public-pdf>准备／重试正式 PDF</button>
    </div>
    <div class="farewell-mobile-tabs" role="tablist" aria-label="公开遗言工作区"><button type="button" role="tab" aria-selected="true" tabindex="0" class="is-active" data-farewell-tab="outline">目录</button><button type="button" role="tab" aria-selected="false" tabindex="-1" data-farewell-tab="edit">编辑</button><button type="button" role="tab" aria-selected="false" tabindex="-1" data-farewell-tab="preview">预览</button></div>
    <div class="farewell-workspace">
      <nav class="farewell-outline" data-farewell-pane="outline" aria-label="公开遗言分组目录">
        <div class="farewell-pane-title"><strong>分组目录</strong><span>${groups.length}</span></div>
        ${groups.map((group, index) => `<button type="button" class="group-selector${group.id===selectedGroup ? " is-selected" : ""}" data-group-select="${escapeHtml(group.id)}" data-group-number="${String(index + 1).padStart(2, "0")}"><span>${String(index + 1).padStart(2, "0")} · ${escapeHtml(group.draft_title)}</span><small>${group.entry_count??group.entries.length} 条</small></button>`).join("") || '<p class="empty-state">请创建第一个分组。</p>'}
        ${embedded?'<button type="button" data-editor-more-groups '+(state.next_group_cursor?'':'hidden')+'>加载更多章节</button>':''}
        <form class="farewell-create-group" method="post" action="/api/public-farewell-v2/groups">${hidden(tokenInput, adminField)}<input name="title" aria-label="新分组标题" placeholder="新分组标题" required><button type="submit">新增分组</button></form>
        ${recycleBin(state, tokenInput, adminField)}
      </nav>
      <main class="farewell-edit-pane" data-farewell-pane="edit">
        <div class="autosave-indicator" id="farewell-autosave" aria-live="polite">草稿已保存 · ${escapeHtml(formatDate(state?.draft_updated_at))}</div><button type="button" class="secondary" data-retry-save hidden>重试保存</button>
        ${panelGroups.map((group) => groupPanel(group, moveGroups, group.id===selectedGroup, tokenInput, adminField)).join("") || '<div class="empty-state large">先在左侧新增一个分组。</div>'}
        ${embedded?'<button type="button" data-editor-more-entries '+(state.next_entry_cursor?'':'hidden')+'>加载更多条目</button>':''}
      </main>
      <aside class="farewell-preview-pane" data-farewell-pane="preview">
        <div class="preview-switch"><button type="button" class="is-active" data-preview-mode="draft">草稿预览</button><button type="button" data-preview-mode="formal">正式预览</button></div>
        <div class="preview-scroll">
          <div data-preview-wrap="draft">${farewellPreviewMarkup(embedded?panelGroups:state?.draft_groups || [], formalUpdatedAt, "draft")}</div>
          <div data-preview-wrap="formal" hidden>${farewellPreviewMarkup(state?.formal_groups || [], formalUpdatedAt, "formal")}</div>
          ${state.lazy_entries?'<button type="button" data-editor-more-formal '+(state.next_formal_cursor?'':'hidden')+'>加载正式预览</button>':''}
        </div>
      </aside>
    </div>
    ${embedded?'':`<script>${farewellEditorScript()}</script>`}
  </section>`;
}

export function farewellEditorScript() {
  return `(() => {
    const localSelector='form.farewell-create-group,form.farewell-create-entry,form.farewell-command';
    const localDrafts=new Map(),localDefaults=new WeakMap();
    const localFields=form=>[...form.elements].filter(field=>field.name&&!field.disabled&&!field.readOnly&&!['hidden','password','file','submit','button','reset'].includes(field.type)&&!/(?:token|secret|password|csrf|mfa|recovery|credential|authorization)/i.test(field.name));
    const localKey=form=>(form.getAttribute?.('action')||form.action)+'|'+['group_id','entry_id','direction'].map(name=>form.elements.namedItem?.(name)?.value||form.elements[name]?.value||'').join('|');
    function localValues(form){
      const counts=new Map();return localFields(form).map(field=>{const name=field.name+':'+field.type+(['checkbox','radio'].includes(field.type)?':'+field.value:''),index=counts.get(name)||0;counts.set(name,index+1);return {key:name+':'+index,value:field.multiple?[...field.options].filter(option=>option.selected).map(option=>option.value):field.value,...(['checkbox','radio'].includes(field.type)?{checked:field.checked,indeterminate:Boolean(field.indeterminate)}:{})};});
    }
    function setLocalValues(form,values){
      const rows=new Map(values.map(row=>[row.key,row])),fields=localFields(form),current=localValues(form);
      fields.forEach((field,index)=>{const row=rows.get(current[index].key);if(!row)return;if(field.multiple){for(const option of field.options)option.selected=row.value.includes(option.value);}else field.value=row.value;if('checked'in row){field.checked=row.checked;field.indeterminate=row.indeterminate;}});
    }
    function rememberLocalForm(form,field){
      if(!localDefaults.has(form))localDefaults.set(form,localValues(form));
      const values=localValues(form),changed=JSON.stringify(values)!==JSON.stringify(localDefaults.get(form));
      if(changed){localDrafts.set(localKey(form),values);form.dataset.unsaved='1';form.dataset.dirty='1';}
      else{localDrafts.delete(localKey(form));delete form.dataset.unsaved;delete form.dataset.dirty;}
      window.aftermeFormChanged?.(form,field);window.aftermeDirtyStatus?.();
    }
    window.aftermeCaptureFarewellForms=root=>{if(root)for(const form of root.querySelectorAll(localSelector))rememberLocalForm(form);};
    window.aftermeRestoreFarewellForms=root=>{
      if(!root)return;
      for(const form of root.querySelectorAll(localSelector)){
        window.aftermeRegisterForm?.(form);if(!localDefaults.has(form))localDefaults.set(form,localValues(form));
        const values=localDrafts.get(localKey(form));if(values){setLocalValues(form,values);rememberLocalForm(form,localFields(form)[0]);}
      }
    };
    function completeLocalForm(form){
      localDrafts.delete(localKey(form));setLocalValues(form,localDefaults.get(form)||[]);delete form.dataset.unsaved;delete form.dataset.dirty;window.aftermeFormSaved?.(form);window.aftermeDirtyStatus?.();
    }
    window.bindFarewellEditor = () => {
    const root = document.getElementById('public-farewell-v2');
    if (!root || root.dataset.bound === '1') return;
    root.dataset.bound = '1';
    const timers = new Map();
    const dirtyForms = new Map();
    const savingForms = new Set();
    const failedForms = new Set();
    root.querySelectorAll('form.farewell-autosave,form.farewell-create-group,form.farewell-create-entry,form.farewell-command').forEach(form=>window.aftermeRegisterForm?.(form));
    window.aftermeRestoreFarewellForms(root);
    for(const type of ['input','change'])root.addEventListener(type,event=>{const form=event.target.closest(localSelector);if(form)rememberLocalForm(form,event.target);});
    let queue = Promise.resolve();
    let needsRefresh = false;
    window.aftermeDraftFlush = flushDrafts;
    if (!window.aftermeDraftUnloadBound) {
      window.aftermeDraftUnloadBound = true;
      window.addEventListener('beforeunload', (event) => {
        if (document.querySelector('[data-unsaved="1"]')) { event.preventDefault(); event.returnValue = ''; }
      });
    }
    const status = root.querySelector('#farewell-autosave');
    const pending = root.querySelector('#farewell-pending');

    function markPending() {
      pending.textContent = '有修改尚未应用';
      pending.classList.add('has-pending');
      const readiness = document.querySelector('[data-readiness-pending]'); if (readiness) readiness.textContent = '公开遗言有修改待应用';
    }
    function selectGroup(id) {
      root.dataset.selectedGroup = id;
      root.querySelectorAll('[data-group-select]').forEach((button) => button.classList.toggle('is-selected', button.dataset.groupSelect === id));
      root.querySelectorAll('[data-group-panel]').forEach((panel) => panel.classList.toggle('is-selected', panel.dataset.groupPanel === id));
      if (matchMedia('(max-width: 760px)').matches) activateTab('edit');
    }
    function selectEntry(id) {
      const panel = root.querySelector('.farewell-group-panel.is-selected');
      if (!panel) return;
      panel.querySelectorAll('[data-entry-select]').forEach((button) => button.classList.toggle('is-selected', button.dataset.entrySelect === id));
      panel.querySelectorAll('[data-entry-editor]').forEach((editor) => editor.classList.toggle('is-selected', editor.dataset.entryEditor === id));
    }
    function activateTab(name) {
      root.querySelectorAll('[data-farewell-tab]').forEach((button) => { const selected = button.dataset.farewellTab === name; button.classList.toggle('is-active', selected); button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
      root.dataset.mobilePane = name;
    }
    root.addEventListener('click', async event => {
      const button=event.target.closest('[data-group-select], [data-entry-select], [data-editor-more-groups], [data-editor-more-entries]');
      if(!button)return;
      if(button.dataset.entrySelect){
        try{await flushDrafts();if(root.dataset.lazyEntries==='1')await window.aftermeLoadEntry(root,button.dataset.entrySelect);else selectEntry(button.dataset.entrySelect);}catch(error){status.textContent=error.message||'无法加载';}return;
      }
      button.disabled=true;
      try {
        if(root.dataset.embedded==='1') {
          await flushDrafts();
          if(button.dataset.groupSelect){
            if((root.dataset.loadedGroup!==button.dataset.groupSelect||root.getAttribute('aria-busy')==='true')&&await window.aftermeLoadFarewell(button.dataset.groupSelect,{preserveDirectory:true})===false)return;
            const rebound=document.getElementById('public-farewell-v2');
            rebound.dataset.mobilePane='edit';
            rebound.querySelector('[data-farewell-tab="edit"]').click();
          } else await window.aftermeFarewellMore(root,button.hasAttribute('data-editor-more-groups')?'groups':'entries');
        } else selectGroup(button.dataset.groupSelect);
      } catch(error){status.textContent=error.message||'无法加载';} finally {button.disabled=false;}
    });
    root.querySelectorAll('[data-farewell-tab]').forEach((button) => button.addEventListener('click', () => activateTab(button.dataset.farewellTab)));
    root.querySelector('.farewell-mobile-tabs').addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = [...root.querySelectorAll('[data-farewell-tab]')];
      const current = tabs.indexOf(event.target); if (current < 0) return;
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      activateTab(tabs[index].dataset.farewellTab); tabs[index].focus();
    });

    async function saveDraft(form) {
      const revision = dirtyForms.get(form);
      if (revision === undefined) return;
      status.textContent = '保存中...';
      savingForms.add(form);
      try {
        const submittedSnapshot=window.aftermeFormSnapshot?.(form);
        const { response, result } = await window.aftermeSubmit(form);
        if (!response.ok || !result.ok) throw new Error(result.message || result.error || '保存失败');
        window.aftermeFormSaved?.(form,submittedSnapshot);
        failedForms.delete(form);
        if (dirtyForms.get(form) === revision) { dirtyForms.delete(form); delete form.dataset.unsaved;delete form.dataset.dirty;window.aftermeDirtyStatus?.(); }
        status.textContent = result.changed ? '草稿已保存' : '草稿保持当前版本';
        root.querySelector('[data-retry-save]').hidden = true;
        if (result.changed) markPending();
        updateDraftPreview(form);
        if (form.dataset.refreshOnSave === '1') needsRefresh = true;
      } catch (error) {
        failedForms.add(form);
        status.textContent = '保存失败，输入仍保留：' + (error.message || '请重试');
        root.querySelector('[data-retry-save]').hidden = false;
        throw error;
      } finally {savingForms.delete(form);window.aftermeDirtyStatus?.();}
    }
    function flushDrafts(force=true) {
      if(force){for (const timer of timers.values()) clearTimeout(timer);timers.clear();}
      const operation = queue.catch(() => {}).then(async () => {
        do{for (const form of [...dirtyForms.keys()]) await saveDraft(form);}while(force&&dirtyForms.size);
      });
      queue = operation;
      return operation;
    }
    let autoSaving=false;
    async function autoSave() {
      if(autoSaving)return;
      autoSaving=true;let succeeded=false;
      try {
        await flushDrafts(false);succeeded=true;
        if (needsRefresh && !dirtyForms.size && !root.inert && root.isConnected) {
          needsRefresh = false;
          root.inert = true;
          await flushDrafts();
          await refreshEditor();
        }
      } catch { root.inert = false; }
      finally{autoSaving=false;if(succeeded&&dirtyForms.size&&root.isConnected){for(const form of dirtyForms.keys()){clearTimeout(timers.get(form));timers.set(form,setTimeout(()=>{timers.delete(form);autoSave();},900));}}}
    }
    function schedule(form,field) {
      clearTimeout(timers.get(form));
      if(window.aftermeFormChanged?.(form,field)===false&&!savingForms.has(form)&&!failedForms.has(form)){
        timers.delete(form);dirtyForms.delete(form);delete form.dataset.unsaved;delete form.dataset.dirty;
        if(!dirtyForms.size&&!savingForms.size){status.textContent='草稿已保存';root.querySelector('[data-retry-save]').hidden=true;}
        window.aftermeDirtyStatus?.();return;
      }
      dirtyForms.set(form, (dirtyForms.get(form) || 0) + 1);
      form.dataset.unsaved = '1';
      form.dataset.dirty = '1';
      status.textContent = '等待保存...';
      timers.set(form, setTimeout(()=>{timers.delete(form);autoSave();}, 900));
      window.aftermeDirtyStatus?.();
    }
    root.querySelector('[data-retry-save]').addEventListener('click', () => autoSave());
    root.addEventListener('input',event=>{const form=event.target.closest('form.farewell-autosave');if(form)schedule(form,event.target);});
    root.addEventListener('change',event=>{const form=event.target.closest('form.farewell-autosave');if(form){
        if (event.target.name === 'group_id' || event.target.name === 'is_public') form.dataset.refreshOnSave = '1';
        schedule(form,event.target);
    }});
    root.addEventListener('submit',event=>{const form=event.target.closest('form.farewell-autosave');if(form){event.preventDefault();schedule(form);autoSave();}});
    root.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        const form = event.target.closest('form.farewell-autosave');
        if (form) { event.preventDefault(); schedule(form); autoSave(); }
      }
    });

    async function refreshEditor(message = '',selection={}) {
      const token = root.querySelector('input[name=admin_token]')?.value || '';
      const selectedGroup = selection.groupId||root.dataset.selectedGroup;
      const selectedEntry = selection.entryId||root.querySelector('.farewell-group-panel.is-selected .farewell-entry-editor.is-selected')?.dataset.entryEditor || '';
      const mobilePane = selection.groupId||selection.entryId?'edit':root.dataset.mobilePane;
      if(root.dataset.embedded==='1') {
        await window.aftermeLoadFarewell(selectedGroup,{selectedEntry,forceEntry:Boolean(selection.entryId),focusGroup:Boolean(selection.groupId),mobilePane,message});return;
      }
      const response = await fetch('/admin/legacy', {headers: token?{Authorization:'Bearer '+token}:{}});
      if (!response.ok) throw new Error('无法刷新编辑器');
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      const next = doc.getElementById('public-farewell-v2');
      if (!next) throw new Error('编辑器响应无效');
      const readiness = document.querySelector('[data-readiness-pending]'); const nextReadiness = doc.querySelector('[data-readiness-pending]'); if (readiness && nextReadiness) readiness.textContent = nextReadiness.textContent;
      window.aftermeCaptureFarewellForms(root);
      root.replaceWith(next);
      window.bindFarewellEditor();
      const rebound = document.getElementById('public-farewell-v2');
      window.aftermeBindFields(rebound);
      rebound.querySelector('[data-group-select="' + selectedGroup + '"]')?.click();
      const selectedPanel = rebound.querySelector('.farewell-group-panel.is-selected');
      selectedPanel?.querySelector('[data-entry-select="' + selectedEntry + '"]')?.click();
      if (mobilePane) {
        rebound.dataset.mobilePane = mobilePane;
        rebound.querySelectorAll('[data-farewell-tab]').forEach((tab) => { const selected = tab.dataset.farewellTab === mobilePane; tab.classList.toggle('is-active', selected); tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; });
      }
      if (message) rebound.querySelector('#farewell-autosave').textContent = message;
    }

    root.addEventListener('submit',async event=>{
      const form=event.target.closest('.farewell-command, .farewell-create-group, .farewell-create-entry');if(!form)return;
      event.preventDefault();
      if (form.dataset.confirm && !confirm(form.dataset.confirm)) return;
      const button = event.submitter;
      if (button) button.disabled = true;
      root.inert = true;
      try {
        await flushDrafts();
        if (form.action.endsWith('/apply') && !await window.aftermeReviewApply()) { root.inert = false; if (button) button.disabled = false; return; }
        const {response,result}=await window.aftermeSubmit(form);
        if (!response.ok || !result.ok) throw new Error(result.message || result.error || '操作失败');
        completeLocalForm(form);
        if(form.action.endsWith('/apply')){for(const locale of ['zh','en','ru'])window.aftermePreparePdf?.({kind:'public',locale,revision:result.formal_revision});window.aftermePdf?.resume();}
        const reordering = form.action.endsWith('/reorder');
        const message = reordering
          ? (result.moved ? '顺序已保存到草稿；点击“应用到正式版本”后，正式预览和 PDF 才会更新。' : '已到达这个方向的边界，当前顺序已保留。')
          : '';
        await refreshEditor(message,{groupId:form.matches('.farewell-create-group')?result.id:null,entryId:form.matches('.farewell-create-entry')?result.id:null});
      } catch (error) {
        root.inert = false;
        status.textContent = error.message || '操作失败';
        if (button) button.disabled = false;
      }
    });

    root.querySelectorAll('[data-preview-mode]').forEach((button) => button.addEventListener('click', () => {
      root.querySelectorAll('[data-preview-mode]').forEach((candidate) => candidate.classList.toggle('is-active', candidate === button));
      root.querySelectorAll('[data-preview-wrap]').forEach((wrapper) => {
        wrapper.hidden = wrapper.dataset.previewWrap !== button.dataset.previewMode;
      });
      if(button.dataset.previewMode==='formal'&&root.dataset.nextFormal==='0')window.aftermeFarewellFormal?.(root).catch(error=>{status.textContent=error.message;});
    }));
    root.querySelector('[data-editor-more-formal]')?.addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;try{await window.aftermeFarewellFormal(root);}catch(error){status.textContent=error.message;}finally{button.disabled=false;}});
    root.querySelectorAll('[data-editor-more-trash]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{await window.aftermeFarewellTrash(root,button);}catch(error){status.textContent=error.message;}finally{button.disabled=false;}}));
    root.querySelector('[data-prepare-public-pdf]')?.addEventListener('click',()=>{window.aftermePreparePdf?.({kind:'public',revision:Number(root.dataset.formalRevision)});window.aftermePdf?.resume();});

    function updateDraftPreview(form) {
      if (form.dataset.kind === 'group') {
        const id = form.action.split('/').pop();
        const title = form.elements.title.value;
        const directoryTitle = root.querySelector('[data-group-select="' + id + '"] span');
        if (directoryTitle) directoryTitle.textContent = (directoryTitle.parentElement.dataset.groupNumber || '') + ' · ' + title;
        const preview = root.querySelector('[data-preview-document="draft"] [data-preview-group="' + id + '"] h2');
        if (preview) preview.textContent = title;
        const epigraph = form.elements.epigraph.value;
        const epigraphWrap = root.querySelector('[data-preview-document="draft"] [data-preview-epigraph-wrap="' + id + '"]');
        const epigraphPreview = root.querySelector('[data-preview-document="draft"] [data-preview-epigraph="' + id + '"]');
        const epigraphParts = splitEpigraphValue(epigraph);
        if (epigraphPreview) {
          const quote = epigraphPreview.querySelector('[data-preview-epigraph-quote]');
          const source = epigraphPreview.querySelector('[data-preview-epigraph-source]');
          if (quote) quote.textContent = epigraphParts.quote;
          if (source) {
            source.textContent = epigraphParts.source;
            source.hidden = !epigraphParts.source;
          }
        }
        if (epigraphWrap) epigraphWrap.hidden = !epigraph.trim();
      } else {
        const id = form.action.split('/').pop();
        const preview = root.querySelector('[data-preview-document="draft"] [data-preview-entry="' + id + '"] .letter');
        if (preview) preview.textContent = form.elements.body.value;
        const excerpt=root.querySelector('[data-entry-select="'+id+'"] small');if(excerpt)excerpt.textContent=form.elements.body.value.slice(0,80);
      }
    }

    function splitEpigraphValue(value) {
      const lines = String(value || '').replaceAll('\\r', '').split('\\n');
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      const lastLine = lines.length ? lines[lines.length - 1].trim() : '';
      const attribution = lastLine.match(/^(?:[—–-]\\s*)+(.+)$/u);
      if (!attribution) return { quote: lines.join('\\n').trim(), source: '' };
      lines.pop();
      return { quote: lines.join('\\n').trim(), source: attribution[1].trim() };
    }
  }; window.bindFarewellEditor();})();`;
}

export const farewellEditorStyles = `
  body.admin-page main { width: min(1320px, calc(100% - 32px)); }
  .farewell-v2 { padding: 0; overflow: hidden; }
  .farewell-v2-topbar { display: grid; grid-template-columns: minmax(220px, 1fr) auto; gap: 12px 24px; padding: 20px; border-bottom: 1px solid var(--line); }
  .farewell-v2-topbar h2 { margin: 2px 0 4px; }
  .farewell-version-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 8px; }
  .farewell-version-actions form { margin: 0; }
  .farewell-version-actions button { margin: 0; }
  .farewell-release-rule { grid-column: 1 / -1; margin: 0; }
  .pending-badge { border: 1px solid var(--line); padding: 7px 9px; font-size: 12px; color: var(--muted); }
  .pending-badge.has-pending { color: var(--ink); border-color: var(--muted); }
  .farewell-workspace { display: grid; grid-template-columns: 220px minmax(400px, 1fr) 360px; min-height: 620px; }
  .farewell-outline, .farewell-edit-pane, .farewell-preview-pane { min-width: 0; }
  .farewell-outline { padding: 16px; border-right: 1px solid var(--line); background: var(--field); }
  .farewell-pane-title { display: flex; justify-content: space-between; margin-bottom: 10px; }
  .group-selector, .entry-selector { width: 100%; margin: 0; border: 0; border-top: 1px solid var(--line); border-radius: 0; background: transparent; color: var(--ink); text-align: left; display: flex; justify-content: space-between; gap: 10px; }
  .group-selector { padding: 13px 5px; }
  .group-selector.is-selected, .entry-selector.is-selected { background: var(--selected); }
  .group-selector small, .entry-selector small { color: var(--muted); font-weight: 400; }
  .farewell-create-group { margin-top: 16px; }
  .farewell-create-group button { width: 100%; }
  .farewell-edit-pane { padding: 18px 20px 28px; }
  .autosave-indicator { min-height: 26px; text-align: right; color: var(--muted); font-size: 12px; }
  .farewell-group-panel, .farewell-entry-editor { display: none; }
  .farewell-group-panel.is-selected, .farewell-entry-editor.is-selected { display: block; }
  .farewell-group-head, .farewell-editor-heading { display: flex; justify-content: space-between; align-items: end; gap: 14px; }
  .group-title-form { flex: 1; display: grid; gap: 8px; }
  .group-title-form .epigraph-field { margin-top: 8px; }
  .group-title-form textarea { min-height: 104px; line-height: 1.7; }
  .farewell-order { display: flex; gap: 6px; align-items: center; }
  .farewell-order form { margin: 0; }
  .farewell-order button { margin: 0; }
  .compact-button { padding: 8px; font-size: 12px; }
  .farewell-entry-strip { display: flex; gap: 6px; overflow-x: auto; padding: 18px 0 12px; border-bottom: 1px solid var(--line); }
  .entry-selector { width: 150px; min-width: 150px; padding: 9px; border: 1px solid var(--line); border-radius: 5px; flex-direction: column; }
  .entry-selector small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; }
  .farewell-create-entry { min-width: 110px; }
  .farewell-create-entry button { margin: 0; height: 100%; }
  .farewell-entry-stage { padding-top: 18px; }
  .farewell-editor-heading { margin-bottom: 12px; }
  .farewell-fields-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .farewell-danger-row { display: flex; justify-content: flex-end; margin-top: 18px; }
  .farewell-danger-row form { margin: 0; }
  .farewell-preview-pane { border-left: 1px solid var(--line); background: var(--field); }
  .preview-switch { display: grid; grid-template-columns: 1fr 1fr; padding: 10px; border-bottom: 1px solid var(--line); }
  .preview-switch button { margin: 0; border-color: transparent; background: transparent; color: var(--muted); }
  .preview-switch button.is-active { background: var(--selected); color: var(--ink); }
  .preview-scroll { max-height: 760px; overflow-y: auto; padding: 22px; }
  .farewell-preview-document h1 { font-family: Georgia, "Noto Serif SC", serif; font-size: 30px; }
  .farewell-preview-group { border-top: 1px solid var(--line); padding-top: 18px; margin-top: 18px; }
  .farewell-preview-group h2 { font-family: Georgia, "Noto Serif SC", serif; margin: 0 0 4px; }
  .farewell-epigraph-wrap { width: 88%; margin: 18px 0 22px auto; }
  .farewell-epigraph { margin: 0; color: var(--epigraph); font-family: "Noto Serif SC", "Songti SC", Georgia, serif; font-size: 14px; line-height: 1.75; }
  .farewell-epigraph-quote { display: block; white-space: pre-wrap; }
  .farewell-epigraph-source { display: block; margin-top: 8px; text-align: right; font-style: normal; }
  .farewell-epigraph-source::before { content: ""; display: inline-block; width: 2em; border-top: 1px solid currentColor; margin-right: .5em; vertical-align: .35em; }
  .farewell-epigraph-source[hidden] { display: none; }
  .farewell-epigraph-updated { margin-top: 6px; text-align: right; }
  .farewell-preview-entry { padding: 14px 0 0; }
  .farewell-preview-entry + .farewell-preview-entry { border-top: 0; margin-top: 12px; }
  .farewell-preview-entry .letter { font-family: Georgia, "Noto Serif SC", serif; line-height: 1.8; }
  .farewell-mobile-tabs { display: none; }
  .farewell-recycle { margin-top: 20px; border-top: 1px solid var(--line); padding-top: 12px; }
  .recycle-row { padding: 10px 0; border-bottom: 1px solid var(--line); }
  .recycle-row > div { display: flex; gap: 6px; }
  .recycle-row form, .recycle-row button { margin: 0; }
  .empty-state { color: var(--muted); }
  .empty-state.large { padding: 80px 20px; text-align: center; }
  @media (max-width: 1100px) { .farewell-workspace { grid-template-columns: 210px minmax(0, 1fr); } .farewell-preview-pane { display: none; } }
  @media (max-width: 900px) {
    .farewell-v2-topbar { grid-template-columns: 1fr; }
    .farewell-version-actions { justify-content: flex-start; }
    .farewell-mobile-tabs { display: grid; grid-template-columns: repeat(3, 1fr); padding: 8px; border-bottom: 1px solid var(--line); }
    .farewell-mobile-tabs button { margin: 0; background: transparent; border-color: transparent; color: var(--muted); }
    .farewell-mobile-tabs button.is-active { background: var(--selected); color: var(--ink); }
    .farewell-workspace { display: block; min-height: 0; }
    .farewell-v2 [data-farewell-pane] { display: none; border: 0; }
    .farewell-v2:not([data-mobile-pane]), .farewell-v2[data-mobile-pane="outline"] [data-farewell-pane="outline"],
    .farewell-v2[data-mobile-pane="edit"] [data-farewell-pane="edit"], .farewell-v2[data-mobile-pane="preview"] [data-farewell-pane="preview"] { display: block; }
    .farewell-outline, .farewell-edit-pane, .farewell-preview-pane { padding: 16px; }
    .farewell-group-head, .farewell-editor-heading { align-items: stretch; flex-direction: column; }
    .farewell-order { flex-wrap: wrap; }
    .farewell-fields-row { grid-template-columns: 1fr; }
    .preview-scroll { max-height: none; padding: 8px; }
  }
`;
