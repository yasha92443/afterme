// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {readFileSync,lstatSync,realpathSync,existsSync,readdirSync,statSync} from 'node:fs';
import {resolve,relative,sep,dirname,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {inventory} from './dependency-licenses.mjs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

export const forbiddenPath=/(^|\/)(?:\.git|node_modules|output|\.wrangler|\.backups|tmp[^/]*)(?:\/|$)|(?:^|\/)(?:wrangler\.toml|\.env(?:\..*)?|\.dev\.vars(?:\..*)?|client_secret_[^/]+\.json)$|\.(?:local(?:\.json)?|log|pid|sqlite(?:-.*)?|db(?:-.*)?|pdf)$/i;

export function findingsFor(path,buffer){
  if(path==='assets/fonts/afterme-song-sc.ttf')return [];
  const text=buffer.toString('utf8'),findings=[];
  const add=(rule,index=0)=>findings.push({path,rule,line:text.slice(0,index).split('\n').length});
  if(forbiddenPath.test(path))add('private-file-path');
  const rules=[
    ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
    ['provider-token',/(?:["'\s])(?:GOCSPX-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|1\/\/[A-Za-z0-9_-]{30,}|re_[A-Za-z0-9]{30,}|AIza[A-Za-z0-9_-]{30,})(?:["'\s])/g],
    ['credential-assignment',/["']?(?:ADMIN_TOKEN|CONTENT_ENCRYPTION_KEY|LEGACY_CONTENT_ENCRYPTION_KEY|GMAIL_CLIENT_SECRET|GMAIL_REFRESH_TOKEN|RESEND_API_KEY|CLOUDFLARE_API_TOKEN)["']?\s*(?:=|:)\s*["']([A-Za-z0-9_\/+\-=]{32,})["']/gi],
    ['personal-filesystem-path',/[A-Z]:[\\/](?:Users|Aha)[\\/][^\s"'<>]+/g],
  ];
  // Embedded font data is base64, not credentials. Its generator/license are checked separately.
  if(path!=='src/pdf-serif-font-data.js')for(const [name,regex]of rules)for(const m of text.matchAll(regex))add(name,m.index);
  for(const m of text.matchAll(/[A-Za-z0-9_.+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)){
    const email=m[0].toLowerCase(),domain=email.split('@')[1];
    if(!/(?:^|\.)example\.(?:com|org|net)$|\.(?:invalid|test)$/.test(domain)&&!/^afterme\.fixture(?:\+[^@]+)?@gmail\.com$/.test(email))add('non-example-email',m.index);
  }
  for(const m of text.matchAll(/https:\/\/[a-z0-9.-]+\.workers\.dev/gi))if(!/(?:your-subdomain|example|localhost)/i.test(m[0]))add('personal-worker-url',m.index);
  return findings;
}

// Load only known credential fields. Values never enter findings or command-line
// arguments, and the same in-memory set is reused for the exported source tree.
export function loadPrivateValues(root=process.cwd(),{env=process.env,privateValuesFile}={}) {
  const values=new Set(),secret=/token|secret|password|passphrase|encryption[_-]?key|api[_-]?key/i;
  const add=value=>{if(typeof value==='string'&&value.trim().length>=8)values.add(value.trim());};
  function collect(value,all=false) {
    if(Array.isArray(value)){for(const item of value)collect(item,all);return;}
    if(value&&typeof value==='object'){for(const [key,item]of Object.entries(value))if(all||secret.test(key))collect(item,true);return;}
    if(all)add(value);
  }
  const read=path=>{if(statSync(path).size>1024*1024)throw Error('Private-value input is too large');return readFileSync(path,'utf8');};
  for(const [key,value]of Object.entries(env))if(secret.test(key)&&/^(?:ADMIN_|CONTENT_|LEGACY_CONTENT_|GMAIL_|RESEND_|CLOUDFLARE_|AFTERME_BACKUP_)/.test(key))add(value);
  for(const file of ['.admin-token.local','.content-encryption-key.local','.security-backup-passphrase.local']){const path=resolve(root,file);if(existsSync(path))add(read(path));}
  for(const file of ['.gmail-oauth.local.json','.dev.vars','.env']) {
    const path=resolve(root,file);if(!existsSync(path))continue;
    const raw=read(path);
    if(file.endsWith('.json')){try{collect(JSON.parse(raw));}catch{throw Error('Invalid local credential JSON');}}
    else for(const line of raw.split(/\r?\n/)){const match=line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);if(match&&secret.test(match[1]))add(match[2].replace(/^(["'])(.*)\1$/,'$2'));}
  }
  const extra=privateValuesFile||env.AFTERME_RELEASE_PRIVATE_VALUES_FILE;
  if(extra){try{collect(JSON.parse(read(resolve(extra))),true);}catch{throw Error('Unable to read private-value input');}}
  if(env.AFTERME_RELEASE_PRIVATE_VALUES){try{collect(JSON.parse(env.AFTERME_RELEASE_PRIVATE_VALUES),true);}catch{throw Error('Invalid private-value environment input');}}
  return [...values];
}

export function auditRelease(root=process.cwd(),{complete=false,denyValues,privateValuesFile}={}){
  root=realpathSync(resolve(root));const findings=[],manifestPath=resolve(root,'release-files.json');
  denyValues??=loadPrivateValues(root,{privateValuesFile});
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  if(manifest.format_version!==1||!Array.isArray(manifest.files)||new Set(manifest.files).size!==manifest.files.length)throw Error('Invalid release manifest');
  const required=['LICENSE','package.json','package-lock.json','README.md','SECURITY.md','THIRD_PARTY_NOTICES.md','third_party/NotoSerifSC-OFL.txt','src/pdf-serif-font-data.js','assets/fonts/afterme-song-sc.ttf','third_party/pdf-chinese-font.json','src/pdf-chinese-font.js','migrations/0018_settings_and_channels.sql','release-files.json'];
  for(const file of required)if(!manifest.files.includes(file))findings.push({path:file,rule:'required-file-not-allowlisted',line:1});
  for(const file of manifest.files){
    if(typeof file!=='string'||file.includes('\\')||isAbsolute(file)||/^[A-Za-z]:/.test(file)||file.split('/').some(p=>p==='..'||p===''||p==='.')||forbiddenPath.test(file)){findings.push({path:String(file),rule:'unsafe-manifest-path',line:1});continue;}
    const absolute=resolve(root,file);
    if(!existsSync(absolute)){findings.push({path:file,rule:'missing-file',line:1});continue;}
    // Resolve every component; files or directories linked outside the tree are rejected.
    let current=absolute,linked=false;while(current!==root){if(lstatSync(current).isSymbolicLink()){findings.push({path:file,rule:'symlink',line:1});linked=true;break;}current=dirname(current);}if(linked)continue;
    const actual=realpathSync(absolute),inside=relative(root,actual);
    if(inside==='..'||inside.startsWith('..'+sep)||!lstatSync(absolute).isFile()){findings.push({path:file,rule:'not-a-contained-regular-file',line:1});continue;}
    const bytes=readFileSync(absolute);findings.push(...findingsFor(file,bytes));
    for(const value of denyValues)if(value.length>=8&&bytes.includes(Buffer.from(value)))findings.push({path:file,rule:'local-private-value-match',line:1});
  }
  if(complete){const allowed=new Set(manifest.files);const walk=dir=>{for(const e of readdirSync(resolve(root,dir),{withFileTypes:true})){const file=dir?dir+'/'+e.name:e.name;if(e.isDirectory())walk(file);else if(!allowed.has(file))findings.push({path:file,rule:'unexpected-export-file',line:1});}};walk('');}
  const pkg=JSON.parse(readFileSync(resolve(root,'package.json'))),lock=JSON.parse(readFileSync(resolve(root,'package-lock.json')));
  if(!findings.length){
    try{const font=readFileSync(resolve(root,'assets/fonts/afterme-song-sc.ttf')),info=JSON.parse(readFileSync(resolve(root,'third_party/pdf-chinese-font.json'),'utf8'));if(info.license!=='OFL-1.1'||info.asset!=='assets/fonts/afterme-song-sc.ttf'||font.readUInt32BE(0)!==0x10000||createHash('sha256').update(font).digest('hex')!==info.sha256)throw Error();}
    catch{findings.push({path:'assets/fonts/afterme-song-sc.ttf',rule:'font-provenance-mismatch',line:1});}
  }
  if(pkg.version!==lock.version||pkg.license!==lock.packages[''].license||JSON.stringify(pkg.devDependencies)!==JSON.stringify(lock.packages[''].devDependencies))findings.push({path:'package-lock.json',rule:'package-lock-mismatch',line:1});
  if(pkg.license==='UNLICENSED'||!pkg.license)findings.push({path:'LICENSE',rule:'license-not-selected',line:1});
  const licenseFile=resolve(root,'LICENSE'),licenseText=existsSync(licenseFile)?readFileSync(licenseFile,'utf8'):'';if(licenseText.trim().length<100)findings.push({path:'LICENSE',rule:'license-text-missing',line:1});
  if(pkg.license==='GPL-3.0-or-later'&&(!licenseText.includes('GNU GENERAL PUBLIC LICENSE')||!licenseText.includes('Version 3, 29 June 2007')||!manifest.files.includes('COPYRIGHT.md')||!readFileSync(resolve(root,'COPYRIGHT.md'),'utf8').includes('SPDX-License-Identifier: GPL-3.0-or-later')))findings.push({path:'LICENSE',rule:'gpl-grant-mismatch',line:1});
  const inv=JSON.parse(readFileSync(resolve(root,'third_party/dependency-licenses.json')));
  if(JSON.stringify(inv.packages)!==JSON.stringify(inventory(lock)))findings.push({path:'third_party/dependency-licenses.json',rule:'dependency-inventory-stale',line:1});
  // Only local relative Markdown targets are checked; external docs and fragment-only links are not fetched.
  for(const file of manifest.files.filter(f=>f.endsWith('.md'))){const content=readFileSync(resolve(root,file),'utf8');for(const m of content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)){const link=m[1].split('#')[0];if(!link||/^(?:https?:|mailto:)/.test(link))continue;const target=relative(root,resolve(root,dirname(file),link)).split(sep).join('/');if(!manifest.files.includes(target))findings.push({path:file,rule:'broken-or-private-document-link',line:content.slice(0,m.index).split('\n').length});}}
  return {ok:findings.length===0,files:manifest.files.length,findings};
}

export function auditTrackedFiles(root=process.cwd()){
  const allowed=new Set(JSON.parse(readFileSync(resolve(root,'release-files.json'),'utf8')).files);
  const command=spawnSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8',windowsHide:true});
  if(command.status!==0)throw Error('Tracked-file audit requires the intended public Git checkout');
  return command.stdout.split('\0').filter(Boolean).filter(file=>!allowed.has(file)).map(path=>({path,rule:'tracked-file-not-allowlisted',line:1}));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let root=process.cwd(),privateValuesFile,tracked=false;
  const args=process.argv.slice(2);for(let i=0;i<args.length;i++){if(args[i]==='--tracked')tracked=true;else if(args[i]==='--private-values-file'){privateValuesFile=args[++i];if(!privateValuesFile)throw Error('Private-value file argument required');}else if(args[i].startsWith('--'))throw Error('Unknown release audit option');else root=args[i];}
  const report=auditRelease(root,{privateValuesFile});if(tracked)report.findings.push(...auditTrackedFiles(root));report.ok=report.findings.length===0;console.log(JSON.stringify(report,null,2));process.exitCode=report.ok?0:1;
}
