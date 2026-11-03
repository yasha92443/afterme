// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
// Verify a complete backup offline; never connects to production or sends mail.
import { mkdtempSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const input = process.argv[2];
if (!input) throw new Error('Usage: npm run backup:verify -- COMPLETE-BACKUP.json (provide CONTENT_ENCRYPTION_KEY in the environment)');
const directory = mkdtempSync(join(tmpdir(), 'afterme-backup-check-'));
const output = join(directory, 'recovery.sqlite');
try {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./restore-backup.mjs', import.meta.url)), resolve(input), output], { encoding: 'utf8', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || '离线恢复校验失败。');
  const recovered = JSON.parse(result.stdout.trim());
  if(recovered.ok!==true||recovered.application_smoke_verified!==true||recovered.release_suspended!==true||recovered.network_used!==false)throw Error('Recovery application smoke check did not complete');
  console.log(JSON.stringify({ ok: true, schema_restored: true, application_smoke_verified:true,schema_version:recovered.schema_version,verified_encrypted_payloads: recovered.verified_encrypted_payloads, release_suspended: true, network_used: false }));
} finally {
  for (const file of [output, output + '-wal', output + '-shm']) if (existsSync(file)) unlinkSync(file);
  rmdirSync(directory);
}
