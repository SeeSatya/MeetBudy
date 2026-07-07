/**
 * muxer.js — ffmpeg.wasm-based remuxer for Meet Budy.
 *
 * Chrome MV3 quirk: a content script can read chrome-extension:// URLs via
 * fetch(), but it CANNOT spawn a Worker from a chrome-extension:// URL
 * because Web Worker construction is gated by the document origin (the page,
 * meet.google.com). Workaround: fetch ffmpeg-core.js as text and the .wasm
 * as bytes, then build a Blob-URL Worker with the core JS inlined and the
 * wasm passed in via `wasmBinary`. The blob worker inherits page origin so
 * Chrome is happy, and ffmpeg never has to fetch anything itself.
 *
 * Safe-by-default: any missing vendor file / load failure / mux failure
 * surfaces as a rejected promise. Raw recording files are saved before this
 * runs, so zero data loss.
 */
(function () {
  'use strict';

  const FFMPEG_CORE_JS_URL = chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.js');
  const FFMPEG_WASM_URL    = chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.wasm');

  let _available = null;
  let _ffmpeg    = null;
  let _loading   = null;

  async function probe(url) {
    try { const r = await fetch(url, { method: 'HEAD' }); return r.ok; }
    catch (_) { return false; }
  }

  async function isAvailable() {
    if (_available !== null) return _available;
    const [a, b] = await Promise.all([probe(FFMPEG_CORE_JS_URL), probe(FFMPEG_WASM_URL)]);
    _available = a && b;
    if (!_available) console.warn('[MeetBudyMuxer] vendor files missing:', { core: a, wasm: b });
    return _available;
  }

  function buildWorkerScript(coreText) {
    // The worker's body. Inlines ffmpeg-core.js, then sets up onmessage to run
    // mux commands. wasmBinary is supplied through postMessage, NOT fetched.
    return `
      ${coreText}
      let core = null;
      const ffLog = [];
      self.onmessage = async (e) => {
        const { id, cmd, args, files, wasmBinary } = e.data;
        try {
          if (cmd === 'init') {
            core = await createFFmpegCore({
              wasmBinary,
              print:    (line) => { ffLog.push(line); self.postMessage({ kind: 'log', line }); },
              printErr: (line) => { ffLog.push(line); self.postMessage({ kind: 'log', line }); },
            });
            self.postMessage({ id, ok: true });
            return;
          }
          if (cmd === 'run') {
            if (!core) throw new Error('ffmpeg core not initialized');
            for (const f of files) {
              core.FS.writeFile(f.name, f.data);
              self.postMessage({ kind: 'log', line: '[fs] wrote ' + f.name + ' (' + f.data.byteLength + ' bytes)' });
            }
            self.postMessage({ kind: 'log', line: '[exec] ffmpeg ' + args.join(' ') });
            const ret = core.exec(...args);
            if (ret !== 0) throw new Error('ffmpeg exit ' + ret + ' — tail: ' + ffLog.slice(-6).join(' | '));
            let out;
            try { out = core.FS.readFile('output.mkv'); }
            catch (_) { throw new Error('output.mkv missing — tail: ' + ffLog.slice(-8).join(' | ')); }
            for (const f of files) { try { core.FS.unlink(f.name); } catch (_) {} }
            try { core.FS.unlink('output.mkv'); } catch (_) {}
            self.postMessage({ id, ok: true, data: out }, [out.buffer]);
            return;
          }
        } catch (err) {
          self.postMessage({ id, ok: false, error: String(err && err.message || err) });
        }
      };
    `;
  }

  async function load() {
    if (_ffmpeg) return _ffmpeg;
    if (_loading) return _loading;
    _loading = (async () => {
      console.log('[MeetBudyMuxer] fetching ffmpeg-core.js and wasm…');
      const [coreText, wasmBuf] = await Promise.all([
        fetch(FFMPEG_CORE_JS_URL).then(r => r.text()),
        fetch(FFMPEG_WASM_URL).then(r => r.arrayBuffer()),
      ]);
      console.log(`[MeetBudyMuxer] vendor loaded: core ${(coreText.length/1024).toFixed(1)}KB, wasm ${(wasmBuf.byteLength/1024/1024).toFixed(2)}MB`);

      const workerBlob = new Blob([buildWorkerScript(coreText)], { type: 'application/javascript' });
      const workerUrl  = URL.createObjectURL(workerBlob);
      const worker     = new Worker(workerUrl);

      const pending = new Map();
      let nextId    = 1;
      worker.onmessage = (e) => {
        if (e.data && e.data.kind === 'log') { console.log('[ffmpeg]', e.data.line); return; }
        const { id, ok, data, error } = e.data;
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        ok ? p.resolve(data) : p.reject(new Error(error || 'unknown worker error'));
      };
      worker.onerror = (e) => {
        const msg = `worker fatal: ${e.message || e.filename || 'unknown'}`;
        console.error('[MeetBudyMuxer]', msg, e);
        for (const [, p] of pending) p.reject(new Error(msg));
        pending.clear();
      };
      function call(cmd, payload = {}) {
        return new Promise((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve, reject });
          const transfer = [];
          if (payload.files) transfer.push(...payload.files.map(f => f.data.buffer));
          if (payload.wasmBinary) transfer.push(payload.wasmBinary);
          worker.postMessage({ id, cmd, ...payload }, transfer);
        });
      }

      // Transfer the wasm bytes once into the worker
      await call('init', { wasmBinary: wasmBuf });
      _ffmpeg = {
        run: (args, files) => call('run', { args, files }),
        terminate: () => { try { worker.terminate(); } catch (_) {} URL.revokeObjectURL(workerUrl); _ffmpeg = null; _loading = null; },
      };
      return _ffmpeg;
    })();
    try { return await _loading; }
    catch (err) { _loading = null; throw err; }
  }

  async function blobToUint8(b) { return new Uint8Array(await b.arrayBuffer()); }

  async function muxToMkv(mainBlob, secondaryBlobs, mainExt = 'mkv') {
    if (!(await isAvailable())) throw new Error('ffmpeg vendor files missing');
    const ff = await load();

    const files = [{ name: `input0.${mainExt}`, data: await blobToUint8(mainBlob) }];
    for (let i = 0; i < secondaryBlobs.length; i++) {
      files.push({ name: `input${i + 1}.webm`, data: await blobToUint8(secondaryBlobs[i]) });
    }

    // All inputs are already Opus + H.264 → stream-copy. Arg order matters:
    // every -map/-metadata/-c flag must precede the output filename.
    const args = ['-y'];
    files.forEach(f => { args.push('-i', f.name); });
    args.push('-map', '0:v:0', '-map', '0:a:0');
    for (let i = 1; i < files.length; i++) args.push('-map', `${i}:a:0`);
    args.push('-metadata:s:a:0', 'title=main-mix');
    for (let i = 1; i < files.length; i++) {
      args.push(`-metadata:s:a:${i}`, `title=track-${i}`);
    }
    args.push('-c', 'copy', '-f', 'matroska', 'output.mkv');

    console.log('[MeetBudyMuxer] running ffmpeg', args);
    const out = await ff.run(args, files);
    return new Blob([out], { type: 'video/x-matroska' });
  }

  function terminate() {
    if (_ffmpeg && typeof _ffmpeg.terminate === 'function') {
      _ffmpeg.terminate();
    }
  }

  window.MeetBudyMuxer = { isAvailable, muxToMkv, terminate };
  console.log('[MeetBudyMuxer] ready (blob-worker pattern, vendor at:', FFMPEG_CORE_JS_URL, ')');
})();
