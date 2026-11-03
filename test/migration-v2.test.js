// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

test("migration preserves eight groups and eighteen entries with reconstructed times", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE public_farewell_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      entry_order INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE public_farewell (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const titles = ["总则", "关于死亡", "关于我", "关于政治理想", "说在最后", "朋友", "家人", "其他"];
  const counts = [3, 3, 2, 2, 2, 2, 2, 2];
  const insert = db.prepare(`
    INSERT INTO public_farewell_items
      (id, title, body, sort_order, entry_order, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'published', ?, ?)
  `);
  let id = 1;
  for (let groupIndex = 0; groupIndex < titles.length; groupIndex += 1) {
    for (let entryIndex = 0; entryIndex < counts[groupIndex]; entryIndex += 1) {
      const created = `2026-07-${String(groupIndex + 1).padStart(2, "0")}T00:00:00.000Z`;
      insert.run(id, titles[groupIndex], `正文 ${id}`, (groupIndex + 1) * 10, (entryIndex + 1) * 10, created, created);
      id += 1;
    }
  }
  db.prepare("INSERT INTO audit_log (event_type, details_json, created_at) VALUES (?, ?, ?)").run(
    "public_farewell_item_upsert",
    JSON.stringify({ id: 1, status: "published" }),
    "2026-07-12T12:00:00.000Z"
  );
  db.prepare("INSERT INTO audit_log (event_type, details_json, created_at) VALUES (?, ?, ?)").run(
    "public_farewell_group_renamed",
    JSON.stringify({ title: "旧标题", new_title: "关于死亡" }),
    "2026-07-11T11:00:00.000Z"
  );

  db.exec(readFileSync(new URL("../migrations/0010_public_farewell_editor_v2.sql", import.meta.url), "utf8"));

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM public_farewell_groups_v2").get().count, 8);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM public_farewell_entries_v2").get().count, 18);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM public_farewell_items").get().count, 18);
  assert.deepEqual(
    db.prepare("SELECT title FROM public_farewell_groups_v2 ORDER BY sort_order, id").all().map((row) => row.title),
    titles
  );
  assert.deepEqual(
    db.prepare("SELECT entries.body FROM public_farewell_entries_v2 entries JOIN public_farewell_groups_v2 groups ON groups.id = entries.group_id ORDER BY groups.sort_order, entries.sort_order, entries.id").all().map((row) => row.body),
    Array.from({ length: 18 }, (_, index) => `正文 ${index + 1}`)
  );
  assert.equal(
    db.prepare("SELECT body_updated_at FROM public_farewell_entries_v2 WHERE id = 1").get().body_updated_at,
    "2026-07-12T12:00:00.000Z"
  );
  assert.equal(
    db.prepare("SELECT title_updated_at FROM public_farewell_groups_v2 WHERE title = '关于死亡'").get().title_updated_at,
    "2026-07-11T11:00:00.000Z"
  );
});