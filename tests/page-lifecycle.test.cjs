'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {setup, original} = require('./fixtures/page-runtime.cjs');
const outputs = [{id:1,name:'Main',targets:['EVERYONE']},{id:2,name:'Extra',targets:['EVERYONE']}];
function configure(e) { e.command('SET_AUDIO_TRACKS', {list:outputs}); }
function noTracks(e) {
  for (const map of [e.a.audioTracks,e.a.audioSources,e.a.trackGainNodes,e.a.trackSinkEls,e.a.trackAnalysers,e.a.trackStreamMap,e.a.videoProbes,e.a.domVideoElements]) assert.equal(map.size,0);
  assert.equal(e.a.allVideoTracks.length,0);
  assert.equal(e.a.activeScreenShareTracks.length,0);
}
async function start(e,id='A') { e.a.setId(id); await e.a.startRecording(id); await e.settle(); }
async function stopped(e) { await e.a.stopRecording(); await e.settle(); }

test('Natural audio/video departure releases metadata, probes, sinks and listeners under churn', () => {
  const e=setup(); const pc=new e.window.RTCPeerConnection();
  for(let n=0;n<100;n++) for(const kind of ['audio','video']) {
    const track=new e.Track(kind);pc.receive(track);track.endNaturally();
    assert.equal((track.listeners.get('ended')||[]).length,0);
  }
  e.fire(100);noTracks(e);assert.equal(e.a.state().volumePollId,null);
  assert.equal(e.elements.filter(el=>el.isConnected&&el.srcObject).length,0);
});

test('Explicit stop without ended retires complete audio and video ownership while idle', () => {
  const e=setup();const pc=new e.window.RTCPeerConnection();
  for(let n=0;n<50;n++) for(const kind of ['audio','video']) {const track=new e.Track(kind);pc.receive(track);track.stop();}
  e.fire(100);e.fire(1000);noTracks(e);assert.equal(e.a.state().volumePollId,null);
  assert.equal(e.elements.filter(el=>el.isConnected&&el.srcObject).length,0);
});

test('Definitive peer retirement releases its registrations without stopping Meet tracks', () => {
  const e=setup();const pc=new e.window.RTCPeerConnection();const audio=new e.Track('audio');const video=new e.Track('video');
  pc.receive(audio);pc.receive(video);pc.close();noTracks(e);
  assert.equal(audio.readyState,'live');assert.equal(video.readyState,'live');assert.equal(e.a.activePeerConnections.size,0);
});

test('Shared peer ownership and recoverable disconnect preserve live media', () => {
  const e=setup();const a=new e.window.RTCPeerConnection();const b=new e.window.RTCPeerConnection();const track=new e.Track('audio');
  a.receive(track);b.receive(track);a.connectionState='disconnected';a.dispatch('connectionstatechange');
  assert.equal(e.a.audioSources.size,1);a.close();assert.equal(e.a.audioSources.size,1);
  b.close();noTracks(e);assert.equal(track.readyState,'live');
});

test('Unknown-peer DOM observation retires from readyState rather than an unrelated peer', () => {
  const e=setup();const track=new e.Track('video');e.a.addVideoTrack(track);const pc=new e.window.RTCPeerConnection();pc.close();
  assert.equal(e.a.allVideoTracks.length,1);track.stop();e.fire(1000);noTracks(e);
});

test('Camera classification removes only probe-specific listeners and all probe timers', () => {
  const e=setup();const track=new e.Track('video');e.a.addVideoTrack(track);const probe=e.a.videoProbes.get(track.id);
  probe.videoWidth=640;probe.videoHeight=480;probe.dispatch('loadedmetadata');
  assert.equal(e.a.videoProbes.size,0);assert.equal(probe.srcObject,null);assert.equal(probe.isConnected,false);
  assert.equal((track.listeners.get('ended')||[]).length,1);
  assert.equal((probe.listeners.get('loadedmetadata')||[]).length,0);
  assert.equal((probe.listeners.get('resize')||[]).length,0);
  assert.equal([...e.timers.values()].filter(timer=>timer.ms!==1000).length,0);
  track.endNaturally();noTracks(e);
});

for(const failure of ['failWorker','failWorkerPost']) test(`${failure}: compositor construction fallback releases URLs and partial workers`, () => {
  const e=setup({[failure]:true});e.a.startCompositorLoop(()=>{});e.a.stopCompositorLoop();
  assert.equal(e.urls.size,0);assert.equal(e.workerInventory.filter(worker=>!worker.terminated).length,0);assert.equal(e.timers.size,0);
});

test('A rejected duplicate START keeps a single session and immutable chunk IDs', async () => {
  const e=setup({deferredResume:true});configure(e);
  e.command('START',{recordingId:'A'});e.command('START',{recordingId:'B'});
  e.resumePending.splice(0).forEach(resolve=>resolve());await e.settle();
  assert.equal(e.recorderInventory.filter(recorder=>recorder.state==='recording').length,2);
  e.recorderInventory.forEach(recorder=>recorder.data());await e.settle();
  e.command('START',{recordingId:'C'});e.recorderInventory.forEach(recorder=>recorder.data());await e.settle();
  assert.deepEqual([...new Set(e.writes.map(row=>row.recordingId))].sort(),['A','A__t2']);
  await stopped(e);assert.equal(e.recorderInventory.filter(recorder=>recorder.state!=='inactive').length,0);
});

test('STOP cancels suspended startup; its late resume cannot revive or clean up a new session', async () => {
  const e=setup({deferredResume:true});configure(e);e.command('START',{recordingId:'A'});const oldCanvas=e.a.state().canvasElement;
  await stopped(e);assert.equal(e.a.state().canvasElement,null);assert.equal(e.recorderInventory.length,0);
  e.command('START',{recordingId:'B'});e.resumePending.splice(0).forEach(resolve=>resolve());await e.settle();
  assert.equal(e.recorderInventory.filter(recorder=>recorder.state==='recording').length,2);
  assert.notEqual(e.a.state().canvasElement,oldCanvas);
  assert.equal(e.messages.findLast(message=>message.event==='RECORDING_STARTED').data.recordingId,'B');
  await stopped(e);
});

test('Finalization awaits every output final event and IDB transaction before advertising completion', async () => {
  const e=setup({deferredStop:true,deferredWrites:true,finalChunkSize:32});configure(e);await start(e);
  const canvasTrack=e.a.state().recordingCanvasStream.getVideoTracks()[0];
  const stopping=e.a.stopRecording();await e.settle();
  assert.equal(e.messages.filter(message=>message.event==='RECORDING_STOPPED').length,0);
  e.command('START',{recordingId:'rejected-during-finalize'});assert.equal(e.recorderInventory.length,2);
  e.stopEvents.shift()();await e.settle();e.releaseWrites();await e.settle();
  assert.equal(e.messages.filter(message=>message.event==='RECORDING_STOPPED').length,0);
  e.releaseStops();await e.settle();assert.equal(e.pendingWrites.length,1);
  assert.equal(canvasTrack.readyState,'ended');
  e.releaseWrites();await stopping;await e.settle();
  const completion=e.messages.find(message=>message.event==='RECORDING_STOPPED');
  assert.equal(completion.data.recordingId,'A');assert.equal(completion.data.totalChunks,1);
  assert.equal(completion.data.secondaries[0].chunks,1);
  assert.deepEqual(e.writes.map(row=>row.recordingId).sort(),['A','A__t2']);
  assert.equal(e.a.state().canvasElement,null);
});

test('Unexpected main stops terminate all independent recorders across repeated restarts', async () => {
  const e=setup();configure(e);
  for(let n=0;n<10;n++) {
    await start(e,`session-${n}`);const recorders=[...e.recorderInventory];const canvasTrack=e.a.state().recordingCanvasStream.getVideoTracks()[0];
    e.a.state().mediaRecorder.autoStop();await e.settle();
    assert.equal(recorders.filter(recorder=>recorder.state!=='inactive').length,0);
    assert.equal(canvasTrack.readyState,'ended');assert.equal(e.a.state().mediaRecorder,null);
    assert.equal(e.a.secondaryRecorders.size,0);
  }
});

test('Old stop/error callbacks cannot mutate a newer recording', async () => {
  const e=setup();configure(e);await start(e,'A');const old=e.a.state().mediaRecorder;const lateStop=old.onstop;const lateError=old.onerror;
  await stopped(e);await start(e,'B');const current=e.a.state().mediaRecorder;const canvas=e.a.state().recordingCanvasStream.getVideoTracks()[0];
  lateError({error:new Error('late error')});lateStop();e.fire(3000);await e.settle();
  assert.equal(e.a.state().mediaRecorder,current);assert.equal(current.state,'recording');assert.equal(canvas.readyState,'live');
  assert.equal(e.a.secondaryRecorders.size,1);await stopped(e);
});

for(const failure of ['failAudioContext','failContext','failCapture','failMainConstructor','failMainStart']) test(`${failure}: startup rollback releases capture, handlers and busy state`, async () => {
  const e=setup({[failure]:true});configure(e);await start(e);await e.settle();
  assert.equal(e.a.state().isRecording,false);assert.equal(e.a.state().mediaRecorder,null);assert.equal(e.a.state().canvasElement,null);
  assert.equal(e.recorderInventory.filter(recorder=>recorder.state!=='inactive').length,0);
  assert.equal(e.elements.filter(element=>element.tagName==='CANVAS'&&element.srcObject).length,0);
  for(const gate of e.a.trackGains.values()) assert.equal(gate.gain.value,0);
  assert.equal(e.workerInventory.filter(worker=>!worker.terminated).length,0);
  for(const recorder of e.recorderInventory) assert.equal(recorder.ondataavailable,null);
});

test('requestData exceptions never skip main or secondary stop', async () => {
  const e=setup({failRequestData:true});configure(e);await start(e);await stopped(e);
  assert.equal(e.recorderInventory.filter(recorder=>recorder.state!=='inactive').length,0);assert.equal(e.a.state().canvasElement,null);
});

test('Failed secondary starts do not block successful output finalization', async () => {
  const e=setup({failSecondaryStart:true});configure(e);await start(e);await stopped(e);
  assert.equal(e.a.state().mediaRecorder,null);assert.equal(e.a.secondaryRecorders.size,0);
  assert.equal(e.messages.find(message=>message.event==='RECORDING_STOPPED').data.secondaries.length,0);
});

test('Output config changes retain active output metadata and destinations through final save', async () => {
  const e=setup({finalChunkSize:8});configure(e);await start(e);const secondary=e.a.secondaryRecorders.get(2);const destination=secondary.recorder.stream.getAudioTracks()[0];
  e.command('SET_AUDIO_TRACKS',{list:[outputs[0]]});assert.equal(e.a.secondaryRecorders.get(2),secondary);assert.equal(destination.readyState,'live');
  await stopped(e);const completion=e.messages.find(message=>message.event==='RECORDING_STOPPED');
  assert.equal(completion.data.secondaries[0].recordingId,'A__t2');assert.equal(completion.data.secondaries[0].name,'Extra');
  assert.equal(completion.data.secondaries[0].chunks,1);assert.equal(destination.readyState,'ended');
  assert.equal(e.a.trackDestNodes.has(2),false);
});

test('Ordinary Stop releases only session-owned capture and preserves remote first-source reuse', async () => {
  const e=setup();configure(e);const pc=new e.window.RTCPeerConnection();const remote=new e.Track('audio');pc.receive(remote);
  const source=e.a.audioSources.get(remote.id);const sink=e.a.trackSinkEls.get(remote.id);
  for(let n=0;n<3;n++) {await start(e,`normal-${n}`);const canvas=e.a.state().recordingCanvasStream.getVideoTracks()[0];await stopped(e);assert.equal(canvas.readyState,'ended');}
  assert.equal(e.a.audioSources.get(remote.id),source);assert.equal(e.a.trackSinkEls.get(remote.id),sink);assert.equal(sink.isConnected,true);
  assert.equal(remote.readyState,'live');assert.equal(e.a.state().audioCtx.state,'running');assert.equal(e.a.trackDestNodes.size,2);
  assert.equal(e.nodes.filter(node=>node.mediaStream?.getAudioTracks().includes(remote)).length,1);
  assert.equal(e.workerInventory.filter(worker=>!worker.terminated).length,0);remote.endNaturally();noTracks(e);
});

test('Source construction failure immediately detaches partial priming sink', () => {
  const e=setup({failAudioSource:true});const track=new e.Track('audio');e.a.addAudioTrack(track);
  assert.equal(e.a.trackSinkEls.size,0);assert.equal(e.a.audioSources.size,0);assert.equal(e.elements.filter(element=>element.isConnected&&element.srcObject).length,0);
  track.stop();e.fire(1000);noTracks(e);
});

test('Aborted chunk transactions drain and mark completion without hanging cleanup', async () => {
  const e=setup({failWrite:true,finalChunkSize:8});configure(e);await start(e);await stopped(e);
  const completion=e.messages.find(message=>message.event==='RECORDING_STOPPED');
  assert.equal(completion.data.writeFailed,true);assert.equal(completion.data.totalChunks,0);assert.equal(e.a.state().canvasElement,null);
});

test('Repeated injection adds no constructor wrappers or window listeners', () => {
  const e=setup();const constructor=e.window.RTCPeerConnection;const listenerCount=[...e.window.listeners.values()].reduce((count,list)=>count+list.length,0);
  for(let n=0;n<10;n++) vm.runInContext(original,e.context);
  assert.equal(e.window.RTCPeerConnection,constructor);assert.equal([...e.window.listeners.values()].reduce((count,list)=>count+list.length,0),listenerCount);
});

test('Partial root AudioContext graph failure stops allocated destination and permits retry', async () => {
  const e=setup({failGainAt:1});await start(e,'fails');
  assert.equal(e.a.state().audioCtx,null);assert.equal(e.a.trackDestNodes.size,0);
  assert.equal(e.nodes.filter(node=>node.stream).every(node=>node.stream.getTracks().every(track=>track.readyState==='ended')),true);
  await start(e,'retry');assert.equal(e.a.state().isRecording,true);await stopped(e);
});

test('Partial custom output graph failure disconnects nodes and stops its destination', async () => {
  const e=setup({failGainAt:3});configure(e);await start(e,'fails');
  assert.equal(e.a.state().isRecording,false);
  const destinations=e.nodes.filter(node=>node.stream);
  assert.ok(destinations.length>=2);assert.equal(destinations[1].stream.getTracks()[0].readyState,'ended');
  await start(e,'retry');assert.equal(e.a.state().isRecording,true);await stopped(e);
});

test('Main error finalizes all outputs once even when a later stop event repeats', async () => {
  const e=setup({finalChunkSize:4});configure(e);await start(e);const error=e.a.state().mediaRecorder.onerror;
  error({error:new Error('fixture: native recorder error')});await e.settle();error({error:new Error('repeat')});await e.settle();
  assert.equal(e.recorderInventory.filter(recorder=>recorder.state!=='inactive').length,0);
  assert.equal(e.messages.filter(message=>message.event==='RECORDING_STOPPED').length,1);assert.equal(e.a.state().canvasElement,null);
});

test('Pause, resume and stop preserve all outputs and leave no drawing worker', async () => {
  const e=setup();configure(e);await start(e);e.command('PAUSE');
  assert.equal(e.recorderInventory.every(recorder=>recorder.state==='paused'),true);
  assert.equal(e.workerInventory.filter(worker=>!worker.terminated).length,0);
  e.command('RESUME');assert.equal(e.recorderInventory.every(recorder=>recorder.state==='recording'),true);
  assert.equal(e.workerInventory.filter(worker=>!worker.terminated).length,1);
  e.command('PAUSE');await stopped(e);assert.equal(e.recorderInventory.every(recorder=>recorder.state==='inactive'),true);
  assert.equal(e.workerInventory.filter(worker=>!worker.terminated).length,0);
});

test('Retiring one live screen-share registration preserves another share and its probe', () => {
  const e=setup();const pc=new e.window.RTCPeerConnection();const a=new e.Track('video');const b=new e.Track('video');a.contentHint=b.contentHint='detail';
  pc.receive(a);pc.receive(b);a.stop();e.fire(1000);
  assert.equal(e.a.videoProbes.size,1);assert.equal(e.a.activeScreenShareTracks.length,1);assert.equal(e.a.activeScreenShareTracks[0],b);
  assert.equal(e.a.trackStreamMap.size,1);assert.equal(b.readyState,'live');b.endNaturally();noTracks(e);
});

test('Failed ICE recovery preserves exact receiver resources and local sender visibility', async () => {
  const e=setup();configure(e);const pc=new e.window.RTCPeerConnection();
  const audio=new e.Track('audio'),video=new e.Track('video'),local=new e.Track('audio');
  pc.senders=[{track:local}];pc.receive(audio);pc.receive(video);
  e.command('SET_RECORD_MY_MIC',{enabled:true});await start(e);
  const source=e.a.audioSources.get(audio.id),sink=e.a.trackSinkEls.get(audio.id),probe=e.a.videoProbes.get(video.id);
  const localSource=e.nodes.find(node=>node.mediaStream?.getAudioTracks().includes(local));
  assert.ok(localSource.edges.size>0);
  for(const state of ['failed','connecting','connected']) {
    pc.connectionState=state;pc.dispatch('connectionstatechange');e.fire(1000);
    assert.equal(e.a.activePeerConnections.has(pc),true);
    assert.equal(e.a.audioSources.get(audio.id),source);assert.equal(e.a.trackSinkEls.get(audio.id),sink);
    assert.equal(e.a.videoProbes.get(video.id),probe);assert.equal(probe.isConnected,true);
    assert.equal(sink.isConnected,true);assert.ok(source.edges.size>0);assert.ok(localSource.edges.size>0);
  }
  pc.receive(audio);assert.equal(e.a.audioSources.get(audio.id),source);
  assert.equal(e.nodes.filter(node=>node.mediaStream?.getAudioTracks().includes(audio)).length,1);
  const recoveredVideo=new e.Track('video');pc.receive(recoveredVideo);assert.equal(e.a.videoProbes.has(recoveredVideo.id),true);
  await stopped(e);assert.equal(local.readyState,'live');assert.equal(audio.readyState,'live');
  pc.close();noTracks(e);assert.equal(video.readyState,'live');assert.equal(recoveredVideo.readyState,'live');
});

test('Deferred next-output allocation failure still delivers exactly one immutable saved-session completion', async () => {
  const e=setup({failGainAt:6,finalChunkSize:8});configure(e);await start(e,'saved-before-allocation-error');
  const nextOutput={id:3,name:'Next',targets:['EVERYONE']};
  e.command('SET_AUDIO_TRACKS',{list:[outputs[0],nextOutput]});await stopped(e);
  const completions=e.messages.filter(message=>message.event==='RECORDING_STOPPED');
  assert.equal(completions.length,1);assert.equal(completions[0].data.recordingId,'saved-before-allocation-error');
  assert.equal(completions[0].data.totalChunks,1);
  assert.deepEqual(Array.from(completions[0].data.secondaries,entry=>[entry.recordingId,entry.name,entry.chunks]),[['saved-before-allocation-error__t2','Extra',1]]);
  assert.deepEqual(e.writes.map(row=>row.recordingId).sort(),['saved-before-allocation-error','saved-before-allocation-error__t2']);
  assert.equal(e.a.state().activeSession,null);assert.equal(e.a.state().canvasElement,null);
  assert.equal(e.recorderInventory.every(recorder=>recorder.state==='inactive'),true);
  assert.ok(e.messages.some(message=>message.event==='WARN'&&message.data.includes('Next recording audio graph setup failed')));
  assert.equal(e.a.trackDestNodes.has(2),false);assert.equal(e.a.trackDestNodes.has(3),false);
  await start(e,'retry-next-configuration');assert.equal(e.a.secondaryRecorders.has(3),true);
  await stopped(e);assert.equal(e.messages.filter(message=>message.event==='RECORDING_STOPPED').length,2);
});

function assertRemoteOutputRoute(e,remote,source,sink,id) {
  const gain=e.a.trackGainNodes.get(remote.id),mixer=e.a.trackMixers.get(id),gate=e.a.trackGains.get(id),destination=e.a.trackDestNodes.get(id);
  assert.equal(e.a.audioSources.get(remote.id),source);assert.equal(e.a.trackSinkEls.get(remote.id),sink);
  assert.ok(source.edges.has(gain));assert.ok(gain.edges.has(mixer));assert.ok(mixer.edges.has(gate));assert.ok(gate.edges.has(destination));
  assert.equal(gate.gain.value,1);assert.equal(e.a.secondaryRecorders.get(id).recorder.stream.getAudioTracks()[0],destination.stream.getAudioTracks()[0]);
  assert.equal(remote.readyState,'live');assert.equal(e.nodes.filter(node=>node.mediaStream?.getAudioTracks().includes(remote)).length,1);
}

function failNextGraphOnce(e,mode,remoteGain) {
  const proto=e.context.AudioContext.prototype,originalDestination=proto.createMediaStreamDestination,originalGain=proto.createGain;
  let fired=false,ordinal=0;
  proto.createMediaStreamDestination=function() {
    if(e.a.state().activeSession===null&&mode==='destination'&&!fired) {fired=true;throw new Error('fixture: deferred destination');}
    return originalDestination.call(this);
  };
  proto.createGain=function() {
    const next=e.a.state().activeSession===null;
    if(next) ordinal++;
    if(next&&!fired&&((mode==='first-gain'&&ordinal===1)||(mode==='second-gain'&&ordinal===2))) {fired=true;throw new Error('fixture: deferred gain');}
    const node=originalGain.call(this);
    if(next&&!fired&&mode==='parameter'&&ordinal===1) {
      const original=node.gain.setValueAtTime;
      node.gain.setValueAtTime=function(...args) {if(!fired) {fired=true;throw new Error('fixture: deferred parameter');}return original.apply(this,args);};
    }
    if(next&&!fired&&((mode==='mixer-connect'&&ordinal===2)||(mode==='gate-connect'&&ordinal===1))) {
      const original=node.connect;
      node.connect=function(...args) {if(!fired) {fired=true;throw new Error('fixture: deferred node connection');}return original.apply(this,args);};
    }
    return node;
  };
  if(mode==='route-connect') {
    const original=remoteGain.connect;
    remoteGain.connect=function(target) {
      if(e.a.state().activeSession===null&&target===e.a.trackMixers.get(3)&&!fired) {fired=true;throw new Error('fixture: deferred input routing');}
      return original.call(this,target);
    };
  }
  return ()=>fired;
}

for(const failure of ['destination','first-gain','second-gain','parameter','mixer-connect','gate-connect','route-connect']) test(`Retry repairs real remote-to-output route after deferred ${failure} failure`, async () => {
  const e=setup({finalChunkSize:8});configure(e);const pc=new e.window.RTCPeerConnection(),remote=new e.Track('audio');pc.receive(remote);
  const source=e.a.audioSources.get(remote.id),sink=e.a.trackSinkEls.get(remote.id),gain=e.a.trackGainNodes.get(remote.id);
  await start(e,'completed-before-route-retry');e.command('SET_AUDIO_TRACKS',{list:[outputs[0],{id:3,name:'New remote output',targets:['EVERYONE']}]});
  const fired=failNextGraphOnce(e,failure,gain);await stopped(e);assert.equal(fired(),true);
  const completed=e.messages.filter(message=>message.event==='RECORDING_STOPPED');assert.equal(completed.length,1);assert.equal(completed[0].data.recordingId,'completed-before-route-retry');
  await start(e,'retry-actually-routed');assert.equal(e.a.state().isRecording,true);
  assertRemoteOutputRoute(e,remote,source,sink,3);await stopped(e);pc.close();noTracks(e);
});

test('Persistent accepted-start routing failure rolls back idle instead of announcing a silent output', async () => {
  const e=setup();configure(e);const pc=new e.window.RTCPeerConnection(),remote=new e.Track('audio');pc.receive(remote);
  const source=e.a.audioSources.get(remote.id),sink=e.a.trackSinkEls.get(remote.id),gain=e.a.trackGainNodes.get(remote.id);
  await start(e,'completed');e.command('SET_AUDIO_TRACKS',{list:[outputs[0],{id:3,name:'New remote output',targets:['EVERYONE']}]});await stopped(e);
  const before=e.recorderInventory.length,originalConnect=gain.connect;
  gain.connect=function(target) {if(target===e.a.trackMixers.get(3)) throw new Error('fixture: persistent routing failure');return originalConnect.call(this,target);};
  await start(e,'must-not-record');assert.equal(e.a.state().isRecording,false);assert.equal(e.a.state().activeSession,null);assert.equal(e.a.state().canvasElement,null);
  assert.equal(e.recorderInventory.length,before);assert.equal(e.recorderInventory.every(recorder=>recorder.state==='inactive'),true);
  assert.equal(e.messages.some(message=>message.event==='RECORDING_STARTED'&&message.data.recordingId==='must-not-record'),false);
  assert.ok(e.messages.some(message=>message.event==='RECORDING_IDLE'&&message.data.recordingId==='must-not-record'));
  assert.equal(e.a.audioSources.get(remote.id),source);assert.equal(e.a.trackSinkEls.get(remote.id),sink);assert.equal(remote.readyState,'live');
  for(const gate of e.a.trackGains.values()) assert.equal(gate.gain.value,0);
  gain.connect=originalConnect;await start(e,'repaired');assertRemoteOutputRoute(e,remote,source,sink,3);await stopped(e);pc.close();noTracks(e);
});

test('No incoming media stops after ten seconds despite generated tracks and pause', async () => {
  const e=setup({finalChunkSize:20});await start(e);e.command('PAUSE');
  const canvas=e.a.state().recordingCanvasStream.getVideoTracks()[0];assert.equal(canvas.readyState,'live');
  for(let i=0;i<9;i++) {e.advanceTime(1000);e.fire(1000);await e.settle();assert.equal(e.messages.filter(m=>m.event==='RECORDING_STOPPED').length,0);}
  e.advanceTime(1000);e.fire(1000);await e.settle();
  assert.equal(e.messages.filter(m=>m.event==='RECORDING_STOPPED').length,1);assert.equal(canvas.readyState,'ended');
  assert.equal(e.messages.findLast(m=>m.event==='MEETING_ACTIVITY').data.seconds,0);
  assert.equal(e.writes.length,1);
});

test('Silent incoming audio/static video remain valid and recovery cancels media-loss countdown', async () => {
  const e=setup(),pc=new e.window.RTCPeerConnection(),remote=new e.Track('audio');pc.receive(remote);await start(e);
  for(let i=0;i<12;i++) {e.advanceTime(1000);e.fire(1000);await e.settle();}
  assert.equal(e.a.state().isRecording,true);assert.equal(e.messages.filter(m=>m.event==='MEETING_ACTIVITY').length,0);
  remote.muted=true;e.advanceTime(1000);e.fire(1000);assert.equal(e.messages.findLast(m=>m.event==='MEETING_ACTIVITY').data.seconds,10);
  for(let i=0;i<5;i++) {e.advanceTime(1000);e.fire(1000);}
  remote.muted=false;e.advanceTime(1000);e.fire(1000);assert.equal(e.messages.findLast(m=>m.event==='MEETING_ACTIVITY').data.state,'activity_restored');
  const staticVideo=new e.Track('video');pc.receive(staticVideo);remote.endNaturally();
  for(let i=0;i<12;i++) {e.advanceTime(1000);e.fire(1000);await e.settle();}assert.equal(e.a.state().isRecording,true);await stopped(e);
});

test('Recoverable disconnected peer starts grace period while retaining exact remote sources', async () => {
  const e=setup(),pc=new e.window.RTCPeerConnection(),remote=new e.Track('audio');pc.receive(remote);const source=e.a.audioSources.get(remote.id);await start(e);
  pc.connectionState='disconnected';pc.dispatch('connectionstatechange');e.advanceTime(1000);e.fire(1000);
  assert.equal(e.messages.findLast(m=>m.event==='MEETING_ACTIVITY').data.seconds,10);assert.equal(e.a.audioSources.get(remote.id),source);
  pc.connectionState='connected';e.advanceTime(1000);e.fire(1000);assert.equal(e.messages.findLast(m=>m.event==='MEETING_ACTIVITY').data.state,'activity_restored');await stopped(e);
});

test('Cancelling leave confirmation preserves recording; actual pagehide requests final flush', async () => {
  const e=setup({deferredResume:true,finalChunkSize:12});e.command('START',{recordingId:'closing'});
  let prevented=0;const warning={preventDefault(){prevented++;},returnValue:null};e.window.dispatch('beforeunload',warning);assert.equal(prevented,1);assert.equal(warning.returnValue,'');
  e.resumePending.splice(0).forEach(fn=>fn());await e.settle();const recorder=e.a.state().mediaRecorder;
  e.window.dispatch('beforeunload',warning);assert.equal(recorder.state,'recording');
  e.window.dispatch('pagehide',{persisted:false});await e.settle();assert.equal(e.messages.filter(m=>m.event==='RECORDING_STOPPED').length,1);assert.equal(e.writes.length,1);
  e.window.dispatch('beforeunload',warning);assert.equal(prevented,2);
});

test('Missing native stop callbacks finalize boundedly and mark committed output incomplete', async () => {
  const e=setup({deferredStop:true});configure(e);await start(e);e.recorderInventory.forEach(r=>r.data(24));await e.settle();const stopping=e.a.stopRecording();await e.settle();
  assert(e.a.state().activeSession);e.fire(5000);await stopping;await e.settle();
  const event=e.messages.find(m=>m.event==='RECORDING_STOPPED');assert.equal(event.data.incomplete,true);assert.equal(event.data.totalChunks,1);assert.equal(event.data.secondaries[0].chunks,1);assert.equal(e.a.state().activeSession,null);
  await start(e,'new');e.releaseStops();await e.settle();assert.equal(e.a.state().mediaRecorder.state,'recording');
  const end=e.a.stopRecording();e.releaseStops();await end;
});

test('Stalled IDB drain releases busy state without deleting data or leaking old chunk progress', async () => {
  const e=setup({deferredWrites:true});await start(e,'stalled');e.a.state().mediaRecorder.data(24);await e.settle();const stopping=e.a.stopRecording();await e.settle();e.fire(10000);await stopping;
  const event=e.messages.find(m=>m.event==='RECORDING_STOPPED');assert.equal(event.data.incomplete,true);await start(e,'new');const before=e.messages.filter(m=>m.event==='CHUNK_SAVED').length;
  e.releaseWrites();await e.settle();assert.equal(e.messages.filter(m=>m.event==='CHUNK_SAVED').length,before);assert.equal(e.a.state().mediaRecorder.state,'recording');await stopped(e);
});

test('Local senders and a self-preview do not count as incoming meeting media', async () => {
  const e=setup(),pc=new e.window.RTCPeerConnection(),local=new e.Track('video');pc.senders=[{track:local}];pc.receive(local);
  const preview=e.context.document.createElement('video');preview.srcObject={getTracks:()=>[local]};preview.closest=()=>({textContent:"You're continuously framed",querySelector:()=>null});e.context.document.body.appendChild(preview);
  await start(e);
  for(let i=0;i<10;i++){e.advanceTime(1000);e.fire(1000);await e.settle();}assert.equal(e.messages.filter(m=>m.event==='RECORDING_STOPPED').length,1);
  const dom=setup(),video=new dom.Track('video'),self=dom.context.document.createElement('video');self.srcObject={getTracks:()=>[video]};self.closest=()=>({textContent:'Backgrounds and visual effects',querySelector:()=>null});dom.context.document.body.appendChild(self);dom.a.addVideoTrack(video);
  await start(dom);for(let i=0;i<10;i++){dom.advanceTime(1000);dom.fire(1000);await dom.settle();}assert.equal(dom.messages.filter(m=>m.event==='RECORDING_STOPPED').length,1);
});
