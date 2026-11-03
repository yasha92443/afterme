// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
function rows(result) {
  return result?.results || [];
}

const groupPendingSql='is_committed=0 OR title<>draft_title OR epigraph<>draft_epigraph OR sort_order<>draft_sort_order OR is_deleted<>draft_is_deleted';
const entryPendingSql='is_committed=0 OR body<>draft_body OR group_id<>draft_group_id OR is_public<>draft_is_public OR sort_order<>draft_sort_order OR is_deleted<>draft_is_deleted';
const entrySummary='id,revision,draft_group_id,draft_is_public,draft_sort_order,draft_updated_at,body_updated_at,substr(draft_body,1,80) AS excerpt';
function pageCursor(value,compound=true){
  if(!value||value==='0')return null;
  if(!(compound?/^\d+:\d+$/:/^\d+$/).test(String(value)))throw Object.assign(Error('Invalid cursor'),{status:400});
  const values=String(value).split(':').map(Number);
  if(values.some(n=>!Number.isSafeInteger(n)))throw Object.assign(Error('Invalid cursor'),{status:400});
  return values;
}
function limitPage(result,limit,order='draft_sort_order'){
  const values=rows(result),results=values.slice(0,limit);
  return {results,next_cursor:values.length>limit?order?results.at(-1)[order]+':'+results.at(-1).id:String(results.at(-1).id):null};
}
const pageLimit=value=>Math.min(50,Math.max(1,Number(value)||50));

function different(left, right) {
  return String(left ?? "") !== String(right ?? "");
}

function groupPending(group) {
  return !Number(group.is_committed)
    || different(group.title, group.draft_title)
    || different(group.epigraph, group.draft_epigraph)
    || Number(group.sort_order) !== Number(group.draft_sort_order)
    || Number(group.is_deleted) !== Number(group.draft_is_deleted);
}

function entryPending(entry) {
  return !Number(entry.is_committed)
    || different(entry.body, entry.draft_body)
    || Number(entry.group_id) !== Number(entry.draft_group_id)
    || Number(entry.is_public) !== Number(entry.draft_is_public)
    || Number(entry.sort_order) !== Number(entry.draft_sort_order)
    || Number(entry.is_deleted) !== Number(entry.draft_is_deleted);
}

function renderSignature(groups, entries, mode) {
  return JSON.stringify(assemble(groups, entries, mode).map((group) => ({
    id: Number(group.id),
    title: group.display_title,
    epigraph: group.display_epigraph,
    entries: group.entries
      .filter((entry) => mode === "formal" || Number(entry.display_public))
      .map((entry) => ({ id: Number(entry.id), body: entry.display_body })),
  })));
}
function assemble(groups, entries, mode) {
  const draft = mode === "draft";
  const byGroup=new Map();
  for(const entry of entries){
    if(Number(draft?entry.draft_is_deleted:entry.is_deleted)||(!draft&&!Number(entry.is_public)))continue;
    const id=Number(draft?entry.draft_group_id:entry.group_id),list=byGroup.get(id)||[];
    list.push({...entry,display_body:draft?entry.draft_body:entry.body,display_public:Number(draft?entry.draft_is_public:entry.is_public)});byGroup.set(id,list);
  }
  const visibleGroups = groups
    .filter((group) => !Number(draft ? group.draft_is_deleted : group.is_deleted))
    .sort((a, b) => Number(draft ? a.draft_sort_order : a.sort_order) - Number(draft ? b.draft_sort_order : b.sort_order) || Number(a.id) - Number(b.id))
    .map((group) => ({
      ...group,
      display_title: draft ? group.draft_title : group.title,
      display_epigraph: draft ? group.draft_epigraph : group.epigraph,
      entries:(byGroup.get(Number(group.id))||[]).sort((a,b)=>Number(draft?a.draft_sort_order:a.sort_order)-Number(draft?b.draft_sort_order:b.sort_order)||Number(a.id)-Number(b.id)),
    }));
  return visibleGroups;
}

export class FarewellV2Repository {
  constructor(db) {
    this.db = db;
  }

  async rawState() {
    const [groups, entries, document,versions] = await this.db.batch([
      this.db.prepare("SELECT * FROM public_farewell_groups_v2 ORDER BY draft_sort_order, id"),
      this.db.prepare("SELECT * FROM public_farewell_entries_v2 ORDER BY draft_group_id, draft_sort_order, id"),
      this.db.prepare("SELECT * FROM public_farewell WHERE id = 1"),
      this.db.prepare('SELECT draft_revision,formal_revision FROM farewell_document_versions WHERE id=1'),
    ]);
    return { groups: rows(groups), entries: rows(entries), document:rows(document)[0]||null,...rows(versions)[0] };
  }

  async getVersions(){return this.db.prepare('SELECT draft_revision,formal_revision,pending_count FROM farewell_document_versions WHERE id=1').first();}

  async getChanges(){
    const [groups,entries,versions]=await this.db.batch([
      this.db.prepare(`SELECT id,is_committed,title<>draft_title AS title_changed,substr(draft_title,1,160) AS draft_title,epigraph<>draft_epigraph AS epigraph_changed,sort_order<>draft_sort_order AS order_changed,is_deleted,draft_is_deleted FROM public_farewell_groups_v2 WHERE ${groupPendingSql}`),
      this.db.prepare(`SELECT id,is_committed,body<>draft_body AS body_changed,group_id<>draft_group_id AS group_changed,is_public<>draft_is_public AS public_changed,sort_order<>draft_sort_order AS order_changed,is_deleted,draft_is_deleted FROM public_farewell_entries_v2 WHERE ${entryPendingSql}`),
      this.db.prepare('SELECT draft_revision,formal_revision FROM farewell_document_versions WHERE id=1'),
    ]);
    const changes=[...rows(groups).map(g=>({label:'分组：'+g.draft_title,changes:[!g.is_committed?'新增':'',g.title_changed?'标题':'',g.epigraph_changed?'题辞':'',g.order_changed?'顺序':'',g.is_deleted!==g.draft_is_deleted?(g.draft_is_deleted?'移除':'恢复'):''].filter(Boolean)})),...rows(entries).map(e=>({label:'条目 '+e.id,changes:[!e.is_committed?'新增':'',e.body_changed?'正文':'',e.group_changed?'分组':'',e.public_changed?'公开状态':'',e.order_changed?'顺序':'',e.is_deleted!==e.draft_is_deleted?(e.draft_is_deleted?'移除':'恢复'):''].filter(Boolean)}))];
    return {...rows(versions)[0],pending_count:changes.length,changes};
  }

  async getEditorState() {
    const state = await this.rawState();
    const pendingGroups = state.groups.filter(groupPending);
    const pendingEntries = state.entries.filter(entryPending);
    return {
      ...state,
      draft_groups: assemble(state.groups, state.entries, "draft"),
      formal_groups: assemble(state.groups, state.entries, "formal"),
      trashed_groups: state.groups.filter((group) => Number(group.draft_is_deleted)),
      trashed_entries: state.entries.filter((entry) => Number(entry.draft_is_deleted)),
      pending_count: pendingGroups.length + pendingEntries.length,
      pending_changes: [
        ...pendingGroups.map(g => ({ label: '分组：' + g.draft_title, changes: [!g.is_committed ? '新增' : '', different(g.title,g.draft_title) ? '标题' : '', different(g.epigraph,g.draft_epigraph) ? '题辞' : '', g.sort_order !== g.draft_sort_order ? '顺序' : '', g.is_deleted !== g.draft_is_deleted ? (g.draft_is_deleted ? '移除' : '恢复') : ''].filter(Boolean) })),
        ...pendingEntries.map(e => ({ label: '条目 ' + e.id, changes: [!e.is_committed ? '新增' : '', different(e.body,e.draft_body) ? '正文' : '', e.group_id !== e.draft_group_id ? '分组' : '', e.is_public !== e.draft_is_public ? '公开状态' : '', e.sort_order !== e.draft_sort_order ? '顺序' : '', e.is_deleted !== e.draft_is_deleted ? (e.draft_is_deleted ? '移除' : '恢复') : ''].filter(Boolean) })),
      ],
      draft_updated_at: [...state.groups, ...state.entries].reduce((latest, item) => !latest || item.draft_updated_at > latest ? item.draft_updated_at : latest, null),
    };
  }

  async getEditorPage({groupId=0}={}) {
    // A single read batch avoids one remote round trip per panel and keeps the
    // directory, selected chapter and previews on the same database snapshot.
    const selectedId=`COALESCE((SELECT id FROM public_farewell_groups_v2 WHERE id=? AND draft_is_deleted=0),
      (SELECT id FROM public_farewell_groups_v2 WHERE draft_is_deleted=0 ORDER BY draft_sort_order,id LIMIT 1))`;
    const [directoryResult,selectedResult,draftResult,documentResult,trashedGroups,trashedEntries,pendingResult,versions]=await this.db.batch([
      this.db.prepare(`SELECT g.id,substr(g.draft_title,1,160) AS draft_title,g.revision,g.draft_sort_order,
      (SELECT COUNT(*) FROM public_farewell_entries_v2 e WHERE e.draft_group_id=g.id AND e.draft_is_deleted=0) AS entry_count
      FROM public_farewell_groups_v2 g WHERE g.draft_is_deleted=0 ORDER BY draft_sort_order,id LIMIT 51`),
      this.db.prepare(`SELECT g.*,(SELECT COUNT(*) FROM public_farewell_entries_v2 e WHERE e.draft_group_id=g.id AND e.draft_is_deleted=0) AS entry_count
        FROM public_farewell_groups_v2 g WHERE id=(${selectedId})`).bind(groupId),
      this.db.prepare(`SELECT ${entrySummary} FROM public_farewell_entries_v2 WHERE draft_group_id=(${selectedId}) AND draft_is_deleted=0 ORDER BY draft_sort_order,id LIMIT 51`).bind(groupId),
      this.db.prepare('SELECT * FROM public_farewell WHERE id=1'),
      this.db.prepare('SELECT id,substr(draft_title,1,160) AS draft_title FROM public_farewell_groups_v2 WHERE draft_is_deleted=1 ORDER BY id DESC LIMIT 51'),
      this.db.prepare('SELECT id,substr(draft_body,1,80) AS excerpt FROM public_farewell_entries_v2 WHERE draft_is_deleted=1 ORDER BY id DESC LIMIT 51'),
      this.db.prepare('SELECT pending_count AS count FROM farewell_document_versions WHERE id=1'),
      this.db.prepare('SELECT draft_revision,formal_revision FROM farewell_document_versions WHERE id=1'),
    ]);
    const directory=rows(directoryResult),selected=rows(selectedResult)[0],draftEntries=rows(draftResult),document=rows(documentResult)[0]||null;
    const panel=selected?{...selected,display_title:selected.draft_title,display_epigraph:selected.draft_epigraph,entries:draftEntries.slice(0,50)}:null;
    return {document,...rows(versions)[0],lazy_entries:true,draft_groups:directory.slice(0,50).map(g=>({...g,entries:panel?.id===g.id?panel.entries:[]})),editor_group:panel,
      formal_groups:selected&&selected.is_committed&&!selected.is_deleted?[{...selected,display_title:selected.title,display_epigraph:selected.epigraph,entries:[]}]:[],
      trashed_groups:rows(trashedGroups).slice(0,50),trashed_entries:rows(trashedEntries).slice(0,50),
      next_trash_group_cursor:rows(trashedGroups).length>50?String(rows(trashedGroups)[49].id):null,
      next_trash_entry_cursor:rows(trashedEntries).length>50?String(rows(trashedEntries)[49].id):null,
      next_formal_cursor:selected?'0':null,
      pending_count:Number(rows(pendingResult)[0].count),
      draft_updated_at:panel?.draft_updated_at||document?.updated_at,
      next_group_cursor:directory.length>50?directory[49].draft_sort_order+':'+directory[49].id:null,
      next_entry_cursor:draftEntries.length>50?draftEntries[49].draft_sort_order+':'+draftEntries[49].id:null};
  }

  async getEntryPage({groupId,cursor,limit=50}={}){
    limit=pageLimit(limit);const after=pageCursor(cursor);
    const result=await this.db.prepare(`SELECT ${entrySummary} FROM public_farewell_entries_v2 WHERE draft_group_id=? AND draft_is_deleted=0 ${after?'AND (draft_sort_order,id)>(?,?)':''} ORDER BY draft_sort_order,id LIMIT ?`).bind(groupId,...(after||[]),limit+1).all();
    return limitPage(result,limit);
  }

  async getEntryEditor(id){return this.db.prepare('SELECT id,revision,draft_group_id,draft_body,draft_is_public,draft_updated_at,body_updated_at FROM public_farewell_entries_v2 WHERE id=? AND draft_is_deleted=0').bind(id).first();}

  async getTrashPage({kind='groups',cursor,limit=50}={}){
    if(!['groups','entries'].includes(kind))throw Object.assign(Error('Invalid trash kind'),{status:400});
    limit=pageLimit(limit);const after=pageCursor(cursor,false),groups=kind==='groups';
    return limitPage(await this.db.prepare(`SELECT id,${groups?'substr(draft_title,1,160) AS draft_title':'substr(draft_body,1,80) AS excerpt'} FROM public_farewell_${groups?'groups':'entries'}_v2 WHERE draft_is_deleted=1 ${after?'AND id<?':''} ORDER BY id DESC LIMIT ?`).bind(...(after||[]),limit+1).all(),limit,null);
  }

  async getFormalPage({groupId,cursor='0',limit=50,byteLimit=65536}={}){
    limit=pageLimit(limit);let after=null,offset=0;
    if(cursor&&cursor!=='0'){
      if(!/^\d+:\d+:\d+$/.test(String(cursor)))throw Object.assign(Error('Invalid formal cursor'),{status:400});
      const values=String(cursor).split(':').map(Number);if(values.some(n=>!Number.isSafeInteger(n)))throw Object.assign(Error('Invalid formal cursor'),{status:400});
      after=values.slice(0,2);offset=values[2];
    }
    const candidates=rows(await this.db.prepare(`SELECT e.id,e.sort_order,length(e.body) AS body_length,substr(e.body,CASE WHEN e.id=? THEN ? ELSE 1 END,16384) AS body FROM public_farewell_entries_v2 e JOIN public_farewell_groups_v2 g ON g.id=e.group_id WHERE e.group_id=? AND e.is_deleted=0 AND e.is_public=1 AND g.is_deleted=0 ${after?'AND ((e.sort_order,e.id)>(?,?) OR (e.id=? AND length(e.body)>?))':''} ORDER BY e.sort_order,e.id LIMIT ?`).bind(after?.[1]||0,offset+1,groupId,...(after?[...after,after[1],offset]:[]),limit+1).all());
    const results=[];let used=0,next_cursor=null;
    for(const entry of candidates){
      const start=entry.id===after?.[1]?offset:0,bytes=new TextEncoder().encode(entry.body).length;
      if(results.length>=limit||(results.length&&used+bytes>Math.min(262144,Math.max(49152,byteLimit)))){const last=results.at(-1);next_cursor=last.sort_order+':'+last.id+':'+last.end_offset;break;}
      const end=start+[...entry.body].length;
      results.push({id:entry.id,sort_order:entry.sort_order,body:entry.body,continuation:start>0,end_offset:end});used+=bytes;
      if(end<entry.body_length){next_cursor=entry.sort_order+':'+entry.id+':'+end;break;}
    }
    return {results,next_cursor};
  }

  async listFormalGroups() {
    const [groups,entries]=await this.db.batch([
      this.db.prepare('SELECT id,title,epigraph,sort_order,is_deleted,is_committed,title_updated_at,epigraph_updated_at FROM public_farewell_groups_v2 WHERE is_deleted=0 ORDER BY sort_order,id'),
      this.db.prepare('SELECT e.id,e.group_id,e.body,e.is_public,e.sort_order,e.is_deleted,e.body_updated_at FROM public_farewell_entries_v2 e JOIN public_farewell_groups_v2 g ON g.id=e.group_id WHERE g.is_deleted=0 AND e.is_deleted=0 AND e.is_public=1 ORDER BY e.group_id,e.sort_order,e.id'),
    ]);
    return assemble(rows(groups),rows(entries),'formal');
  }

  async listDraftGroups() {
    const state = await this.rawState();
    return assemble(state.groups, state.entries, "draft");
  }

  async getGroup(id) {
    return this.db.prepare("SELECT * FROM public_farewell_groups_v2 WHERE id = ?").bind(id).first();
  }

  async getEntry(id) {
    return this.db.prepare("SELECT * FROM public_farewell_entries_v2 WHERE id = ?").bind(id).first();
  }

  async createGroup({ title, now }) {
    const order = await this.db.prepare("SELECT COALESCE(MAX(draft_sort_order), 0) + 10 AS value FROM public_farewell_groups_v2 WHERE draft_is_deleted = 0").first();
    const result = await this.db.prepare(
      `INSERT INTO public_farewell_groups_v2
       (title, draft_title, epigraph, draft_epigraph, sort_order, draft_sort_order, is_deleted, draft_is_deleted,
        is_committed, title_updated_at, epigraph_updated_at, draft_updated_at, created_at)
       VALUES (?, ?, '', '', ?, ?, 1, 0, 0, ?, NULL, ?, ?)`
    ).bind(title, title, Number(order?.value || 10), Number(order?.value || 10), now, now, now).run();
    return Number(result.meta.last_row_id);
  }

  async saveGroupDraft({ id, title, epigraph, now, expectedRevision }) {
    const group = await this.getGroup(id);
    if (!group) return { found: false, changed: false };
    if (expectedRevision !== undefined && group.revision !== expectedRevision) return { found: true, conflict: true, current: group };
    const nextEpigraph = epigraph === undefined ? String(group.draft_epigraph ?? "") : String(epigraph ?? "");
    const changed = different(group.draft_title, title) || different(group.draft_epigraph, nextEpigraph);
    if (changed) {
      const result = await this.db.prepare(
        "UPDATE public_farewell_groups_v2 SET draft_title = ?, draft_epigraph = ?, draft_updated_at = ?, revision = revision + 1 WHERE id = ? AND revision = ?"
      ).bind(title, nextEpigraph, now, id, group.revision).run();
      if (!result.meta?.changes) return { found: true, conflict: true, current: await this.getGroup(id) };
    }
    return { found: true, changed, revision: group.revision + (changed ? 1 : 0) };
  }

  async createEntry({ groupId, body, isPublic, now }) {
    const group = await this.getGroup(groupId);
    if (!group || Number(group.draft_is_deleted)) return null;
    const order = await this.db.prepare(
      "SELECT COALESCE(MAX(draft_sort_order), 0) + 10 AS value FROM public_farewell_entries_v2 WHERE draft_group_id = ? AND draft_is_deleted = 0"
    ).bind(groupId).first();
    const result = await this.db.prepare(
      `INSERT INTO public_farewell_entries_v2
       (group_id, draft_group_id, body, draft_body, is_public, draft_is_public, sort_order, draft_sort_order,
        is_deleted, draft_is_deleted, is_committed, body_updated_at, draft_updated_at, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, 1, 0, 0, ?, ?, ?)`
    ).bind(groupId, groupId, body, body, isPublic ? 1 : 0, Number(order?.value || 10), Number(order?.value || 10), now, now, now).run();
    return Number(result.meta.last_row_id);
  }

  async saveEntryDraft({ id, body, isPublic, groupId, now, expectedRevision }) {
    const entry = await this.getEntry(id);
    const target = await this.getGroup(groupId);
    if (!entry || !target || Number(target.draft_is_deleted)) return { found: false, changed: false };
    if (expectedRevision !== undefined && entry.revision !== expectedRevision) return { found: true, conflict: true, current: entry };
    const changed = different(entry.draft_body, body)
      || Number(entry.draft_is_public) !== Number(isPublic ? 1 : 0)
      || Number(entry.draft_group_id) !== Number(groupId);
    if (changed) {
      let order = Number(entry.draft_sort_order);
      if (Number(entry.draft_group_id) !== Number(groupId)) {
        const next = await this.db.prepare(
          "SELECT COALESCE(MAX(draft_sort_order), 0) + 10 AS value FROM public_farewell_entries_v2 WHERE draft_group_id = ? AND draft_is_deleted = 0"
        ).bind(groupId).first();
        order = Number(next?.value || 10);
      }
      const result = await this.db.prepare(
        `UPDATE public_farewell_entries_v2
         SET draft_body = ?, draft_is_public = ?, draft_group_id = ?, draft_sort_order = ?, draft_updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ?`
      ).bind(body, isPublic ? 1 : 0, groupId, order, now, id, entry.revision).run();
      if (!result.meta?.changes) return { found: true, conflict: true, current: await this.getEntry(id) };
    }
    return { found: true, changed, revision: entry.revision + (changed ? 1 : 0) };
  }

  async reorder({ kind, id, direction, now }) {
    const isGroup = kind === "group";
    const table = isGroup ? "public_farewell_groups_v2" : "public_farewell_entries_v2";
    const item = isGroup ? await this.getGroup(id) : await this.getEntry(id);
    if (!item) return { found: false, moved: false };
    const parentClause = isGroup ? "" : "AND draft_group_id = ?";
    const statement = this.db.prepare(
      `SELECT id FROM ${table} WHERE draft_is_deleted = 0 ${parentClause} ORDER BY draft_sort_order, id`
    );
    const result = isGroup ? await statement.all() : await statement.bind(item.draft_group_id).all();
    const ordered = rows(result);
    const index = ordered.findIndex((candidate) => Number(candidate.id) === Number(id));
    if (index < 0) return { found: true, moved: false };
    const target = direction === "top" ? 0 : direction === "bottom" ? ordered.length - 1 : index + (direction === "up" ? -1 : 1);
    if (target < 0 || target >= ordered.length || target === index) return { found: true, moved: false };
    const [moved] = ordered.splice(index, 1);
    ordered.splice(target, 0, moved);
    await this.db.batch(ordered.map((candidate, position) => this.db.prepare(
      `UPDATE ${table} SET draft_sort_order = ?, draft_updated_at = ?, revision = revision + 1 WHERE id = ?`
    ).bind((position + 1) * 10, now, candidate.id)));
    return { found: true, moved: true };
  }

  async setTrashed({ kind, id, trashed, now }) {
    const table = kind === "group" ? "public_farewell_groups_v2" : "public_farewell_entries_v2";
    const result = await this.db.prepare(
      `UPDATE ${table} SET draft_is_deleted = ?, draft_updated_at = ?, revision = revision + 1 WHERE id = ?`
    ).bind(trashed ? 1 : 0, now, id).run();
    return Number(result.meta?.changes || 0) > 0;
  }

  async permanentlyDelete({ kind, id }) {
    if (kind === "entry") {
      const entry = await this.getEntry(id);
      if (!entry) return false;
      if (Number(entry.is_committed) && (!Number(entry.is_deleted) || !Number(entry.draft_is_deleted))) return false;
      await this.db.prepare("DELETE FROM public_farewell_entries_v2 WHERE id = ?").bind(id).run();
      return true;
    }
    const group = await this.getGroup(id);
    if (!group) return false;
    if (Number(group.is_committed) && (!Number(group.is_deleted) || !Number(group.draft_is_deleted))) return false;
    await this.db.batch([
      this.db.prepare("DELETE FROM public_farewell_entries_v2 WHERE group_id = ? OR draft_group_id = ?").bind(id, id),
      this.db.prepare("DELETE FROM public_farewell_groups_v2 WHERE id = ?").bind(id),
    ]);
    return true;
  }

  async applyDraft({now,expectedDraftRevision}={}) {
    const [versionResult,changedResult]=await this.db.batch([
      this.db.prepare('SELECT draft_revision,formal_revision FROM farewell_document_versions WHERE id=1'),
      this.db.prepare(`SELECT EXISTS(SELECT 1 FROM public_farewell_groups_v2 WHERE
        is_deleted<>draft_is_deleted OR (is_deleted=0 AND draft_is_deleted=0 AND (title<>draft_title OR epigraph<>draft_epigraph OR sort_order<>draft_sort_order)))
        OR EXISTS(SELECT 1 FROM public_farewell_entries_v2 e
          LEFT JOIN public_farewell_groups_v2 g ON g.id=e.group_id LEFT JOIN public_farewell_groups_v2 d ON d.id=e.draft_group_id
          WHERE (e.is_deleted=0 AND e.is_public=1 AND g.is_deleted=0)<>(e.draft_is_deleted=0 AND e.draft_is_public=1 AND d.draft_is_deleted=0)
          OR ((e.is_deleted=0 AND e.is_public=1 AND g.is_deleted=0 OR e.draft_is_deleted=0 AND e.draft_is_public=1 AND d.draft_is_deleted=0)
          AND (e.body<>e.draft_body OR e.group_id<>e.draft_group_id OR e.sort_order<>e.draft_sort_order))) AS changed`),
    ]);
    const current=rows(versionResult)[0],expected=expectedDraftRevision??current.draft_revision;
    if(current.draft_revision!==expected)return {conflict:true,current};
    const changed=Boolean(rows(changedResult)[0].changed),marker=crypto.randomUUID(),guard='EXISTS(SELECT 1 FROM farewell_document_versions WHERE id=1 AND write_token=?)';
    const result=await this.db.batch([
      this.db.prepare('UPDATE farewell_document_versions SET write_token=? WHERE id=1 AND draft_revision=?').bind(marker,expected),
      this.db.prepare(`UPDATE public_farewell_groups_v2 SET
        title_updated_at=CASE WHEN title<>draft_title OR is_committed=0 THEN ? ELSE title_updated_at END,
        epigraph_updated_at=CASE WHEN epigraph<>draft_epigraph THEN ? ELSE epigraph_updated_at END,
        title=draft_title,epigraph=draft_epigraph,sort_order=draft_sort_order,is_deleted=draft_is_deleted,is_committed=1,draft_updated_at=?,revision=revision+1
        WHERE (${groupPendingSql}) AND ${guard}`).bind(now,now,now,marker),
      this.db.prepare(`UPDATE public_farewell_entries_v2 SET
        body_updated_at=CASE WHEN body<>draft_body OR is_committed=0 THEN ? ELSE body_updated_at END,
        group_id=draft_group_id,body=draft_body,is_public=draft_is_public,sort_order=draft_sort_order,is_deleted=draft_is_deleted,is_committed=1,draft_updated_at=?,revision=revision+1
        WHERE (${entryPendingSql}) AND ${guard}`).bind(now,now,marker),
      this.db.prepare(`INSERT INTO public_farewell(id,title,body,status,updated_at)
        SELECT 1,'公开遗言','','DRAFT',? WHERE ?=1 AND ${guard}
        ON CONFLICT(id) DO UPDATE SET title='公开遗言',updated_at=excluded.updated_at`).bind(now,changed?1:0,marker),
      this.db.prepare('UPDATE farewell_document_versions SET formal_revision=formal_revision+?,write_token=NULL WHERE id=1 AND write_token=?').bind(changed?1:0,marker),
      this.db.prepare('SELECT draft_revision,formal_revision FROM farewell_document_versions WHERE id=1'),
      this.db.prepare('SELECT updated_at FROM public_farewell WHERE id=1'),
    ]);
    if(!result[0].meta?.changes)return {conflict:true,current:rows(result[5])[0]};
    return {changed,...rows(result[5])[0],updated_at:rows(result[6])[0]?.updated_at||null};
  }

  async discardDraft({now,expectedDraftRevision}={}) {
    const current=await this.getVersions(),expected=expectedDraftRevision??current.draft_revision;
    if(current.draft_revision!==expected)return {conflict:true,current};
    const marker=crypto.randomUUID(),guard='EXISTS(SELECT 1 FROM farewell_document_versions WHERE id=1 AND write_token=?)';
    const result=await this.db.batch([
      this.db.prepare('UPDATE farewell_document_versions SET write_token=? WHERE id=1 AND draft_revision=?').bind(marker,expected),
      this.db.prepare(`DELETE FROM public_farewell_entries_v2 WHERE is_committed=0 AND ${guard}`).bind(marker),
      this.db.prepare(`UPDATE public_farewell_entries_v2 SET draft_group_id=group_id,draft_body=body,draft_is_public=is_public,draft_sort_order=sort_order,draft_is_deleted=is_deleted,draft_updated_at=?,revision=revision+1 WHERE is_committed=1 AND (${entryPendingSql}) AND ${guard}`).bind(now,marker),
      this.db.prepare(`DELETE FROM public_farewell_groups_v2 WHERE is_committed=0 AND ${guard}`).bind(marker),
      this.db.prepare(`UPDATE public_farewell_groups_v2 SET draft_title=title,draft_epigraph=epigraph,draft_sort_order=sort_order,draft_is_deleted=is_deleted,draft_updated_at=?,revision=revision+1 WHERE is_committed=1 AND (${groupPendingSql}) AND ${guard}`).bind(now,marker),
      this.db.prepare('UPDATE farewell_document_versions SET write_token=NULL WHERE id=1 AND write_token=?').bind(marker),
      this.db.prepare('SELECT draft_revision,formal_revision FROM farewell_document_versions WHERE id=1'),
    ]);
    if(!result[0].meta?.changes)return {conflict:true,current:rows(result[6])[0]};
    return {discarded:result.slice(1,5).reduce((n,r)=>n+Number(r.meta?.changes||0),0),...rows(result[6])[0]};
  }
}
