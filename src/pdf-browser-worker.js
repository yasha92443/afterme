// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
import {parseFont} from './pdf-chinese-font.js';
import {buildPrivateLetterPdfAsync,buildPublicFarewellPdfAsync} from './pdf.js';
let font;
async function chineseFont(){
  if(!font){font=fetch('/static/pdf-font.ttf',{credentials:'same-origin'}).then(async response=>{if(!response.ok)throw Error('PDF font unavailable; the saved text is safe');return parseFont(new Uint8Array(await response.arrayBuffer()));});font.catch(()=>{font=null;});}
  return font;
}
self.onmessage=async event=>{
  const {id,source}=event.data;
  try{
    const options={...source.options,chineseFont:await chineseFont()};
    const bytes=await(source.kind==='private'?buildPrivateLetterPdfAsync(options):buildPublicFarewellPdfAsync(options));
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
    self.postMessage({id,bytes:bytes.buffer,sha256:digest},[bytes.buffer]);
  }catch(error){self.postMessage({id,error:error.message});}
};
