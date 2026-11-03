// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { Repository } from '../src/repository.js';
import { handleRequest } from '../src/worker.js';
import { farewellEditorMarkup } from '../src/farewell-editor-ui.js';

import { database } from './helpers/database.js';
import {testFontAssets} from './helpers/pdf-fonts.js';

for (const kind of ['group', 'entry']) test(`${kind} buttons reorder real SQLite drafts and apply the order to the formal version`, async () => {
  const db = database();
  try {
    const repo = new Repository(db);
    const now = '2026-09-08T00:00:00.000Z';
    await repo.setupOwner({ displayName: 'Test', email: 'test@example.invalid', now });
    const groups = [];
    for (const title of ['A', 'B', 'C']) {
      const id = await repo.farewell.createGroup({ title, now });
      groups.push(id);
      for (const body of ['one', 'two', 'three']) await repo.farewell.createEntry({ groupId: id, body, isPublic: true, now });
    }
    await repo.farewell.applyDraft({ now });
    const initial = await repo.farewell.getEditorState();
    const ids = kind === 'group' ? groups : initial.draft_groups[0].entries.map(entry => entry.id);
    const collection = kind === 'group' ? 'groups' : 'entries';
    const html = farewellEditorMarkup({ state: initial, tokenInput: '<input type="hidden" name="admin_token" value="test">', adminField: '', releaseGraceHours: 72 });
    const forms = [...html.matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)];
    const env = { PDF_FONTS:testFontAssets,DB: db, ALLOW_LOCAL_RATE_LIMIT_FALLBACK:true,ADMIN_TOKEN: 'test', RELEASE_SUSPENDED: 'true', MAIL_PROVIDER: 'dry-run' };
    const order = state => (kind === 'group' ? state : state.find(group => group.id === groups[0]).entries).map(item => item.id);
    for (const [direction, expected] of [
      ['up', [ids[1], ids[0], ids[2]]],
      ['down', ids],
      ['bottom', [ids[0], ids[2], ids[1]]],
      ['top', [ids[1], ids[0], ids[2]]],
    ]) {
      const form = forms.find(([, action, body]) => action === `/api/public-farewell-v2/${collection}/${ids[1]}/reorder` && body.includes(`name="direction" value="${direction}"`));
      assert.ok(form, `rendered ${kind} ${direction} button must point to its supported route`);
      const response = await handleRequest(new Request('https://example.invalid' + form[1], { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify({ direction }) }), env);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).moved, true);
      assert.deepEqual(order(await repo.farewell.listDraftGroups()), expected);
      assert.deepEqual(order(await repo.farewell.listFormalGroups()), ids, 'formal order must wait for apply');
    }
    const applied = await handleRequest(new Request('https://example.invalid/api/public-farewell-v2/apply', { method: 'POST', headers: { Authorization: 'Bearer test','Content-Type':'application/json' },body:JSON.stringify({expected_draft_revision:(await repo.farewell.getVersions()).draft_revision}) }), env);
    assert.equal(applied.status, 200);
    assert.deepEqual(order(await repo.farewell.listFormalGroups()), [ids[1], ids[0], ids[2]]);
    assert.equal((await repo.farewell.getEditorState()).pending_count, 0);
    assert.equal(await repo.getDocumentArtifact('public_farewell'),null,'PDF preparation is separate from committing the text');
    assert.equal((await repo.getPublicFarewell()).status, 'DRAFT');
  } finally { db.close(); }
});
