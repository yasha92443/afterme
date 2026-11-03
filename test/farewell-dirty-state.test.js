// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {farewellEditorScript} from '../src/farewell-editor-ui.js';

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function editor({values=['A'],hooks=true,submit}={}){
  const listeners=new Map(),timers=new Map(),baselines=new WeakMap(),submissions=[],checkpoints=[];
  let serial=0,dirtyCount=0;
  const status={textContent:''},pending={textContent:'',classList:{add(){}}},retry={hidden:true,addEventListener(){}};
  const forms=values.map((value,i)=>{
    const form={dataset:{kind:'entry'},action:'https://example.test/api/public-farewell-v2/entries/'+(i+1),elements:{body:{value}},isConnected:true};
    form.elements.body.name='body';form.elements.body.closest=selector=>selector.includes('farewell-autosave')?form:null;return form;
  });
  const root={dataset:{},isConnected:true,inert:false,
    querySelectorAll(selector){return selector.startsWith('form.farewell-autosave')?forms:[];},
    querySelector(selector){return selector==='#farewell-autosave'?status:selector==='#farewell-pending'?pending:selector==='[data-retry-save]'?retry:selector==='.farewell-mobile-tabs'?{addEventListener(){}}:null;},
    addEventListener(type,handler){const callbacks=listeners.get(type)||[];callbacks.push(handler);listeners.set(type,callbacks);},
  };
  const snapshot=form=>JSON.stringify(form.elements.body.value);
  const window={addEventListener(){},aftermeDirtyStatus(){dirtyCount=forms.filter(form=>form.dataset.dirty==='1').length;},async aftermeSubmit(form){const value=form.elements.body.value;submissions.push(value);return submit?submit(form,value):{response:{ok:true},result:{ok:true,changed:true}};}};
  if(hooks)Object.assign(window,{aftermeRegisterForm(form){if(!baselines.has(form))baselines.set(form,snapshot(form));},aftermeFormSnapshot:snapshot,aftermeFormChanged(form){return snapshot(form)!==baselines.get(form);},aftermeFormSaved(form,sent){baselines.set(form,sent);checkpoints.push(sent);}});
  const context={window,document:{getElementById(){return root;},querySelector(){return null;}},matchMedia:()=>({matches:false}),setTimeout(callback){timers.set(++serial,callback);return serial;},clearTimeout(id){timers.delete(id);}};
  runInNewContext(farewellEditorScript(),context);
  return {forms,status,retry,timers,submissions,checkpoints,get dirtyCount(){return dirtyCount;},change(index,value){const form=forms[index];form.elements.body.value=value;for(const callback of listeners.get('input')||[])callback({target:form.elements.body});},flush:()=>window.aftermeDraftFlush()};
}

test('reverting an unsent autosave cancels its timer without clearing another dirty form',async()=>{
  const state=editor({values:['A','X']});state.change(0,'B');state.change(1,'Y');state.change(0,'A');
  assert.equal(state.forms[0].dataset.unsaved,undefined);assert.equal(state.forms[1].dataset.unsaved,'1');assert.equal(state.dirtyCount,1);assert.equal(state.timers.size,1);
  await state.flush();assert.deepEqual(state.submissions,['Y']);assert.equal(state.dirtyCount,0);assert.equal(state.forms[1].dataset.unsaved,undefined);
});

test('a revert during an in-flight autosave is persisted after the submitted value',async()=>{
  const first=deferred(),started=deferred();let stored='A',count=0;
  const state=editor({submit:async(_form,value)=>{if(++count===1){started.resolve();await first.promise;}stored=value;return {response:{ok:true},result:{ok:true,changed:true}};}});
  state.change(0,'B');const saving=state.flush();await started.promise;state.change(0,'A');assert.equal(state.forms[0].dataset.unsaved,'1');
  first.resolve();await saving;assert.deepEqual(state.submissions,['B','A']);assert.equal(stored,'A');assert.deepEqual(state.checkpoints,['"B"','"A"']);assert.equal(state.dirtyCount,0);
});

test('failed autosave does not checkpoint or cancel a possibly persisted change when reverted',async()=>{
  let stored='A',failed=true;
  const state=editor({submit:async(_form,value)=>{stored=value;if(failed){failed=false;throw Error('Synthetic response lost');}return {response:{ok:true},result:{ok:true,changed:true}};}});
  state.change(0,'B');await assert.rejects(state.flush(),/Synthetic/);assert.equal(stored,'B');assert.equal(state.checkpoints.length,0);assert.equal(state.forms[0].dataset.unsaved,'1');assert.equal(state.retry.hidden,false);
  state.change(0,'A');assert.equal(state.forms[0].dataset.unsaved,'1');await state.flush();assert.equal(stored,'A');assert.deepEqual(state.submissions,['B','A']);assert.equal(state.dirtyCount,0);
});

test('standalone legacy editor remains compatible when dashboard hooks are absent',async()=>{
  const state=editor({hooks:false});state.change(0,'B');assert.equal(state.forms[0].dataset.unsaved,'1');await state.flush();assert.deepEqual(state.submissions,['B']);assert.equal(state.forms[0].dataset.unsaved,undefined);assert.equal(state.dirtyCount,0);
});

function localForm(kind,action,fields){
  const elements=fields.map(field=>({type:'text',disabled:false,readOnly:false,...field}));
  elements.namedItem=name=>elements.find(field=>field.name===name)||null;
  for(const field of elements)elements[field.name]=field;
  const form={dataset:{},elements,action,isConnected:true,getAttribute:name=>name==='action'?action:null,matches:selector=>selector.split(',').some(part=>part.trim().endsWith('.'+kind))};
  for(const field of elements)field.closest=selector=>form.matches(selector)?form:null;
  return form;
}
const newGroup=()=>localForm('farewell-create-group','/api/public-farewell-v2/groups',[{name:'title',value:''},{name:'admin_token',value:'fresh-credential',type:'hidden'}]);
function localEditor({forms=[newGroup()],hooks=true,legacy=false,submit}={}){
  const baselines=new WeakMap(),registered=[],submissions=[];let root,nextLegacy;
  function makeRoot(currentForms){
    const listeners=new Map(),status={textContent:''},pending={classList:{add(){}}},retry={hidden:true,addEventListener(){}};
    return {forms:currentForms,listeners,dataset:{embedded:legacy?'0':'1',selectedGroup:'1'},isConnected:true,inert:false,status,
      querySelectorAll:selector=>currentForms.filter(form=>form.matches(selector)),
      querySelector:selector=>selector==='#farewell-autosave'?status:selector==='#farewell-pending'?pending:selector==='[data-retry-save]'?retry:selector==='.farewell-mobile-tabs'?{addEventListener(){}}:null,
      addEventListener(type,handler){const handlers=listeners.get(type)||[];handlers.push(handler);listeners.set(type,handlers);},
      replaceWith(next){this.isConnected=false;root=next;},
    };
  }
  const values=form=>JSON.stringify([...form.elements].filter(field=>field.type!=='hidden').map(field=>[field.name,field.value,field.checked,field.indeterminate]));
  const window={addEventListener(){},aftermeDirtyStatus(){},aftermeBindFields(){},aftermeReviewApply:async()=>true,
    async aftermeSubmit(form){submissions.push(form.action);return submit?submit(form):{response:{ok:true},result:{ok:true,id:12,formal_revision:1}};},
    async aftermeLoadFarewell(){redraw([newGroup()]);return true;},
  };
  if(hooks)Object.assign(window,{aftermeRegisterForm(form){if(!baselines.has(form)){baselines.set(form,values(form));registered.push([form,values(form)]);}},aftermeFormSnapshot:values,aftermeFormChanged(form){return values(form)!==baselines.get(form);},aftermeFormSaved(form){baselines.set(form,values(form));}});
  root=makeRoot(forms);
  const document={getElementById:()=>root,querySelector:()=>null};
  const context={window,document,matchMedia:()=>({matches:false}),setTimeout(){},clearTimeout(){},fetch:async()=>({ok:true,text:async()=>''}),DOMParser:class{parseFromString(){return {getElementById:()=>nextLegacy,querySelector:()=>null};}}};
  runInNewContext(farewellEditorScript(),context);
  function redraw(nextForms){window.aftermeCaptureFarewellForms(root);root.isConnected=false;root=makeRoot(nextForms);window.bindFarewellEditor();return root;}
  return {window,baselines,registered,submissions,get root(){return root;},redraw,
    change(form,name,value){const field=form.elements.namedItem(name);field.value=value;for(const handler of root.listeners.get('input')||[])handler({target:field});},
    async submit(form){const event={target:{closest:selector=>form.matches(selector)?form:null},submitter:{disabled:false},preventDefault(){}};for(const handler of root.listeners.get('submit')||[])await handler(event);},
    prepareLegacy(nextForms){nextLegacy=makeRoot(nextForms);},
  };
}

test('unsubmitted new group title survives redraws, registers its clean baseline first, and clears when reverted',()=>{
  const first=newGroup(),state=localEditor({forms:[first]});state.change(first,'title','LOCAL <title> remains a value');assert.equal(first.dataset.unsaved,'1');
  const next=newGroup();next.elements.admin_token.value='replacement-credential';state.redraw([next]);
  assert.equal(next.elements.title.value,'LOCAL <title> remains a value');assert.equal(next.elements.admin_token.value,'replacement-credential');assert.equal(next.dataset.dirty,'1');assert.equal(state.window.aftermeFormChanged(next),true);
  assert.equal(JSON.parse(state.baselines.get(next))[0][1],'');
  state.change(next,'title','');assert.equal(next.dataset.unsaved,undefined);assert.equal(state.window.aftermeFormChanged(next),false);
  const last=newGroup();state.redraw([last]);assert.equal(last.elements.title.value,'');assert.equal(last.dataset.dirty,undefined);
});

test('hidden entry body, routing fields, and credentials never become local form drafts',()=>{
  const entry=localForm('farewell-create-entry','/api/public-farewell-v2/entries',[{name:'group_id',type:'hidden',value:'1'},{name:'body',type:'hidden',value:'SERVER DEFAULT'},{name:'csrf',type:'hidden',value:'old-csrf'},{name:'admin_token',value:'old-visible-credential'}]);
  const state=localEditor({forms:[entry]});entry.elements.body.value='DO NOT RESTORE';entry.elements.group_id.value='99';entry.elements.admin_token.value='DO NOT RETAIN';
  const next=localForm('farewell-create-entry',entry.action,[{name:'group_id',type:'hidden',value:'99'},{name:'body',type:'hidden',value:'NEW SERVER DEFAULT'},{name:'csrf',type:'hidden',value:'new-csrf'},{name:'admin_token',value:'new-visible-credential'}]);state.redraw([next]);
  assert.equal(next.elements.body.value,'NEW SERVER DEFAULT');assert.equal(next.elements.csrf.value,'new-csrf');assert.equal(next.elements.admin_token.value,'new-visible-credential');assert.equal(next.dataset.unsaved,undefined);
});

test('editable future create-entry fields stay scoped to their target group across lazy redraws',()=>{
  const entry=group=>localForm('farewell-create-entry','/api/public-farewell-v2/entries',[{name:'group_id',type:'hidden',value:String(group)},{name:'body',type:'textarea',value:''}]);
  const first=entry(1),state=localEditor({forms:[first]});state.change(first,'body','GROUP ONE INPUT');const second=entry(2);state.redraw([second]);assert.equal(second.elements.body.value,'');
  state.change(second,'body','GROUP TWO INPUT');const restored=entry(1);state.redraw([restored]);assert.equal(restored.elements.body.value,'GROUP ONE INPUT');assert.equal(restored.elements.group_id.value,'1');assert.equal(restored.dataset.unsaved,'1');
});

test('successful create clears only the submitted form so its title does not revive on later redraws',async()=>{
  const group=newGroup(),command=localForm('farewell-command','/api/public-farewell-v2/groups/1/reorder',[{name:'direction',type:'hidden',value:'up'},{name:'note',value:''}]);
  const state=localEditor({forms:[group,command]});state.change(group,'title','NEW GROUP TO CREATE');state.change(command,'note','OTHER UNCOMMITTED INPUT');await state.submit(group);
  assert.deepEqual(state.submissions,['/api/public-farewell-v2/groups']);assert.equal(state.root.forms[0].elements.title.value,'');assert.equal(group.dataset.unsaved,undefined);
  const nextGroup=newGroup(),nextCommand=localForm('farewell-command',command.action,[{name:'direction',type:'hidden',value:'up'},{name:'note',value:''}]);state.redraw([nextGroup,nextCommand]);
  assert.equal(nextGroup.elements.title.value,'');assert.equal(nextCommand.elements.note.value,'OTHER UNCOMMITTED INPUT');assert.equal(nextCommand.dataset.unsaved,'1');
});

test('failed create keeps the unsaved title through a later redraw',async()=>{
  const group=newGroup(),state=localEditor({forms:[group],submit:async()=>{throw Error('Synthetic create failure');}});state.change(group,'title','KEEP FAILED CREATE');await state.submit(group);
  assert.match(state.root.status.textContent,/Synthetic create failure/);assert.equal(group.elements.title.value,'KEEP FAILED CREATE');assert.equal(group.dataset.unsaved,'1');assert.equal(state.root.inert,false);
  const next=newGroup();state.redraw([next]);assert.equal(next.elements.title.value,'KEEP FAILED CREATE');assert.equal(next.dataset.unsaved,'1');
});

test('legacy refresh preserves an unsubmitted group title without dashboard hooks',async()=>{
  const group=newGroup(),command=localForm('farewell-command','/api/public-farewell-v2/apply',[]),state=localEditor({forms:[group,command],hooks:false,legacy:true});state.change(group,'title','LEGACY UNSUBMITTED TITLE');
  const next=newGroup();state.prepareLegacy([next]);await state.submit(command);
  assert.equal(state.root.forms[0],next);assert.equal(next.elements.title.value,'LEGACY UNSUBMITTED TITLE');assert.equal(next.dataset.unsaved,'1');assert.equal(next.dataset.dirty,'1');
});
