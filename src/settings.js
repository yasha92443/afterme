// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
export const PRESETS = Object.freeze({ short: [24,48,96,72], current: [48,72,120,72], long: [72,120,168,168] });
export const DEFAULT_PREFERENCES = Object.freeze({ locale:'zh', timezone:'Asia/Shanghai', theme:'night', font_size:18, pdf_style:'night', selfcheck:true, backup_reminder_days:30, daily_email_limit:20 });
export function defaultRules(ids = []) {
  return { overdue_hours:48, alert_hours:72, verify_hours:120,
    private:{enabled:true,contact_ids:[...ids],quorum:3,grace_hours:72},
    public:{enabled:true,contact_ids:[...ids],quorum:3,grace_hours:72,web:true,pdf:true,audience:ids.map(id=>'contact:'+id)} };
}
export function presetRules(name, rules) {
  const p=PRESETS[name]; if(!p) throw new Error('Unknown preset');
  return {...rules,overdue_hours:p[0],alert_hours:p[1],verify_hours:p[2],private:{...rules.private,grace_hours:p[3]},public:{...rules.public,grace_hours:p[3]}};
}
function bad(message) { const e=new Error(message); e.status=400; throw e; }
function integer(value,min,max,name) { if(!Number.isInteger(value)||value<min||value>max) bad(`${name}: ${min}–${max}`); return value; }
function bool(value,name) { if(typeof value!=='boolean') bad(`${name}: boolean required`); return value; }
function ids(value,name) { if(!Array.isArray(value)||value.length>100||value.some(v=>!Number.isSafeInteger(v)||v<1)||new Set(value).size!==value.length) bad(`${name}: invalid IDs`); return [...value]; }
export function validateRules(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)) bad('rules required');
  const r={};
  for(const key of ['overdue_hours','alert_hours','verify_hours']) r[key]=integer(value[key],1,8760,key);
  if(!(r.overdue_hours<r.alert_hours&&r.alert_hours<r.verify_hours)) bad('Time thresholds must increase / 时间节点必须递增');
  for(const key of ['private','public']) {
    const c=value[key]; if(!c||typeof c!=='object') bad(`${key} required`);
    r[key]={enabled:bool(c.enabled,key),contact_ids:ids(c.contact_ids,key),quorum:integer(c.quorum,1,100,'quorum'),grace_hours:integer(c.grace_hours,0,8760,'grace_hours')};
    if(key==='public') {
      r[key].web=bool(c.web,'web'); r[key].pdf=bool(c.pdf,'pdf');
      if(!Array.isArray(c.audience)||c.audience.length>200||c.audience.some(v=>typeof v!=='string'||! /^(contact|recipient):[1-9]\d*$/.test(v))||new Set(c.audience).size!==c.audience.length) bad('Invalid public audience');
      r[key].audience=[...c.audience];
    }
  }
  return r;
}
export function validatePreferences(value,cap=20) {
  if(!value||typeof value!=='object'||Array.isArray(value)) bad('preferences required');
  const p={...DEFAULT_PREFERENCES,...value};
  if(!['zh','en','ru'].includes(p.locale)||!['night','paper','contrast','system'].includes(p.theme)||!['night','paper'].includes(p.pdf_style)) bad('Invalid language/theme');
  if(typeof p.timezone!=='string'||p.timezone.length>100) bad('Invalid timezone');
  try {new Intl.DateTimeFormat('en',{timeZone:p.timezone}).format();} catch {bad('Invalid timezone');}
  integer(p.font_size,14,24,'font_size'); integer(p.backup_reminder_days,1,365,'backup_reminder_days');
  integer(p.daily_email_limit,1,cap,'daily_email_limit'); bool(p.selfcheck,'selfcheck');
  return Object.fromEntries(Object.keys(DEFAULT_PREFERENCES).map(k=>[k,p[k]]));
}
export function sensitiveChange(active,next) { return ['private','public'].some(k=>next[k].quorum<active[k].quorum||next[k].grace_hours<active[k].grace_hours); }
export function previewRules(rules,anchor,contacts=[],cap=20,limit=cap) {
  const r=validateRules(rules); const start=Date.parse(anchor); if(!Number.isFinite(start)) bad('Invalid anchor');
  const timeline=Object.fromEntries(['overdue_hours','alert_hours','verify_hours'].map(k=>[k,new Date(start+r[k]*3600000).toISOString()]));
  const warnings=[],issues=[];
  for(const k of ['private','public']) {
    const c=r[k], available=c.contact_ids.filter(id=>contacts.some(contact=>contact.id===id&&contact.active)).length;
    if(c.enabled&&available<c.quorum)issues.push({channel:k,code:'insufficient',available,quorum:c.quorum});
    if(c.enabled&&(c.quorum===1||c.grace_hours===0))issues.push({channel:k,code:'risk'});
    if(c.enabled&&available<c.quorum) warnings.push(`${k}: ${available}/${c.quorum} contacts; release blocked`);
    if(c.enabled&&(c.quorum===1||c.grace_hours===0)) warnings.push(`${k}: ${c.quorum} confirmation(s), ${c.grace_hours}h buffer; release may be immediate`);
  }
  if(limit>cap) warnings.push('Deployment mail cap exceeded');
  return {timeline,warnings,issues,scheduler_interval_hours:1,mail_cap:cap};
}
