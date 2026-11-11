/**
 * ffmpeg.wasm remuxer. Content-script workers must use a page-origin Blob URL;
 * extension URLs are fetched and inlined instead of passed to Worker.
 */
(function () {
  'use strict';
  // FORCE_REINJECT runs this file before the guarded bridge. Keep its owner.
  if (window.MeetBudyMuxer?._meetBudyManaged) return;
  const FFMPEG_CORE_JS_URL = chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.js');
  const FFMPEG_WASM_URL = chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.wasm');
  const LOAD_TIMEOUT = 30000;
  const RUN_TIMEOUT = 10 * 60 * 1000;
  let _available = null;
  let _ffmpeg = null;
  let _loading = null;
  let _owner = null;

  async function probe(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try { return (await fetch(url, { method: 'HEAD', signal: controller.signal })).ok; }
    catch (_) { return false; }
    finally { clearTimeout(timer); }
  }
  async function isAvailable() {
    if (_available !== null) return _available;
    const [a, b] = await Promise.all([probe(FFMPEG_CORE_JS_URL), probe(FFMPEG_WASM_URL)]);
    _available = a && b;
    return _available;
  }

  function buildWorkerScript(coreText) {
    return `
      ${coreText}
      let core = null;
      const ffLog = [];
      const log = (line) => {
        ffLog.push(String(line));
        if (ffLog.length > 80) ffLog.shift();
        self.postMessage({ kind: 'log', line });
      };
      self.onmessage = async (e) => {
        const { id, cmd, args, files, wasmBinary } = e.data;
        try {
          if (cmd === 'init') {
            core = await createFFmpegCore({ wasmBinary, print: log, printErr: log });
            self.postMessage({ id, ok: true });
          } else if (cmd === 'run') {
            if (!core) throw new Error('ffmpeg core not initialized');
            try {
              for (const f of files) core.FS.writeFile(f.name, f.data);
              const ret = core.exec(...args);
              if (ret !== 0) throw new Error('ffmpeg exit ' + ret + ' — tail: ' + ffLog.slice(-6).join(' | '));
              const out = core.FS.readFile('output.mkv');
              self.postMessage({ id, ok: true, data: out }, [out.buffer]);
            } finally {
              // A failed write/exec/read can leave inputs or a partial output.
              for (const f of files) { try { core.FS.unlink(f.name); } catch (_) {} }
              try { core.FS.unlink('output.mkv'); } catch (_) {}
            }
          } else throw new Error('Unknown worker command');
        } catch (err) {
          self.postMessage({ id, ok: false, error: String(err && err.message || err) });
        }
      };
    `;
  }

  function dispose(owner, error = new Error('Mux cancelled')) {
    if (!owner || owner.disposed) return;
    owner.disposed = true;
    owner.controller.abort();
    clearTimeout(owner.loadTimer);
    for (const p of owner.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    owner.pending.clear();
    owner.rejectCancelled(error);
    if (owner.worker) {
      owner.worker.onmessage = owner.worker.onerror = owner.worker.onmessageerror = null;
      try { owner.worker.terminate(); } catch (_) {}
      owner.worker = null;
    }
    if (owner.url) { URL.revokeObjectURL(owner.url); owner.url = null; }
    if (_owner === owner) { _owner = null; _ffmpeg = null; _loading = null; }
  }

  async function load() {
    if (_ffmpeg) return _ffmpeg;
    if (_loading) return _loading;
    const owner = { controller: new AbortController(), pending: new Map(), worker: null, url: null, disposed: false };
    owner.cancelled = new Promise((_, reject) => { owner.rejectCancelled = reject; });
    // Cancellation may happen after initialization while no fetch is racing it.
    owner.cancelled.catch(() => {});
    _owner = owner;
    owner.loadTimer = setTimeout(() => dispose(owner, new Error('ffmpeg initialization timed out')), LOAD_TIMEOUT);
    let nextId = 1;
    function call(cmd, payload = {}) {
      if (owner.disposed) return Promise.reject(new Error('Mux cancelled'));
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => dispose(owner, new Error('ffmpeg ' + cmd + ' timed out')), cmd === 'init' ? LOAD_TIMEOUT : RUN_TIMEOUT);
        owner.pending.set(id, { resolve, reject, timer });
        try {
          const transfer = [];
          if (payload.files) transfer.push(...payload.files.map(f => f.data.buffer));
          if (payload.wasmBinary) transfer.push(payload.wasmBinary);
          owner.worker.postMessage({ id, cmd, ...payload }, transfer);
        } catch (err) { dispose(owner, err); }
      });
    }
    const loading = (async () => {
      try {
        const read = async (url, kind) => {
          const r = await fetch(url, { signal: owner.controller.signal });
          if (!r.ok) throw new Error('ffmpeg vendor fetch failed');
          return r[kind]();
        };
        const [coreText, wasmBuf] = await Promise.race([
          Promise.all([read(FFMPEG_CORE_JS_URL, 'text'), read(FFMPEG_WASM_URL, 'arrayBuffer')]), owner.cancelled,
        ]);
        if (owner.disposed) throw new Error('Mux cancelled');
        owner.url = URL.createObjectURL(new Blob([buildWorkerScript(coreText)], { type: 'application/javascript' }));
        owner.worker = new Worker(owner.url);
        owner.worker.onmessage = e => {
          if (e.data?.kind === 'log') { console.log('[ffmpeg]', e.data.line); return; }
          const p = owner.pending.get(e.data?.id);
          if (!p) return;
          owner.pending.delete(e.data.id);
          clearTimeout(p.timer);
          e.data.ok ? p.resolve(e.data.data) : p.reject(new Error(e.data.error || 'unknown worker error'));
        };
        owner.worker.onerror = e => dispose(owner, new Error('worker fatal: ' + (e.message || 'unknown')));
        owner.worker.onmessageerror = () => dispose(owner, new Error('worker message could not be decoded'));
        await call('init', { wasmBinary: wasmBuf });
        if (owner.disposed) throw new Error('Mux cancelled');
        clearTimeout(owner.loadTimer);
        const ff = { run: (args, files) => call('run', { args, files }), terminate: () => dispose(owner), owner };
        if (_owner === owner) _ffmpeg = ff;
        return ff;
      } catch (err) { dispose(owner, err); throw err; }
      finally { if (_loading === loading) _loading = null; }
    })();
    _loading = loading;
    return loading;
  }

  async function muxToMkv(mainBlob, secondaryBlobs, mainExt = 'mkv', opts = {}) {
    const signal = opts.signal;
    const cancelled = () => { if (signal?.aborted) throw new Error('Mux cancelled'); };
    cancelled();
    const onAbort = () => terminate();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (!(await isAvailable())) throw new Error('ffmpeg vendor files missing');
      cancelled();
      const ff = await load();
      cancelled();
      const files = [{ name: 'input0.' + mainExt, data: new Uint8Array(await mainBlob.arrayBuffer()) }];
      for (let i = 0; i < secondaryBlobs.length; i++) {
        cancelled();
        files.push({ name: 'input' + (i + 1) + '.webm', data: new Uint8Array(await secondaryBlobs[i].arrayBuffer()) });
      }
      cancelled();
      const args = ['-y'];
      files.forEach(f => args.push('-i', f.name));
      args.push('-map', '0:v:0', '-map', '0:a:0');
      for (let i = 1; i < files.length; i++) args.push('-map', i + ':a:0');
      args.push('-metadata:s:a:0', 'title=main-mix');
      for (let i = 1; i < files.length; i++) args.push('-metadata:s:a:' + i, 'title=track-' + i);
      args.push('-c', 'copy', '-f', 'matroska', 'output.mkv');
      const out = await ff.run(args, files);
      cancelled();
      return new Blob([out], { type: 'video/x-matroska' });
    } finally { signal?.removeEventListener('abort', onAbort); }
  }
  function terminate() { dispose(_owner); }
  window.MeetBudyMuxer = { isAvailable, muxToMkv, terminate, _meetBudyManaged: true };
})();
