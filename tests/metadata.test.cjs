'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webm,el,n,unknown,children,uint} = require('./fixtures/webm.cjs');
const window={};
vm.runInNewContext(fs.readFileSync(require.resolve('../webm_metadata.js'),'utf8'), {window,Blob,Uint8Array,DataView,Map,Set});
const finalize=window.MeetBudyMetadata.finalize;
async function inspect(options) {
  const input=webm(options), result=await finalize(new Blob([input]));
  const data=Buffer.from(await result.blob.arrayBuffer()), top=children(data), segment=top.find(x=>x.id===0x18538067), body=children(data,segment.start,segment.end);
  return {input,result,data,top,segment,body};
}
for(const audio of [false,true]) test(`Open segment and clusters finalize with valid duration and exact cue addresses (${audio?'audio':'video'})`,async()=>{
  const e=await inspect({audio,scale:2000000});
  assert.equal(e.segment.end,e.data.length);assert.equal(e.result.extension,'webm');assert.equal(e.result.blocks,2);
  const info=children(e.body.find(x=>x.id===0x1549a966).data);
  assert.equal(uint(info.find(x=>x.id===0x2ad7b1).data),2000000);
  assert.equal(info.find(x=>x.id===0x4489).data.readDoubleBE(),2010);
  assert.equal(e.result.durationMs,4020);
  const cues=children(e.body.find(x=>x.id===0x1c53bb6b).data);
  assert.equal(cues.length,2);
  for(const cue of cues) {
    const parts=children(cue.data), positions=children(parts.find(x=>x.id===0xb7).data);
    const clusterPos=uint(positions.find(x=>x.id===0xf1).data), relative=uint(positions.find(x=>x.id===0xf0).data);
    const cluster=e.body.find(x=>x.offset===e.segment.start+clusterPos);assert.equal(cluster.id,0x1f43b675);
    const block=children(e.data,cluster.start,cluster.end).find(x=>x.offset===cluster.start+relative);assert.equal(block.id,0xa3);
    assert.deepEqual([...block.data],[0x81,0,0,0x80,0x08,0x42,0x24]);
  }
  const seek=children(e.body.find(x=>x.id===0x114d9b74).data);
  for(const entry of seek) {const parts=children(entry.data);const id=uint(parts.find(x=>x.id===0x53ab).data),pos=uint(parts.find(x=>x.id===0x53ac).data);assert.equal(e.body.find(x=>x.offset===e.segment.start+pos).id,id);}
});
test('Old finite first-chunk Segment retains later complete clusters',async()=>{
  const input=webm({openCluster:false});
  // Replace the open Segment marker with a finite header covering all but the
  // final complete Cluster, reproducing the previous first-chunk corruption.
  const first=el(0x1a45dfa3,el(0x4282,Buffer.from('webm'))), offset=first.length+unknown(0x18538067).length;
  const body=input.subarray(offset), clusters=children(body); const last=clusters.at(-1);
  const damaged=Buffer.concat([first,el(0x18538067,body.subarray(0,last.offset)),body.subarray(last.offset)]);
  const result=await finalize(new Blob([damaged]));assert.equal(result.blocks,2);assert.equal(result.durationMs,2020);
});
test('BlockGroup seek offset addresses the enclosing group',async()=>{
  const e=await inspect({blockGroup:true});const cue=children(e.body.find(x=>x.id===0x1c53bb6b).data)[0];const pos=children(children(cue.data).find(x=>x.id===0xb7).data);
  const cluster=e.body.find(x=>x.offset===e.segment.start+uint(pos.find(x=>x.id===0xf1).data));
  const relative=uint(pos.find(x=>x.id===0xf0).data);assert.equal(children(e.data,cluster.start,cluster.end).find(x=>x.offset===cluster.start+relative).id,0xa0);
});
test('H.264 container is honestly identified as Matroska without changing payloads',async()=>{
  const e=await inspect({codec:'V_MPEG4/ISO/AVC'});assert.equal(e.result.extension,'mkv');assert.equal(e.result.blob.type,'video/x-matroska');
  assert.equal(children(e.top[0].data).find(x=>x.id===0x4282).data.toString(),'matroska');
  const block=children(e.body.find(x=>x.id===0x1f43b675).data).find(x=>x.id===0xa3);assert.deepEqual([...block.data],[0x81,0,0,0x80,0x08,0x42,0x24]);
});
test('Malformed and cancelled repair rejects without changing the source',async()=>{
  const source=new Blob([webm().subarray(0,20)]), before=Buffer.from(await source.arrayBuffer());await assert.rejects(finalize(source),/metadata/i);assert.deepEqual(Buffer.from(await source.arrayBuffer()),before);
  const controller=new AbortController();controller.abort();await assert.rejects(finalize(new Blob([webm()]),{signal:controller.signal}),/cancelled/i);
});
