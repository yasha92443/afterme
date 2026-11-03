// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from "node:test";
import assert from "node:assert/strict";
import { Repository } from "../src/repository.js";

test("contact lookup compares normalized email addresses", async () => {
  let preparedSql = "";
  let boundValue = "";
  const db = {
    prepare(sql) {
      preparedSql = sql;
      return {
        bind(value) {
          boundValue = value;
          return {
            async first() {
              return { id: 1, email: "person@example.com" };
            },
          };
        },
      };
    },
  };

  const result = await new Repository(db).findContactByEmail("person@example.com");
  assert.equal(result.id, 1);
  assert.match(preparedSql, /lower\(trim\(email\)\)/);
  assert.equal(boundValue, "person@example.com");
});

test("private recipient lookup uses its own normalized email directory", async () => {
  let preparedSql = "";
  const db = {
    prepare(sql) {
      preparedSql = sql;
      return {
        bind() {
          return { async first() { return { id: 9, email: "recipient@example.com" }; } };
        },
      };
    },
  };

  const result = await new Repository(db).findRecipientByEmail("recipient@example.com");
  assert.equal(result.id, 9);
  assert.match(preparedSql, /FROM recipients/);
  assert.match(preparedSql, /lower\(trim\(email\)\)/);
});

test("private letter update replaces recipient, encrypted body, PDF and save time without relying on a user title", async () => {
  let sql = "";
  let values = [];
  const db = {
    prepare(statement) {
      sql = statement;
      return { bind(...bound) { values = bound; return { async run() { return { meta: { changes: 1 } }; } }; } };
    },
  };
  const updated = await new Repository(db).updateEncryptedItem({
    id: 7,
    recipientId: 9,
    encryptedPayload: "encrypted-body",
    pdfPayload: "encrypted-pdf",
    payloadSize: 42,
    updatedAt: "2026-08-31T00:00:00.000Z",
  });
  assert.equal(updated, true);
  assert.match(sql, /SET title = '私人信件'/);
  assert.match(sql, /released_at IS NULL/);
  assert.deepEqual(values, [9, "encrypted-body", "encrypted-pdf", 42, "2026-08-31T00:00:00.000Z", 1, 7, null, null]);
});

test("mail template upsert stores the editable subject and body", async () => {
  let sql = "";
  let values = [];
  const db = {
    prepare(statement) {
      sql = statement;
      return { bind(...bound) { values = bound; return { async run() {} }; } };
    },
  };
  await new Repository(db).upsertMailTemplate({ key: "contact_alert", subjectTemplate: "标题", bodyTemplate: "正文", now: "2026-08-13T00:00:00.000Z" });
  assert.match(sql, /INSERT INTO mail_templates/);
  assert.deepEqual(values, ["contact_alert", "标题", "正文", "2026-08-13T00:00:00.000Z"]);
});

test("verification replies can match a subject that was actually delivered", async () => {
  let sql = "";
  let values = [];
  const db = {
    prepare(statement) {
      sql = statement;
      return { bind(...bound) { values = bound; return { async first() { return { id: 7 }; } }; } };
    },
  };
  const matched = await new Repository(db).wasVerificationSubjectSentTo("friend@example.com", "旧核验标题");
  assert.equal(matched, true);
  assert.match(sql, /event_type = 'contact_verify'/);
  assert.deepEqual(values, ["friend@example.com", "旧核验标题"]);
});

test("public farewell title update preserves release state fields", async () => {
  let preparedSql = "";
  let boundValues = [];
  const db = {
    prepare(sql) {
      preparedSql = sql;
      return {
        bind(...values) {
          boundValues = values;
          return { async run() {} };
        },
      };
    },
  };

  await new Repository(db).upsertPublicFarewellTitle({
    title: "最后的话",
    now: "2026-07-13T00:00:00.000Z",
  });
  assert.match(preparedSql, /title = excluded\.title/);
  assert.doesNotMatch(preparedSql, /status = excluded\.status/);
  assert.doesNotMatch(preparedSql, /auto_released_at = NULL/);
  assert.deepEqual(boundValues, ["最后的话", "2026-07-13T00:00:00.000Z"]);
});

test("renaming a public farewell group updates every item and safely merges an existing title", async () => {
  const updates = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async all() {
              if (values[0] === "旧标题") return { results: [{ id: 2, sort_order: 20 }, { id: 3, sort_order: 20 }] };
              if (values[0] === "已有标题") return { results: [{ id: 1, sort_order: 10 }] };
              return { results: [] };
            },
            async run() { updates.push({ sql, values }); },
          };
        },
      };
    },
  };

  const result = await new Repository(db).renamePublicFarewellGroup({
    title: "旧标题",
    newTitle: "已有标题",
    now: "2026-07-13T00:00:00.000Z",
  });
  assert.deepEqual(result, { found: true, merged: true });
  const itemUpdates = updates.filter((entry) => entry.sql.includes("UPDATE public_farewell_items"));
  assert.equal(itemUpdates.length, 3);
  assert.deepEqual(itemUpdates.map((entry) => entry.values.at(-1)), [1, 2, 3]);
  assert.deepEqual(itemUpdates.map((entry) => entry.values[2]), [10, 20, 30]);
});
