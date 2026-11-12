'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {environment,cluster,popup,drain,waitForRun}=require('./fixtures/extension-runtime.cjs');
const key=id=>'meetBudyPendingCombine:'+encodeURIComponent(id);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const warning=e=>{let prevented=false;const event={preventDefault(){prevented=true;},returnValue:null};e.emitWindow('beforeunload',event);return {prevented,value:event.returnValue};};

test('Toolbar availability follows exact Meet host navigation and active tab',async()=>{
  const group=cluster(),e=environment({group});group.activateTab(e.id);
  assert(group.actionCalls.findLast(x=>x.type==='icon').path[16].endsWith('icon16.png'));
  for(const url of ['https://example.com/','https://meet.google.com.evil.test/call','http://meet.google.com/call','https://meet.google.com:8443/call']) {
    group.updateTab(e.id,url);assert(group.actionCalls.findLast(x=>x.type==='icon').path[16].endsWith('icon16-inactive.png'));
    assert.match(group.actionCalls.findLast(x=>x.type==='title').title,/unavailable/);
  }
  group.updateTab(e.id,'https://meet.google.com/abc-defg-hij');assert(group.actionCalls.findLast(x=>x.type==='icon').path[128].endsWith('icon128.png'));
});

test('START always checks consent and active site even when another tab is recording',async()=>{
  const group=cluster(),meet=environment({group,id:7}),offsite=environment({group,id:8});await meet.page('RECORDING_STARTED',{recordingId:'active'});
  group.updateTab(8,'https://example.com/');group.activateTab(8);
  const before=meet.posts.length;
  assert.equal((await group.dispatch({type:'START_RECORDING'})).ok,false);
  assert.match((await group.dispatch({type:'START_RECORDING',consentAcknowledged:true})).error,/active Google Meet/);
  assert.equal(meet.posts.length,before);assert.equal(offsite.posts.filter(x=>x.cmd==='START').length,0);
  await group.dispatch({type:'STOP_RECORDING',targetTabId:7,recordingId:'active'});assert(meet.posts.some(x=>x.cmd==='STOP') || meet.window.__content.state().pendingCount>0);
});

test('Popup requires acknowledgment for each accepted recording and keeps Stop usable',async()=>{
  const e=environment();await e.page('INJECTED');const ui=await popup(e);
  await e.document.get('btnRecord').click();await drain();assert.equal(e.posts.filter(x=>x.cmd==='START').length,0);assert.match(e.document.get('statusMsg').textContent,/permission/);
  e.document.get('consentAcknowledged').checked=true;await e.document.get('btnRecord').click();await drain();
  const start=e.posts.find(x=>x.cmd==='START');assert(start);assert.equal(e.document.get('consentAcknowledged').checked,false);
  await e.page('RECORDING_STARTED',{recordingId:start.recordingId,mimeType:'video/webm'});ui.message(e.group.backgroundMessages.find(x=>x.type==='STATUS'&&x.payload.state==='recording'));
  await e.document.get('btnRecord').click();assert(e.posts.some(x=>x.cmd==='STOP'));
});

test('Content close warning covers startup and final save, then disappears; cancelled attempt does not stop',async()=>{
  const e=environment();await e.page('INJECTED');assert.equal(warning(e).prevented,false);
  const starting=e.command('START_RECORDING');await drain();assert.equal(warning(e).prevented,true);await starting;
  const id=e.posts.find(x=>x.cmd==='START').recordingId;await e.page('RECORDING_STARTED',{recordingId:id,mimeType:'video/webm'});e.seed(id);
  const before=e.posts.filter(x=>x.cmd==='STOP').length;assert.equal(warning(e).value,'');assert.equal(e.posts.filter(x=>x.cmd==='STOP').length,before);
  const gate=deferred();e.group.db.faults.readWait=gate.promise;
  const saving=e.page('RECORDING_STOPPED',{recordingId:id,mimeType:'video/webm',secondaries:[],stoppedAt:e.time.now()});await drain();assert.equal(warning(e).prevented,true);
  // Refreshing status during native raw-save must not promote its live job.
  await e.page('STATUS_RESPONSE',{isRecording:false});assert.equal(e.group.stored[key(id)].state,'preparing');
  gate.resolve();await saving;assert.equal(warning(e).prevented,false);assert.equal(e.group.stored[key(id)],undefined);
});

test('Content close warning covers combine and pagehide cancels it while preserving chunks',async()=>{
  const e=environment({mode:'hung-run'});await e.finish('combine');const run=e.window.__content.runPendingCombine('combine');run.catch(()=>{});await waitForRun(e);
  assert.equal(warning(e).prevented,true);e.emitWindow('pagehide',{persisted:false});await assert.rejects(run,/cancel/i);await drain();
  assert.equal(e.group.db.rows.length,4);assert.equal(e.group.stored[key('combine')].state,'pending');assert.equal(warning(e).prevented,false);
});

test('Native finalization deadline auto-saves committed media and persistently warns about incompleteness',async()=>{
  const e=environment();await e.finish('incomplete',false,{incomplete:true,stoppedAt:1234567});const job=e.group.stored[key('incomplete')];
  assert.equal(job.state,'recovery');assert.equal(job.incomplete,true);assert.equal(job.stoppedAt,1234567);assert.equal(e.group.db.rows.length,2);assert(e.document.all.some(x=>x.download));
  await popup(e);assert.match(e.document.get('combinePromptText').textContent,/incomplete/);
});

test('Browser restart discovers recording-owned committed chunks even when tab removal never ran',async()=>{
  const group=cluster(),old=environment({group,id:7});await old.page('RECORDING_STARTED',{recordingId:'crash',mimeType:'video/webm'});old.seed('crash');
  group.tabs.delete(7); // Forced browser process termination bypasses onRemoved.
  const recovered=environment({group,id:8});group.restartBackground();await recovered.page('STATUS_RESPONSE',{isRecording:false});await drain();
  const state=await group.dispatch({type:'GET_RECORDING_STATE'});assert.equal(state.isRecording,false);assert.equal(group.stored.meetRecorderState.isRecording,false);
  const job=group.stored[key('crash')];assert.equal(job.state,'recovery');assert.equal(job.incomplete,true);assert.equal(job.needsRawSave,true);
  await recovered.window.__content.runPendingCombine('crash');assert.equal(group.db.rows.length,0);assert(recovered.document.all.some(x=>x.download?.includes('recovered')));
});

test('Metadata failure preserves original downloadable bytes and recovery ownership',async()=>{
  const e=environment();e.group.db.rows.push({recordingId:'damaged',data:new Blob(['truncated recording'])});await e.page('RECORDING_STARTED',{recordingId:'damaged',mimeType:'video/webm'});
  await e.page('RECORDING_STOPPED',{recordingId:'damaged',mimeType:'video/webm',secondaries:[]});
  assert.equal(e.group.stored[key('damaged')].state,'recovery');assert.equal(e.group.db.rows.length,1);
  const original=[...e.urls.values()].find(x=>x.size===19);assert(original);assert.equal(await original.text(),'truncated recording');
  assert(e.sent.some(x=>x.payload?.state==='metadata_warning'));
});

test('Timed-out database reopen cannot write an orphan tail after recovered chunks are cleared', async () => {
  const { setup } = require('./fixtures/page-runtime.cjs');
  const { webm } = require('./fixtures/webm.cjs');
  const group = cluster(), bridge = environment({ group }), page = setup();
  let delayOpen = false;
  const pendingOpens = [];
  // Both execution contexts use the same origin database, while only the page
  // recorder's reopened handle is delayed. Existing read/write transactions
  // would otherwise serialize recovery reads behind accepted chunk writes.
  page.context.indexedDB = {
    open(...args) {
      const proxy = {}, request = group.db.api.open(...args);
      request.onsuccess = event => {
        const complete = () => proxy.onsuccess?.(event);
        if (delayOpen) pendingOpens.push(complete);
        else complete();
      };
      return proxy;
    },
  };
  page.command('START', { recordingId: 'late-open' });
  await page.settle(); await drain();
  await bridge.page('RECORDING_STARTED', { recordingId: 'late-open', mimeType: 'video/webm' });
  const input = webm(), cut = input.lastIndexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75]));
  page.a.state().mediaRecorder.ondataavailable({ data: new Blob([input.subarray(0, cut)]) });
  await page.settle(); await drain();
  assert.equal(group.db.rows.length, 1);
  group.db.handles.find(handle => handle.onversionchange).onversionchange();
  delayOpen = true;
  page.a.state().mediaRecorder.ondataavailable({ data: new Blob([input.subarray(cut)]) });
  await page.settle(); await drain();
  assert.equal(pendingOpens.length, 1);
  const stopping = page.a.stopRecording();
  await page.settle(); page.fire(10000); await stopping;
  const stopped = page.messages.find(message => message.event === 'RECORDING_STOPPED');
  assert.equal(stopped.data.incomplete, true);
  await bridge.page('RECORDING_STOPPED', stopped.data);
  await bridge.window.__content.runPendingCombine('late-open');
  assert.equal(group.db.rows.length, 0);
  const errors = page.messages.filter(message => message.event === 'ERROR').length;
  pendingOpens.forEach(complete => complete());
  await page.settle(); await drain();
  assert.equal(group.db.rows.length, 0);
  assert.equal(group.stored[key('late-open')], undefined);
  assert.equal(page.messages.filter(message => message.event === 'ERROR').length, errors);
});
