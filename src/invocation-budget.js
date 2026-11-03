// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import { Buffer } from 'node:buffer';
const rawStatement = Symbol('budget-raw-statement');
const wrappedBudget = Symbol('invocation-budget');
const rawDatabase = Symbol('budget-raw-database');

export class InvocationBudgetError extends Error {
  constructor(kind) { super(`Invocation ${kind} budget exhausted before dispatch`); this.name = 'InvocationBudgetError'; this.kind = kind; this.dispatched = false; }
}
export function isInvocationBudgetError(error) { return error instanceof InvocationBudgetError || error?.name === 'InvocationBudgetError'; }
export function createInvocationBudget({ d1 = 48, statements = d1, external = 45 } = {}) {
  return {
    maxD1: d1, maxStatements: statements, maxExternal: external, usedD1: 0, usedStatements: 0, usedExternal: 0,
    get remainingD1() { return Math.max(0, Math.min(this.maxD1 - this.usedD1,this.maxStatements-this.usedStatements)); },
    get remainingExternal() { return Math.max(0, this.maxExternal - this.usedExternal); },
    canStart(d1 = 1, external = 0) { return this.remainingD1 >= d1 && this.remainingExternal >= external; },
    consumeD1(statements = 1) { if (!this.canStart(statements)) throw new InvocationBudgetError('D1'); this.usedD1++; this.usedStatements += statements; },
    consumeExternal() { if (this.remainingExternal < 1) throw new InvocationBudgetError('external'); this.usedExternal++; },
  };
}
export function invocationBudget(env) { return env?.INVOCATION_BUDGET || null; }
export function wrapBudgetDatabase(db, budget) {
  if (!db || !budget || db[wrappedBudget] === budget) return db;
  db = db[rawDatabase] || db;
  function wrap(statement) { return {
    [rawStatement]: statement,
    bind(...values) { return wrap(statement.bind(...values)); },
    async first(...args) { budget.consumeD1(); return statement.first(...args); },
    async all(...args) { budget.consumeD1(); return statement.all(...args); },
    async run(...args) { budget.consumeD1(); return statement.run(...args); },
  }; }
  return {
    [wrappedBudget]: budget,
    [rawDatabase]: db,
    prepare(sql) { return wrap(db.prepare(sql)); },
    async batch(statements) { budget.consumeD1(statements.length); return db.batch(statements.map(s => s[rawStatement] || s)); },
  };
}
export async function budgetFetch(env, input, init) { invocationBudget(env)?.consumeExternal(); return fetch(input, init); }
export function bytesToBase64(bytes) { return Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength).toString('base64'); }
export function base64ToBytes(value) { return new Uint8Array(Buffer.from(value,'base64')); }
