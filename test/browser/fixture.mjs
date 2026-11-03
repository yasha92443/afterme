// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
// Loopback-only, disposable in-memory data. This fixture never uses provider credentials.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {loadWorkerForTests} from '../../scripts/load-worker-for-tests.mjs';
import {database} from '../helpers/database.js';
import {Repository} from '../../src/repository.js';
import {buildStoredPayload} from '../../src/content.js';
import {ensurePeopleLinks,listPeople} from '../../src/people.js';
import {defaultRules} from '../../src/settings.js';
import {runArtifactValidationStep} from '../../src/pdf-artifacts.js';
const {default:worker,AfterMeRuntime}=await loadWorkerForTests(process.env.AFTERME_TEST_RUNTIME==='durable-object'?'output/build-durable/durable-worker.js':'output/build/worker.js');
const base='http://127.0.0.1:8872',allow={async limit(){return {success:true};}};
let db,repo,env,ids,delays={},calls=[],pdfEnabled=false,validationTimer,validating=false;
async function reset({people:withPeople=false,pdfSmall=false}={}){
  clearInterval(validationTimer);validationTimer=null;db?.close();db=database({through:24});repo=new Repository(db);delays={};calls=[];pdfEnabled=false;
  env={DB:db,ADMIN_TOKEN:'synthetic-browser-admin',CONTENT_ENCRYPTION_KEY:'synthetic-browser-key',MAIL_PROVIDER:'dry-run',INBOUND_PROVIDER:'web',BASE_URL:base,PDF_GENERATION_MODE:'browser',LOGIN_LIMITER:allow,VERIFY_LIMITER:allow,API_LIMITER:allow,READ_LIMITER:allow,EXPENSIVE_LIMITER:allow,
    PDF_FONTS:{async fetch(request){const path=new URL(request.url).pathname;if(!['/browser/pdf-client.js','/browser/pdf-worker.js','/fonts/afterme-song-sc.ttf'].includes(path))return new Response('Not found',{status:404});return new Response(readFileSync(new URL('../../assets'+path,import.meta.url)));}},
  };
  if(AfterMeRuntime){env.EXECUTION_RUNTIME='durable-object';const object=new AfterMeRuntime({},env);env.APP_RUNTIME={getByName(){return object;}};}
  const now=new Date().toISOString();await repo.setupOwner({displayName:'Synthetic owner',email:'owner@example.invalid',now});await repo.getSettings(env);await repo.getRoundRules(await repo.getOwner());
  const recipient=await repo.createRecipient({name:'Synthetic recipient',email:'recipient@example.invalid',now});
  const payload=await buildStoredPayload({body:{plaintext:'Private fixture letter'},env});
  const letter=await repo.createEncryptedItem({kind:'letter',title:'Private',recipientId:recipient,encryptedPayload:payload,payloadSize:payload.length,vaultToken:'fixture-vault',vaultTokenHash:'fixture-hash',updatedAt:now});
  let peopleSeed;
  if(withPeople){
    // Seed the old tables deliberately. Contact and recipient IDs differ, and
    // mixed legacy rows remain distinct until a user explicitly edits a field.
    const contactOnly=await repo.createContact({name:'Zeta legacy confirmer',email:'contact-only@example.invalid',role:'friend',priority:1,tokenHash:'synthetic-contact-only'});
    const primary=await repo.createContact({name:'Synthetic recipient',email:'recipient@example.invalid',role:'friend',priority:2,tokenHash:'synthetic-primary'});
    const mixed=await repo.createContact({name:'Mixed contact name',email:'mixed@example.invalid',role:'friend',priority:3,tokenHash:'synthetic-mixed'});
    const reverseMixed=await repo.createContact({name:'Reverse inactive contact',email:'reverse-mixed@example.invalid',role:'friend',priority:4,tokenHash:'synthetic-reverse-mixed'});
    await repo.createRecipient({name:'Recipient only',email:'recipient-only@example.invalid',now});
    const mixedRecipient=await repo.createRecipient({name:'Mixed recipient name',email:'mixed@example.invalid',now});
    await db.prepare("UPDATE recipients SET active=0,locale='ru' WHERE id=?").bind(mixedRecipient).run();
    await repo.createRecipient({name:'Reverse active recipient',email:'reverse-mixed@example.invalid',now});
    await db.prepare("UPDATE contacts SET active=0,locale='ru' WHERE id=?").bind(reverseMixed).run();
    const legacyPayload=await buildStoredPayload({body:{plaintext:'Legacy contact-bound fixture letter'},env});
    const contactLetter=await repo.createEncryptedItem({kind:'letter',title:'Legacy contact letter',encryptedPayload:legacyPayload,payloadSize:legacyPayload.length,vaultToken:'synthetic-legacy-contact',vaultTokenHash:'synthetic-legacy-hash',updatedAt:now});
    await db.prepare('UPDATE encrypted_items SET recipient_contact_id=? WHERE id=?').bind(contactOnly,contactLetter).run();
    const mixedPayload=await buildStoredPayload({body:{plaintext:'Original mixed contact letter'},env});
    const mixedContactLetter=await repo.createEncryptedItem({kind:'letter',title:'Mixed legacy contact letter',encryptedPayload:mixedPayload,payloadSize:mixedPayload.length,vaultToken:'synthetic-mixed-contact',vaultTokenHash:'synthetic-mixed-hash',updatedAt:now});
    await db.prepare('UPDATE encrypted_items SET recipient_contact_id=? WHERE id=?').bind(mixed,mixedContactLetter).run();
    const settings=await repo.getSettings(env),rules=defaultRules([contactOnly,primary]);rules.private.quorum=2;rules.public.quorum=2;rules.public.audience=['recipient:'+recipient];
    await repo.saveSettings({revision:settings.revision,preferences:settings.preferences,rules,now});await repo.checkin(now);
    peopleSeed={primary,contactOnly,mixed,reverseMixed,contactLetter,mixedContactLetter};
  }
  const groups=[];let entry;
  for(let i=0;i<(pdfSmall?1:52);i++){const groupId=await repo.farewell.createGroup({title:'Chapter '+(i+1),now});groups.push(groupId);for(let j=0;j<(pdfSmall?3:i===0?55:1);j++){const id=await repo.farewell.createEntry({groupId,body:'Entry '+(j+1),isPublic:true,now});if(i===0&&j===0)entry=id;}}
  await repo.farewell.applyDraft({now});
  const trashGroups=[],trashEntries=[];
  for(let i=0;i<55;i++){const g=await repo.farewell.createGroup({title:'Deleted chapter '+i,now}),e=await repo.farewell.createEntry({groupId:groups[0],body:'Deleted entry '+i,isPublic:true,now});await repo.farewell.setTrashed({kind:'group',id:g,trashed:true,now});await repo.farewell.setTrashed({kind:'entry',id:e,trashed:true,now});trashGroups.push(g);trashEntries.push(e);}
  await ensurePeopleLinks(db);
  ids={groups,entry,letter,trashGroups,trashEntries};
  if(peopleSeed){const directory=(await listPeople(db)).results;ids.people={primary:directory.find(person=>person.id===peopleSeed.primary),contact_only:directory.find(person=>person.id===peopleSeed.contactOnly),mixed:directory.find(person=>person.id===peopleSeed.mixed),reverse_mixed:directory.find(person=>person.id===peopleSeed.reverseMixed),contact_letter:peopleSeed.contactLetter,mixed_contact_letter:peopleSeed.mixedContactLetter};}
  return ids;
}
await reset();
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,base),chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);
    if(url.pathname.startsWith('/__fixture/')){
      let data={};if(bytes.length)data=JSON.parse(bytes.toString('utf8'));
      let result;
      if(url.pathname==='/__fixture/ready')result={ready:true};
      else if(url.pathname==='/__fixture/reset')result=await reset({people:data.people===true,pdfSmall:data.pdfSmall===true});
      else if(url.pathname==='/__fixture/delays'){delays=data;result={ok:true};}
      else if(url.pathname==='/__fixture/pdf'){
        pdfEnabled=Boolean(data.enabled);
        if(data.staged){
          env.BACKGROUND_EXECUTION_MODE='staged';
          clearInterval(validationTimer);
          validationTimer=setInterval(async()=>{
            if(validating)return;validating=true;
            try{const row=await db.prepare("SELECT id FROM pdf_artifacts WHERE status='pending' AND validation_state='validating' ORDER BY updated_at,id LIMIT 1").first();if(row)await runArtifactValidationStep(repo,env,{artifact_id:row.id},new Date().toISOString());}
            catch(error){console.error('Synthetic validation failed',error.message);}
            finally{validating=false;}
          },100);
        }
        result={ok:true};
      }
      else if(url.pathname==='/__fixture/state')result={ids,calls,entry:await repo.farewell.getEntry(ids.entry),versions:await repo.farewell.getVersions(),inbound:await db.prepare("SELECT status,reconciliation_note FROM inbound_mail_log WHERE gmail_message_id='synthetic-inbound'").first()};
      else if(url.pathname==='/__fixture/inbound'){await db.prepare("INSERT INTO inbound_mail_log(gmail_message_id,status,subject,processed_at,confirmation_round,source) VALUES('synthetic-inbound','failed',?, ?, (SELECT confirmation_round FROM owner WHERE id=1),'gmail')").bind('<img src=x onerror=alert(1)> Synthetic inbound',new Date().toISOString()).run();result={ok:true};}
      else if(url.pathname==='/__fixture/edit'){result=await repo.farewell.saveEntryDraft({id:ids.entry,body:data.body,groupId:ids.groups[0],isPublic:true,now:new Date().toISOString()});}
      else {res.writeHead(404);res.end();return;}
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result));return;
    }
    const call={path:url.pathname,method:req.method,start:Date.now(),end:null};calls.push(call);
    const delay=delays[req.method+' '+url.pathname]??delays[url.pathname]??0;if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    let response;
    if(!pdfEnabled&&url.pathname==='/api/pdf-artifacts/targets')response=Response.json({results:[],next_cursor:null});
    else if(!pdfEnabled&&url.pathname==='/api/pdf-artifacts'&&req.method==='POST')response=Response.json({status:'ready',id:'synthetic-ready'});
    else {
      response=await worker.fetch(new Request(base+req.url,{method:req.method,headers:req.headers,body:bytes.length?bytes:undefined}),env);
    }
    call.end=Date.now();call.status=response.status;
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'fixture_failure',message:error.message}));console.error(error);}
});
server.listen(8872,'127.0.0.1',()=>console.log('Synthetic browser fixture ready on '+base));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(validationTimer);server.close(()=>{db?.close();process.exit(0);});});
