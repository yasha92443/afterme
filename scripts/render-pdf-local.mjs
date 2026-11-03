// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
// Font files remain on the operator's licensed computer; only the PDF embeds them.
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {resolve,join,delimiter} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildPrivateLetterPdf,buildPublicFarewellPdf} from '../src/pdf.js';
import {parseFont} from '../src/pdf-chinese-font.js';

const args=process.argv.slice(2),options={};
const localConfig=existsSync('.pdf-local.local.json')?JSON.parse(readFileSync('.pdf-local.local.json','utf8')):{};
for(let i=0;i<args.length;i+=2){const name=args[i];if(!['--input','--output','--python','--simsun','--times','--source-url','--admin-file'].includes(name)||!args[i+1]||args[i+1].startsWith('--')||options[name])throw Error('Use (--input document.json | --source-url https://instance/api/.../pdf-source --admin-file session-file) --output document.pdf [--python executable] [--simsun font.ttc] [--times font.ttf]');options[name]=args[i+1];}
if(Boolean(options['--input'])===Boolean(options['--source-url'])||!options['--output'])throw Error('Choose exactly one of --input or --source-url and supply --output');
const input=options['--input']?resolve(options['--input']):null,output=resolve(options['--output']);
if(input===output||existsSync(output))throw Error('PDF output must be a new file');
let doc;
if(input)doc=JSON.parse(readFileSync(input,'utf8'));
else{
  if(!options['--admin-file'])throw Error('--admin-file must contain an authenticated management session token (or admin token when MFA is disabled)');
  const url=new URL(options['--source-url']);
  if(url.username||url.password||url.search||url.hash||!/^\/api\/(public-farewell|items\/\d+)\/pdf-source$/.test(url.pathname)||!(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname))))throw Error('Expected an HTTPS PDF source API URL (HTTP allowed for local fixtures only)');
  const response=await fetch(url,{headers:{Authorization:'Bearer '+readFileSync(options['--admin-file'],'utf8').trim()},redirect:'error',signal:AbortSignal.timeout(45000)});
  if(!response.ok)throw Error('PDF source request failed: HTTP '+response.status+'; renew your management session if necessary');
  doc=await response.json();
}
if(!['public','private'].includes(doc.kind)||typeof doc.options!=='object'||!doc.options||doc.options.fontPair)throw Error('Expected {kind:"public"|"private",options:{...}} without fontPair');
const build=doc.kind==='public'?buildPublicFarewellPdf:buildPrivateLetterPdf;
const draft=Buffer.from(build({...doc.options,chineseFont:parseFont(new Uint8Array(readFileSync(new URL('../assets/fonts/afterme-song-sc.ttf',import.meta.url))))})).toString('utf8');
const rendered=[...draft.matchAll(/<([A-F0-9]+)> Tj/g)].map(([,hex])=>Array.from({length:hex.length/4},(_,i)=>String.fromCharCode(parseInt(hex.slice(i*4,i*4+4),16))).join('')).join('\n');
const tempRoot=resolve('output/pdf/local-font-work');mkdirSync(tempRoot,{recursive:true});const temp=mkdtempSync(join(tempRoot,'document-'));
try{
  writeFileSync(join(temp,'text.json'),JSON.stringify({text:rendered+'\n'+JSON.stringify(doc.options)}));
  const fonts=join(temp,'fonts.json'),windowsFonts=join(process.env.WINDIR||'C:\\Windows','Fonts');
  const env={...process.env};if(localConfig.pythonPackages)env.PYTHONPATH=[localConfig.pythonPackages,env.PYTHONPATH].filter(Boolean).join(delimiter);
  const run=spawnSync(options['--python']||process.env.AFTERME_PYTHON||localConfig.python||'python',[fileURLToPath(new URL('subset-document-fonts.py',import.meta.url)),'--input',join(temp,'text.json'),'--output',fonts,'--simsun',options['--simsun']||join(windowsFonts,'simsun.ttc'),'--times',options['--times']||join(windowsFonts,'times.ttf')],{encoding:'utf8',windowsHide:true,timeout:120000,env});
  if(run.status!==0)throw Error('Local font preparation failed. Install Python/fontTools and provide licensed SimSun/Times New Roman paths; no PDF was written. '+(run.error?.code||run.stderr?.split('\n').filter(Boolean).at(-1)||''));
  const fontPair=JSON.parse(readFileSync(fonts,'utf8')),pdf=build({...doc.options,fontPair});
  mkdirSync(resolve(output,'..'),{recursive:true});writeFileSync(output,pdf,{flag:'wx'});
  console.log(JSON.stringify({ok:true,output,bytes:pdf.length,fonts:['SimSun','Times New Roman'],embedded:true,localOnly:true}));
}finally{const absolute=resolve(temp);if(!absolute.startsWith(tempRoot+'\\')&&!absolute.startsWith(tempRoot+'/'))throw Error('Unsafe font temporary directory');rmSync(absolute,{recursive:true,force:true});}
