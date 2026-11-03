// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
const encoder = new TextEncoder();
async function key(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function createAdminSession(secret, now = Date.now()) {
  const payload = `session.${now + 30 * 60 * 1000}.${crypto.randomUUID()}`;
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(payload)));
  return payload + '.' + [...signature].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function validAdminSession(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || !/^session\.\d+\.[a-f0-9-]+\.[a-f0-9]{64}$/.test(token)) return false;
  const parts = token.split('.');
  if (Number(parts[1]) <= now || Number(parts[1]) > now + 30 * 60 * 1000) return false;
  const signature = Uint8Array.from(parts.pop().match(/../g), hex => parseInt(hex, 16));
  return crypto.subtle.verify('HMAC', await key(secret), signature, encoder.encode(parts.join('.')));
}
