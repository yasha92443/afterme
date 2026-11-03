// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
const rawStatement=Symbol('statement');
export function measureDatabase(db) {
  const stats={queries:0,roundtrips:0,rows_read:0,db_ms:0,db_wall_ms:0};
  let inFlight=0,windowStart=0;
  function begin(){const start=performance.now();stats.roundtrips++;if(inFlight++===0)windowStart=start;return start;}
  function finish(start){const now=performance.now();stats.db_ms+=now-start;if(--inFlight===0)stats.db_wall_ms+=now-windowStart;}
  function record(result){stats.rows_read+=Number(result?.meta?.rows_read??result?.results?.length??(result?1:0));}
  function wrap(raw){return {
    [rawStatement]:raw,
    bind(...values){return wrap(raw.bind(...values));},
    async first(column){const start=begin();stats.queries++;try{const r=await raw.all();record(r);const row=r.results?.[0]||null;return column&&row?row[column]:row;}finally{finish(start);}},
    async all(...args){const start=begin();stats.queries++;try{const r=await raw.all(...args);record(r);return r;}finally{finish(start);}},
    async run(...args){const start=begin();stats.queries++;try{const r=await raw.run(...args);record(r);return r;}finally{finish(start);}},
  };}
  return {stats,db:{prepare(sql){return wrap(db.prepare(sql));},async batch(statements){const start=begin();stats.queries+=statements.length;try{const results=await db.batch(statements.map(s=>s[rawStatement]||s));results.forEach(record);return results;}finally{finish(start);}}}};
}
