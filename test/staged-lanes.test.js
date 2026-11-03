// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {database} from './helpers/database.js';
import {Repository} from '../src/repository.js';
import {BACKGROUND_LANE_CRONS,backgroundLaneForCron,runBackgroundLaneTick} from '../src/background-scheduler.js';
import {checkConfiguration} from '../scripts/setup-guided.mjs';

const anchor=Date.parse('2030-01-01T00:00:00.000Z');
const time=minute=>new Date(anchor+minute*60000).toISOString();
function fixture(t){const db=database();t.after(()=>db.close());return {db,repo:new Repository(db)};}
function hooks(calls){return Object.fromEntries(['inbox','control','maintenance','mail','validate','discover','release','notice'].map(stage=>[stage,async()=>{calls.push(stage);return {stage};}]));}

test('three distinct trigger expressions resolve only to their configured lane',()=>{
  assert.deepEqual(Object.values(BACKGROUND_LANE_CRONS),['* * * * *','*/2 * * * *','1-59/2 * * * *']);
  for(const [lane,cron] of Object.entries(BACKGROUND_LANE_CRONS))assert.equal(backgroundLaneForCron(cron),lane);
  for(const cron of ['',undefined,'*/5 * * * *','*/1 * * * *','0-59/2 * * * *'])assert.equal(backgroundLaneForCron(cron),null);
});

test('inbox keeps a minute slot while control and maintenance alternate independently every four minutes',async t=>{
  const {repo}=fixture(t),calls=[],actions=hooks(calls),events=[];
  for(let minute=0;minute<=16;minute++){
    events.push({minute,...await runBackgroundLaneTick(repo,{},time(minute),'inbox',actions)});
    const lane=minute%2===0?'control':'work';
    events.push({minute,...await runBackgroundLaneTick(repo,{},time(minute),lane,actions)});
  }
  assert.deepEqual(events.filter(e=>e.stage==='inbox').map(e=>e.minute),Array.from({length:17},(_,index)=>index));
  assert.deepEqual(events.filter(e=>e.stage==='control').map(e=>e.minute),[0,4,8,12,16]);
  assert.deepEqual(events.filter(e=>e.stage==='maintenance').map(e=>e.minute),[2,6,10,14]);
  assert.deepEqual(events.filter(e=>e.lane==='work').slice(0,5).map(e=>e.stage),['mail','validate','discover','release','notice']);
  assert.equal(calls.length,events.length);
});

test('an inbox lease neither blocks the other lanes nor allows duplicate inbox work',async t=>{
  const {repo}=fixture(t),calls=[],actions=hooks(calls);let release,started;
  const pending=new Promise(resolve=>{release=resolve;}),began=new Promise(resolve=>{started=resolve;});
  actions.inbox=async()=>{calls.push('inbox');started();await pending;return {done:true};};
  const first=runBackgroundLaneTick(repo,{},time(0),'inbox',actions);await began;
  const duplicate=await runBackgroundLaneTick(repo,{},time(1),'inbox',actions);
  assert.equal(duplicate.deferred,true);assert.equal(duplicate.stage,'leased');
  assert.equal((await runBackgroundLaneTick(repo,{},time(0),'control',actions)).stage,'control');
  assert.equal((await runBackgroundLaneTick(repo,{},time(1),'work',actions)).stage,'mail');
  release();assert.equal((await first).stage,'inbox');assert.equal(calls.filter(stage=>stage==='inbox').length,1);
});

test('an expired lease is recoverable and a late previous owner cannot overwrite the replacement',async t=>{
  const {db,repo}=fixture(t);let release,started;
  const pending=new Promise(resolve=>{release=resolve;}),began=new Promise(resolve=>{started=resolve;});
  const original=runBackgroundLaneTick(repo,{},time(0),'inbox',{inbox:async()=>{started();await pending;return {};}});await began;
  const replacement=await runBackgroundLaneTick(repo,{},time(2),'inbox',{inbox:async()=>({replacement:true})});
  assert.equal(replacement.result.replacement,true);
  const after=await db.prepare("SELECT * FROM background_lane_leases WHERE lane='inbox'").first();
  release();const late=await original;assert.equal(late.ok,false);assert.equal(late.deferred,true);assert.equal(late.lease_lost,true);
  const final=await db.prepare("SELECT * FROM background_lane_leases WHERE lane='inbox'").first();
  assert.equal(final.updated_at,time(2));assert.equal(final.inbox_at,time(2));assert.equal(final.lease_token,null);assert.deepEqual(final,after);
});

test('a failed control stage releases its lease, preserves completion time and gives maintenance its next slot',async t=>{
  const {db,repo}=fixture(t),calls=[],actions=hooks(calls);actions.control=async()=>{throw new TypeError('Synthetic failure');};
  await assert.rejects(runBackgroundLaneTick(repo,{},time(0),'control',actions),/Synthetic failure/);
  let row=await db.prepare("SELECT * FROM background_lane_leases WHERE lane='control'").first();assert.equal(row.control_at,null);assert.equal(row.lease_token,null);assert.equal(row.last_error,'TypeError');
  assert.equal((await runBackgroundLaneTick(repo,{},time(2),'control',actions)).stage,'maintenance');
  actions.control=async()=>({done:true});assert.equal((await runBackgroundLaneTick(repo,{},time(4),'control',actions)).stage,'control');
  row=await db.prepare("SELECT * FROM background_lane_leases WHERE lane='control'").first();assert.equal(row.control_at,time(4));assert.equal(row.maintenance_at,time(2));assert.equal(row.last_error,null);
});

test('work availability is sampled once and skips inactive kinds without consuming their turns',async t=>{
  const {repo}=fixture(t),calls=[],actions=hooks(calls);let snapshots=0,oldChecks=0;
  actions.availability=async()=>{snapshots++;return {mail:true,release:true};};actions.available=async()=>{oldChecks++;return true;};
  const stages=[];for(const minute of [1,3,5,7])stages.push((await runBackgroundLaneTick(repo,{},time(minute),'work',actions)).stage);
  assert.deepEqual(stages,['mail','release','mail','release']);assert.equal(snapshots,4);assert.equal(oldChecks,0);
  actions.availability=async()=>new Set();const idle=await runBackgroundLaneTick(repo,{},time(9),'work',actions);assert.equal(idle.stage,'idle');assert.deepEqual(calls,['mail','release','mail','release']);
});

test('the scheduler uses one returning claim and one fenced completion without an extra state read',async t=>{
  const {db,repo}=fixture(t),queries=[];repo.db={prepare(sql){queries.push(sql);return db.prepare(sql);}};
  assert.equal((await runBackgroundLaneTick(repo,{},time(0),'inbox',{inbox:async()=>({})})).stage,'inbox');
  assert.equal(queries.length,2);assert.match(queries[0],/^UPDATE background_lane_leases.*RETURNING \*/s);assert.match(queries[1],/WHERE lane=\? AND lease_token=\?/);
});

test('invalid lane and time fail before touching the database',async()=>{
  const repo={db:{prepare(){assert.fail('Invalid input must not query');}}};
  await assert.rejects(runBackgroundLaneTick(repo,{},time(0),'unknown',{}),/Invalid background lane/);
  await assert.rejects(runBackgroundLaneTick(repo,{},'invalid','work',{}),/Invalid background time/);
});

function config(){return readFileSync(new URL('../wrangler.example.toml',import.meta.url),'utf8').replace('00000000-0000-4000-8000-000000000000','11111111-1111-4111-8111-111111111111');}
const laneConfig=()=>config().replace('PDF_GENERATION_MODE = "browser"','PDF_GENERATION_MODE = "browser"\nBACKGROUND_EXECUTION_MODE = "staged"\nBACKGROUND_LANE_SCHEDULING = "true"').replace('crons = ["*/5 * * * *"]','crons = ["* * * * *", "*/2 * * * *", "1-59/2 * * * *"]');
test('setup accepts the exact three-lane schedules in any order, including multiline arrays and comments',()=>{
  const source=laneConfig();assert.equal(checkConfiguration(source).ok,true);
  const multiline=source.replace('crons = ["* * * * *", "*/2 * * * *", "1-59/2 * * * *"]','crons = [\n "1-59/2 * * * *", # work\n "* * * * *", # inbox\n "*/2 * * * *", # control\n]');
  const result=checkConfiguration(multiline);assert.equal(result.ok,true,JSON.stringify(result.errors));assert.equal(result.background_lanes,true);assert.equal(result.crons.length,3);
});
test('setup rejects missing, duplicate or wrong lane schedules and a lane flag without staged execution',()=>{
  const source=laneConfig();
  for(const bad of [source.replace(', "*/2 * * * *"',''),source.replace('"*/2 * * * *"','"* * * * *"'),source.replace('"1-59/2 * * * *"','"0-59/2 * * * *"'),source.replace('BACKGROUND_EXECUTION_MODE = "staged"','BACKGROUND_EXECUTION_MODE = "legacy"')])assert.equal(checkConfiguration(bad).ok,false);
  assert.equal(checkConfiguration(source.replace('MAIL_PROVIDER = "dry-run"','MAIL_PROVIDER = "resend"')).ok,false);
  assert.equal(checkConfiguration(source+'\n[triggers]\ncrons = ["* * * * *"]\n').ok,false);
});
test('setup preserves the legacy five-minute and single-lane staged configurations',()=>{
  assert.equal(checkConfiguration(config()).ok,true);
  const single=config().replace('PDF_GENERATION_MODE = "browser"','PDF_GENERATION_MODE = "browser"\nBACKGROUND_EXECUTION_MODE = "staged"').replace('crons = ["*/5 * * * *"]','crons = ["* * * * *"]');assert.equal(checkConfiguration(single).ok,true);
  assert.equal(checkConfiguration(single.replace('crons = ["* * * * *"]','crons = ["* * * * *", "*/2 * * * *"]')).ok,false);
});
