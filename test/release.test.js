// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,symlinkSync} from 'node:fs';
import {resolve,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inflateRawSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {auditRelease,findingsFor} from '../scripts/release-audit.mjs';
import {prepareRelease,sourceZip,crc32} from '../scripts/prepare-release.mjs';

const workspace=fileURLToPath(new URL('../',import.meta.url));
function fixture(t){const parent=resolve(workspace,'output');mkdirSync(parent,{recursive:true});const root=mkdtempSync(resolve(parent,'release-test-'));t.after(()=>{const absolute=resolve(root);if(!absolute.startsWith(parent+sep+'release-test-'))throw Error('Unsafe test cleanup path');rmSync(absolute,{recursive:true,force:true});});const manifest=JSON.parse(readFileSync(resolve(workspace,'release-files.json')));for(const file of manifest.files){const target=resolve(root,file);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(resolve(workspace,file)));}return{root,manifest};}
const rules=(path,text)=>findingsFor(path,Buffer.from(text)).map(f=>f.rule);

test('release scanner rejects live-looking credentials without echoing values',()=>{
 const secret='gh'+'p_'+'Z'.repeat(40),report=findingsFor('src/example.js',Buffer.from(`const key="${secret}";`));
 assert.ok(report.some(f=>f.rule==='provider-token'));assert.equal(JSON.stringify(report).includes(secret),false);
});
test('release scanner catches quoted JSON credential names',()=>{
 const secret=crypto.randomUUID(),report=findingsFor('README.md',Buffer.from(JSON.stringify({ADMIN_TOKEN:secret})));
 assert.ok(report.some(f=>f.rule==='credential-assignment'));assert.equal(JSON.stringify(report).includes(secret),false);
});
test('real audit and prepare entrypoints reject a known opaque key without printing it',t=>{
 const {root}=fixture(t),secret=crypto.randomUUID();writeFileSync(resolve(root,'.admin-token.local'),secret);writeFileSync(resolve(root,'README.md'),'A recovery reference: '+secret);
 for(const [script,args]of [['release-audit.mjs',[root]],['prepare-release.mjs',[]]]){
  const result=spawnSync(process.execPath,[resolve(workspace,'scripts',script),...args],{cwd:root,encoding:'utf8',windowsHide:true});
  assert.notEqual(result.status,0);assert.match(result.stdout+result.stderr,/local-private-value-match/);assert.equal((result.stdout+result.stderr).includes(secret),false);
 }
});
test('prepare carries an optional private-value source into the normalized export audit',t=>{
 const {root}=fixture(t),secret=crypto.randomUUID()+'\nprivate-suffix',values=resolve(root,'.known-values.local.json');
 writeFileSync(values,JSON.stringify([secret]));writeFileSync(resolve(root,'README.md'),secret.replace('\n','\r\n'));
 assert.throws(()=>prepareRelease({root,destination:resolve(root,'output/releases/normalized'),privateValuesFile:values}),/Export audit failed.*local-private-value-match/);
});
test('release scanner rejects private paths, production addresses and absolute personal paths',()=>{
 assert.ok(rules('.dev.vars','').includes('private-file-path'));
 assert.ok(rules('wrangler.toml','').includes('private-file-path'));
 assert.ok(rules('src/example.js','const email="'+'owner'+'@'+'mailbox.com'+'"').includes('non-example-email'));
 assert.ok(rules('README.md','https://'+'personal-instance'+'.workers.dev').includes('personal-worker-url'));
 assert.ok(rules('README.md','C:'+String.fromCharCode(92)+'Users'+String.fromCharCode(92)+'private-user'+String.fromCharCode(92)+'file').includes('personal-filesystem-path'));
});
test('release scanner accepts reserved examples and the generated font module',()=>{
 assert.deepEqual(rules('README.md','owner@example.invalid https://afterme.your-subdomain.workers.dev'),[]);
 assert.deepEqual(findingsFor('src/pdf-serif-font-data.js',readFileSync(new URL('../src/pdf-serif-font-data.js',import.meta.url))),[]);
});
test('release audit rejects removed license, stale dependency inventory and local private-value matches',t=>{
 const {root}=fixture(t);assert.equal(auditRelease(root).ok,true);
 assert.ok(auditRelease(root,{denyValues:['AfterMe PDF Serif']}).findings.some(f=>f.rule==='local-private-value-match'));
 writeFileSync(resolve(root,'LICENSE'),'');assert.equal(auditRelease(root).ok,false);
});
test('release audit rejects manifest traversal and links to excluded private docs',t=>{
 const {root,manifest}=fixture(t);manifest.files.push('../outside.txt');writeFileSync(resolve(root,'release-files.json'),JSON.stringify(manifest));
 assert.ok(auditRelease(root).findings.some(f=>f.rule==='unsafe-manifest-path'));
 manifest.files.pop();writeFileSync(resolve(root,'release-files.json'),JSON.stringify(manifest));writeFileSync(resolve(root,'README.md'),'[private](docs/not-in-release.md)');
 assert.ok(auditRelease(root).findings.some(f=>f.rule==='broken-or-private-document-link'));
});
test('complete exported-tree audit rejects an unexpected private file',t=>{
 const {root}=fixture(t);writeFileSync(resolve(root,'.admin-token.local'),crypto.randomUUID());
 assert.equal(auditRelease(root).ok,true);assert.ok(auditRelease(root,{complete:true}).findings.some(f=>f.rule==='unexpected-export-file'));
});
test('ZIP validates paths, uses UTF-8, preserves bytes, CRC and deterministic content',()=>{
 assert.equal(crc32(Buffer.from('123456789')),0xcbf43926);
 const files=[{name:'示例.txt',data:Buffer.from('中文 English Русский')}],zip=sourceZip(files);assert.deepEqual(zip,sourceZip(files));
 assert.equal(zip.readUInt16LE(6),0x800);const nameLength=zip.readUInt16LE(26),length=zip.readUInt32LE(18);assert.equal(zip.subarray(30,30+nameLength).toString(),'示例.txt');
 const restored=inflateRawSync(zip.subarray(30+nameLength,30+nameLength+length));assert.deepEqual(restored,files[0].data);assert.equal(zip.readUInt32LE(14),crc32(restored));
 assert.throws(()=>sourceZip([{name:'../escape',data:Buffer.alloc(0)}]));assert.throws(()=>sourceZip([...files,...files]));
});
test('release export excludes local secrets and Git history, checks the copy and refuses overwrite',t=>{
 const {root}=fixture(t);mkdirSync(resolve(root,'.git'));writeFileSync(resolve(root,'wrangler.toml'),'private-config');writeFileSync(resolve(root,'.admin-token.local'),crypto.randomUUID());
 const destination=resolve(root,'output/releases/fixture'),report=prepareRelease({root,destination});assert.equal(report.ok,true);assert.equal(report.published,false);
 const manifest=JSON.parse(readFileSync(resolve(destination,'manifest.json')));assert.ok(manifest.files.every(f=>!['wrangler.toml','.admin-token.local'].includes(f.path)&&!f.path.startsWith('.git/')));assert.equal(auditRelease(resolve(destination,'source'),{complete:true}).ok,true);
 assert.throws(()=>prepareRelease({root,destination}),/overwrite/);assert.throws(()=>prepareRelease({root,destination:resolve(root,'outside')}),/output/);
});
test('release audit rejects missing font notice and stale dependency inventory',t=>{
 const {root}=fixture(t);writeFileSync(resolve(root,'third_party/dependency-licenses.json'),JSON.stringify({packages:[]}));assert.ok(auditRelease(root).findings.some(f=>f.rule==='dependency-inventory-stale'));
 rmSync(resolve(root,'third_party/NotoSerifSC-OFL.txt'));assert.ok(auditRelease(root).findings.some(f=>f.rule==='missing-file'));
});
test('release audit rejects symbolic links when supported by the host',t=>{
 const {root,manifest}=fixture(t);try{symlinkSync(root,resolve(root,'linked'),'junction');}catch(e){if(['EPERM','EACCES'].includes(e.code)){t.skip('Host does not permit symlinks');return;}throw e;}manifest.files.push('linked/README.md');writeFileSync(resolve(root,'release-files.json'),JSON.stringify(manifest));
 assert.ok(auditRelease(root).findings.some(f=>f.rule==='symlink'));
});
