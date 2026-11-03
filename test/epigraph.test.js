// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from "node:test";
import assert from "node:assert/strict";
import { parseEpigraph } from "../src/epigraph.js";
import { farewellEditorScript } from "../src/farewell-editor-ui.js";

test("epigraph parser separates a dashed final attribution", () => {
  assert.deepEqual(parseEpigraph("中国的豆腐也是很好吃的东西，世界第一。\n——瞿秋白《多余的话》"), {
    quote: "中国的豆腐也是很好吃的东西，世界第一。",
    source: "瞿秋白《多余的话》",
  });
});

test("epigraph parser preserves ordinary multiline quotations", () => {
  assert.deepEqual(parseEpigraph("第一行\n第二行"), {
    quote: "第一行\n第二行",
    source: "",
  });
});


test("generated editor script keeps epigraph parsing escapes valid", () => {
  assert.doesNotThrow(() => new Function(farewellEditorScript()));
});
