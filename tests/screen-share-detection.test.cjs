'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {setup} = require('./fixtures/page-runtime.cjs');

// Add test-only access inside the real source's closure. Keep the shared fixture
// unchanged; its synchronous setup restores the VM method before each test runs.
function setupDetection() {
  const runInContext = vm.runInContext;
  const marker = "  postOut('INJECTED',";
  vm.runInContext = function(source, context, options) {
    assert.ok(source.includes(marker));
    const hook = `window.__screenAudit = {
      isLikelyScreenShareVideoElement, scanDomForScreenShare, clearScreenShare,
      get track() { return screenShareTrack; },
      set forcedOff(value) { forceNoScreenShare = value; }
    };\n`;
    return runInContext.call(this, source.replace(marker, hook + marker), context, options);
  };
  try {
    const e = setup();
    e.screen = e.window.__screenAudit;
    return e;
  } finally {
    vm.runInContext = runInContext;
  }
}

function makeTrack(e, settings = {}, label = '') {
  const track = new e.Track('video', label);
  track.getSettings = () => settings;
  return track;
}

function makeVideo(e, track, {width = 0, height = 0, label = '', nearestLabel = '', regionLabel = '', tile = null} = {}) {
  const vid = e.context.document.createElement('video');
  vid.srcObject = new e.context.MediaStream([track]);
  vid.videoWidth = width;
  vid.videoHeight = height;
  vid.readyState = width && height ? 2 : 0;
  vid.getBoundingClientRect = () => ({width: 1920, height: 1080});
  vid.getAttribute = name => name === 'aria-label' ? label : null;
  vid.closest = selector => {
    if (selector === '[data-participant-id]') return tile;
    if (selector === '[data-self-name]') return null;
    if (selector === '[aria-label]') return nearestLabel ? {getAttribute: () => nearestLabel} : null;
    if (selector.includes('[aria-label*="present"')) return regionLabel ? {getAttribute: () => regionLabel} : null;
    return null;
  };
  e.context.document.body.appendChild(vid);
  return vid;
}

function decode(e, track, width, height) {
  const probe = e.a.videoProbes.get(track.id);
  assert.ok(probe, 'the real addVideoTrack must allocate its probe');
  probe.videoWidth = width;
  probe.videoHeight = height;
  probe.readyState = width && height ? 2 : 0;
  probe.dispatch('loadedmetadata');
  return probe;
}

function detected(e) {
  return e.messages.filter(message => message.event === 'SCREEN_SHARE_DETECTED');
}

const dimensions = [
  [640, 480, false], [960, 540, false], [1279, 720, false],
  [1280, 719, false], [1920, 540, false], [640, 1080, false],
  [1280, 0, false], [0, 720, false], [0, 0, false],
  [1280, 720, true], [1920, 1080, true],
];

for (const [width, height, expected] of dimensions) {
  test(`Decoded ${width}x${height}: DOM and track probes require both 720p dimensions`, () => {
    const dom = setupDetection(), track = makeTrack(dom), vid = makeVideo(dom, track, {width, height});
    assert.equal(dom.screen.isLikelyScreenShareVideoElement(vid), expected);
    dom.screen.scanDomForScreenShare(true);
    assert.equal(dom.screen.track === track, expected);
    assert.equal(detected(dom).length, expected ? 1 : 0);

    const rtc = setupDetection(), remote = makeTrack(rtc);
    new rtc.window.RTCPeerConnection().receive(remote);
    decode(rtc, remote, width, height);
    assert.equal(rtc.screen.track === remote, expected);
    assert.equal(detected(rtc).length, expected ? 1 : 0);
  });

  test(`Settings ${width}x${height}: undecoded DOM and track probes use the same fallback`, () => {
    const dom = setupDetection(), track = makeTrack(dom, {width, height}), vid = makeVideo(dom, track);
    assert.equal(dom.screen.isLikelyScreenShareVideoElement(vid), expected);
    dom.screen.scanDomForScreenShare(true);
    assert.equal(dom.screen.track === track, expected);

    const rtc = setupDetection(), remote = makeTrack(rtc, {width, height});
    rtc.a.addVideoTrack(remote);
    rtc.fire(300);
    assert.equal(rtc.screen.track === remote, expected);
    assert.equal(detected(rtc).length, expected ? 1 : 0);
  });
}

test('Decoded dimensions override stale high settings, including a provisional track detection', () => {
  const dom = setupDetection(), track = makeTrack(dom, {width: 1920, height: 1080});
  const vid = makeVideo(dom, track, {width: 640, height: 480});
  assert.equal(dom.screen.isLikelyScreenShareVideoElement(vid), false);
  dom.screen.scanDomForScreenShare(true);
  assert.equal(dom.screen.track, null);

  const rtc = setupDetection(), remote = makeTrack(rtc, {width: 1920, height: 1080});
  rtc.a.addVideoTrack(remote);
  assert.equal(rtc.screen.track, remote);
  const probe = decode(rtc, remote, 640, 480);
  assert.equal(rtc.screen.track, null);
  assert.equal(rtc.a.activeScreenShareTracks.length, 0);
  assert.equal(probe.isConnected, false);
  assert.equal(remote.readyState, 'live');
  assert.equal(rtc.messages.filter(message => message.event === 'SCREEN_SHARE_ENDED').length, 1);
  rtc.fire(800);
  assert.equal(rtc.screen.track, null);
});

test('Complete decoded 720p survives stale low settings; incomplete pairs never mix dimensions', () => {
  const e = setupDetection(), track = makeTrack(e, {width: 640, height: 480});
  const vid = makeVideo(e, track, {width: 1280, height: 720});
  assert.equal(e.screen.isLikelyScreenShareVideoElement(vid), true);
  e.a.addVideoTrack(track);
  decode(e, track, 1280, 720);
  assert.equal(e.screen.track, track);

  const partial = setupDetection(), p = makeTrack(partial, {width: 0, height: 720});
  assert.equal(partial.screen.isLikelyScreenShareVideoElement(makeVideo(partial, p, {width: 1280})), false);
  const fallback = setupDetection(), f = makeTrack(fallback, {width: 1280, height: 720});
  assert.equal(fallback.screen.isLikelyScreenShareVideoElement(makeVideo(fallback, f, {width: 640})), true);
});

test('A known decoded DOM video outranks stale settings before its extension probe decodes', () => {
  for (const [width, height, settings, expected] of [
    [640, 480, {width: 1920, height: 1080}, false],
    [1280, 720, {width: 640, height: 480}, true],
  ]) {
    const e = setupDetection(), track = makeTrack(e, settings);
    const vid = makeVideo(e, track, {width, height});
    // This is the registration performed by the existing startup DOM rescan.
    e.a.domVideoElements.set(track.id, vid);
    e.a.addVideoTrack(track);
    assert.equal(e.screen.track === track, expected);
    e.fire(300);
    assert.equal(e.screen.track === track, expected);
  }
});

for (const [name, options] of [
  ['detail', {contentHint: 'detail'}], ['text', {contentHint: 'text'}],
  ['monitor', {settings: {displaySurface: 'monitor'}}],
  ['window', {settings: {displaySurface: 'window'}}],
  ['browser', {settings: {displaySurface: 'browser'}}],
  ['screen label', {label: 'Screen 1'}], ['tab label', {label: 'Chrome tab'}],
  ['presentation label', {label: 'Presentation'}], ['desktop label', {label: 'Desktop capture'}],
]) {
  test(`${name} explicitly identifies a share before decoding and below 720p`, () => {
    const e = setupDetection(), track = makeTrack(e, options.settings, options.label);
    track.contentHint = options.contentHint || '';
    const vid = makeVideo(e, track);
    assert.equal(e.screen.isLikelyScreenShareVideoElement(vid), true);
    e.a.addVideoTrack(track);
    assert.equal(e.screen.track, track);
    const probe = decode(e, track, 640, 360);
    assert.equal(e.screen.track, track);
    assert.equal(probe.isConnected, true);
    e.screen.scanDomForScreenShare(true);
    assert.equal(e.a.domVideoElements.get(track.id), vid);
    assert.equal(detected(e).length, 1);
  });
}

test('A presentation ancestor survives incidental labels and a low-resolution probe', () => {
  const e = setupDetection(), track = makeTrack(e);
  const vid = makeVideo(e, track, {width: 320, height: 180, nearestLabel: 'More options for Alice', regionLabel: 'Presentation'});
  assert.equal(e.screen.isLikelyScreenShareVideoElement(vid), true);
  e.screen.scanDomForScreenShare(true);
  assert.equal(e.screen.track, track);
  assert.equal(e.a.domVideoElements.get(track.id), vid);
  const probe = decode(e, track, 320, 180);
  assert.equal(probe.isConnected, true);
  assert.equal(e.screen.track, track);
});

test('Participant names and camera label substrings are not presentation semantics', () => {
  for (const label of ['Stable Webcam', 'Tablet Camera', 'Windowson Camera']) {
    const e = setupDetection(), track = makeTrack(e, {}, label);
    const vid = makeVideo(e, track, {width: 640, height: 480, tile: {textContent: 'Tabitha Sharedman'}});
    assert.equal(e.screen.isLikelyScreenShareVideoElement(vid), false);
    e.a.addVideoTrack(track);
    decode(e, track, 640, 480);
    e.screen.scanDomForScreenShare(true);
    assert.equal(e.screen.track, null);
  }
});

test('A small explicit DOM share beats a larger high-resolution webcam', () => {
  const e = setupDetection(), webcam = makeTrack(e), share = makeTrack(e);
  makeVideo(e, webcam, {width: 3840, height: 2160});
  const presentation = makeVideo(e, share, {width: 640, height: 360, label: 'Alice is presenting'});
  e.screen.scanDomForScreenShare(true);
  assert.equal(e.screen.track, share);
  assert.equal(e.a.domVideoElements.get(share.id), presentation);
  assert.equal(detected(e).length, 1);
});

test('Extension probes never become DOM candidates or replace a Meet-owned presentation element', () => {
  const e = setupDetection(), share = makeTrack(e);
  share.contentHint = 'detail';
  e.a.addVideoTrack(share);
  const probe = decode(e, share, 3840, 2160);
  assert.equal(e.screen.isLikelyScreenShareVideoElement(probe), false);
  e.screen.scanDomForScreenShare(true);
  assert.equal(e.a.domVideoElements.size, 0);
  const presentation = makeVideo(e, share, {width: 320, height: 180, regionLabel: 'Presentation'});
  e.screen.scanDomForScreenShare(true);
  assert.equal(e.a.domVideoElements.get(share.id), presentation);
  assert.equal(e.screen.track, share);
});

test('Resolution-only probes and rescans cannot displace an explicit active share', () => {
  const e = setupDetection(), share = makeTrack(e), webcam = makeTrack(e, {width: 3840, height: 2160});
  share.contentHint = 'text';
  e.a.addVideoTrack(share);
  makeVideo(e, webcam, {width: 3840, height: 2160});
  e.a.addVideoTrack(webcam);
  const probe = decode(e, webcam, 3840, 2160);
  e.screen.scanDomForScreenShare(true);
  assert.equal(e.screen.track, share);
  assert.equal(e.a.activeScreenShareTracks.length, 1);
  assert.equal(e.a.activeScreenShareTracks[0], share);
  assert.equal(probe.isConnected, false);
  assert.equal(detected(e).length, 1);
});

test('A resolution-only active share remains stable against a later larger webcam probe', () => {
  const e = setupDetection(), share = makeTrack(e), webcam = makeTrack(e);
  e.a.addVideoTrack(share);
  decode(e, share, 1280, 720);
  e.a.addVideoTrack(webcam);
  decode(e, webcam, 3840, 2160);
  assert.equal(e.screen.track, share);
  assert.equal(e.a.activeScreenShareTracks.length, 1);
  assert.equal(detected(e).length, 1);
});

test('An explicit share supersedes a provisional camera without reviving it on retirement', () => {
  const e = setupDetection(), webcam = makeTrack(e), share = makeTrack(e);
  e.a.addVideoTrack(webcam);
  const probe = decode(e, webcam, 1280, 720);
  share.contentHint = 'detail';
  e.a.addVideoTrack(share);
  assert.equal(e.screen.track, share);
  assert.equal(probe.isConnected, false);
  share.endNaturally();
  e.fire(300);
  assert.equal(e.screen.track, null);
  assert.equal(e.a.activeScreenShareTracks.length, 0);
  assert.equal(webcam.readyState, 'live');
});

test('Local sender webcams and self previews do not become shares or override a real share', () => {
  for (const source of ['sender', 'self tile', 'legacy self tile']) {
    const e = setupDetection(), camera = makeTrack(e, {width: 1920, height: 1080});
    const tile = source === 'self tile' ? {textContent: "You're continuously framed"}
      : source === 'legacy self tile' ? {textContent: '', hasAttribute: name => name === 'data-self-name'} : null;
    const preview = makeVideo(e, camera, {width: 1920, height: 1080, tile});
    if (source === 'sender') new e.window.RTCPeerConnection().senders = [{track: camera}];
    assert.equal(e.screen.isLikelyScreenShareVideoElement(preview), false);
    e.a.addVideoTrack(camera);
    decode(e, camera, 1920, 1080);
    e.screen.scanDomForScreenShare(true);
    assert.equal(e.screen.track, null);

    const share = makeTrack(e);
    share.contentHint = 'detail';
    e.a.addVideoTrack(share);
    e.screen.scanDomForScreenShare(true);
    assert.equal(e.screen.track, share);
    assert.equal(detected(e).length, 1);
  }
});

test('An explicit local presentation sender remains supported', () => {
  const e = setupDetection(), share = makeTrack(e, {displaySurface: 'browser'});
  new e.window.RTCPeerConnection().senders = [{track: share}];
  const vid = makeVideo(e, share, {width: 640, height: 360});
  assert.equal(e.screen.isLikelyScreenShareVideoElement(vid), true);
  e.a.addVideoTrack(share);
  decode(e, share, 640, 360);
  assert.equal(e.screen.track, share);
});

test('Throwing settings are tolerated when decoded frames or explicit hints identify the share', () => {
  const e = setupDetection(), track = makeTrack(e);
  track.getSettings = () => {throw new Error('fixture: unavailable settings');};
  const vid = makeVideo(e, track, {width: 1280, height: 720});
  assert.equal(e.screen.isLikelyScreenShareVideoElement(vid), true);
  e.screen.scanDomForScreenShare(true);
  decode(e, track, 1280, 720);
  assert.equal(e.screen.track, track);
});

test('Ended tracks and forced-off detection cannot produce new share events', () => {
  const e = setupDetection(), ended = makeTrack(e, {displaySurface: 'monitor'});
  ended.stop();
  const vid = makeVideo(e, ended, {width: 1920, height: 1080});
  assert.equal(e.screen.isLikelyScreenShareVideoElement(vid), false);
  e.a.addVideoTrack(ended);
  const share = makeTrack(e);
  share.contentHint = 'detail';
  e.screen.forcedOff = true;
  e.a.addVideoTrack(share);
  decode(e, share, 1920, 1080);
  makeVideo(e, share, {width: 1920, height: 1080});
  e.screen.scanDomForScreenShare(true);
  assert.equal(e.screen.track, null);
  assert.equal(detected(e).length, 0);
});

test('A cached DOM video reused for another track cannot supply labels or dimensions', () => {
  const e = setupDetection(), camera = makeTrack(e), share = makeTrack(e);
  const vid = makeVideo(e, camera, {width: 640, height: 480});
  e.a.domVideoElements.set(camera.id, vid);
  e.a.addVideoTrack(camera);
  vid.srcObject = new e.context.MediaStream([share]);
  vid.videoWidth = 1920; vid.videoHeight = 1080;
  vid.getAttribute = name => name === 'aria-label' ? 'Presentation' : null;
  e.fire(300);
  assert.notEqual(e.screen.track, camera);
  decode(e, camera, 640, 480);
  assert.notEqual(e.screen.track, camera);
  assert.equal(e.a.videoProbes.has(camera.id), false);
});

test('An explicit presentation keeps its live probe after its DOM tile disappears', () => {
  const e = setupDetection(), share = makeTrack(e);
  const vid = makeVideo(e, share, {width: 1280, height: 720, label: 'Presentation'});
  e.screen.scanDomForScreenShare(true);
  const probe = decode(e, share, 1280, 720);
  vid.remove();
  probe.dispatch('resize');
  assert.equal(e.screen.track, share);
  assert.equal(e.a.videoProbes.get(share.id), probe);
  assert.equal(probe.isConnected, true);
  probe.videoWidth = 640; probe.videoHeight = 360;
  probe.dispatch('resize');
  assert.equal(e.a.videoProbes.get(share.id), probe);
  share.endNaturally();
  assert.equal(e.a.videoProbes.size, 0);
});

for (const hinted of [false, true]) {
  test(`Re-enabling presentation detection recovers existing ${hinted ? 'hinted' : 'resolution-only'} receivers`, () => {
    const e = setupDetection(), share = makeTrack(e);
    if (hinted) share.contentHint = 'detail';
    e.command('FORCE_NO_SCREEN_SHARE', {enabled: true});
    new e.window.RTCPeerConnection().receive(share);
    decode(e, share, 1280, 720);
    e.fire(15000);
    assert.equal(e.screen.track, null);
    e.command('FORCE_NO_SCREEN_SHARE', {enabled: false});
    const probe = e.a.videoProbes.get(share.id);
    assert.ok(probe, 'reenabling must recreate any retired live receiver probe');
    if (!probe.videoWidth) decode(e, share, 1280, 720);
    e.fire(300);
    assert.equal(e.screen.track, share);
    share.endNaturally();
    assert.equal(e.a.videoProbes.size, 0);
  });
}

for (const [name, settings, label, contentHint, domLabel] of [
  ['facingMode', {facingMode: 'user'}, '', '', ''],
  ['webcam label', {}, 'HD Webcam', '', ''],
  ['camera content hint', {}, '', 'motion', ''],
  ['camera DOM semantics', {}, '', '', 'Camera'],
]) {
  test(`Explicit ${name} vetoes a 1080p webcam's resolution fallback`, () => {
    const e = setupDetection(), camera = makeTrack(e, settings, label);
    camera.contentHint = contentHint;
    const vid = makeVideo(e, camera, {width: 1920, height: 1080, label: domLabel});
    assert.equal(e.screen.isLikelyScreenShareVideoElement(vid), false);
    e.a.domVideoElements.set(camera.id, vid);
    e.a.addVideoTrack(camera);
    decode(e, camera, 1920, 1080);
    e.screen.scanDomForScreenShare(true);
    assert.equal(e.screen.track, null);
    // Explicit presentation evidence remains stronger than a camera hint.
    camera.contentHint = 'detail';
    e.screen.scanDomForScreenShare(true);
    assert.equal(e.screen.track, camera);
  });
}

test('Normal receiver probes find camera semantics without manually cached DOM videos', () => {
  const e = setupDetection(), camera = makeTrack(e);
  makeVideo(e, camera, {width: 1920, height: 1080, label: 'Camera'});
  new e.window.RTCPeerConnection().receive(camera);
  decode(e, camera, 1920, 1080);
  e.screen.scanDomForScreenShare(true);
  assert.equal(e.screen.track, null);
  assert.equal(detected(e).length, 0);
});

test('Re-enable immediately revalidates retained probes after hints change without resize', () => {
  const e = setupDetection(), track = makeTrack(e);
  track.contentHint = 'detail';
  e.a.addVideoTrack(track);
  decode(e, track, 1920, 1080);
  for (const delay of [300, 800, 1500, 3000, 6000, 12000, 15000]) e.fire(delay);
  assert.equal(e.screen.track, track);
  e.command('FORCE_NO_SCREEN_SHARE', {enabled: true});
  track.contentHint = 'motion';
  e.command('FORCE_NO_SCREEN_SHARE', {enabled: false});
  assert.equal(e.screen.track, null);
  assert.equal(e.a.videoProbes.size, 0);
});

test('Explicit camera evidence retires a stale share even without decoded dimensions', () => {
  const e = setupDetection(), track = makeTrack(e);
  track.contentHint = 'detail'; e.a.addVideoTrack(track);
  for (const delay of [300, 800, 1500, 3000, 6000, 12000, 15000]) e.fire(delay);
  e.command('FORCE_NO_SCREEN_SHARE', {enabled: true});
  track.contentHint = 'motion';
  e.command('FORCE_NO_SCREEN_SHARE', {enabled: false});
  assert.equal(e.screen.track, null);
  assert.equal(e.a.videoProbes.size, 0);
  const share = makeTrack(e); e.a.addVideoTrack(share); decode(e, share, 1280, 720);
  assert.equal(e.screen.track, share);
});

test('A newly identified local preview loses its selected share and cached-video playback', () => {
  const e = setupDetection(), camera = makeTrack(e);
  const vid = makeVideo(e, camera, {width: 1920, height: 1080});
  e.command('RESCAN_MEDIA'); decode(e, camera, 1920, 1080);
  assert.equal(e.screen.track, camera);
  e.command('FORCE_NO_SCREEN_SHARE', {enabled: true});
  const closest = vid.closest;
  vid.closest = selector => selector === '[data-self-name]' ? {} : closest(selector);
  e.command('FORCE_NO_SCREEN_SHARE', {enabled: false});
  assert.equal(e.screen.track, null);
  assert.equal(e.a.activeScreenShareTracks.length, 0);
  assert.equal(e.a.videoProbes.size, 0);
});

test('Camera ancestors are inspected past an incidental video label on the normal receiver path', () => {
  const e = setupDetection(), camera = makeTrack(e);
  const vid = makeVideo(e, camera, {width: 1920, height: 1080, label: 'Video for Alice'});
  const closest = vid.closest;
  vid.closest = selector => selector.includes('[aria-label*="camera"') ? {getAttribute: () => 'Camera'} : closest(selector);
  new e.window.RTCPeerConnection().receive(camera);
  decode(e, camera, 1920, 1080);
  assert.equal(e.screen.track, null);
  assert.equal(detected(e).length, 0);
});

test('Participant-bearing camera labels cannot turn names into presentation evidence', () => {
  for (const name of ['Tab Hunter', 'Screen Smith', 'Window Jones', 'Presentation Brown', 'Shared White']) {
    const e = setupDetection(), camera = makeTrack(e);
    camera.contentHint = 'motion';
    makeVideo(e, camera, {width: 640, height: 480, label: `Camera for ${name}`});
    new e.window.RTCPeerConnection().receive(camera);
    decode(e, camera, 640, 480);
    e.screen.scanDomForScreenShare(true);
    assert.equal(e.screen.track, null, name);
    assert.equal(detected(e).length, 0, name);
  }
});

test('A DOM-hinted local share keeps its probe after tile removal and re-enabling', () => {
  const e = setupDetection(), share = makeTrack(e);
  new e.window.RTCPeerConnection().senders = [{track: share}];
  const vid = makeVideo(e, share, {width: 1280, height: 720, label: 'Presentation'});
  e.screen.scanDomForScreenShare(true);
  const probe = decode(e, share, 1280, 720);
  vid.remove();
  e.command('FORCE_NO_SCREEN_SHARE', {enabled: true});
  e.command('FORCE_NO_SCREEN_SHARE', {enabled: false});
  assert.equal(e.screen.track, share);
  assert.equal(e.a.videoProbes.get(share.id), probe);
  assert.equal(probe.isConnected, true);
  share.endNaturally(); assert.equal(e.a.videoProbes.size, 0);
});

test('Presentation ancestors are found even when participant video labels contain hint words', () => {
  for (const name of ['Screen Smith', 'Presentation Brown', 'Shared White']) {
    const e = setupDetection(), share = makeTrack(e);
    const vid = makeVideo(e, share, {width: 640, height: 360, label: `Video for ${name}`});
    const section = e.context.document.createElement('section'); section.setAttribute('aria-label', 'Presentation');
    e.context.document.body.appendChild(section); section.appendChild(vid);
    const closest = vid.closest;
    vid.closest = selector => selector.includes('[aria-label*="present"') ? vid : closest(selector);
    e.screen.scanDomForScreenShare(true);
    assert.equal(e.screen.track, share, name);
    const probe = decode(e, share, 640, 360);
    assert.equal(probe.isConnected, true);
  }
});

test('Recording discovers a later explicit local presentation while an inferred video is selected', async () => {
  const e = setupDetection(), camera = makeTrack(e), pc = new e.window.RTCPeerConnection();
  pc.connectionState = 'connected'; pc.receive(camera); decode(e, camera, 1280, 720);
  await e.a.startRecording('later-local-share'); await e.settle();
  const share = makeTrack(e); pc.senders = [{track: share}];
  makeVideo(e, share, {width: 640, height: 360, label: 'Presentation'});
  for (let i = 0; i < 5; i++) {
    e.advanceTime(1000); e.fire(1000); await e.settle();
    e.a.state().timerWorker.onmessage({data: 'tick'});
  }
  assert.equal(e.screen.track, share);
  assert.ok(e.canvasCalls.some(call => call.name === 'drawImage' && call.args[0].srcObject?.getVideoTracks().includes(share)));
  await e.a.stopRecording();
});

test('Recording retires late camera evidence after every initial probe check has expired', async () => {
  const e = setupDetection(), camera = makeTrack(e), pc = new e.window.RTCPeerConnection();
  const vid = makeVideo(e, camera, {width: 1280, height: 720});
  pc.connectionState = 'connected'; pc.receive(camera); const probe = decode(e, camera, 1280, 720);
  for (const delay of [300, 800, 1500, 3000, 6000, 12000, 15000]) e.fire(delay);
  await e.a.startRecording('late-camera-hint'); await e.settle();
  vid.getAttribute = name => name === 'aria-label' ? 'Camera for Alice' : null;
  e.canvasCalls.length = 0;
  for (let i = 0; i < 5; i++) {
    e.advanceTime(1000); e.fire(1000); await e.settle();
    e.a.state().timerWorker.onmessage({data: 'tick'});
  }
  e.command('STATUS');
  assert.equal(e.screen.track, null);
  assert.equal(probe.isConnected, false);
  assert.equal(e.canvasCalls.some(call => call.name === 'drawImage' && call.args[0] === probe), false);
  await e.a.stopRecording();
});

test('A remembered local presentation cannot override a newly exposed self webcam tile', () => {
  const e = setupDetection(), track = makeTrack(e);
  new e.window.RTCPeerConnection().senders = [{track}];
  const presentation = makeVideo(e, track, {width: 1280, height: 720, label: 'Presentation'});
  e.screen.scanDomForScreenShare(true); decode(e, track, 1280, 720);
  presentation.remove();
  const camera = makeVideo(e, track, {width: 1280, height: 720, label: 'Video for Local'});
  const closest = camera.closest;
  camera.closest = selector => selector === '[data-self-name]' ? {} : closest(selector);
  e.command('FORCE_NO_SCREEN_SHARE', {enabled: true});
  e.command('FORCE_NO_SCREEN_SHARE', {enabled: false});
  assert.equal(e.screen.track, null);
  assert.equal(e.a.videoProbes.size, 0);
});

for (const paused of [false, true]) {
  test(`A selected presentation survives tile virtualization during ${paused ? 'pause and resume' : 'refresh and drawing'}`, async () => {
    const e = setupDetection(), first = makeTrack(e), selected = makeTrack(e);
    makeVideo(e, first, {width: 1920, height: 1080, label: 'Presentation'});
    e.screen.scanDomForScreenShare(true); decode(e, first, 1920, 1080);
    selected.contentHint = 'detail'; e.a.addVideoTrack(selected);
    const selectedVideo = makeVideo(e, selected, {width: 1280, height: 720, label: 'Presentation'});
    const probe = decode(e, selected, 1280, 720);
    for (const delay of [300, 800, 1500, 3000, 6000, 12000, 15000]) e.fire(delay);
    await e.a.startRecording('virtualized-selected-share'); await e.settle();
    assert.equal(e.screen.track, selected);
    selectedVideo.remove(); if (paused) e.command('PAUSE');
    for (let i = 0; i < 4; i++) { e.advanceTime(1000); e.fire(1000); await e.settle(); }
    if (paused) e.command('RESUME');
    e.canvasCalls.length = 0; e.a.state().timerWorker.onmessage({data: 'tick'});
    assert.equal(e.screen.track, selected);
    assert.equal(e.a.videoProbes.get(selected.id), probe);
    assert.ok(e.canvasCalls.some(call => call.name === 'drawImage' && call.args[0] === probe));
    // A newly discovered explicit source can still replace the selected share.
    const newest = makeTrack(e); makeVideo(e, newest, {width: 640, height: 360, label: 'Presentation'});
    e.advanceTime(1000); e.fire(1000); await e.settle();
    assert.equal(e.screen.track, newest);
    await e.a.stopRecording();
  });
}

test('STREAMs rechecks preserve the selected share when registration and identification orders differ', async () => {
  const e = setupDetection(), selected = makeTrack(e), first = makeTrack(e);
  // Register B before A; identify A first, then B after initial checks expire.
  e.a.addVideoTrack(selected);
  first.contentHint = 'detail'; e.a.addVideoTrack(first);
  makeVideo(e, first, {width: 1920, height: 1080, label: 'Presentation'});
  decode(e, first, 1920, 1080);
  for (const delay of [300, 800, 1500, 3000, 6000, 12000]) e.fire(delay);
  selected.contentHint = 'detail';
  const tile = makeVideo(e, selected, {width: 1280, height: 720, label: 'Presentation'});
  const probe = decode(e, selected, 1280, 720); e.fire(15000);
  assert.deepEqual(Array.from(e.a.activeScreenShareTracks, track => track.id), [first.id, selected.id]);
  await e.a.startRecording('recheck-order'); await e.settle();
  tile.remove(); e.command('FORCE_NO_SCREEN_SHARE', {enabled: true});
  e.command('FORCE_NO_SCREEN_SHARE', {enabled: false});
  for (let i = 0; i < 4; i++) { e.advanceTime(1000); e.fire(1000); await e.settle(); }
  e.canvasCalls.length = 0; e.a.state().timerWorker.onmessage({data: 'tick'});
  assert.equal(e.screen.track, selected);
  assert.ok(e.canvasCalls.some(call => call.name === 'drawImage' && call.args[0] === probe));
  // The stability guard must still permit camera rejection and live fallback.
  e.command('FORCE_NO_SCREEN_SHARE', {enabled: true}); selected.contentHint = 'motion';
  e.command('FORCE_NO_SCREEN_SHARE', {enabled: false});
  assert.equal(e.screen.track, first);
  assert.equal(probe.isConnected, false);
  await e.a.stopRecording();
});

test('An older probe decoding first cannot prevent a newly identified presentation from displaying', () => {
  const e = setupDetection(), older = makeTrack(e), newer = makeTrack(e);
  older.contentHint = newer.contentHint = 'detail';
  e.a.addVideoTrack(older); e.a.addVideoTrack(newer);
  decode(e, older, 1280, 720);
  decode(e, newer, 1280, 720);
  assert.equal(e.screen.track, newer);
});

for (const signal of ['DOM', 'displaySurface', 'detail']) {
  test(`A new explicit ${signal} presentation is discovered while the current tile remains visible`, async () => {
    const e = setupDetection(), current = makeTrack(e), pc = new e.window.RTCPeerConnection();
    current.contentHint = 'detail'; pc.connectionState = 'connected'; pc.receive(current);
    const oldTile = makeVideo(e, current, {width: 1920, height: 1080, label: 'Presentation'});
    decode(e, current, 1920, 1080);
    await e.a.startRecording('new-visible-share'); await e.settle();
    const next = makeTrack(e, signal === 'displaySurface' ? {displaySurface: 'browser'} : {});
    if (signal === 'detail') next.contentHint = 'detail';
    pc.senders = [{track: next}];
    makeVideo(e, next, {width: 640, height: 360, label: signal === 'DOM' ? 'Presentation' : ''});
    for (let i = 0; i < 4; i++) {
      e.advanceTime(1000); e.fire(1000); await e.settle();
      e.a.state().timerWorker.onmessage({data: 'tick'});
    }
    assert.equal(oldTile.isConnected, true);
    assert.equal(e.screen.track, next);
    assert.ok(e.a.allVideoTracks.includes(next));
    assert.ok(e.canvasCalls.some(call => call.name === 'drawImage' && call.args[0].srcObject?.getVideoTracks().includes(next)));
    e.command('FORCE_NO_SCREEN_SHARE', {enabled: true}); e.command('FORCE_NO_SCREEN_SHARE', {enabled: false});
    e.command('PAUSE'); e.advanceTime(1000); e.fire(1000); await e.settle(); e.command('RESUME');
    assert.equal(e.screen.track, next);
    await e.a.stopRecording();
  });
}

test('A receiver reused for presentation regains an owned probe before its tile disappears', async () => {
  const e = setupDetection(), track = makeTrack(e), pc = new e.window.RTCPeerConnection();
  pc.connectionState = 'connected'; pc.receive(track);
  decode(e, track, 640, 480);
  assert.equal(e.a.videoProbes.has(track.id), false);
  assert.ok(e.a.allVideoTracks.includes(track));
  await e.a.startRecording('reused-presentation-receiver'); await e.settle();
  const tile = makeVideo(e, track, {width: 1280, height: 720, label: 'Presentation'});
  e.advanceTime(1000); e.fire(1000); await e.settle();
  assert.equal(e.screen.track, track);
  const probe = decode(e, track, 1280, 720);
  tile.remove();
  for (let i = 0; i < 4; i++) { e.advanceTime(1000); e.fire(1000); await e.settle(); }
  e.canvasCalls.length = 0; e.a.state().timerWorker.onmessage({data: 'tick'});
  assert.equal(e.screen.track, track);
  assert.ok(e.canvasCalls.some(call => call.name === 'drawImage' && call.args[0] === probe));
  await e.a.stopRecording();
});

for (const signal of ['detail', 'text', 'displaySurface']) {
  for (const existingShare of [false, true]) {
    test(`A retired receiver gains ${signal} without a tile ${existingShare ? 'during another share' : 'over the background'}`, async () => {
      const e = setupDetection(), pc = new e.window.RTCPeerConnection(), track = makeTrack(e);
      pc.connectionState = 'connected'; pc.receive(track); decode(e, track, 640, 480);
      assert.equal(e.a.videoProbes.has(track.id), false);
      if (existingShare) {
        const current = makeTrack(e); current.contentHint = 'detail'; pc.receive(current);
        decode(e, current, 1280, 720);
      }
      await e.a.startRecording('hidden-reused-receiver'); await e.settle();
      if (signal === 'displaySurface') track.getSettings = () => ({displaySurface: 'browser'});
      else track.contentHint = signal;
      for (let i = 0; i < 5; i++) {
        e.advanceTime(1000); e.fire(1000); await e.settle();
        e.a.state().timerWorker.onmessage({data: 'tick'});
      }
      assert.equal(e.screen.track, track);
      const probe = decode(e, track, 640, 360);
      e.canvasCalls.length = 0; e.a.state().timerWorker.onmessage({data: 'tick'});
      assert.ok(e.canvasCalls.some(call => call.name === 'drawImage' && call.args[0] === probe));
      e.command('STATUS'); assert.equal(e.screen.track, track);
      await e.a.stopRecording();
    });
  }
}

test('A retained undecoded receiver detects a late explicit hint after initial checks expire', async () => {
  const e = setupDetection(), pc = new e.window.RTCPeerConnection(), track = makeTrack(e);
  pc.connectionState = 'connected'; pc.receive(track);
  const probe = e.a.videoProbes.get(track.id);
  for (const delay of [300, 800, 1500, 3000, 6000, 12000]) e.fire(delay);
  await e.a.startRecording('retained-hidden-receiver'); await e.settle();
  track.contentHint = 'detail';
  e.advanceTime(1000); e.fire(1000); await e.settle();
  assert.equal(e.screen.track, track);
  assert.equal(e.a.videoProbes.get(track.id), probe);
  await e.a.stopRecording();
});
