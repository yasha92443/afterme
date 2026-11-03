// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {backupCryptoFactory} from '../src/backup-crypto.js';
const [input,output]=process.argv.slice(2),password=process.env.AFTERME_BACKUP_PASSPHRASE;
if(!input||!output||!password)throw Error('Usage: npm run backup:encrypt -- input.json NEW-encrypted.json (set AFTERME_BACKUP_PASSPHRASE separately)');
if(statSync(input).size>256*1024*1024)throw Error('Backup too large');
const envelope=await backupCryptoFactory().encrypt(JSON.parse(readFileSync(input,'utf8')),password);
writeFileSync(output,JSON.stringify(envelope),{flag:'wx',mode:0o600});
console.log(JSON.stringify({ok:true,encrypted:true,plaintext_written:false}));
