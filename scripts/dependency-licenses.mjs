// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export function inventory(lock) {
  return Object.entries(lock.packages).filter(([name])=>name).map(([name,p])=>({
    path:name,version:p.version,license:p.license||'UNKNOWN',development:Boolean(p.dev),optional:Boolean(p.optional),
  })).sort((a,b)=>a.path.localeCompare(b.path));
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){
  const packages=inventory(JSON.parse(readFileSync('package-lock.json','utf8')));
  if(packages.some(p=>p.license==='UNKNOWN'))throw Error('Dependency license metadata missing; inspect upstream before release');
  writeFileSync('third_party/dependency-licenses.json',JSON.stringify({source:'package-lock.json',packages},null,2)+'\n');
  console.log(JSON.stringify({packages:packages.length,licenses:[...new Set(packages.map(p=>p.license))]}));
}
