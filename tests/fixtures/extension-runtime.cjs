'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { webm } = require('./webm.cjs');
const root = path.resolve(__dirname, '../..');
const source = name => process.env.MEETBUD_SOURCE_DIR ? fs.readFileSync(path.join(process.env.MEETBUD_SOURCE_DIR, name), 'utf8') : process.env.MEETBUD_SOURCE_REF
  ? execFileSync('git', ['show', process.env.MEETBUD_SOURCE_REF + ':' + name], { cwd: root, encoding: 'utf8' })
  : fs.readFileSync(path.join(root, name), 'utf8');
const instrument = (text, exportText) => { const i = text.lastIndexOf('})();'); return text.slice(0, i) + exportText + '\n' + text.slice(i); };
const quiet = { log() {}, warn() {}, error() {} };
const copy = value => value === undefined ? undefined : structuredClone(value);
const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); await new Promise(setImmediate); for (let i = 0; i < 40; i++) await Promise.resolve(); };
function clock() {
  let now = 1000000, id = 0; const timers = new Map();
  return { timers, now: () => now,
    setTimeout(fn, ms = 0) { const k = ++id; timers.set(k, { fn, due: now + ms }); return k; }, clearTimeout(k) { timers.delete(k); },
    async advance(ms) { const end = now + ms; for (;;) {
      let first; for (const pair of timers) if (pair[1].due <= end && (!first || pair[1].due < first[1].due)) first = pair;
      if (!first) break; now = first[1].due; timers.delete(first[0]); first[1].fn(); await drain();
    } now = end; await drain(); }
  };
}
function dom() {
  const all = [], ids = new Map();
  function element(tag) {
    const events = new Map(), classes = new Set();
    const e = { tagName: tag.toUpperCase(), style: {}, children: [], parentNode: null, attrs: {}, textContent: '', checked: false,
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle: c => classes.has(c) ? classes.delete(c) : classes.add(c) },
      appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child; },
      prepend(child) { child.remove(); this.children.unshift(child); child.parentNode = this; },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }, remove() { this.parentNode?.removeChild(this); },
      click() { return this.emit('click', { target: this, stopPropagation() {} }); },
      addEventListener(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); },
      emit(name, event) { return Promise.all((events.get(name) || []).map(fn => fn(event))); },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, removeAttribute(k) { delete this.attrs[k]; }, closest() { return null; }
    };
    Object.defineProperty(e, 'firstChild', { get: () => e.children[0] });
    Object.defineProperty(e, 'innerHTML', { set(v) { this._html = v; for (const c of this.children) c.parentNode = null; this.children = []; }, get() { return this._html || ''; } });
    all.push(e); return e;
  }
  const head = element('head'), body = element('body');
  const get = id => { if (!ids.has(id)) ids.set(id, element('div')); return ids.get(id); };
  return { all, get, document: { head, body, documentElement: head, createElement: element, getElementById: get, querySelectorAll() { return []; } } };
}
function database() {
  const rows = [], handles = [];
  const faults = { open: false, read: false, delete: false, abortDelete: false, readWait: null };
  const api = { open() { const req = {}; queueMicrotask(() => {
    if (faults.open) { req.onerror?.({ target: { error: new Error('fixture open failed') } }); return; }
    const handle = { objectStoreNames: { contains: () => true }, close() { this.closed = true; }, transaction(name, mode) {
      if (this.closed) { const error = new Error('database connection is closing'); error.name = 'InvalidStateError'; throw error; }
      if (mode === 'readwrite' && faults.delete) throw new Error('fixture deletion failed');
      const tx = { error: null };
      tx.objectStore = () => ({ index: () => ({
        getAll(id) { const req = {}; const run = () => {
          if (faults.read) { req.error = new Error('fixture read failed'); req.onerror?.(); }
          else { req.result = rows.filter(r => r.recordingId === id).map(copy); req.onsuccess?.(); }
        }; if (faults.readWait) faults.readWait.then(run); else queueMicrotask(run); return req; },
        openCursor(id) {
          const req = {}, selected = rows.filter(r => r.recordingId === id), deleted = []; let pos = 0;
          const step = () => {
            const row = selected[pos++];
            req.onsuccess?.({ target: { result: row ? { delete() { deleted.push(row); }, continue() { queueMicrotask(step); } } : null } });
            if (!row) queueMicrotask(() => {
              if (faults.abortDelete) { tx.error = new Error('fixture deletion aborted'); tx.onabort?.(); return; }
              for (const r of deleted) { const i = rows.indexOf(r); if (i >= 0) rows.splice(i, 1); } tx.oncomplete?.();
            });
          }; queueMicrotask(step); return req;
        },
        openKeyCursor() {
          const req = {}, keys = [...new Set(rows.map(r => r.recordingId))].sort(); let pos = 0;
          const step = () => { const key = keys[pos++]; req.onsuccess?.({ target: { result: key === undefined ? null : { key, continue() { queueMicrotask(step); } } } }); if (key === undefined) queueMicrotask(() => tx.oncomplete?.()); };
          queueMicrotask(step); return req;
        }
      }), add(row) { const req = {}; queueMicrotask(() => { rows.push(copy(row)); tx.oncomplete?.(); }); return req; } });
      return tx;
    } }; handles.push(handle); req.onsuccess?.({ target: { result: handle } });
  }); return req; } };
  return { rows, handles, faults, api };
}
function cluster() {
  const stored = {}, changes = [], tabs = new Map(), db = database(), backgroundMessages = [];
  let handler, onRemoved, onUpdated, onActivated;
  const actionCalls = [];
  const local = {
    get(key, callback) { const result = key === null ? copy(stored) : { [key]: copy(stored[key]) }; queueMicrotask(() => callback?.(result)); return Promise.resolve(result); },
    set(values, callback) { const delta = {}; for (const [key, value] of Object.entries(values)) { delta[key] = { oldValue: copy(stored[key]), newValue: copy(value) }; stored[key] = copy(value); }
      queueMicrotask(() => { for (const listener of changes) listener(delta, 'local'); callback?.(); }); return Promise.resolve(); },
    remove(keys, callback) { const delta = {}; for (const key of Array.isArray(keys) ? keys : [keys]) { delta[key] = { oldValue: copy(stored[key]) }; delete stored[key]; }
      queueMicrotask(() => { for (const listener of changes) listener(delta, 'local'); callback?.(); }); return Promise.resolve(); }
  };
  const chrome = { storage: { local }, runtime: { onMessage: { addListener(fn) { handler = fn; } }, sendMessage(message) { backgroundMessages.push(copy(message)); return Promise.resolve(); } },
    action: { setIcon(value) { actionCalls.push({type:'icon', ...value}); return Promise.resolve(); }, setTitle(value) { actionCalls.push({type:'title', ...value}); return Promise.resolve(); } },
    tabs: { query(query, cb) { cb([...tabs.values()].filter(tab => (!query.active || tab.active) && (!query.url || tab.url.startsWith('https://meet.google.com/'))).map(tab => ({ id: tab.id, url: tab.url }))); },
      get(id, cb) { const tab=tabs.get(id); if(!tab) chrome.runtime.lastError={message:'fixture tab missing'}; cb(tab ? {id,url:tab.url}:undefined); chrome.runtime.lastError=null; },
      onUpdated: {addListener(fn) { onUpdated=fn; }}, onActivated: {addListener(fn) { onActivated=fn; }},
      sendMessage(id, message, cb) { const tab = tabs.get(id); if (!tab || tab.unreachable) { chrome.runtime.lastError = { message: 'fixture tab unavailable' }; cb?.(); chrome.runtime.lastError = null; return; }
        tab.command(message.type, message, false).then(responses => cb?.(responses[0])); }, onRemoved: { addListener(fn) { onRemoved = fn; } } },
    scripting: { executeScript(opts, cb) { const tab = tabs.get(opts.target.tabId); for (const file of opts.files) file === 'muxer.js' ? tab.evalMux() : file === 'webm_metadata.js' ? tab.evalMetadata() : tab.evalContent(); cb?.(); } }
  };
  const restartBackground = () => vm.runInNewContext(source('background.js'), { chrome, console: quiet, URL, Date, Promise, Map, setTimeout, clearTimeout });
  restartBackground();
  function dispatch(message, sender = {}) { return new Promise(resolve => { const async = handler(message, sender, resolve); if (async !== true) resolve(undefined); }); }
  return { actionCalls, updateTab(id,url,status='loading') { const tab=tabs.get(id), change={status}; if(url!==tab.url) change.url=url; tab.url=url; onUpdated?.(id,change,tab); }, activateTab(id) { for(const tab of tabs.values()) tab.active=tab.id===id; onActivated?.({tabId:id}); }, stored, db, tabs, local, changes, dispatch, backgroundMessages, chrome, restartBackground, removeTab(id) { tabs.delete(id); onRemoved?.(id); }, jobKeys() { return Object.keys(stored).filter(k => k.startsWith('meetBudyPendingCombine:')); } };
}
function environment({ group = cluster(), id = 7, mode = 'success', bootContent = true } = {}) {
  const time = clock(), document = dom(), posts = [], sent = [], workers = [], urls = new Map(), pageListeners = [], runtimeListeners = [];
  let urlId = 0;
  const faults = { mode, fetch: false, fetchWait: null, download: false };
  class Worker {
    constructor(url) { if (faults.mode === 'constructor-failure') throw new Error('fixture constructor failure'); this.url = url; this.messages = []; this.terminated = false; workers.push(this); }
    postMessage(message) {
      this.messages.push(message);
      const mode = faults.mode;
      if (mode === 'post-' + message.cmd + '-failure') throw new Error('fixture postMessage failure');
      if (mode === 'hung-' + message.cmd) return;
      queueMicrotask(() => { if (this.terminated) return;
        if (mode === 'fatal-' + message.cmd) this.onerror?.({ message: 'fixture fatal' });
        else if (mode === 'decode-' + message.cmd) this.onmessageerror?.({});
        else this.onmessage?.({ data: { id: message.id, ok: mode !== 'reject-' + message.cmd, error: 'fixture reply failure', data: new Uint8Array(2048) } });
      });
    }
    terminate() { this.terminated = true; }
    reply(cmd = 'run') { const message = [...this.messages].reverse().find(m => m.cmd === cmd); this.onmessage?.({ data: { id: message.id, ok: true, data: new Uint8Array(2048) } }); }
  }
  const sender = { tab: { id, url: 'https://meet.google.com/fixture-' + id } };
  const chrome = { runtime: { getURL: p => 'chrome-extension://fixture/' + p, onMessage: { addListener: fn => runtimeListeners.push(fn) },
    sendMessage(message, callback) {
      sent.push(copy(message)); const promise = group.dispatch(message, sender);
      promise.then(result => callback?.(result)); return promise;
    } }, storage: { local: group.local, onChanged: { addListener: fn => group.changes.push(fn) } } };
  const windowEvents = new Map();
  const window = { addEventListener(name, fn) { if (name === 'message') pageListeners.push(fn); else { if(!windowEvents.has(name)) windowEvents.set(name,[]); windowEvents.get(name).push(fn); } }, postMessage(p) { posts.push(copy(p)); } };
  class DateMock extends Date { static now() { return time.now(); } }
  class URLMock extends URL { static createObjectURL(blob) { const url = 'blob:fixture-' + (++urlId); urls.set(url, blob); return url; } static revokeObjectURL(url) { urls.delete(url); } }
  const context = vm.createContext({ window, document: document.document, location: { origin: 'https://meet.google.com' }, chrome,
    Blob, Uint8Array, ArrayBuffer, DataView, Set, Map, Promise, console: quiet, Date: DateMock, Math, URL: URLMock, AbortController,
    indexedDB: group.db.api, IDBKeyRange: { only: x => x }, Worker, queueMicrotask,
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, setInterval: time.setTimeout, clearInterval: time.clearTimeout,
    fetch: async (url, opts) => { if (opts?.method !== 'HEAD') { if (faults.fetch) throw new Error('fixture fetch failed'); if (faults.fetchWait) await faults.fetchWait; }
      return { ok: true, text: async () => '', arrayBuffer: async () => new ArrayBuffer(16) }; }
  });
  const create = document.document.createElement;
  document.document.createElement = tag => { const e = create(tag); if (tag === 'a') { const click = e.click; e.click = () => { if (faults.download) throw new Error('fixture download failed'); return click.call(e); }; } return e; };
  const evalMetadata = () => vm.runInContext(source('webm_metadata.js'),context);
  const evalMux = () => vm.runInContext(instrument(source('muxer.js'), 'window.__mux = { buildWorkerScript, state: () => ({ loaded: !!_ffmpeg, loading: !!_loading }) };'), context);
  const evalContent = () => vm.runInContext(instrument(source('content_script.js'), `window.__content = { sendCmd, savePendingCombine, loadPendingCombine, runPendingCombine, cancelPendingCombine, deferPendingCombine, openDB, assembleAndDownload,
    recoverStoredRecordings: typeof recoverStoredRecordings === 'function' ? recoverStoredRecordings : null,
    state: () => ({ pageInjected, pendingCount: pendingPageCommands.length, currentRecordingId, job: currentPendingCombine, combineInProgress }) };`), context);
  async function command(type, extra = {}, waitForEffects = true) {
    const response = await new Promise(resolve => runtimeListeners.forEach(fn => fn({ ...extra, type }, sender, resolve)));
    if (waitForEffects) await drain(); return [response];
  }
  async function page(event, data) { await Promise.all(pageListeners.map(fn => fn({ data: { source: 'MEET_REC_PAGE', type: 'EVENT', event, data } }))); await drain(); }
  const e = { id, url: sender.tab.url, active: true, group, time, document, posts, sent, workers, urls, pageListeners, runtimeListeners, faults, window, context, chrome, command, page, evalMux, evalContent, evalMetadata,
    emitWindow(name,event={}) { for(const fn of windowEvents.get(name)||[]) fn(event); },
    seed(rid, count = 2, options = {}) { const data=webm({audio:rid.includes('__t'), ...options}); for(let i=0;i<count;i++) group.db.rows.push({recordingId:rid,data:new Blob([data.subarray(Math.floor(data.length*i/count),Math.floor(data.length*(i+1)/count))])}); },
    job(rid) { return { id: rid, recordingId: rid, mimeType: 'video/webm', secondaries: [{ recordingId: rid + '__t2', trackId: 2, name: 'extra', mimeType: 'audio/webm' }], createdAt: time.now(), nextPromptAt: 0 }; },
    async finish(rid, multi = true, extra = {}) { e.seed(rid); if (multi) e.seed(rid + '__t2'); await page('RECORDING_STARTED', { recordingId: rid, mimeType: 'video/webm' }); await page('RECORDING_STOPPED', { recordingId: rid, mimeType: 'video/webm', secondaries: multi ? e.job(rid).secondaries : [], ...extra }); }
  };
  group.tabs.set(id, e);
  evalMetadata(); evalMux(); if (bootContent) evalContent();
  return e;
}
async function waitForRun(e, afterWorkers = 0) { for (let i = 0; i < 60; i++) { if (e.workers.slice(afterWorkers).some(w => w.messages.some(m => m.cmd === 'run'))) return; await drain(); } throw new Error('fixture did not reach worker run'); }
async function popup(e) {
  const chrome = { ...e.chrome, tabs:e.group.chrome.tabs, runtime: { ...e.chrome.runtime, sendMessage(message, cb) { const p = e.group.dispatch(message, {}); p.then(result => cb?.(result)); return p; } } };
  const listeners = [];
  chrome.runtime.onMessage = { addListener: fn => listeners.push(fn) };
  const context = vm.createContext({ ...e.context, window: {}, chrome });
  const src = source('popup/popup.js').replace(/\n  init\(\);/, '\n // Boot skipped: pending UI initialized explicitly.');
  vm.runInContext(instrument(src, 'window.__popup = { initButtonListeners, loadPendingCombineFromStorage, handleStatus, state: () => ({ job: pendingCombineJob, timer: pendingCombineTimer, isRecording, startTime, timerInterval, activeRecordingId: typeof activeRecordingId === "undefined" ? null : activeRecordingId, activeRecordingContextId: typeof activeRecordingContextId === "undefined" ? null : activeRecordingContextId, activeRecordingTabId: typeof activeRecordingTabId === "undefined" ? null : activeRecordingTabId }) };'), context);
  const ui = context.window.__popup;
  ui.initButtonListeners(); ui.loadPendingCombineFromStorage(); await drain();
  ui.message = message => listeners.forEach(fn => fn(message));
  return ui;
}
module.exports = { environment, cluster, drain, waitForRun, popup, vm, copy };
