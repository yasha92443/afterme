// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkConfiguration} from '../scripts/setup-guided.mjs';
const fixture=()=>readFileSync(new URL('../wrangler.durable-object.example.toml',import.meta.url),'utf8').replace('00000000-0000-4000-8000-000000000000','11111111-1111-4111-8111-111111111111');
test('Durable profile requires the native entrypoint, local binding, SQLite migration and staged lanes',()=>{
  const source=fixture(),result=checkConfiguration(source);
  assert.equal(result.ok,true,JSON.stringify(result.errors));assert.equal(result.execution_runtime,'durable-object');
  for(const candidate of [source.replace('src/durable-worker.js','src/worker.js'),source.replace('name = "APP_RUNTIME"','name = "MISSING_RUNTIME"'),source.replace('class_name = "AfterMeRuntime"','class_name = "AnotherRuntime"'),source.replace('class_name = "AfterMeRuntime"','class_name = "AfterMeRuntime"\nscript_name = "another-worker"'),source.replace('new_sqlite_classes','new_classes'),source.replace('BACKGROUND_EXECUTION_MODE = "staged"','BACKGROUND_EXECUTION_MODE = "legacy"'),source.replace('BACKGROUND_LANE_SCHEDULING = "true"','BACKGROUND_LANE_SCHEDULING = "false"'),source+'\n[limits]\ncpu_ms = 30000\n',source.replace('EXECUTION_RUNTIME = "durable-object"','EXECUTION_RUNTIME = "durable-objects"')])assert.equal(checkConfiguration(candidate).ok,false);
});
