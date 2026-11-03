// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
// Self-contained so the same authenticated format runs in the browser and offline CLI.
export function backupCryptoFactory(){
  const encoder=new TextEncoder(),cap=256*1024*1024,chunkSize=1024*1024;
  function encode(bytes){let out='';for(let i=0;i<bytes.length;i+=32768)out+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(out);}
  function decode(value,max){if(typeof value!=='string'||value.length>Math.ceil(max/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw Error('Invalid encrypted backup');const out=Uint8Array.from(atob(value),c=>c.charCodeAt(0));if(out.length>max)throw Error('Backup too large');return out;}
  async function key(password,salt){
    if(typeof password!=='string'||password.length<12||encoder.encode(password).length>1024)throw Error('Use a backup passphrase of 12 or more characters (maximum 1024 bytes)');
    const material=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveKey']);
    return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',iterations:600000,salt},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  }
  function kdf(salt){return {name:'PBKDF2',hash:'SHA-256',iterations:600000,salt};}
  function nonce(prefix,index){const iv=new Uint8Array(12);iv.set(prefix);new DataView(iv.buffer).setUint32(8,index);return iv;}
  function chunkHeader(envelope){return {format:envelope.format,version:2,kdf:kdf(envelope.kdf.salt),cipher:{name:'AES-GCM',iv_prefix:envelope.cipher.iv_prefix},chunk_size:envelope.chunk_size,plaintext_bytes:envelope.plaintext_bytes,chunk_count:envelope.chunk_count};}
  function utf8Length(value){let bytes=0;for(let i=0;i<value.length;i++){const point=value.charCodeAt(i);if(point<128)bytes++;else if(point<2048)bytes+=2;else if(point>=0xd800&&point<=0xdbff&&i+1<value.length&&value.charCodeAt(i+1)>=0xdc00&&value.charCodeAt(i+1)<=0xdfff){bytes+=4;i++;}else bytes+=3;}return bytes;}
  function* plaintextChunks(value){
    let chunk=new Uint8Array(chunkSize),filled=0;
    for(let start=0;start<value.length;){let end=Math.min(value.length,start+262144);if(end<value.length&&value.charCodeAt(end-1)>=0xd800&&value.charCodeAt(end-1)<=0xdbff)end--;const part=encoder.encode(value.slice(start,end));start=end;
      for(let offset=0;offset<part.length;){const length=Math.min(chunkSize-filled,part.length-offset);chunk.set(part.subarray(offset,offset+length),filled);filled+=length;offset+=length;if(filled===chunkSize){yield chunk;chunk=new Uint8Array(chunkSize);filled=0;}}
    }
    if(filled)yield chunk.subarray(0,filled);
  }
  async function encrypt(backup,password){
    const raw=JSON.stringify(backup);if(typeof raw!=='string'||raw.length>cap)throw Error('Backup too large');
    const plaintextBytes=utf8Length(raw);if(plaintextBytes>cap)throw Error('Backup too large');
    const salt=crypto.getRandomValues(new Uint8Array(16)),prefix=crypto.getRandomValues(new Uint8Array(8));
    const header={format:'afterme-encrypted-backup',version:2,kdf:kdf(encode(salt)),cipher:{name:'AES-GCM',iv_prefix:encode(prefix)},chunk_size:chunkSize,plaintext_bytes:plaintextBytes,chunk_count:Math.ceil(plaintextBytes/chunkSize)};
    const derived=await key(password,salt),chunks=[];let index=0;
    for(const part of plaintextChunks(raw)){
      const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce(prefix,index),additionalData:encoder.encode(JSON.stringify({...header,index}))},derived,part);
      chunks.push(encode(new Uint8Array(cipher)));
      index++;
    }
    return {...header,chunks};
  }
  async function decrypt(envelope,password){
    if(envelope?.format!=='afterme-encrypted-backup'||![1,2].includes(envelope.version)||envelope.kdf?.name!=='PBKDF2'||envelope.kdf.hash!=='SHA-256'||envelope.kdf.iterations!==600000||envelope.cipher?.name!=='AES-GCM')throw Error('Unsupported encrypted backup');
    const salt=decode(envelope.kdf.salt,16);if(salt.length!==16)throw Error('Invalid encrypted backup');
    if(envelope.version===1){
      const iv=decode(envelope.cipher.iv,12),ciphertext=decode(envelope.ciphertext,128*1024*1024+16);
      if(iv.length!==12||ciphertext.length<16)throw Error('Invalid encrypted backup');
      const header={format:envelope.format,version:1,kdf:kdf(envelope.kdf.salt),cipher:{name:'AES-GCM',iv:envelope.cipher.iv}};
      try{const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:encoder.encode(JSON.stringify(header))},await key(password,salt),ciphertext);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));}catch{throw Error('Backup password is incorrect or backup was modified');}
    }
    if(envelope.chunk_size!==chunkSize||!Number.isSafeInteger(envelope.plaintext_bytes)||envelope.plaintext_bytes<1||envelope.plaintext_bytes>cap||!Number.isSafeInteger(envelope.chunk_count)||envelope.chunk_count!==Math.ceil(envelope.plaintext_bytes/chunkSize)||!Array.isArray(envelope.chunks)||envelope.chunks.length!==envelope.chunk_count)throw Error('Invalid encrypted backup manifest');
    const prefix=decode(envelope.cipher.iv_prefix,8);if(prefix.length!==8)throw Error('Invalid encrypted backup');
    const header=chunkHeader(envelope),derived=await key(password,salt),decoder=new TextDecoder('utf-8',{fatal:true}),parts=[];
    try{
      for(let index=0;index<envelope.chunk_count;index++){
        const size=Math.min(chunkSize,envelope.plaintext_bytes-index*chunkSize),ciphertext=decode(envelope.chunks[index],size+16);
        if(ciphertext.length!==size+16)throw Error('Invalid encrypted backup chunk');
        const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce(prefix,index),additionalData:encoder.encode(JSON.stringify({...header,index}))},derived,ciphertext);
        parts.push(decoder.decode(plain,{stream:index+1<envelope.chunk_count}));
      }
      return JSON.parse(parts.join(''));
    }catch{throw Error('Backup password is incorrect or backup was modified');}
  }
  return {encrypt,decrypt};
}
