// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from "node:test";
import assert from "node:assert/strict";
import { FarewellV2Repository } from "../src/farewell-v2.js";

// Execute real transactional SQL so revision guards and trigger behavior are covered.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {after} from 'node:test';
const openDatabases=[];after(()=>openDatabases.forEach(db=>db.close()));
class FakeD1 {
  constructor({groups,entries,document}){
    this.sqlite=new DatabaseSync(':memory:');openDatabases.push(this.sqlite);
    for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())this.sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
    const insert=(table,row)=>{const value={...row,created_at:row.created_at||row.draft_updated_at||document.updated_at};this.sqlite.prepare(`INSERT OR REPLACE INTO ${table}(${Object.keys(value).join(',')}) VALUES(${Object.keys(value).map(()=>'?').join(',')})`).run(...Object.values(value));};
    for(const group of groups)insert('public_farewell_groups_v2',group);
    for(const entry of entries)insert('public_farewell_entries_v2',entry);
    this.sqlite.prepare('INSERT OR REPLACE INTO public_farewell(id,title,body,status,updated_at) VALUES(1,?,?,?,?)').run(document.title,'',document.status,document.updated_at);
  }
  get groups(){return this.sqlite.prepare('SELECT * FROM public_farewell_groups_v2 ORDER BY id').all();}
  get entries(){return this.sqlite.prepare('SELECT * FROM public_farewell_entries_v2 ORDER BY id').all();}
  get document(){return this.sqlite.prepare('SELECT * FROM public_farewell WHERE id=1').get();}
  prepare(sql){const statement=this.sqlite.prepare(sql);let values=[];return {bind(...args){values=args;return this;},async first(){return statement.get(...values)||null;},async all(){return {results:statement.all(...values)};},run(){if(/^\s*SELECT/i.test(sql))return {results:statement.all(...values)};const result=statement.run(...values);return {meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};}};}
  async batch(statements){this.sqlite.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(statement.run());this.sqlite.exec('COMMIT');return results;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
}

function fixture() {
  const old = "2026-07-01T00:00:00.000Z";
  return {
    document: { id: 1, title: "公开遗言", status: "DRAFT", updated_at: old },
    groups: [
      { id: 1, title: "第一组", draft_title: "第一组", epigraph: "", draft_epigraph: "", epigraph_updated_at: null, sort_order: 10, draft_sort_order: 10, is_deleted: 0, draft_is_deleted: 0, is_committed: 1, title_updated_at: old, draft_updated_at: old },
      { id: 2, title: "第二组", draft_title: "第二组", epigraph: "", draft_epigraph: "", epigraph_updated_at: null, sort_order: 20, draft_sort_order: 20, is_deleted: 0, draft_is_deleted: 0, is_committed: 1, title_updated_at: old, draft_updated_at: old },
    ],
    entries: [
      { id: 1, group_id: 1, draft_group_id: 1, body: "正文一", draft_body: "正文一", is_public: 1, draft_is_public: 1, sort_order: 10, draft_sort_order: 10, is_deleted: 0, draft_is_deleted: 0, is_committed: 1, body_updated_at: old, draft_updated_at: old },
      { id: 2, group_id: 1, draft_group_id: 1, body: "正文二", draft_body: "正文二", is_public: 1, draft_is_public: 1, sort_order: 20, draft_sort_order: 20, is_deleted: 0, draft_is_deleted: 0, is_committed: 1, body_updated_at: old, draft_updated_at: old },
    ],
  };
}

test("autosaving a group title changes draft only", async () => {
  const db = new FakeD1(fixture());
  const repo = new FarewellV2Repository(db);
  await repo.saveGroupDraft({ id: 1, title: "新标题", now: "2026-07-02T00:00:00.000Z" });
  assert.equal(db.groups[0].title, "第一组");
  assert.equal(db.groups[0].draft_title, "新标题");
  assert.equal(db.groups[0].title_updated_at, "2026-07-01T00:00:00.000Z");
  assert.equal(db.document.updated_at, "2026-07-01T00:00:00.000Z");
});

test("applying an epigraph draft updates only epigraph and overall times", async () => {
  const data = fixture();
  data.groups[0].draft_epigraph = "人生如逆旅。\n——苏轼";
  const db = new FakeD1(data);
  const repo = new FarewellV2Repository(db);
  const result = await repo.applyDraft({ now: "2026-07-02T12:00:00.000Z" });
  assert.equal(result.changed, true);
  assert.equal(db.groups[0].epigraph, "人生如逆旅。\n——苏轼");
  assert.equal(db.groups[0].epigraph_updated_at, "2026-07-02T12:00:00.000Z");
  assert.equal(db.groups[0].title_updated_at, "2026-07-01T00:00:00.000Z");
  assert.deepEqual(db.entries.map((entry) => entry.body_updated_at), [
    "2026-07-01T00:00:00.000Z",
    "2026-07-01T00:00:00.000Z",
  ]);
  assert.equal(db.document.updated_at, "2026-07-02T12:00:00.000Z");
});

test("applying a title draft updates group title and overall time but no body time", async () => {
  const data = fixture();
  data.groups[0].draft_title = "新标题";
  const db = new FakeD1(data);
  const repo = new FarewellV2Repository(db);
  const result = await repo.applyDraft({ now: "2026-07-03T00:00:00.000Z" });
  assert.equal(result.changed, true);
  assert.equal(db.groups[0].title_updated_at, "2026-07-03T00:00:00.000Z");
  assert.deepEqual(db.entries.map((entry) => entry.body_updated_at), [
    "2026-07-01T00:00:00.000Z",
    "2026-07-01T00:00:00.000Z",
  ]);
  assert.equal(db.document.updated_at, "2026-07-03T00:00:00.000Z");
});

test("applying one body draft updates only that body time and overall time", async () => {
  const data = fixture();
  data.entries[1].draft_body = "修改后的正文二";
  const db = new FakeD1(data);
  await new FarewellV2Repository(db).applyDraft({ now: "2026-07-04T00:00:00.000Z" });
  assert.equal(db.entries[0].body_updated_at, "2026-07-01T00:00:00.000Z");
  assert.equal(db.entries[1].body_updated_at, "2026-07-04T00:00:00.000Z");
  assert.equal(db.groups[0].title_updated_at, "2026-07-01T00:00:00.000Z");
  assert.equal(db.document.updated_at, "2026-07-04T00:00:00.000Z");
});

test("ordering and public-state changes update only the overall time", async () => {
  const data = fixture();
  data.entries[0].draft_sort_order = 20;
  data.entries[1].draft_sort_order = 10;
  data.entries[1].draft_is_public = 0;
  const db = new FakeD1(data);
  await new FarewellV2Repository(db).applyDraft({ now: "2026-07-05T00:00:00.000Z" });
  assert.deepEqual(db.entries.map((entry) => entry.body_updated_at), [
    "2026-07-01T00:00:00.000Z",
    "2026-07-01T00:00:00.000Z",
  ]);
  assert.equal(db.document.updated_at, "2026-07-05T00:00:00.000Z");
});

test("a no-op apply does not change any formal time", async () => {
  const db = new FakeD1(fixture());
  const result = await new FarewellV2Repository(db).applyDraft({ now: "2026-07-06T00:00:00.000Z" });
  assert.equal(result.changed, false);
  assert.equal(db.document.updated_at, "2026-07-01T00:00:00.000Z");
});

test("draft changes inside an already deleted group do not change overall public time", async () => {
  const data = fixture();
  data.groups[0].is_deleted = 1;
  data.groups[0].draft_is_deleted = 1;
  data.groups[0].draft_title = "删除状态下的新标题";
  const db = new FakeD1(data);
  const result = await new FarewellV2Repository(db).applyDraft({ now: "2026-07-07T00:00:00.000Z" });
  assert.equal(result.changed, false);
  assert.equal(db.document.updated_at, "2026-07-01T00:00:00.000Z");
});

test("trash and restore remain draft-only until apply", async () => {
  const db = new FakeD1(fixture());
  const repo = new FarewellV2Repository(db);
  await repo.setTrashed({ kind: "entry", id: 1, trashed: true, now: "2026-07-08T00:00:00.000Z" });
  assert.equal(db.entries[0].is_deleted, 0);
  assert.equal(db.entries[0].draft_is_deleted, 1);
  await repo.setTrashed({ kind: "entry", id: 1, trashed: false, now: "2026-07-08T01:00:00.000Z" });
  assert.equal(db.entries[0].draft_is_deleted, 0);
  assert.equal(db.document.updated_at, "2026-07-01T00:00:00.000Z");
});

test("discard restores committed drafts and removes uncommitted rows", async () => {
  const data = fixture();
  data.groups[0].draft_title = "不保留的标题";
  data.entries[0].draft_body = "不保留的正文";
  data.groups.push({ ...data.groups[1], id: 3, title: "草稿组", draft_title: "草稿组", is_committed: 0, is_deleted: 1, draft_is_deleted: 0 });
  data.entries.push({ ...data.entries[1], id: 3, group_id: 3, draft_group_id: 3, body: "草稿正文", draft_body: "草稿正文", is_committed: 0, is_deleted: 1, draft_is_deleted: 0 });
  const db = new FakeD1(data);
  const result = await new FarewellV2Repository(db).discardDraft({ now: "2026-07-09T00:00:00.000Z" });
  assert.equal(result.discarded, 4);
  assert.equal(db.groups[0].draft_title, "第一组");
  assert.equal(db.entries[0].draft_body, "正文一");
  assert.equal(db.groups.some((group) => group.id === 3), false);
  assert.equal(db.entries.some((entry) => entry.id === 3), false);
  assert.equal(db.document.updated_at, "2026-07-01T00:00:00.000Z");
});
test("permanent group deletion cascades only after both versions are deleted", async () => {
  const data = fixture();
  const db = new FakeD1(data);
  const repo = new FarewellV2Repository(db);

  assert.equal(await repo.permanentlyDelete({ kind: "group", id: 1 }), false);
  assert.equal(db.groups.length, 2);
  assert.equal(db.entries.length, 2);

  db.sqlite.exec('UPDATE public_farewell_groups_v2 SET is_deleted=1,draft_is_deleted=1 WHERE id=1');
  assert.equal(await repo.permanentlyDelete({ kind: "group", id: 1 }), true);
  assert.deepEqual(db.groups.map((group) => group.id), [2]);
  assert.equal(db.entries.length, 0);
});