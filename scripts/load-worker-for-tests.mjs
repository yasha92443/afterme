// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {registerHooks} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Node has no cloudflare:workers module. Replace only its platform base for
// local bundle/browser tests; deployed Workers always use the native class.
// This does not emulate RPC, billing, CPU limits or the Cloudflare network.
export async function loadWorkerForTests(path) {
  const base='data:text/javascript,'+encodeURIComponent('export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }');
  const hooks=registerHooks({resolve(specifier,context,next){return specifier==='cloudflare:workers'?{url:base,shortCircuit:true}:next(specifier,context);}});
  try {return await import(pathToFileURL(resolve(path)).href);}finally{hooks.deregister();}
}
