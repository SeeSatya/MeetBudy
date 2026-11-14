'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {setup} = require('./fixtures/page-runtime.cjs');

const avatar = (person, size = 31) => `https://lh3.googleusercontent.com/${person}=s${size}-c`;
const normalized = url => url.replace(/=s\d+/, '=s200');
function tile(e, id, name, options = {}) {
  const document = e.context.document;
  const el = document.createElement('div');
  el.setAttribute('data-participant-id', id);
  const button = document.createElement('button');
  button.setAttribute('aria-label', `More options for ${name}`);
  el.appendChild(button);
  if (options.self) el.textContent = "You're continuously framed";
  if (options.speaking) el.style = {borderStyle: 'solid', borderWidth: '2px', borderColor: 'rgb(26, 115, 232)'};
  const out = {el, button};
  out.setName = value => button.setAttribute('aria-label', `More options for ${value}`);
  out.setAvatar = url => {
    if (!out.img) { out.img = document.createElement('img'); el.appendChild(out.img); }
    out.img.src = url;
  };
  if (options.avatar) out.setAvatar(options.avatar);
  if (options.stream) {
    out.media = document.createElement(options.tag || 'video');
    out.media.srcObject = options.stream;
    out.media.videoWidth = 640; out.media.videoHeight = 360; out.media.readyState = 4;
    el.appendChild(out.media);
  }
  document.body.appendChild(el);
  return out;
}
function remote(e, name, options = {}) {
  const pc = new e.window.RTCPeerConnection();
  pc.connectionState = 'connected';
  const audio = new e.Track('audio');
  const stream = new e.Stream([audio, new e.Track('video')]);
  const view = tile(e, options.id || name, name, {...options, stream});
  pc.receive(audio, stream);
  return {...view, pc, audio, stream};
}
async function start(e, id = 'identity-test') {
  await e.a.startRecording(id); await e.settle();
  assert.equal(e.a.state().isRecording, true);
}
async function stop(e) { await e.a.stopRecording(); await e.settle(); }
async function refresh(e) { e.advanceTime(1000); e.fire(1000); await e.settle(); }
function render(e) {
  e.a.renderSpeakersOverlay(e.context.document.createElement('canvas').getContext('2d'));
}
function card(e, audio) { return e.a.activeSpeakers.get(`track:${audio.id}`); }
function assertIdentity(e, audio, name, url) {
  const identity = e.a.audioTrackToParticipant.get(audio.id);
  assert.equal(identity?.name, name);
  assert.equal(identity?.avatarUrl, url ? normalized(url) : null);
}

test('First capture has modern tile names and preloaded avatars without any speech or compositor tick', async () => {
  let captures = 0, snapshot;
  const e = setup({loadedAvatars: true, onCapture(a) {
    captures++;
    snapshot = {
      names: [alice, bob].map(view => a.audioTrackToParticipant.get(view.audio.id)?.name),
      imageWidths: ['Alice', 'Bob', 'Local'].map(name => a.avatarImageCache.get(avatar(name, 200))?.naturalWidth),
    };
  }});
  tile(e, 'self', 'Local', {self: true, avatar: avatar('Local')});
  const alice = remote(e, 'Alice', {avatar: avatar('Alice')});
  const bob = remote(e, 'Bob', {avatar: avatar('Bob')});
  await start(e);
  assert.deepEqual(snapshot.names, ['Alice', 'Bob']);
  assert.deepEqual(snapshot.imageWidths, [200, 200, 200]);
  assert.equal(captures, 1); assert.equal(e.a.activeSpeakers.size, 0);
  e.a.audioLevels.set(alice.audio.id, 0.2); render(e);
  assert.equal(card(e, alice.audio)?.name, 'Alice');
  assert.ok(e.canvasCalls.some(call => call.name === 'drawImage' && call.args[0].src === avatar('Alice', 200)));
  assert.ok(e.canvasCalls.some(call => call.name === 'fillText' && call.args[0] === 'Alice'));
  await stop(e);
});

test('Startup waits for visible avatar loads before capture, including the local avatar', async () => {
  let captures = 0;
  const e = setup({onCapture() { captures++; }});
  tile(e, 'self', 'Local', {self: true, avatar: avatar('Local')});
  remote(e, 'Alice', {avatar: avatar('Alice')});
  const starting = e.a.startRecording('pending-images'); await e.settle();
  assert.equal(captures, 0);
  assert.equal([...e.timers.values()].filter(timer => timer.ms === 750).length, 1);
  e.images.filter(img => img.src).forEach(img => img.load());
  await starting; assert.equal(captures, 1);
  assert.equal([...e.timers.values()].filter(timer => timer.ms === 750).length, 0);
  await stop(e);
});

test('Unavailable avatars cannot indefinitely block startup and failed images use initials', async () => {
  const e = setup(); const alice = remote(e, 'Alice', {avatar: avatar('Alice')});
  const starting = e.a.startRecording('image-timeout'); await e.settle();
  assert.equal(e.a.state().isRecording, false);
  e.fire(750); await starting; await e.settle();
  e.images.filter(img => img.src).forEach(img => img.load(false));
  e.a.audioLevels.set(alice.audio.id, 0.2); render(e);
  assert.equal(card(e, alice.audio)?.name, 'Alice');
  assert.equal(e.canvasCalls.some(call => call.name === 'drawImage'), false);
  await stop(e);
});

test('Failed profile photos retry the same URL during recording and replace the initials', async () => {
  const e = setup(); const alice = remote(e, 'Alice', {avatar: avatar('Alice')});
  const starting = e.a.startRecording('retry-image'); await e.settle();
  const original = e.a.avatarImageCache.get(normalized(avatar('Alice')));
  original.load(false); await starting;
  e.advanceTime(4000); e.fire(1000); await e.settle();
  assert.equal(e.a.avatarImageCache.get(normalized(avatar('Alice'))), original);
  await refresh(e);
  const retry = e.a.avatarImageCache.get(normalized(avatar('Alice')));
  assert.notEqual(retry, original);
  assert.equal(original.src, '');
  retry.load(); e.a.audioLevels.set(alice.audio.id, 0.2); render(e);
  assert.ok(e.canvasCalls.some(call => call.name === 'drawImage' && call.args[0] === retry));
  await stop(e);
});

test('A stalled profile photo request is replaced without another recording', async () => {
  const e = setup(); remote(e, 'Alice', {avatar: avatar('Alice')});
  const starting = e.a.startRecording('stalled-image'); await e.settle();
  const original = e.a.avatarImageCache.get(normalized(avatar('Alice')));
  e.fire(750); await starting;
  e.advanceTime(10000); e.fire(1000); await e.settle();
  const retry = e.a.avatarImageCache.get(normalized(avatar('Alice')));
  assert.notEqual(retry, original);
  assert.equal(original.src, '');
  assert.equal(original.onload, null); assert.equal(original.onerror, null);
  retry.load(); assert.equal(retry.naturalWidth, 200);
  await stop(e);
});

test('Late avatars refresh already resolved remote and local identities during silence', async () => {
  const e = setup({loadedAvatars: true});
  const self = tile(e, 'self', 'Local', {self: true});
  const alice = remote(e, 'Alice'); await start(e);
  assertIdentity(e, alice.audio, 'Alice', null);
  self.setAvatar(avatar('Local')); alice.setAvatar(avatar('Alice'));
  await refresh(e);
  assertIdentity(e, alice.audio, 'Alice', avatar('Alice'));
  assert.equal(e.a.getLocalUserInfo().avatarUrl, avatar('Local', 200));
  assert.equal(e.a.avatarImageCache.get(avatar('Alice', 200))?.naturalWidth, 200);
  e.a.audioLevels.set(alice.audio.id, 0.2); render(e);
  assert.equal(card(e, alice.audio)?.avatarUrl, avatar('Alice', 200));
  await stop(e);
});

test('A complete avatar cache refreshes changed local and remote URLs', async () => {
  const e = setup({loadedAvatars: true});
  const self = tile(e, 'self', 'Local', {self: true, avatar: avatar('Local')});
  const alice = remote(e, 'Alice', {avatar: avatar('Alice')}); await start(e);
  self.setAvatar(avatar('new-Local')); alice.setAvatar(avatar('new-Alice'));
  await refresh(e);
  assertIdentity(e, alice.audio, 'Alice', avatar('new-Alice'));
  assert.equal(e.a.getLocalUserInfo().avatarUrl, avatar('new-Local', 200));
  await stop(e);
});

test('An already speaking resolved card updates its avatar instead of freezing the first result', async () => {
  const e = setup({loadedAvatars: true}); const alice = remote(e, 'Alice');
  await start(e); e.a.audioLevels.set(alice.audio.id, 0.2); render(e);
  const visibleCard = () => [...e.a.activeSpeakers.values()].find(speaker => speaker.name === 'Alice');
  assert.equal(visibleCard()?.name, 'Alice');
  assert.equal(visibleCard()?.avatarUrl, null);
  alice.setAvatar(avatar('Alice')); await refresh(e); render(e);
  assert.equal(visibleCard()?.avatarUrl, avatar('Alice', 200));
  await stop(e);
});

test('Identity refresh continues while paused and does not depend on rendering speaker cards', async () => {
  const e = setup({loadedAvatars: true}); const alice = remote(e, 'Alice');
  await start(e); e.command('PAUSE');
  assert.equal(e.a.state().timerWorker, null);
  alice.setAvatar(avatar('Alice')); await refresh(e);
  assertIdentity(e, alice.audio, 'Alice', avatar('Alice'));
  assert.equal(e.a.activeSpeakers.size, 0);
  await stop(e);
});

test('Late tiles and new joins warm every directly bound audio track before speech', async () => {
  const e = setup({loadedAvatars: true});
  const pc = new e.window.RTCPeerConnection(); pc.connectionState = 'connected';
  const audio = new e.Track('audio'); const stream = pc.receive(audio);
  await start(e); assert.equal(e.a.audioTrackToParticipant.has(audio.id), false);
  tile(e, 'late', 'Alice', {stream, avatar: avatar('Alice')});
  const bob = remote(e, 'Bob', {avatar: avatar('Bob')});
  await refresh(e);
  assertIdentity(e, audio, 'Alice', avatar('Alice'));
  assertIdentity(e, bob.audio, 'Bob', avatar('Bob'));
  await stop(e);
});

test('A video stream ID binds a separate incoming audio stream even without a shared track', async () => {
  const e = setup({loadedAvatars: true});
  const pc = new e.window.RTCPeerConnection(); pc.connectionState = 'connected';
  const audio = new e.Track('audio'); const received = pc.receive(audio);
  const visible = new e.Stream([new e.Track('video')]); visible.id = received.id;
  tile(e, 'alice', 'Alice', {stream: visible, avatar: avatar('Alice')});
  await start(e); assertIdentity(e, audio, 'Alice', avatar('Alice')); await stop(e);
});

test('Direct contained audio tracks resolve even when signaling provides no stream ID', async () => {
  const e = setup({loadedAvatars: true}); const alice = remote(e, 'Alice', {avatar: avatar('Alice')});
  e.a.trackStreamMap.delete(alice.audio.id);
  await start(e); assertIdentity(e, alice.audio, 'Alice', avatar('Alice')); await stop(e);
});

test('Direct bindings cover every audio track in the media stream, including Meet audio elements', async () => {
  const e = setup({loadedAvatars: true}); const pc = new e.window.RTCPeerConnection(); pc.connectionState = 'connected';
  const a = new e.Track('audio'), b = new e.Track('audio'), stream = new e.Stream([a, b]);
  tile(e, 'alice', 'Alice', {stream, tag: 'audio', avatar: avatar('Alice')});
  pc.receive(a, stream); pc.receive(b, stream);
  await start(e);
  assertIdentity(e, a, 'Alice', avatar('Alice')); assertIdentity(e, b, 'Alice', avatar('Alice'));
  e.a.audioLevels.set(a.id, 0.2); e.a.audioLevels.set(b.id, 0.2); render(e);
  assert.equal(e.canvasCalls.filter(call => call.name === 'fillText' && call.args[0] === 'Alice').length, 1);
  await stop(e);
});

test('Reused streams change identity and avatar and immediately replace old speaker cards', async () => {
  const e = setup({loadedAvatars: true}); const alice = remote(e, 'Alice', {avatar: avatar('Alice')});
  await start(e); e.a.audioLevels.set(alice.audio.id, 0.2); render(e);
  alice.el.setAttribute('data-participant-id', 'bob'); alice.setName('Bob'); alice.setAvatar(avatar('Bob'));
  await refresh(e); render(e);
  assertIdentity(e, alice.audio, 'Bob', avatar('Bob'));
  assert.equal(card(e, alice.audio)?.name, 'Bob');
  assert.equal([...e.a.activeSpeakers.values()].some(speaker => speaker.name === 'Alice'), false);
  await stop(e);
});

test('Reassigned streams with missing metadata invalidate the old identity instead of retaining it', async () => {
  const e = setup({loadedAvatars: true}); const alice = remote(e, 'Alice', {avatar: avatar('Alice')});
  await start(e);
  alice.el.setAttribute('data-participant-id', 'unknown'); alice.setName(''); alice.img.remove();
  await refresh(e);
  assert.equal(e.a.audioTrackToParticipant.has(alice.audio.id), false);
  assert.equal(e.a.participantTileCache.has(alice.stream.id), false);
  e.a.audioLevels.set(alice.audio.id, 0.2); render(e); assert.equal(card(e, alice.audio)?.name, 'Speaker');
  alice.setName('Bob'); await refresh(e); assertIdentity(e, alice.audio, 'Bob', null);
  await stop(e);
});

test('A changed name on the same participant ID does not carry over the previous avatar', async () => {
  const e = setup({loadedAvatars: true}); const alice = remote(e, 'Alice', {avatar: avatar('Alice')});
  await start(e); alice.setName('Bob'); alice.img.remove();
  await refresh(e); assertIdentity(e, alice.audio, 'Bob', null); await stop(e);
});

test('Virtualized known participants retain identity and refresh metadata through camera-off tiles', async () => {
  const e = setup({loadedAvatars: true}); const alice = remote(e, 'Alice', {id: 'alice'});
  await start(e); alice.el.remove();
  tile(e, 'alice', 'Alice', {avatar: avatar('Alice')}); await refresh(e);
  assertIdentity(e, alice.audio, 'Alice', avatar('Alice'));
  await stop(e);
});

test('Startup and later recordings preserve directly observed identities after their tiles are virtualized', async () => {
  const e = setup({loadedAvatars: true}); const alice = remote(e, 'Alice', {avatar: avatar('Alice')});
  assert.equal(e.a.getParticipantForTrack(alice.audio.id)?.name, 'Alice');
  alice.el.remove(); tile(e, 'visible', 'Bob');
  for (let i = 0; i < 2; i++) {
    await start(e, `virtualized-${i}`);
    assertIdentity(e, alice.audio, 'Alice', avatar('Alice'));
    assert.equal(e.a.avatarImageCache.get(avatar('Alice', 200))?.naturalWidth, 200);
    await stop(e);
    assert.equal(e.a.avatarImageCache.size, 0);
    assert.equal(e.a.getParticipantForTrack(alice.audio.id)?.name, 'Alice');
  }
  alice.audio.endNaturally();
  assert.equal(e.a.audioTrackToParticipant.has(alice.audio.id), false);
});

test('The sole visible remote tile cannot identify unrelated or virtualized audio tracks', async () => {
  const e = setup({loadedAvatars: true}); tile(e, 'visible', 'Alice', {avatar: avatar('Alice')});
  const pc = new e.window.RTCPeerConnection(); pc.connectionState = 'connected';
  const audio = new e.Track('audio'); pc.receive(audio);
  await start(e);
  assert.equal(e.a.getParticipantForTrack(audio.id), null);
  e.a.audioLevels.set(audio.id, 0.2); render(e); assert.equal(card(e, audio)?.name, 'Speaker');
  await stop(e);
});

test('Direct track evidence takes precedence over a different sole visible remote tile', async () => {
  const e = setup({loadedAvatars: true}); const bob = remote(e, 'Bob'); await start(e);
  bob.el.remove(); tile(e, 'visible', 'Alice'); await refresh(e);
  assert.equal(e.a.getParticipantForTrack(bob.audio.id)?.name, 'Bob'); await stop(e);
});

test('Self markers and avatar resolution variants cannot poison remote identity or correlation', async () => {
  const e = setup({loadedAvatars: true});
  const local = remote(e, 'Local', {self: true, speaking: true, avatar: avatar('Local')});
  tile(e, 'impostor', 'Someone Else', {avatar: avatar('Local', 200), speaking: true});
  await start(e); e.a.audioLevels.set(local.audio.id, 0.2);
  for (let i = 0; i < 5; i++) { e.advanceTime(501); render(e); }
  assert.equal(e.a.audioTrackToParticipant.has(local.audio.id), false);
  assert.equal(card(e, local.audio)?.name, 'Speaker');
  await stop(e);
});

test('Shared ancestors and nested participant wrappers cannot borrow a sibling identity', async () => {
  const e = setup({loadedAvatars: true});
  const pc = new e.window.RTCPeerConnection(); pc.connectionState = 'connected';
  const audio = new e.Track('audio'); const stream = pc.receive(audio);
  const wrapper = e.context.document.createElement('div'); wrapper.setAttribute('data-participant-id', 'grid');
  const named = tile(e, 'alice', 'Alice', {avatar: avatar('Alice')});
  wrapper.appendChild(named.el);
  const unrelated = e.context.document.createElement('video'); unrelated.srcObject = stream;
  wrapper.appendChild(unrelated); e.context.document.body.appendChild(wrapper);
  await start(e);
  assert.equal(e.a.getParticipantForTrack(audio.id), null);
  await stop(e);
});

test('Tile UI status text and an avatar alone do not invent a participant name', async () => {
  const e = setup({loadedAvatars: true}); const view = remote(e, '', {id: 'unknown', avatar: avatar('unknown')});
  view.el.textContent = '2 joined';
  await start(e);
  assert.equal(e.a.getParticipantForTrack(view.audio.id), null);
  e.a.audioLevels.set(view.audio.id, 0.2); render(e);
  assert.equal(card(e, view.audio)?.name, 'Speaker');
  await stop(e);
});

test('Conflicting live stream bindings remain unresolved', async () => {
  const e = setup({loadedAvatars: true}); const alice = remote(e, 'Alice');
  tile(e, 'bob', 'Bob', {stream: alice.stream}); await start(e);
  assert.equal(e.a.audioTrackToParticipant.has(alice.audio.id), false);
  assert.equal(e.a.getParticipantForTrack(alice.audio.id), null);
  await stop(e);
});

test('Unlabelled native audio playback cannot override a directly identified video stream', async () => {
  const e = setup({loadedAvatars: true}); const alice = remote(e, 'Alice', {avatar: avatar('Alice')});
  const audio = e.context.document.createElement('audio'); audio.srcObject = alice.stream;
  e.context.document.body.appendChild(audio);
  await start(e); assertIdentity(e, alice.audio, 'Alice', avatar('Alice'));
  assert.equal(e.a.getParticipantForTrack(alice.audio.id)?.name, 'Alice');
  await stop(e);
});

test('Reassignment refreshes the real source routes into named audio outputs', async () => {
  const e = setup({loadedAvatars: true}); const alice = remote(e, 'Alice');
  e.command('SET_AUDIO_TRACKS', {list: [
    {id: 1, name: 'Alice output', targets: ['Alice']},
    {id: 2, name: 'Bob output', targets: ['Bob']},
  ]});
  await start(e);
  const gain = e.a.trackGainNodes.get(alice.audio.id);
  assert.equal(gain.edges.has(e.a.trackMixers.get(1)), true);
  assert.equal(gain.edges.has(e.a.trackMixers.get(2)), false);
  alice.el.setAttribute('data-participant-id', 'bob'); alice.setName('Bob'); await refresh(e);
  assert.equal(gain.edges.has(e.a.trackMixers.get(1)), false);
  assert.equal(gain.edges.has(e.a.trackMixers.get(2)), true);
  await stop(e);
});

test('Camera-off correlation requires repeated unambiguous speech and then refreshes late avatars', async () => {
  const e = setup({loadedAvatars: true}); const pc = new e.window.RTCPeerConnection(); pc.connectionState = 'connected';
  const audio = new e.Track('audio'); pc.receive(audio);
  const alice = tile(e, 'alice', 'Alice', {speaking: true}); tile(e, 'bob', 'Bob');
  await start(e); e.a.audioLevels.set(audio.id, 0.2);
  render(e); e.advanceTime(501); render(e);
  assert.equal(e.a.audioTrackToParticipant.has(audio.id), false);
  e.advanceTime(501); render(e); assertIdentity(e, audio, 'Alice', null);
  alice.setAvatar(avatar('Alice')); await refresh(e);
  assertIdentity(e, audio, 'Alice', avatar('Alice'));
  await stop(e);
});

test('Overlapping remote speech or local speech cannot correlate unbound tracks to a visible highlight', async () => {
  const e = setup({loadedAvatars: true}); const pc = new e.window.RTCPeerConnection(); pc.connectionState = 'connected';
  const a = new e.Track('audio'), b = new e.Track('audio'); pc.receive(a); pc.receive(b);
  const alice = tile(e, 'alice', 'Alice', {speaking: true}); tile(e, 'bob', 'Bob');
  // Also expose the legacy plain-name DOM so the baseline correlation path
  // actually executes; the main modern-name tests use aria-labels alone.
  const label = e.context.document.createElement('span'); label.textContent = 'Alice'; alice.el.appendChild(label);
  await start(e);
  e.a.audioLevels.set(a.id, 0.2); e.a.audioLevels.set(b.id, 0.2);
  for (let i = 0; i < 5; i++) { e.advanceTime(501); render(e); }
  assert.equal(e.a.audioTrackToParticipant.size, 0);
  e.a.audioLevels.set(b.id, 0); e.a.setLocalVolume(0.2);
  for (let i = 0; i < 5; i++) { e.advanceTime(501); render(e); }
  assert.equal(e.a.audioTrackToParticipant.size, 0);
  await stop(e);
});

test('Correlation rechecks a camera-off receiver after it is reused by another speaker', async () => {
  const e = setup({loadedAvatars: true}); const pc = new e.window.RTCPeerConnection(); pc.connectionState = 'connected';
  const audio = new e.Track('audio'); pc.receive(audio);
  const alice = tile(e, 'alice', 'Alice', {speaking: true}); const bob = tile(e, 'bob', 'Bob');
  e.command('SET_AUDIO_TRACKS', {list: [
    {id: 1, name: 'Alice output', targets: ['Alice']},
    {id: 2, name: 'Bob output', targets: ['Bob']},
  ]});
  await start(e); e.a.audioLevels.set(audio.id, 0.2);
  const gain = e.a.trackGainNodes.get(audio.id);
  assert.equal(gain.edges.has(e.a.trackMixers.get(1)), false);
  for (let i = 0; i < 3; i++) { e.advanceTime(501); render(e); }
  assertIdentity(e, audio, 'Alice', null);
  assert.equal(gain.edges.has(e.a.trackMixers.get(1)), true);
  assert.equal(gain.edges.has(e.a.trackMixers.get(2)), false);
  bob.el.style = alice.el.style; alice.el.style = {};
  for (let i = 0; i < 3; i++) { e.advanceTime(501); render(e); }
  assertIdentity(e, audio, 'Bob', null);
  assert.equal(gain.edges.has(e.a.trackMixers.get(1)), false);
  assert.equal(gain.edges.has(e.a.trackMixers.get(2)), true);
  await stop(e);
});

test('A formerly direct receiver can be reassigned after its media binding disappears', async () => {
  const e = setup({loadedAvatars: true}), alice = remote(e, 'Alice');
  const bob = tile(e, 'bob', 'Bob', {speaking: true});
  e.command('SET_AUDIO_TRACKS', {list: [
    {id: 1, name: 'Alice output', targets: ['Alice']},
    {id: 2, name: 'Bob output', targets: ['Bob']},
  ]});
  await start(e); assertIdentity(e, alice.audio, 'Alice', null);
  alice.media.srcObject = null;
  for (let i = 0; i < 4; i++) {
    await refresh(e); e.a.audioLevels.set(alice.audio.id, 0.2); render(e);
  }
  assertIdentity(e, alice.audio, 'Bob', null);
  const gain = e.a.trackGainNodes.get(alice.audio.id);
  assert.equal(gain.edges.has(e.a.trackMixers.get(1)), false);
  assert.equal(gain.edges.has(e.a.trackMixers.get(2)), true);
  assert.equal(card(e, alice.audio)?.name, 'Bob');
  await stop(e);
});

test('A remote person with the local name resolves by distinct participant IDs', async () => {
  const e = setup({loadedAvatars: true});
  tile(e, 'self', 'Alex Kim', {self: true, avatar: avatar('self')});
  const alex = remote(e, 'Alex Kim', {id: 'remote-alex', avatar: avatar('remote')});
  e.command('SET_AUDIO_TRACKS', {list: [{id: 1, name: 'Alex', targets: ['Alex Kim']}]});
  await start(e); assertIdentity(e, alex.audio, 'Alex Kim', avatar('remote'));
  e.a.audioLevels.set(alex.audio.id, 0.2); render(e);
  assert.equal(card(e, alex.audio)?.name, 'Alex Kim');
  assert.equal(e.a.trackGainNodes.get(alex.audio.id).edges.has(e.a.trackMixers.get(1)), true);
  await stop(e);
});

test('Late local-name discovery connects an already recording named microphone output', async () => {
  const e = setup({loadedAvatars: true}), pc = new e.window.RTCPeerConnection();
  pc.connectionState = 'connected';
  const mic = new e.Track('audio'); pc.senders = [{track: mic}];
  pc.receive(new e.Track('audio'));
  e.command('SET_AUDIO_TRACKS', {list: [{id: 1, name: 'Local', targets: ['Local']}]});
  e.command('SET_RECORD_MY_MIC', {enabled: true});
  await start(e);
  const source = e.nodes.find(node => node.mediaStream?.getAudioTracks().includes(mic));
  const gain = [...source.edges].find(node => node.gain && node.frequencyBinCount === 32);
  assert.ok(gain);
  assert.equal(gain.edges.has(e.a.trackMixers.get(1)), false);
  tile(e, 'self', 'Local', {self: true}); await refresh(e);
  assert.equal(gain.edges.has(e.a.trackMixers.get(1)), true);
  await stop(e);
});

test('STATUS resolving a reassigned participant cannot hide the needed audio routing update', async () => {
  const e = setup({loadedAvatars: true}), alice = remote(e, 'Alice');
  e.command('SET_AUDIO_TRACKS', {list: [
    {id: 1, name: 'Alice', targets: ['Alice']}, {id: 2, name: 'Bob', targets: ['Bob']},
  ]});
  await start(e);
  alice.el.setAttribute('data-participant-id', 'bob'); alice.setName('Bob');
  e.command('STATUS'); await refresh(e);
  assertIdentity(e, alice.audio, 'Bob', null);
  const gain = e.a.trackGainNodes.get(alice.audio.id);
  assert.equal(gain.edges.has(e.a.trackMixers.get(1)), false);
  assert.equal(gain.edges.has(e.a.trackMixers.get(2)), true);
  await stop(e);
});

test('Preloading more than 50 photos preserves loaded entries and still loads active speakers', async () => {
  const e = setup(), pc = new e.window.RTCPeerConnection();
  pc.connectionState = 'connected'; pc.receive(new e.Track('audio'));
  for (let i = 0; i < 51; i++) tile(e, `person-${i}`, `Person ${i}`, {avatar: avatar(`person-${i}`)});
  const starting = e.a.startRecording('many-photos'); await e.settle();
  e.fire(750); await starting;
  const loaded = [...e.a.avatarImageCache.values()]; loaded.forEach(img => img.load());
  const requests = e.images.length;
  await refresh(e);
  assert.equal([...e.a.avatarImageCache.values()].filter(img => img.naturalWidth).length, 50);
  assert.equal(e.images.length, requests);
  assert.equal(loaded.filter(img => img.src).length, 50);
  const late = remote(e, 'Late speaker', {avatar: avatar('late')}); await refresh(e);
  e.a.audioLevels.set(late.audio.id, 0.2); render(e);
  const image = e.a.avatarImageCache.get(normalized(avatar('late')));
  assert.ok(image); image.load(); render(e);
  assert.ok(e.canvasCalls.some(call => call.name === 'drawImage' && call.args[0] === image));
  assert.equal(e.a.avatarImageCache.size, 50);
  await stop(e);
});

test('Text-only participant names containing UI keyword substrings still resolve', async () => {
  const e = setup({loadedAvatars: true});
  const people = ['Pina', 'Claudio'].map(name => {
    const pc = new e.window.RTCPeerConnection(); pc.connectionState = 'connected';
    const audio = new e.Track('audio'), stream = new e.Stream([audio, new e.Track('video')]);
    const person = tile(e, name, name, {stream});
    person.button.remove(); person.el.textContent = name + name;
    pc.receive(audio, stream);
    return {...person, audio};
  });
  await start(e);
  for (const person of people) {
    assertIdentity(e, person.audio, person.el.textContent.slice(0, person.el.textContent.length / 2), null);
  }
  await stop(e);
});

for (const paused of [false, true]) {
  test(`Speaker reassignment updates named routes during ${paused ? 'pause' : 'a displayed presentation'}`, async () => {
    const e = setup({loadedAvatars: true}), pc = new e.window.RTCPeerConnection();
    pc.connectionState = 'connected';
    const audio = new e.Track('audio'); pc.receive(audio);
    const alice = tile(e, 'alice', 'Alice', {speaking: true}), bob = tile(e, 'bob', 'Bob');
    e.command('SET_AUDIO_TRACKS', {list: [
      {id: 1, name: 'Alice', targets: ['Alice']}, {id: 2, name: 'Bob', targets: ['Bob']},
    ]});
    await start(e); e.a.audioLevels.set(audio.id, 0.2);
    for (let i = 0; i < 3; i++) { e.advanceTime(501); render(e); }
    assertIdentity(e, audio, 'Alice', null);
    const share = new e.Track('video'); share.contentHint = 'detail'; pc.receive(share);
    const probe = e.a.videoProbes.get(share.id);
    probe.videoWidth = 1280; probe.videoHeight = 720; probe.readyState = 4; probe.dispatch('loadedmetadata');
    e.a.state().timerWorker.onmessage({data: 'tick'});
    if (paused) e.command('PAUSE');
    bob.el.style = alice.el.style; alice.el.style = {};
    e.canvasCalls.length = 0;
    for (let i = 0; i < 6; i++) {
      e.a.audioLevels.set(audio.id, 0.2); await refresh(e);
      if (!paused) e.a.state().timerWorker.onmessage({data: 'tick'});
    }
    assertIdentity(e, audio, 'Bob', null);
    const gain = e.a.trackGainNodes.get(audio.id);
    assert.equal(gain.edges.has(e.a.trackMixers.get(1)), false);
    assert.equal(gain.edges.has(e.a.trackMixers.get(2)), true);
    assert.equal(e.canvasCalls.some(call => call.name === 'fillText'), false);
    if (!paused) assert.ok(e.canvasCalls.some(call => call.name === 'drawImage' && call.args[0] === probe));
    await stop(e);
  });
}

test('Track retirement and repeated sessions release identity timers, images, scores and cards', async () => {
  const e = setup({loadedAvatars: true}); const alice = remote(e, 'Alice', {avatar: avatar('Alice')});
  const baselineTimers = e.timers.size;
  for (let i = 0; i < 4; i++) {
    await start(e, `session-${i}`);
    e.a.audioLevels.set(alice.audio.id, 0.2); render(e);
    const session = e.a.state().activeSession;
    const oldTick = e.timers.get(session.identityTimer).fn;
    await stop(e); oldTick();
    assert.equal(session.identityTimer, null);
    assert.equal(e.timers.size, baselineTimers);
    for (const cache of [e.a.avatarImageCache, e.a.trackCorrelation, e.a.activeSpeakers]) assert.equal(cache.size, 0);
    assert.equal(e.a.audioTrackToParticipant.size, 1);
    assert.equal(e.a.participantTileCache.size, 1);
    assert.equal(e.a.participantMetadata.size, 1);
    assert.equal(e.images.filter(img => img.src).length, 0);
    assert.equal(alice.audio.readyState, 'live');
  }
  await start(e); e.a.audioLevels.set(alice.audio.id, 0.2); render(e);
  alice.el.remove(); alice.audio.endNaturally();
  assert.equal(e.a.audioTrackToParticipant.has(alice.audio.id), false);
  assert.equal(e.a.participantTileCache.has(`track:${alice.audio.id}`), false);
  assert.equal(card(e, alice.audio), undefined);
  await stop(e);
});

test('STOP or pagehide cancels pending avatar startup and late image callbacks cannot revive it', async () => {
  for (const teardown of ['STOP', 'pagehide']) {
    const e = setup(); remote(e, 'Alice', {avatar: avatar('Alice')});
    const starting = e.a.startRecording(teardown); await e.settle();
    const images = e.images.filter(img => img.src), callbacks = images.map(img => img.onload);
    if (teardown === 'STOP') await stop(e);
    else { e.window.dispatch('pagehide', {persisted: false}); await e.settle(); }
    await starting; await e.settle();
    assert.equal(e.a.state().activeSession, null);
    assert.equal([...e.timers.values()].some(timer => timer.ms === 750), false);
    assert.equal(e.a.avatarImageCache.size, 0);
    assert.equal(images.every(img => img.src === '' && img.onload === null && img.onerror === null), true);
    callbacks.forEach(fn => fn()); await e.settle();
    assert.equal(e.a.state().isRecording, false);
    assert.equal(e.messages.some(message => message.event === 'RECORDING_STARTED'), false);
  }
});

test('Late callbacks from cancelled startup cannot clear a later session identity timer', async () => {
  const e = setup(); remote(e, 'Alice', {avatar: avatar('Alice')});
  const first = e.a.startRecording('old'); await e.settle();
  const finish = e.a.state().activeSession.identityWarmupFinish;
  await stop(e); await first;
  const second = e.a.startRecording('new'); await e.settle();
  e.images.filter(img => img.src).forEach(img => img.load()); await second;
  const timer = e.a.state().activeSession.identityTimer;
  finish(); await e.settle();
  assert.equal(e.a.state().isRecording, true); assert.equal(e.timers.has(timer), true);
  await stop(e);
});

test('Startup allocation failure releases preloaded avatars and identity state', async () => {
  const e = setup({loadedAvatars: true, failCapture: true}); remote(e, 'Alice', {avatar: avatar('Alice')});
  await e.a.startRecording('failed'); await e.settle();
  assert.equal(e.a.state().activeSession, null);
  assert.equal(e.a.avatarImageCache.size, 0); assert.equal(e.a.participantMetadata.size, 1);
  assert.equal(e.images.some(img => img.src), false);
  assert.equal([...e.timers.values()].some(timer => timer.ms === 750), false);
});

test('Join/leave metadata and preloaded avatar caches stay bounded', async () => {
  const e = setup({loadedAvatars: true});
  const pc = new e.window.RTCPeerConnection(); pc.connectionState = 'connected'; pc.receive(new e.Track('audio'));
  await start(e);
  for (let i = 0; i < 160; i++) {
    const view = tile(e, `person-${i}`, `Person ${i}`, {avatar: avatar(`person-${i}`)});
    await refresh(e); view.el.remove();
    assert.ok(e.a.participantMetadata.size <= 120);
    assert.ok(e.a.participantTileCache.size <= 120);
    assert.ok(e.a.avatarImageCache.size <= 50);
    assert.ok(e.images.filter(img => img.src).length <= 50);
  }
  assert.equal(e.a.participantMetadata.size, 120);
  await stop(e);
});
