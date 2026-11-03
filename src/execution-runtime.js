// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import application, {fetchApplication} from './worker.js';
import {rateLimit, securityHeaders, requestError} from './request-security.js';
import {recordSecurityEvent} from './security-alerts.js';

// One object per deployment. Identity never comes from a request or user input.
export const RUNTIME_OBJECT_NAME = 'afterme-runtime-v1';
const implementation = {fetch:fetchApplication, scheduled:application.scheduled};

function durableMode(env) {
  if(env.EXECUTION_RUNTIME===undefined||env.EXECUTION_RUNTIME===''||env.EXECUTION_RUNTIME==='worker')return false;
  if(env.EXECUTION_RUNTIME==='durable-object')return true;
  throw requestError(503,'Invalid application runtime configuration');
}

function runtime(env) {
  if(!env.APP_RUNTIME?.getByName)throw requestError(503,'Application runtime unavailable');
  return env.APP_RUNTIME.getByName(RUNTIME_OBJECT_NAME);
}

export function createEdgeHandler(direct=application) {
  let lastRejectionMinute = -1;
  return {
    async fetch(request,env,ctx) {
      try {
        if(!durableMode(env))return await direct.fetch(request,env,ctx);
        await rateLimit(request,env);
        return await runtime(env).fetch(request);
      } catch(error) {
        // Rate-limited floods must not turn into a D1 write or RPC per rejection.
        const status=error.status===429?429:503;
        if(status===429&&ctx?.waitUntil) {
          const minute=Math.floor(Date.now()/60000);
          if(minute!==lastRejectionMinute) {
            lastRejectionMinute=minute;
            try {ctx.waitUntil(Promise.resolve(runtime(env).recordRejection()).catch(()=>{}));}catch{}
          }
        }
        console.error('edge_request_failed',status);
        return securityHeaders(Response.json({error:'request_error',message:status===429?error.message:'系统暂时无法完成操作，请重试。'},{status}));
      }
    },
    async scheduled(controller,env,ctx) {
      if(!durableMode(env))return direct.scheduled(controller,env,ctx);
      // RPC is available only to bindings; there is no public tick HTTP route.
      return runtime(env).runScheduled({cron:controller.cron,scheduledTime:controller.scheduledTime});
    },
  };
}

// Injecting the platform base keeps runtime logic testable in ordinary Node.
export function createDurableRuntimeClass(Base,app=implementation) {
  return class extends Base {
    async fetch(request) {
      // Budgets, repositories and mail providers belong to an invocation, never
      // the object instance. Concurrent fetch and Cron calls retain D1 fencing.
      return app.fetch(request,{...this.env},{rateLimited:true});
    }
    async runScheduled(controller) {
      return app.scheduled(controller,{...this.env});
    }
    async recordRejection() {
      return recordSecurityEvent({...this.env},429);
    }
  };
}

export default createEdgeHandler();
