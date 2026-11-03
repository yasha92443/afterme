// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
// The original IDs remain the authority for votes, frozen rules and letters.
export const PEOPLE_BACKFILL_SQL=[
  `INSERT OR IGNORE INTO recipients(name,email,note,active,created_at,updated_at,locale)
   SELECT c.name,c.email,c.role,c.active,c.created_at,c.created_at,c.locale FROM contacts c
   WHERE NOT EXISTS(SELECT 1 FROM recipients r WHERE lower(trim(r.email))=lower(trim(c.email)))`,
  `INSERT OR IGNORE INTO people_links(contact_id,recipient_id,legacy_contact)
   SELECT c.id,r.id,1 FROM contacts c JOIN recipients r ON lower(trim(r.email))=lower(trim(c.email))`,
  `INSERT OR IGNORE INTO contacts(name,email,role,priority,can_release,token_hash,active,created_at,locale)
   SELECT r.name,r.email,'contact',100,0,'people-mirror:'||lower(hex(randomblob(32))),r.active,r.created_at,r.locale FROM recipients r
   WHERE NOT EXISTS(SELECT 1 FROM contacts c WHERE lower(trim(c.email))=lower(trim(r.email)))`,
  `INSERT OR IGNORE INTO people_links(contact_id,recipient_id,legacy_contact)
   SELECT c.id,r.id,0 FROM contacts c JOIN recipients r ON lower(trim(r.email))=lower(trim(c.email))`,
];
export async function ensurePeopleLinks(db){await db.batch(PEOPLE_BACKFILL_SQL.map(sql=>db.prepare(sql)));}

const projection=`SELECT p.contact_id AS id,p.contact_id,p.recipient_id,p.revision,
 c.name,c.email,c.locale,r.note,c.role,c.priority,c.name AS contact_name,r.name AS recipient_name,
 c.email AS contact_email,r.email AS recipient_email,c.locale AS contact_locale,r.locale AS recipient_locale,
 c.active AS contact_active,r.active AS recipient_active
 FROM people_links p JOIN contacts c ON c.id=p.contact_id JOIN recipients r ON r.id=p.recipient_id`;
const normalize=value=>String(value??'').trim().toLowerCase();
function error(status,code,current){return Object.assign(Error(code),{status,code,...(current?{current}: {})});}
function present(row){
  if(!row)return null;
  const conflicts=['name','locale','active'].filter(key=>row['contact_'+key]!==row['recipient_'+key]);
  if(normalize(row.contact_email)!==normalize(row.recipient_email))conflicts.push('email');
  return {...row,active:row.contact_active===row.recipient_active?row.contact_active:null,profile_conflicts:conflicts};
}
export async function listPeople(db){return {results:(await db.prepare(projection+' ORDER BY c.priority,c.id').all()).results.map(present)};}
export async function getPerson(db,id){return present(await db.prepare(projection+' WHERE p.contact_id=?').bind(id).first());}
async function bySide(db,side,id){return present(await db.prepare(projection+` WHERE p.${side==='contact'?'contact_id':'recipient_id'}=?`).bind(id).first());}
const fields=new Set(['name','email','note','locale','active','role','priority']);
export function validatePersonFields(input,{create=false,defaultLocale='zh'}={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw error(400,'invalid_person');
  const patch={};
  for(const key of fields)if(Object.hasOwn(input,key)){
    let value=input[key];
    if(['name','email','note','role'].includes(key)){
      if(typeof value!=='string')throw error(400,'invalid_person_'+key);
      if(key!=='note')value=value.trim();
      if(value.length>({name:200,email:320,note:4000,role:100}[key])||(['name','email'].includes(key)&&!value))throw error(400,'invalid_person_'+key);
      if(key==='email'){value=normalize(value);if(!/^[^\s@]+@[^\s@]+$/.test(value))throw error(400,'invalid_person_email');}
    }else if(key==='locale'){if(!['zh','en','ru'].includes(value))throw error(400,'invalid_person_locale');}
    else if(key==='active'){if(![true,false,0,1,'0','1','true','false','on','off'].includes(value))throw error(400,'invalid_person_active');value=[true,1,'1','true','on'].includes(value)?1:0;}
    else if(key==='priority'){value=Number(value);if(!Number.isSafeInteger(value)||value<1||value>100000)throw error(400,'invalid_person_priority');}
    patch[key]=value;
  }
  if(create){
    if(!patch.name||!patch.email)throw error(400,'person_name_email_required');
    return {note:'',locale:defaultLocale,active:1,role:'contact',priority:100,...patch};
  }
  return patch;
}
function databaseConflict(cause){if(/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(String(cause?.message||'')))throw error(409,'person_email_exists');throw cause;}
export async function createPerson(db,input,{tokenHash,now=new Date().toISOString(),defaultLocale='zh'}={}){
  const person=validatePersonFields(input,{create:true,defaultLocale});
  if(await db.prepare('SELECT 1 FROM contacts WHERE lower(trim(email))=? UNION ALL SELECT 1 FROM recipients WHERE lower(trim(email))=? LIMIT 1').bind(person.email,person.email).first())throw error(409,'person_email_exists');
  try{await db.batch([
    db.prepare('INSERT INTO contacts(name,email,role,priority,can_release,token_hash,active,locale,created_at) VALUES(?,?,?,?,0,?,?,?,?)').bind(person.name,person.email,person.role,person.priority,tokenHash||'people-new:'+crypto.randomUUID(),person.active,person.locale,now),
    db.prepare('INSERT INTO recipients(name,email,note,active,locale,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind(person.name,person.email,person.note,person.active,person.locale,now,now),
    db.prepare('INSERT INTO people_links(contact_id,recipient_id,legacy_contact) SELECT c.id,r.id,0 FROM contacts c JOIN recipients r ON lower(trim(r.email))=lower(trim(c.email)) WHERE lower(trim(c.email))=?').bind(person.email),
  ]);}catch(cause){databaseConflict(cause);}
  return present(await db.prepare(projection+' WHERE lower(trim(c.email))=?').bind(person.email).first());
}
export async function patchPerson(db,id,input,{expectedRevision,now=new Date().toISOString()}={}){
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw error(400,'expected_revision_required');
  const current=await getPerson(db,id);if(!current)throw error(404,'person_not_found');
  if(current.revision!==expectedRevision)throw error(409,'edit_conflict',current);
  const patch=validatePersonFields(input),contact={},recipient={};
  for(const [key,value] of Object.entries(patch)){
    if(['name','email','locale','active','role','priority'].includes(key)&&value!==current[['name','email','locale','active'].includes(key)?'contact_'+key:key])contact[key]=value;
    if(['name','email','locale','active','note'].includes(key)&&value!==current[['name','email','locale','active'].includes(key)?'recipient_'+key:key])recipient[key]=value;
  }
  const invalidates=Object.hasOwn(patch,'email')&&normalize(patch.email)!==normalize(current.contact_email)||patch.active===0;
  if(!Object.keys(contact).length&&!Object.keys(recipient).length&&!invalidates)return current;
  const marker=crypto.randomUUID(),guard='EXISTS(SELECT 1 FROM people_links WHERE contact_id=? AND write_token=?)';
  const statements=[db.prepare('UPDATE people_links SET write_token=? WHERE contact_id=? AND revision=?').bind(marker,id,expectedRevision)];
  if(Object.keys(contact).length)statements.push(db.prepare('UPDATE contacts SET '+Object.keys(contact).map(key=>key+'=?').join(',')+' WHERE id=? AND '+guard).bind(...Object.values(contact),id,id,marker));
  if(Object.keys(recipient).length)statements.push(db.prepare('UPDATE recipients SET '+Object.keys(recipient).map(key=>key+'=?').join(',')+',updated_at=? WHERE id=? AND '+guard).bind(...Object.values(recipient),now,current.recipient_id,id,marker));
  if(invalidates){
    statements.push(db.prepare('UPDATE contacts SET token_hash=?,verification_round=NULL,verification_thread_id=NULL,verification_issued_at=NULL,verification_expires_at=NULL WHERE id=? AND '+guard).bind('people-invalidated:'+crypto.randomUUID(),id,id,marker));
    statements.push(db.prepare('UPDATE verification_challenges SET used_at=COALESCE(used_at,?) WHERE contact_id=? AND '+guard).bind(Date.parse(now),id,id,marker));
  }
  statements.push(db.prepare('UPDATE people_links SET write_token=NULL WHERE contact_id=? AND write_token=?').bind(id,marker));
  let result;try{result=await db.batch(statements);}catch(cause){databaseConflict(cause);}
  const after=await getPerson(db,id);if(!result[0].meta?.changes)throw error(409,'edit_conflict',after);return after;
}
export async function patchLegacyPerson(db,side,id,input,{now=new Date().toISOString()}={}){
  // Legacy forms submit whole rows. Compare against their original side first,
  // so unchanged mixed locale/active/name values never synchronize the other side.
  let current=await bySide(db,side,id);
  if(!current){
    const table=side==='contact'?'contacts':'recipients';
    if(!await db.prepare('SELECT 1 FROM '+table+' WHERE id=?').bind(id).first())throw error(404,'person_not_found');
    await ensurePeopleLinks(db);current=await bySide(db,side,id);
  }
  if(!current)throw error(404,'person_not_found');
  const changed={};
  for(const key of fields)if(Object.hasOwn(input,key)){
    let value=input[key];
    const original=['name','email','locale','active'].includes(key)?current[side+'_'+key]:current[key];
    if(value===original)continue;
    if(key==='email'&&typeof value==='string'){if(normalize(original)===normalize(value))continue;}
    if(key==='active'&&[true,false,0,1,'0','1','true','false','on','off'].includes(value))value=[true,1,'1','true','on'].includes(value)?1:0;
    if(key==='priority')value=Number(value);
    if(original!==value)changed[key]=value;
  }
  return patchPerson(db,current.id,changed,{expectedRevision:input.expected_revision===undefined?current.revision:Number(input.expected_revision),now});
}
