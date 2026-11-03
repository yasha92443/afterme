// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {inboxGenerationFresh,inboxOperationallyHealthy} from '../src/background-scheduler.js';

const anchor=Date.parse('2030-01-01T00:00:00.000Z'),at=minute=>new Date(anchor+minute*60000).toISOString(),round=4;
const scanning=(extra={})=>({v:2,round,generation_id:'synthetic-current',started_at:at(2),phase:'detail',status:'scanning',closed:false,completed_at:null,provider_verified_at:at(2),observed_at:at(2),backlog:false,incomplete:false,...extra});
const healthy=(extra={})=>scanning({phase:'closed',status:'healthy',closed:true,started_at:at(0),completed_at:at(1),observed_at:at(1),provider_verified_at:at(1),...extra});

test('an actively progressing scan can be operationally healthy while final delivery stays blocked',()=>{
  for(const phase of ['list','detail','apply']){
    const state=scanning({phase});assert.equal(inboxOperationallyHealthy(state,round,at(3)),true,phase);assert.equal(inboxGenerationFresh(state,round,at(3)),false,phase);
  }
});
test('normal closed-generation idle time does not produce a two-to-three-minute health outage',()=>{
  const state=healthy();for(const minute of [1,2,3,3.5,4]){assert.equal(inboxOperationallyHealthy(state,round,at(minute)),true,String(minute));assert.equal(inboxGenerationFresh(state,round,at(minute)),true);}
  assert.equal(inboxOperationallyHealthy(state,round,at(5.01)),false,'a closed but stale generation still cannot stay healthy forever');
});
test('a new bootstrap may inherit recent same-round provider proof but cannot manufacture one',()=>{
  const state=scanning({started_at:at(4),observed_at:at(4),phase:'list',provider_verified_at:at(1)});
  assert.equal(inboxOperationallyHealthy(state,round,at(4)),true);assert.equal(inboxGenerationFresh(state,round,at(4)),false);
  assert.equal(inboxOperationallyHealthy({...state,provider_verified_at:undefined},round,at(4)),false);
  assert.equal(inboxOperationallyHealthy({...state,round:round-1},round,at(4)),false);
  assert.equal(inboxOperationallyHealthy({...state,provider_verified_at:at(-2)},round,at(4)),false);
});
test('ordinary list-detail-apply cycles preserve service health without granting readiness to the next scan',()=>{
  const timeline=[
    scanning({started_at:at(1),provider_verified_at:at(1),observed_at:at(1)}),
    scanning({started_at:at(1),provider_verified_at:at(2),observed_at:at(2),phase:'apply'}),
    healthy({started_at:at(1),completed_at:at(3),provider_verified_at:at(2),observed_at:at(3)}),
  ];
  for(const minute of [4,5])timeline.push(timeline[2]);
  timeline.push(scanning({started_at:at(6),provider_verified_at:at(2),observed_at:at(6),phase:'list'}));
  timeline.push(scanning({started_at:at(7),provider_verified_at:at(7),observed_at:at(7)}));
  timeline.push(scanning({started_at:at(7),provider_verified_at:at(8),observed_at:at(8),phase:'apply'}));
  timeline.push(healthy({started_at:at(7),completed_at:at(9),provider_verified_at:at(8),observed_at:at(9)}));
  for(let index=0;index<timeline.length;index++){
    assert.equal(inboxOperationallyHealthy(timeline[index],round,at(index+1)),true,'minute '+(index+1));
    assert.equal(inboxGenerationFresh(timeline[index],round,at(index+1)),timeline[index].status==='healthy','readiness at minute '+(index+1));
  }
});
test('real provider recency and independent scan progress are both required',()=>{
  assert.equal(inboxOperationallyHealthy(scanning(),round,at(4)),true,'the two-minute progress boundary is inclusive');
  assert.equal(inboxOperationallyHealthy(scanning(),round,at(4.01)),false,'a stalled phase cannot rely on an older network success');
  assert.equal(inboxOperationallyHealthy(scanning({provider_verified_at:at(-3.01)}),round,at(2)),false,'generic phase progress cannot refresh provider evidence');
  assert.equal(inboxOperationallyHealthy(scanning({started_at:at(-3.01)}),round,at(2)),false,'an overlong generation remains unhealthy');
  assert.equal(inboxOperationallyHealthy(scanning({provider_verified_at:at(2.1)}),round,at(2)),false,'future provider evidence is invalid');
  assert.equal(inboxOperationallyHealthy(scanning({observed_at:at(2.1)}),round,at(2)),false,'future progress is invalid');
  assert.equal(inboxOperationallyHealthy(scanning({provider_verified_at:at(3),observed_at:at(2)}),round,at(3)),false,'provider proof cannot postdate its persisted progress');
});
test('failures, backlog, incomplete parsing and unresolved inbound records remain visible',()=>{
  for(const status of ['failed','degraded','not-configured','unknown'])assert.equal(inboxOperationallyHealthy(scanning({status}),round,at(2)),false,status);
  for(const field of ['backlog','incomplete'])for(const value of [true,undefined,'false'])assert.equal(inboxOperationallyHealthy(scanning({[field]:value}),round,at(2)),false,field+' '+value);
  for(const state of [scanning(),healthy()])assert.equal(inboxOperationallyHealthy(state,round,at(2),{blocked:true}),false);
  assert.equal(inboxOperationallyHealthy(scanning({provider_failed:true,observed_at:at(3)}),round,at(3)),false,'starting a retry must not erase a known provider failure');
  assert.equal(inboxOperationallyHealthy(scanning({provider_failed:false,provider_verified_at:at(3),observed_at:at(3)}),round,at(3)),true,'a later verified provider success can recover the provider path');
  assert.equal(inboxOperationallyHealthy(healthy({provider_failed:true}),round,at(2)),false,'a fresh previous generation cannot hide a later provider failure');
});
test('malformed, wrong-round and inconsistent scan metadata fail closed',()=>{
  for(const value of [null,[],{},scanning({generation_id:''}),scanning({round:round-1}),scanning({closed:true}),scanning({phase:'idle'}),scanning({started_at:at(3)})])assert.equal(inboxOperationallyHealthy(value,round,at(2)),false);
  assert.equal(inboxOperationallyHealthy(scanning(),undefined,at(2)),false);assert.equal(inboxOperationallyHealthy(scanning(),round,'invalid'),false);
  assert.equal(inboxOperationallyHealthy(healthy({completed_at:at(-1)}),round,at(2)),false,'healthy status cannot bypass complete-generation ordering');
});
