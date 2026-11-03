// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from "node:test";
import assert from "node:assert/strict";
import { buildMailRehearsal } from "../src/rehearsal.js";
import {testChineseFont} from './helpers/pdf-fonts.js';

test("mail rehearsal sends only to the explicit owner mailbox and marks every message", () => {
  const messages = buildMailRehearsal({
    chineseFont:testChineseFont,
    to: "owner@example.com",
    from: "afterme.fixture@gmail.com",
    token: "abcdefghijklmnopqrstuvwxyz012345",
    now: "2026-08-12T00:00:00.000Z",
  });
  assert.equal(messages.length, 5);
  assert.ok(messages.every((message) => message.to === "owner@example.com"));
  assert.ok(messages.every((message) => message.subject.includes("AfterMe 演练")));
  assert.ok(messages.every((message) => message.text.includes("验证合成场景")));
  assert.match(messages[2].replyTo, /^afterme\.fixture\+verify-[A-Za-z0-9_-]+@gmail\.com$/);
  assert.equal(messages[3].attachments[0].contentType, "application/pdf");
  assert.equal(messages[4].attachments[0].contentType, "application/pdf");
});

