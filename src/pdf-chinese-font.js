// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 yasha92443
// Only this deployment's static font asset is read. Document text never leaves the Worker.
const assetsCache=new WeakMap();
export async function cloudChineseFont(env) {
  const binding=env.PDF_FONTS;
  if(!binding?.fetch)throw new Error('PDF font asset binding is missing');
  if(!assetsCache.has(binding)){
    const loading=(async()=>{
      const response=await binding.fetch(new Request('https://pdf-fonts.invalid/fonts/afterme-song-sc.ttf',{signal:AbortSignal.timeout(20000)}));
      if(!response.ok)throw new Error('PDF font asset unavailable');
      const bytes=new Uint8Array(await response.arrayBuffer());
      return parseFont(bytes);
    })();
    assetsCache.set(binding,loading);
    loading.catch(()=>assetsCache.delete(binding));
  }
  return assetsCache.get(binding);
}

const u16=(bytes,offset)=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint16(offset);
const i16=(bytes,offset)=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getInt16(offset);
const u32=(bytes,offset)=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(offset);
const put16=(bytes,offset,value)=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).setUint16(offset,value);
const put32=(bytes,offset,value)=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).setUint32(offset,value);
const align=value=>(value+3)&~3;

export function parseFont(bytes) {
  if(!(bytes instanceof Uint8Array)||bytes.length<12||bytes.length>20*1024*1024||u32(bytes,0)!==0x10000)throw new Error('Invalid PDF font asset');
  const count=u16(bytes,4),tables=new Map();
  if(count<8||count>64||12+count*16>bytes.length)throw new Error('Invalid font tables');
  for(let i=0;i<count;i++){
    const offset=12+i*16,tag=String.fromCharCode(...bytes.subarray(offset,offset+4)),start=u32(bytes,offset+8),length=u32(bytes,offset+12);
    if(start+length>bytes.length||tables.has(tag))throw new Error('Invalid font table range');
    tables.set(tag,bytes.subarray(start,start+length));
  }
  for(const name of ['head','hhea','hmtx','maxp','loca','glyf','cmap','name','OS/2','post'])if(!tables.has(name))throw new Error('Missing font table');
  const head=tables.get('head'),hhea=tables.get('hhea'),maxp=tables.get('maxp'),loca=tables.get('loca'),cmap=tables.get('cmap');
  const glyphCount=u16(maxp,4),longLoca=i16(head,50)===1;
  if(!glyphCount||loca.length<(glyphCount+1)*(longLoca?4:2))throw new Error('Invalid glyph locations');
  let mapping;
  for(let i=0;i<u16(cmap,2);i++){
    const record=4+i*8,offset=u32(cmap,record+4);
    if(offset+4<=cmap.length&&u16(cmap,offset)===4){const length=u16(cmap,offset+2);if(offset+length>cmap.length)throw new Error('Invalid character map');mapping=cmap.subarray(offset,offset+length);if(u16(cmap,record)===3&&u16(cmap,record+2)===1)break;}
  }
  if(!mapping)throw new Error('Missing Unicode BMP character map');
  const mapView=new DataView(mapping.buffer,mapping.byteOffset,mapping.byteLength),read=offset=>mapView.getUint16(offset);
  const segments=read(6)/2;
  const glyphFor=point=>{
    let low=0,high=segments-1;
    while(low<high){const mid=(low+high)>>1;if(read(14+mid*2)<point)low=mid+1;else high=mid;}
    if(point<read(16+segments*2+low*2))return 0;
    const delta=mapView.getInt16(16+segments*4+low*2),rangeOffset=16+segments*6+low*2,range=read(rangeOffset);
    if(!range)return (point+delta)&65535;
    const address=rangeOffset+range+2*(point-read(16+segments*2+low*2));
    if(address+2>mapping.length)return 0;
    const glyph=read(address);return glyph?(glyph+delta)&65535:0;
  };
  const location=glyph=>longLoca?u32(loca,glyph*4):u16(loca,glyph*2)*2;
  const glyphBytes=glyph=>{
    if(glyph>=glyphCount)throw new Error('Invalid glyph reference');
    const start=location(glyph),end=location(glyph+1),glyf=tables.get('glyf');
    if(start>end||end>glyf.length)throw new Error('Invalid glyph range');
    return glyf.subarray(start,end);
  };
  const metrics=glyph=>{const count=u16(hhea,34),hmtx=tables.get('hmtx');return [u16(hmtx,Math.min(glyph,count-1)*4),i16(hmtx,glyph<count?glyph*4+2:count*4+(glyph-count)*2)];};
  const os2=tables.get('OS/2'),post=tables.get('post');
  const meta={postscriptName:'AfterMePDFSongSC',unitsPerEm:u16(head,18),bbox:[36,38,40,42].map(offset=>i16(head,offset)),ascent:i16(hhea,4),descent:i16(hhea,6),capHeight:os2.length>=90?i16(os2,88):i16(hhea,4),italicAngle:new DataView(post.buffer,post.byteOffset,post.byteLength).getInt32(4)/65536};
  return {tables,glyphFor,glyphBytes,metrics,meta};
}

function components(bytes) {
  const result=[];
  if(bytes.length<10||i16(bytes,0)>=0)return result;
  let offset=10,flags;
  do{
    if(offset+4>bytes.length)throw new Error('Invalid composite glyph');
    flags=u16(bytes,offset);result.push({offset:offset+2,glyph:u16(bytes,offset+2)});
    offset+=4+(flags&1?4:2)+(flags&8?2:flags&64?4:flags&128?8:0);
  }while(flags&32);
  return result;
}

function unicodeMap(points,glyphIds) {
  const groups=[];
  points.forEach((point,index)=>{const last=groups.at(-1);if(last&&point===last.end+1&&glyphIds[index]===last.glyph+point-last.start)last.end=point;else groups.push({start:point,end:point,glyph:glyphIds[index]});});
  const bytes=new Uint8Array(12+16+groups.length*12);
  put16(bytes,2,1);put16(bytes,4,3);put16(bytes,6,10);put32(bytes,8,12);
  put16(bytes,12,12);put32(bytes,16,bytes.length-12);put32(bytes,24,groups.length);
  groups.forEach((group,i)=>{const offset=28+i*12;put32(bytes,offset,group.start);put32(bytes,offset+4,group.end);put32(bytes,offset+8,group.glyph);});
  return bytes;
}

function checksum(bytes) {const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let sum=0,i=0;for(;i+4<=bytes.length;i+=4)sum=(sum+view.getUint32(i))>>>0;let tail=0;for(let j=0;j<4;j++)tail=(tail<<8)|(bytes[i+j]||0);return (sum+(tail>>>0))>>>0;}
function sfnt(tables) {
  const entries=[...tables].sort(([a],[b])=>a<b?-1:1),count=entries.length,power=2**Math.floor(Math.log2(count));
  const bytes=new Uint8Array(12+count*16+entries.reduce((sum,[,table])=>sum+align(table.length),0));
  put32(bytes,0,0x10000);put16(bytes,4,count);put16(bytes,6,power*16);put16(bytes,8,Math.log2(power));put16(bytes,10,count*16-power*16);
  let start=12+count*16,headOffset;
  entries.forEach(([tag,table],i)=>{const offset=12+i*16;bytes.set([...tag].map(c=>c.charCodeAt(0)),offset);put32(bytes,offset+4,checksum(table));put32(bytes,offset+8,start);put32(bytes,offset+12,table.length);bytes.set(table,start);if(tag==='head')headOffset=start;start+=align(table.length);});
  put32(bytes,headOffset+8,(0xb1b0afba-checksum(bytes))>>>0);
  return bytes;
}

// Keep only this document's glyphs and their composite dependencies. Original
// outlines are copied, never reshaped or replaced with another locale's glyphs.
export function subsetChineseFont(font,characters) {
  const points=[...new Set([...characters].map(char=>char.codePointAt(0)>65535?0x25a1:char.codePointAt(0)))].sort((a,b)=>a-b),glyphs=[0],seen=new Set(glyphs),pointGlyphs=[];
  for(const point of points){const glyph=font.glyphFor(point);if(!glyph){const error=new Error(`PDF font lacks U+${point.toString(16).toUpperCase()}`);error.status=422;throw error;}pointGlyphs.push(glyph);if(!seen.has(glyph)){seen.add(glyph);glyphs.push(glyph);}}
  for(let i=0;i<glyphs.length;i++)for(const {glyph} of components(font.glyphBytes(glyphs[i])))if(!seen.has(glyph)){seen.add(glyph);glyphs.push(glyph);}
  const ids=new Map(glyphs.map((glyph,i)=>[glyph,i])),loca=new Uint8Array((glyphs.length+1)*4),hmtx=new Uint8Array(glyphs.length*4),outlines=[];
  let offset=0;
  glyphs.forEach((glyph,i)=>{const bytes=font.glyphBytes(glyph).slice();for(const component of components(bytes))put16(bytes,component.offset,ids.get(component.glyph));put32(loca,i*4,offset);outlines.push(bytes);offset+=align(bytes.length);const [width,bearing]=font.metrics(glyph);put16(hmtx,i*4,width);put16(hmtx,i*4+2,bearing);});
  put32(loca,glyphs.length*4,offset);
  const glyf=new Uint8Array(offset);offset=0;for(const bytes of outlines){glyf.set(bytes,offset);offset+=align(bytes.length);}
  const tables=new Map();for(const name of ['head','hhea','maxp','name','OS/2'])tables.set(name,font.tables.get(name).slice());
  put32(tables.get('head'),8,0);put16(tables.get('head'),50,1);put16(tables.get('hhea'),34,glyphs.length);put16(tables.get('maxp'),4,glyphs.length);
  const post=new Uint8Array(32);post.set(font.tables.get('post').subarray(0,32));put32(post,0,0x30000);
  const glyphIds=pointGlyphs.map(glyph=>ids.get(glyph));
  tables.set('post',post);tables.set('glyf',glyf);tables.set('loca',loca);tables.set('hmtx',hmtx);tables.set('cmap',unicodeMap(points,glyphIds));
  return {meta:font.meta,codepoints:points,glyphIds,advances:pointGlyphs.map(glyph=>font.metrics(glyph)[0]),bytes:sfnt(tables)};
}
