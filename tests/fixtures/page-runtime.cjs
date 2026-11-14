'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const {execFileSync} = require('child_process');
const sourcePath = process.env.MEETBUD_SOURCE_PATH || path.resolve(__dirname, '../../injected.js');
const original = process.env.MEETBUD_SOURCE_REF
  ? execFileSync('git', ['show', `${process.env.MEETBUD_SOURCE_REF}:injected.js`], {cwd: path.dirname(sourcePath), encoding: 'utf8'})
  : fs.readFileSync(sourcePath, 'utf8');
const hook = `window.__audit = {
  addAudioTrack, addVideoTrack, probeVideoTrack, startRecording, stopRecording,
  cleanupRecordingResources, startCompositorLoop, stopCompositorLoop,
  audioTracks, audioSources, trackGainNodes, trackSinkEls, trackAnalysers,
  trackStreamMap, allVideoTracks, videoProbes, domVideoElements, activeScreenShareTracks,
  activePeerConnections, secondaryRecorders, trackMixers, trackDestNodes, trackGains,
  scanParticipantTiles, getParticipantForTrack, getLocalUserInfo, renderSpeakersOverlay,
  audioTrackToParticipant, participantTileCache, avatarImageCache, activeSpeakers,
  audioLevels, trackCorrelation,
  participantMetadata: typeof participantMetadata === 'undefined' ? null : participantMetadata,
  setLocalVolume(value) { localMicVolume = value; },
  setId(id) { currentRecordId = id; },
  state() { return { mediaRecorder, recordingCanvasStream, canvasElement, timerWorker, canvasIntervalId, isRecording, audioCtx, volumePollId, activeSession: typeof activeRecordingSession === 'undefined' ? null : activeRecordingSession }; }
};\n`;
const instrumented = original.replace("  postOut('INJECTED',", hook + "  postOut('INJECTED',");
class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(x => x !== fn)); }
  dispatch(type, event = {}) { for (const fn of [...(this.listeners.get(type) || [])]) fn(event); }
}
function setup(opts = {}) {
  let id = 0, now=1000000;
  const timers = new Map(), recorderInventory = [], workerInventory = [], urls = new Set(), elements = [], nodes = [], messages = [], writes = [], pendingWrites = [], stopEvents = [], images = [], canvasCalls = [];
  class Track extends Events {
    constructor(kind, label = '') { super(); this.id = 'track-' + (++id); this.kind = kind; this.label = label; this.contentHint = ''; this.readyState = 'live'; this.enabled = true; this.muted = false; }
    getSettings() { return {}; }
    stop() { this.readyState = 'ended'; }
    endNaturally() { this.readyState = 'ended'; this.dispatch('ended'); }
  }
  class Stream {
    constructor(tracks = []) { this.id = 'stream-' + (++id); this.tracks = tracks; }
    getTracks() { return [...this.tracks]; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
  }
  class El extends Events {
    constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.style = {}; this.isConnected = false; this.srcObject = null; this.parentElement = null; this.videoWidth = 0; this.videoHeight = 0; this.readyState = 0; this._text = ''; this.children = []; this.attrs = new Map(); elements.push(this); }
    get textContent() { return this._text + this.children.map(el => el.textContent).join(''); }
    set textContent(value) { this._text = value; }
    get childNodes() { return this.children.length ? this.children : (this._text ? [{nodeType: 3}] : []); }
    appendChild(el) { el.remove(); this.children.push(el); el.parentElement = this; el.setConnected(this.isConnected); return el; }
    setConnected(value) { this.isConnected = value; this.children.forEach(el => el.setConnected(value)); }
    remove() { if (this.parentElement?.children) this.parentElement.children = this.parentElement.children.filter(el => el !== this); this.setConnected(false); this.parentElement = null; }
    play() { return Promise.resolve(); }
    matches(selector) {
      return selector.split(',').some(part => {
        const tag = part.trim().match(/^[a-z]+/i)?.[0];
        if (tag && tag.toUpperCase() !== this.tagName) return false;
        const attrs = [...part.matchAll(/\[([\w-]+)(?:(\^=|\*=|=)"([^"]*)")?\]/g)];
        return !!(tag || attrs.length) && attrs.every(([,key,op,value]) => {
          const actual = this.getAttribute(key);
          return actual !== null && (!op || (op === '=' ? actual === value : op === '^=' ? actual.startsWith(value) : actual.includes(value)));
        });
      });
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) { const out = []; const visit = el => { for (const child of el.children) { if (child.matches(selector)) out.push(child); visit(child); } }; visit(this); return out; }
    closest(selector) { for (let el = this; el; el = el.parentElement) if (el.matches(selector)) return el; return null; }
    getAttribute(key) { if (key === 'src' && this.src) return this.src; return this.attrs.get(key) ?? null; }
    setAttribute(key, value) { this.attrs.set(key, String(value)); if (key === 'src') this.src = String(value); }
    hasAttribute(key) { return this.getAttribute(key) !== null; }
    getBoundingClientRect() { return {width: 0, height: 0}; }
    getContext() {
      if (opts.failContext) return null;
      const ctx = {measureText: text => ({width: text.length * 8}), createLinearGradient: () => ({addColorStop() {}})};
      for (const name of ['fillRect', 'drawImage', 'fillText', 'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'arc', 'clip', 'fill', 'stroke']) ctx[name] = (...args) => canvasCalls.push({name, args});
      return ctx;
    }
    captureStream() { if (opts.failCapture) throw new Error('fixture: capture failed'); opts.onCapture?.(window.__audit, images); return new Stream([new Track('video', 'canvas')]); }
  }
  const root = new El('html'); root.isConnected = true;
  const window = new Events(); window.postMessage = message => messages.push(message); window.innerWidth = 1920; window.innerHeight = 1080;
  window.getComputedStyle = el => ({outlineStyle:'none', outlineWidth:'0', borderStyle:'none', borderWidth:'0', boxShadow:'none', ...el.style});
  class Peer extends Events {
    constructor() { super(); this.connectionState = 'new'; this.senders = []; }
    getSenders() { return this.senders; }
    close() { this.connectionState = 'closed'; this.dispatch('connectionstatechange'); }
    receive(track, stream = new Stream([track])) { this.dispatch('track', { track, streams: [stream] }); return stream; }
  }
  window.RTCPeerConnection = Peer;
  class Node {
    constructor() { nodes.push(this); this.edges = new Set(); this.gain = {value: 1, setValueAtTime(value) {this.value=value;}, setTargetAtTime(value) {this.value=value;}}; this.frequencyBinCount=32; }
    connect(other) { this.edges.add(other); }
    disconnect() { this.edges.clear(); }
    getByteFrequencyData(array) { array.fill(0); }
    start() {}
    stop() {}
  }
  const resumePending = []; let gainCalls=0;
  class AudioCtx {
    constructor() { if (opts.failAudioContext) throw new Error('fixture: AudioContext failed'); this.state = opts.deferredResume ? 'suspended' : 'running'; this.currentTime = 0; }
    resume() { if (!opts.deferredResume) { this.state = 'running'; return Promise.resolve(); } return new Promise(resolve => resumePending.push(() => { this.state = 'running'; resolve(); })); }
    close() { this.state='closed'; return Promise.resolve(); }
    createMediaStreamDestination() { const node = new Node(); node.stream = new Stream([new Track('audio', 'destination')]); return node; }
    createGain() { if (++gainCalls===opts.failGainAt) throw new Error('fixture: gain failed'); return new Node(); }
    createAnalyser() { return new Node(); }
    createOscillator() { return new Node(); }
    createMediaStreamSource(stream) { if (opts.failAudioSource) throw new Error('fixture: source failed'); const node = new Node(); node.mediaStream = stream; return node; }
  }
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(stream) { if (opts.failMainConstructor && stream.getVideoTracks().length) throw new Error('fixture: main construction failed'); this.stream = stream; this.state = 'inactive'; this.ondataavailable = null; this.onerror = null; this.onstop = null; recorderInventory.push(this); }
    start() { if ((opts.failMainStart && this.stream.getVideoTracks().length) || (opts.failSecondaryStart && !this.stream.getVideoTracks().length)) throw new Error('fixture: MediaRecorder.start failure'); this.state = 'recording'; }
    requestData() { if (opts.failRequestData) throw new Error('fixture: requestData failed'); }
    data(size=10) { this.ondataavailable?.({data:new Blob([new Uint8Array(size)])}); }
    stop() { this.state = 'inactive'; const dispatch = () => { if (opts.finalChunkSize) this.data(opts.finalChunkSize); this.onstop?.(); }; if (opts.deferredStop) stopEvents.push(dispatch); else dispatch(); }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    autoStop() { this.stop(); }
  }
  class Worker {
    constructor(url) { if (opts.failWorker) throw new Error('fixture: worker construction blocked'); this.url = url; this.terminated = false; workerInventory.push(this); }
    postMessage() { if (opts.failWorkerPost) throw new Error('fixture: worker post failed'); }
    terminate() { this.terminated = true; }
  }
  const document = {body: root, documentElement: root, createElement: tag => new El(tag), querySelector: selector => root.querySelector(selector), querySelectorAll: selector => root.querySelectorAll(selector)};
  const context = vm.createContext({window, document, AudioContext: AudioCtx, MediaStream: Stream, MediaRecorder: Recorder, Worker,
    Image: class {
      constructor() { this.complete = false; this.naturalWidth = 0; this._src = ''; images.push(this); }
      get src() { return this._src; }
      set src(value) { this._src = value; this.complete = false; this.naturalWidth = 0; if (value && opts.loadedAvatars) this.load(); }
      load(success = true) { this.complete = true; this.naturalWidth = success ? 200 : 0; (success ? this.onload : this.onerror)?.(); }
    },
    Node: {TEXT_NODE: 3},
    Blob, Uint8Array, Map, Set, Date: class extends Date {static now() {return now;}}, Reflect, Object, Promise,
    console: {log() {}, warn() {}, error() {}},
    URL: {createObjectURL() { const url = 'blob:fixture-' + (++id); urls.add(url); return url; }, revokeObjectURL(url) { urls.delete(url); }},
    indexedDB: {open() { const req = {}; queueMicrotask(() => req.onsuccess?.({target: {result: {close() {}, transaction() {const tx = {objectStore: () => ({add(row) {writes.push(row); return {};}})}; const complete = () => opts.failWrite ? tx.onabort?.() : tx.oncomplete?.(); if (opts.deferredWrites) pendingWrites.push(complete); else queueMicrotask(complete); return tx;}}}})); return req;}},
    setTimeout(fn, ms) { const tid = ++id; timers.set(tid, {fn, ms}); return tid; }, clearTimeout(tid) { timers.delete(tid); },
    setInterval(fn, ms) { const tid = ++id; timers.set(tid, {fn, ms, interval: true}); return tid; }, clearInterval(tid) { timers.delete(tid); }
  });
  vm.runInContext(instrumented, context, {filename:sourcePath});
  return {a: window.__audit, window, Track, Stream, timers, recorderInventory, workerInventory, urls, elements, context, resumePending, nodes, messages, writes, pendingWrites, stopEvents, images, canvasCalls,
    command(cmd, data={}) { window.dispatch('message', {data:{source:'MEET_REC_CMD',cmd,...data}}); },
    async settle() { for(let n=0;n<30;n++) await Promise.resolve(); },
    releaseWrites() { pendingWrites.splice(0).forEach(fn=>fn()); },
    releaseStops() { stopEvents.splice(0).forEach(fn=>fn()); },
    advanceTime(ms) {now+=ms;},
    fire(ms) { const matches = [...timers].filter(([,v]) => v.ms === ms); for (const [tid, v] of matches) { if (!v.interval) timers.delete(tid); v.fn(); } }
  };
}

module.exports = {setup, original};
