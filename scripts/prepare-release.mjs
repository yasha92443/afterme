// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,relative,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {auditRelease,loadPrivateValues} from './release-audit.mjs';

export function crc32(data){let crc=0xffffffff;for(const b of data){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}

// A deterministic UTF-8 ZIP with deflate and fixed 1980-01-01 timestamps.
// No filesystem traversal, shells, Git metadata or dependency binaries are used.
export function sourceZip(files){const chunks=[],central=[];let offset=0,size=0;
  if(files.length>65535)throw Error('ZIP entry limit exceeded');
  const names=new Set();for(const {name,data}of files){if(names.has(name)||name.startsWith('/')||/^[A-Za-z]:/.test(name)||name.includes('\\')||name.split('/').some(x=>!x||x==='..'||x==='.'))throw Error('Unsafe ZIP path');names.add(name);
    const filename=Buffer.from(name),compressed=deflateRawSync(data),crc=crc32(data),local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(8,8);local.writeUInt16LE(33,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(filename.length,26);
    chunks.push(local,filename,compressed);
    const header=Buffer.alloc(46);header.writeUInt32LE(0x02014b50);header.writeUInt16LE(0x0314,4);header.writeUInt16LE(20,6);header.writeUInt16LE(0x800,8);header.writeUInt16LE(8,10);header.writeUInt16LE(33,14);header.writeUInt32LE(crc,16);header.writeUInt32LE(compressed.length,20);header.writeUInt32LE(data.length,24);header.writeUInt16LE(filename.length,28);header.writeUInt32LE(0o100644*65536,38);header.writeUInt32LE(offset,42);central.push(header,filename);offset+=local.length+filename.length+compressed.length;size+=header.length+filename.length;
  }
  if(offset+size>0xffffffff)throw Error('ZIP size limit exceeded');
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(size,12);end.writeUInt32LE(offset,16);return Buffer.concat([...chunks,...central,end]);
}

export function prepareRelease({root=process.cwd(),destination,privateValuesFile}={}){
  root=realpathSync(resolve(root));const pkg=JSON.parse(readFileSync(resolve(root,'package.json')));
  const stamp=new Date().toISOString().replace(/[:.]/g,'-'),out=resolve(destination||resolve(root,'output/releases',`afterme-${pkg.version}-${stamp}`)),rel=relative(root,out);
  if(!rel.startsWith('output'+sep)||rel.split(sep).length<3)throw Error('Release output must be a new nested directory under workspace output');
  if(existsSync(out))throw Error('Refusing to overwrite release output');
  // Check existing ancestors before writing, so a symlink cannot redirect the export.
  let parent=dirname(out);while(parent!==root){if(existsSync(parent)&&lstatSync(parent).isSymbolicLink())throw Error('Linked release destination refused');parent=dirname(parent);}
  const denyValues=loadPrivateValues(root,{privateValuesFile}),report=auditRelease(root,{denyValues});if(!report.ok)throw Error('Release audit failed: '+JSON.stringify(report.findings));
  const manifest=JSON.parse(readFileSync(resolve(root,'release-files.json')));const tree=resolve(out,'source'),files=[];
  for(const file of [...manifest.files].sort()){const source=readFileSync(resolve(root,file));const data=/\.(?:png|jpg|woff2?|ttf)$/.test(file)?source:Buffer.from(source.toString('utf8').replaceAll('\r\n','\n'));const target=resolve(tree,file);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,data,{flag:'wx'});files.push({name:file,data});}
  const copied=auditRelease(tree,{complete:true,denyValues});if(!copied.ok)throw Error('Export audit failed: '+JSON.stringify(copied.findings));
  const sha=data=>createHash('sha256').update(data).digest('hex'),zip=sourceZip(files),archive=`afterme-${pkg.version}-source.zip`;
  writeFileSync(resolve(out,archive),zip,{flag:'wx'});
  const evidence={format_version:1,version:pkg.version,license:pkg.license,archive,sha256:sha(zip),files:files.map(f=>({path:f.name,bytes:f.data.length,sha256:sha(f.data)})),source_audit:copied,published:false};
  writeFileSync(resolve(out,'manifest.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});writeFileSync(resolve(out,'SHA256SUMS'),`${evidence.sha256}  ${archive}\n`,{flag:'wx'});
  return{ok:true,directory:out,archive:resolve(out,archive),sha256:evidence.sha256,files:files.length,published:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(prepareRelease({destination:process.argv[2]}),null,2));
