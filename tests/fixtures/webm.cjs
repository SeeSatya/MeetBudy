'use strict';
const bytes = value => { const result = []; do { result.unshift(value % 256); value = Math.floor(value / 256); } while (value); return Buffer.from(result); };
const size = value => { let width = 1; while (value >= 2 ** (7 * width) - 1) width++; const result = Buffer.alloc(width); for (let i = width - 1; i >= 0; i--) { result[i] = value % 256; value = Math.floor(value / 256); } result[0] |= 2 ** (8 - width); return result; };
const el = (id, ...data) => { const payload = Buffer.concat(data); return Buffer.concat([bytes(id), size(payload.length), payload]); };
const n = (id, value) => el(id, bytes(value));
const unknown = id => Buffer.concat([bytes(id), Buffer.from([1,255,255,255,255,255,255,255])]);
function webm({audio = false, codec = audio ? 'A_OPUS' : 'V_VP8', openCluster = true, scale = 1000000, blockGroup = false, matroska = false} = {}) {
  const ebml = el(0x1a45dfa3, el(0x4282, Buffer.from(matroska ? 'matroska' : 'webm')));
  const info = el(0x1549a966, n(0x2ad7b1, scale));
  const tracks = el(0x1654ae6b, el(0xae, n(0xd7,1), n(0x83,audio ? 2 : 1), el(0x86,Buffer.from(codec)), n(0x23e383,20000000)));
  const media = Buffer.from([0x81,0,0,0x80,0x08,0x42,0x24]);
  const block = blockGroup ? el(0xa0, el(0xa1,media), n(0x9b,20)) : el(0xa3,media);
  const cluster = time => { const data = Buffer.concat([n(0xe7,time),block]); return openCluster ? Buffer.concat([unknown(0x1f43b675),data]) : el(0x1f43b675,data); };
  return Buffer.concat([ebml, unknown(0x18538067), info, tracks, cluster(0), cluster(2000)]);
}
function children(data, start = 0, end = data.length) {
  const result = [];
  while (start < end) {
    const offset = start; const read = identifier => { let width=1,mask=128; while (!(data[start]&mask)) { width++;mask/=2; } let value=identifier?data[start]:data[start]&(mask-1); start++; for(let i=1;i<width;i++) value=value*256+data[start++]; return value; };
    const id=read(true), length=read(false), payload=start; start+=length;
    if(start>end) throw new Error('Invalid fixture element size');
    result.push({id,offset,start:payload,end:start,data:data.subarray(payload,start)});
  }
  return result;
}
const uint = data => [...data].reduce((n,b)=>n*256+b,0);
module.exports = {webm, el, n, unknown, children, uint};
