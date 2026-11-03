// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {Buffer} from 'node:buffer';
const LINK_MODE_VERSION = 2;
// Scoped to the invocation's environment object, with at most the active and
// legacy content key. No login result or content plaintext is cached.
const cryptoCache=new WeakMap();
function cachedKey(env,secret){
  let entries=cryptoCache.get(env);if(!entries){entries=new Map();cryptoCache.set(env,entries);}
  if(!entries.has(secret)){if(entries.size>=2)entries.clear();entries.set(secret,{});}
  return entries.get(secret);
}

export function inferAccessMode(body) {
  const explicit = body.access_mode || body.security;
  if (explicit === "passphrase" || explicit === "sensitive") return "passphrase";
  if (explicit === "link" || explicit === "private_link") return "link";
  if (body.encrypted_payload && !getPlaintext(body)) return "passphrase";
  return "link";
}

export async function buildStoredPayload({ body, env }) {
  const mode = inferAccessMode(body);
  if (mode === "passphrase") {
    const encryptedPayload = requireString(body.encrypted_payload, "encrypted_payload");
    return JSON.stringify({ v: LINK_MODE_VERSION, mode: "passphrase", payload: encryptedPayload });
  }

  const plaintext = requireString(getPlaintext(body), "plaintext");
  return sealLinkPayload(plaintext, env);
}

export async function openStoredPayload(storedPayload, env) {
  let parsed;
  try {
    parsed = JSON.parse(storedPayload);
  } catch {
    return { mode: "legacy-passphrase", encryptedPayload: storedPayload };
  }

  if (parsed?.v === LINK_MODE_VERSION && parsed.mode === "link") {
    return { mode: "link", plaintext: await openLinkPayload(parsed, env) };
  }

  if (parsed?.v === LINK_MODE_VERSION && parsed.mode === "passphrase") {
    return { mode: "passphrase", encryptedPayload: parsed.payload };
  }

  return { mode: "legacy-passphrase", encryptedPayload: storedPayload };
}

export function storedPayloadMode(storedPayload) {
  try {
    const parsed = JSON.parse(storedPayload);
    if (parsed?.v === LINK_MODE_VERSION && typeof parsed.mode === "string") return parsed.mode;
  } catch {
    // Legacy payloads are treated as passphrase-protected browser ciphertext.
  }
  return "passphrase";
}

async function sealLinkPayload(plaintext, env) {
  if (!env.CONTENT_ENCRYPTION_KEY) throw new Error("请先配置独立的 CONTENT_ENCRYPTION_KEY，再保存私人内容；内容密钥与管理口令须分别设置。");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await contentKey(env);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return JSON.stringify({
    v: LINK_MODE_VERSION,
    mode: "link",
    alg: "AES-GCM",
    key_id: await keyFingerprint(env.CONTENT_ENCRYPTION_KEY,env),
    iv: b64(new Uint8Array(iv)),
    ciphertext: b64(new Uint8Array(cipher)),
  });
}

async function openLinkPayload(payload, env) {
  let secret = env.CONTENT_ENCRYPTION_KEY || env.LEGACY_CONTENT_ENCRYPTION_KEY || env.ADMIN_TOKEN;
  if (payload.key_id && await keyFingerprint(secret || '',env) !== payload.key_id) {
    if (env.LEGACY_CONTENT_ENCRYPTION_KEY && await keyFingerprint(env.LEGACY_CONTENT_ENCRYPTION_KEY,env) === payload.key_id) secret = env.LEGACY_CONTENT_ENCRYPTION_KEY;
    else throw new Error('内容密钥不匹配；请使用备份时的独立内容密钥恢复。');
  }
  let plain;
  const candidates = payload.key_id ? [secret] : [...new Set([secret, env.LEGACY_CONTENT_ENCRYPTION_KEY, env.ADMIN_TOKEN].filter(Boolean))];
  for (const candidate of candidates) {
    try {
      plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(payload.iv) }, await contentKey(env,candidate), fromB64(payload.ciphertext));
      break;
    } catch { /* Legacy payloads can be opened during a verified key migration. */ }
  }
  if (!plain) throw new Error('无法解密内容；请检查内容密钥和备份。');
  return new TextDecoder().decode(plain);
}

export async function keyFingerprint(secret,env) {
  if(env){const entry=cachedKey(env,secret);return entry.fingerprint ||= keyFingerprint(secret);}
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  return [...digest.slice(0, 8)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function contentKey(env,secret=env.CONTENT_ENCRYPTION_KEY || env.ADMIN_TOKEN) {
  if (!secret) throw new Error("CONTENT_ENCRYPTION_KEY or ADMIN_TOKEN is required for link-mode vault content");
  const entry=cachedKey(env,secret);
  return entry.key ||= (async()=>{const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);})();
}

function getPlaintext(body) {
  return body.plaintext ?? body.content ?? body.body;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value;
}

function b64(bytes) {
  return Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength).toString('base64');
}

function fromB64(value) {
  if(typeof value!=='string'||value.length%4!==0||/[^A-Za-z0-9+/]/.test(value.replace(/={1,2}$/, '')))throw new Error('Invalid encrypted payload encoding');
  return new Uint8Array(Buffer.from(value,'base64'));
}
