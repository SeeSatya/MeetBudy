/**
 * content_script.js — Injected into meet.google.com pages.
 *
 * Responsibilities:
 *  1. Inject injected.js into the PAGE context (bypassing extension sandbox)
 *  2. Act as a bridge between the page script and the extension popup
 *  3. Save incoming recording chunks to IndexedDB (resilient to network drops)
 *  4. Assemble final .webm file and trigger browser download on stop
 *  5. Broadcast recording state to background so popup can restore on reopen
 */
(function () {
  'use strict';

  if (window.__meetRecorderContentScriptActive) {
    console.warn('[MeetRecorder] content_script.js already active; skipping duplicate bridge');
    return;
  }
  window.__meetRecorderContentScriptActive = true;

  const MSG_SOURCE_OUT = 'MEET_REC_PAGE';  // messages FROM injected.js
  const MSG_SOURCE_CMD = 'MEET_REC_CMD';   // commands TO injected.js
  const PENDING_COMBINE_KEY = 'meetBudyPendingCombine';

  // ─── IndexedDB Setup ──────────────────────────────────────────────────────
  const DB_NAME    = 'MeetRecorderDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'chunks';

  let db                 = null;
  let currentRecordingId = null;
  let chunkCount         = 0;
  let totalBytes         = 0;
  let recordingStartTime = null;   // epoch ms — stored so popup can restore timer

  // ─── Track last mimeType for assembly ─────────────────────────────────────
  let lastMimeType = 'video/webm';
  let pageInjected = false;
  let pendingPageCommands = [];
  let currentPendingCombine = null;
  let combineInProgress = false;

  // ─── IndexedDB helpers ────────────────────────────────────────────────────
  function openDB(forceReopen = false) {
    return new Promise((resolve, reject) => {
      if (db && !forceReopen) return resolve(db);
      db = null; // drop any stale/closing handle before reopening
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORE_NAME)) {
          const store = d.createObjectStore(STORE_NAME, { autoIncrement: true });
          store.createIndex('by_recording', 'recordingId', { unique: false });
        }
      };
      req.onsuccess  = (e) => {
        db = e.target.result;
        // If another connection (e.g. extension reload) requests an upgrade,
        // close ours so it isn't left in a half-closing state, and forget it
        // so the next op transparently reopens.
        db.onversionchange = () => { try { db.close(); } catch (_) {} db = null; };
        db.onclose         = () => { db = null; };
        resolve(db);
      };
      req.onerror    = (e) => reject(e.target.error);
    });
  }

  // Returns true if an error from a failed transaction means our DB handle is
  // dead (closing/closed) and a fresh openDB() should be attempted.
  function isConnectionClosing(err) {
    return !!err && (
      err.name === 'InvalidStateError' ||
      /connection is closing|database connection is closing/i.test(err.message || '')
    );
  }

  function saveChunkOnce(d, buffer) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = d.transaction(STORE_NAME, 'readwrite');
      } catch (err) {
        // transaction() throws synchronously if the connection is closing
        reject(err);
        return;
      }
      const store = tx.objectStore(STORE_NAME);
      const addReq = store.add({ recordingId: currentRecordingId, data: buffer });
      addReq.onerror = () => reject(addReq.error);
      tx.oncomplete  = resolve;
      tx.onerror     = () => reject(tx.error);
    });
  }

  async function saveChunk(buffer) {
    if (!buffer || buffer.byteLength === 0) {
      console.warn('[MeetRecorder] Skipping zero-byte chunk');
      return;
    }
    let d = await openDB();
    try {
      return await saveChunkOnce(d, buffer);
    } catch (err) {
      if (isConnectionClosing(err)) {
        // Stale connection (extension reloaded / versionchange) — reopen once.
        console.warn('[MeetRecorder] DB connection was closing, reopening…');
        d = await openDB(true);
        return await saveChunkOnce(d, buffer);
      }
      console.error('[MeetRecorder] Chunk save failed:', err);
      throw err;
    }
  }

  function loadAllChunksOnce(d, recordingId) {
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = d.transaction(STORE_NAME, 'readonly'); }
      catch (err) { reject(err); return; }
      const store = tx.objectStore(STORE_NAME);
      const idx   = store.index('by_recording');
      const req   = idx.getAll(recordingId);
      req.onsuccess = () => resolve(req.result.map(r => r.data));
      req.onerror   = () => reject(req.error);
    });
  }

  async function loadAllChunks(recordingId) {
    let d = await openDB();
    try {
      return await loadAllChunksOnce(d, recordingId);
    } catch (err) {
      if (!isConnectionClosing(err)) throw err;
      d = await openDB(true);
      return await loadAllChunksOnce(d, recordingId);
    }
  }

  function clearChunksOnce(d, recordingId) {
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = d.transaction(STORE_NAME, 'readwrite'); }
      catch (err) { reject(err); return; }
      const store  = tx.objectStore(STORE_NAME);
      const idx    = store.index('by_recording');
      const cursor = idx.openCursor(IDBKeyRange.only(recordingId));
      cursor.onsuccess = (e) => {
        const c = e.target.result;
        if (c) { c.delete(); c.continue(); }
      };
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  }

  async function clearChunks(recordingId) {
    let d = await openDB();
    try {
      return await clearChunksOnce(d, recordingId);
    } catch (err) {
      if (!isConnectionClosing(err)) throw err;
      d = await openDB(true);
      return await clearChunksOnce(d, recordingId);
    }
  }

  // ─── Script Injection ─────────────────────────────────────────────────────
  function injectPageScript() {
    pageInjected = false;
    const s = document.createElement('script');
    s.src = `${chrome.runtime.getURL('injected.js')}?t=${Date.now()}`;
    s.onload = () => {
      s.remove();
      // Pre-load the background image as soon as the page is ready
      const bgUrl = chrome.runtime.getURL('background_image.png');
      sendCmd('INIT', { bgUrl }, { queueIfNotReady: false });
    };
    s.onerror = () => {
      setTimeout(() => {
        if (!pageInjected) injectPageScript();
      }, 1000);
    };
    (document.head || document.documentElement).prepend(s);
  }

  // ─── Command → injected.js ──────────────────────────────────────────────────
  // Pass extra data alongside the command (e.g. recordingId for START)
  function sendCmd(cmd, extra = {}, opts = {}) {
    const payload = { source: MSG_SOURCE_CMD, cmd, ...extra };
    const queueIfNotReady = opts.queueIfNotReady !== false;

    if (!pageInjected && queueIfNotReady && cmd !== 'INIT') {
      pendingPageCommands.push(payload);
      injectPageScript();
      return;
    }

    window.postMessage(payload, '*');
  }

  function flushPendingPageCommands() {
    if (!pageInjected || pendingPageCommands.length === 0) return;
    const queue = pendingPageCommands;
    pendingPageCommands = [];
    queue.forEach(payload => window.postMessage(payload, '*'));
  }

  function ensurePageInjected() {
    if (pageInjected) return;
    injectPageScript();
    setTimeout(() => {
      if (!pageInjected) injectPageScript();
    }, 1500);
    setTimeout(() => {
      if (!pageInjected) injectPageScript();
    }, 4000);
  }

  // ─── Popup Broadcasting ───────────────────────────────────────────────────
  function toPopup(type, payload) {
    chrome.runtime.sendMessage({ type, payload }).catch(() => {});
  }

  // ─── State broadcasting → background (for popup restore) ─────────────────
  function broadcastRecordingState(isRecording, isPaused = false) {
    chrome.runtime.sendMessage({
      type: 'RECORDING_STATE_UPDATE',
      state: {
        isRecording,
        isPaused,
        startTime:   isRecording ? recordingStartTime : null,
        recordingId: isRecording ? currentRecordingId : null,
      },
    }).catch(() => {});
  }

  // ─── Download Trigger ─────────────────────────────────────────────────────
  async function rebuildBlobFromChunks(recordingId, mimeType) {
    try {
      const buffers = await loadAllChunks(recordingId);
      if (!buffers || buffers.length === 0) return null;
      return new Blob(buffers, { type: mimeType || 'video/webm' });
    } catch (err) {
      console.error('[MeetRecorder] rebuildBlobFromChunks failed:', err);
      return null;
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      if (a.parentNode) document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 3000);
  }

  async function assembleAndDownload(recordingId, mimeType, opts = {}) {
    const { fileLabel = '', fixDuration = true, silentEmpty = false, keepChunks = false } = opts;
    toPopup('STATUS', { state: 'assembling', message: `Assembling ${fileLabel || 'recording'}…` });

    let buffers;
    try {
      buffers = await loadAllChunks(recordingId);
    } catch (err) {
      toPopup('STATUS', { state: 'error', message: `Load failed: ${err?.message}` });
      return null;
    }

    if (!buffers || buffers.length === 0) {
      if (!silentEmpty) {
        toPopup('STATUS', {
          state: 'error',
          message: `No data recorded${fileLabel ? ` for ${fileLabel}` : ''}. (Chunks may not have saved)`,
        });
      }
      return null;
    }

    // Calculate duration and fix WebM seekability/metadata
    const duration = recordingStartTime ? (Date.now() - recordingStartTime) : 0;
    console.log(`[MeetRecorder] Raw recording duration: ${duration} ms`);

    let firstBlob = buffers[0];
    if (fixDuration && duration > 1000 && firstBlob) {
      toPopup('STATUS', { state: 'assembling', message: 'Injecting seek index (duration)…' });
      try {
        const patchedFirstBlob = await fixWebmDuration(firstBlob, duration);
        buffers[0] = patchedFirstBlob;
        console.log('[MeetRecorder] WebM duration injected successfully on the first chunk');
      } catch (err) {
        console.error('[MeetRecorder] WebM duration fixing failed on first chunk:', err);
      }
    }

    const finalBlob = new Blob(buffers, { type: mimeType || 'video/webm' });

    const url      = URL.createObjectURL(finalBlob);
    const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const isAudio  = mimeType && mimeType.startsWith('audio/');
    const ext      = isAudio
      ? 'webm'
      : ((mimeType && (mimeType.includes('matroska') || mimeType.includes('mkv'))) ? 'mkv' : 'webm');
    const safeLabel = fileLabel ? `_${fileLabel.replace(/[^a-z0-9-_]+/gi, '-')}` : '';
    const filename  = `meet-recording-${ts}${safeLabel}.${ext}`;

    const a         = document.createElement('a');
    a.style.display = 'none';
    a.href          = url;
    a.download      = filename;
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      if (a.parentNode) document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 3000);

    if (!keepChunks) await clearChunks(recordingId);

    toPopup('STATUS', {
      state: 'downloaded',
      message: `Saved: ${filename}`,
      filename,
      sizeMB: (finalBlob.size / 1_048_576).toFixed(1),
    });
    return { filename, sizeMB: (finalBlob.size / 1_048_576).toFixed(1) };
  }

  function savePendingCombine(job) {
    currentPendingCombine = job ? { ...job } : null;
    if (currentPendingCombine) {
      chrome.storage.local.set({ [PENDING_COMBINE_KEY]: currentPendingCombine });
    } else {
      chrome.storage.local.remove(PENDING_COMBINE_KEY);
    }
  }

  function loadPendingCombine() {
    chrome.storage.local.get(PENDING_COMBINE_KEY, (data) => {
      currentPendingCombine = data[PENDING_COMBINE_KEY] || null;
      if (currentPendingCombine) {
        toPopup('STATUS', {
          state: 'combine_pending',
          message: 'Combined encoding is pending',
          data: currentPendingCombine,
        });
      }
    });
  }

  async function runPendingCombine(job = currentPendingCombine) {
    if (!job || combineInProgress) return null;
    combineInProgress = true;
    try {
      if (!window.MeetBudyMuxer) {
        throw new Error('MeetBudyMuxer not loaded');
      }
      if (!(await window.MeetBudyMuxer.isAvailable())) {
        throw new Error('ffmpeg vendor files not found');
      }

      toPopup('STATUS', { state: 'assembling', message: 'Muxing combined MKV (ffmpeg)…' });
      const mainBlob = await rebuildBlobFromChunks(job.recordingId, job.mimeType);
      if (!mainBlob || mainBlob.size < 1024) {
        // Unrecoverable: the source chunks are gone/empty (e.g. the recorder
        // crashed before writing). Retrying can never help, so discard the job
        // and its leftover chunks instead of re-prompting forever.
        try { await clearChunks(job.recordingId); } catch (_) {}
        for (const sec of Array.isArray(job.secondaries) ? job.secondaries : []) {
          try { await clearChunks(sec.recordingId); } catch (_) {}
        }
        savePendingCombine(null);
        toPopup('STATUS', { state: 'aborted', message: 'Combine discarded — recording was empty.' });
        return null;
      }

      const secBlobs = [];
      for (const sec of Array.isArray(job.secondaries) ? job.secondaries : []) {
        const b = await rebuildBlobFromChunks(sec.recordingId, sec.mimeType);
        if (b && b.size >= 1024) secBlobs.push(b);
      }

      const mainExt = (job.mimeType && job.mimeType.includes('matroska')) ? 'mkv' : 'webm';
      const muxBlob = await window.MeetBudyMuxer.muxToMkv(mainBlob, secBlobs, mainExt);
      if (!muxBlob) throw new Error('muxer returned no output');

      downloadBlob(muxBlob, `meet-recording-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_combined.mkv`);
      toPopup('STATUS', {
        state: 'downloaded',
        message: `Saved combined MKV (${secBlobs.length + 1} audio tracks).`,
        filename: 'combined.mkv',
        sizeMB: (muxBlob.size / 1_048_576).toFixed(1),
      });

      try { await clearChunks(job.recordingId); } catch (_) {}
      for (const sec of Array.isArray(job.secondaries) ? job.secondaries : []) {
        try { await clearChunks(sec.recordingId); } catch (_) {}
      }
      savePendingCombine(null);
      return muxBlob;
    } finally {
      combineInProgress = false;
      try { window.MeetBudyMuxer?.terminate?.(); } catch (_) {}
    }
  }

  function deferPendingCombine() {
    if (!currentPendingCombine) return;
    savePendingCombine({ ...currentPendingCombine, nextPromptAt: Date.now() + 10 * 60 * 1000 });
    toPopup('STATUS', {
      state: 'combine_pending',
      message: 'Combined encoding postponed for 10 minutes',
      data: currentPendingCombine,
    });
  }

  async function cancelPendingCombine() {
    const job = currentPendingCombine;
    if (!job) return;
    savePendingCombine(null);
    try { await clearChunks(job.recordingId); } catch (_) {}
    for (const sec of Array.isArray(job.secondaries) ? job.secondaries : []) {
      try { await clearChunks(sec.recordingId); } catch (_) {}
    }
    toPopup('STATUS', { state: 'downloaded', message: 'Combined encoding cancelled' });
  }

  // ─── Message Handler (from injected.js via window) ────────────────────────
  window.addEventListener('message', async (e) => {
    if (!e.data || e.data.source !== MSG_SOURCE_OUT) return;
    const { type, event, data, chunk } = e.data;
    pageInjected = true;

    // ── Recording chunk notifications (injected.js writes directly to IDB) ────────
    // No binary data crosses the isolated-world boundary anymore.
    // injected.js writes to IndexedDB directly (same origin = same IDB instance)
    // and posts only a lightweight CHUNK_SAVED event with count + size.
    // The actual assembly still reads from the shared IDB on RECORDING_STOPPED.

    // ── Events from injected.js ───────────────────────────────────────────
    if (type === 'EVENT') {
      console.log(`[MeetRecorder] ${event}`, data);

      let lvl = 'info';
      if (event === 'ERROR') lvl = 'error';
      else if (event === 'WARN') lvl = 'warn';
      else if (event === 'RECORDING_STARTED' || event === 'CHUNK_SAVED') lvl = 'success';

      let logText = `[Page] ${event}`;
      if (typeof data === 'string') {
        logText += `: ${data}`;
      } else if (data && typeof data === 'object') {
        logText += `: ${JSON.stringify(data)}`;
      }
      chrome.runtime.sendMessage({ type: 'LOG', payload: { text: logText, level: lvl } }).catch(() => {});

      switch (event) {
        case 'INJECTED':
          pageInjected = true;
          flushPendingPageCommands();
          toPopup('STATUS', { state: 'ready', message: 'Ready — waiting for screen share' });
          break;

        case 'CHUNK_SAVED':
          // injected.js saved a chunk directly to IDB — just update UI counters
          chunkCount = data?.count  ?? chunkCount;
          totalBytes = Math.round((data?.totalMB ?? 0) * 1_048_576);
          toPopup('CHUNK', { count: chunkCount, totalMB: data?.totalMB ?? '0.00' });
          break;

        case 'VIDEO_TRACK_RECEIVED':
          toPopup('STATUS', { state: 'video_track', data });
          break;

        case 'VIDEO_TRACK_SIZE':
          toPopup('STATUS', { state: 'video_size', data });
          break;

        case 'SCREEN_SHARE_DETECTED':
          toPopup('STATUS', { state: 'screen_detected', message: 'Screen share detected!', data });
          break;

        case 'SCREEN_SHARE_ENDED':
          toPopup('STATUS', { state: 'screen_ended', message: 'Screen share ended' });
          break;

        case 'AUDIO_TRACK_ADDED':
          toPopup('AUDIO', { sources: data.total });
          break;

        case 'RECORDING_STARTED':
          // Sync recordingId back from injected.js in case it generated its own
          if (data?.recordingId) currentRecordingId = data.recordingId;
          lastMimeType       = data?.mimeType || 'video/webm';
          recordingStartTime = Date.now();
          broadcastRecordingState(true, false);
          toPopup('STATUS', {
            state:     'recording',
            message:   'Recording…',
            startTime: recordingStartTime,
            mimeType:  data?.mimeType,
            hasVideo:  data?.hasVideo,
            hasAudio:  data?.hasAudio,
          });
          break;

        case 'RECORDING_PAUSED':
          broadcastRecordingState(true, true);
          toPopup('STATUS', {
            state: 'paused',
            message: 'Recording paused',
            startTime: recordingStartTime,
          });
          break;

        case 'RECORDING_RESUMED':
          broadcastRecordingState(true, false);
          toPopup('STATUS', {
            state: 'recording',
            message: 'Recording…',
            startTime: recordingStartTime,
          });
          break;

        case 'RECORDING_STOPPED': {
          broadcastRecordingState(false, false);
          const rid        = currentRecordingId;
          const mime       = lastMimeType;
          const secondaries = Array.isArray(data?.secondaries) ? data.secondaries : [];
          toPopup('STATUS', { state: 'stopping', message: 'Finalizing…' });

          // STEP 1 — raw downloads first (zero-loss safety net). Errors here
          // are reported but don't block the mux attempt.
          const mainResult = await assembleAndDownload(rid, mime, { fileLabel: 'full', keepChunks: true });
          const secondaryResults = [];
          for (const sec of secondaries) {
            try {
              const r = await assembleAndDownload(sec.recordingId, sec.mimeType, {
                fileLabel: `track-${sec.trackId}-${sec.name || 'track'}`,
                fixDuration: false,
                silentEmpty: true,
                keepChunks: true,
              });
              if (r) secondaryResults.push({ ...r, sec });
            } catch (err) {
              console.error('[MeetRecorder] Secondary download failed:', sec, err);
              toPopup('STATUS', { state: 'error', message: `Track ${sec.trackId} save failed: ${err?.message || err}` });
            }
          }

          // STEP 2 — persist a pending combine job so reloads do not lose it.
          if (secondaries.length > 0) {
            savePendingCombine({
              recordingId: rid,
              mimeType: mime,
              secondaries,
              createdAt: Date.now(),
              nextPromptAt: 0,
            });
            toPopup('STATUS', {
              state: 'combine_pending',
              message: 'Combined encoding is ready',
              data: currentPendingCombine,
            });
          } else {
            savePendingCombine(null);
            try { await clearChunks(rid); } catch (_) {}
          }

          currentRecordingId = null;
          chunkCount         = 0;
          totalBytes         = 0;
          recordingStartTime = null;
          break;
        }

        case 'RECORDING_IDLE': {
          // Page-side recorder is already gone; clear our state and force the
          // popup back to idle so a stuck "recording" UI can recover.
          broadcastRecordingState(false, false);
          currentRecordingId = null;
          chunkCount         = 0;
          totalBytes         = 0;
          recordingStartTime = null;
          toPopup('STATUS', { state: 'aborted', message: 'Recording was not active — reset.' });
          break;
        }

        case 'STATUS_RESPONSE':
          toPopup('STATUS_RESPONSE', data);
          break;

        case 'ERROR':
          toPopup('STATUS', { state: 'error', message: data });
          break;

        case 'WARN':
        case 'INFO':
        case 'CHUNK_SENDING':
          // Debug only — don't spam popup
          break;

        default:
          break;
      }
    }
  });

  // ─── Commands from popup via background ───────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
      case 'START_RECORDING':
        currentRecordingId = `rec_${Date.now()}`;
        chunkCount         = 0;
        totalBytes         = 0;
        lastMimeType       = 'video/webm';
        recordingStartTime = null;
        // Pass the recordingId and the local background image URL to injected.js
        const bgUrl = chrome.runtime.getURL('background_image.png');
        sendCmd('START', { recordingId: currentRecordingId, bgUrl });
        sendResponse({ ok: true });
        break;

      case 'STOP_RECORDING':
        sendCmd('STOP');
        sendResponse({ ok: true });
        break;

      case 'PAUSE_RECORDING':
        sendCmd('PAUSE');
        sendResponse({ ok: true });
        break;

      case 'RESUME_RECORDING':
        sendCmd('RESUME');
        sendResponse({ ok: true });
        break;

      case 'SET_RECORD_MY_MIC':
        sendCmd('SET_RECORD_MY_MIC', { enabled: message.enabled });
        sendResponse({ ok: true });
        break;

      case 'SET_MUTE':
        sendCmd('SET_MUTE', { mute: message.mute });
        sendResponse({ ok: true });
        break;

      case 'SET_RECORD_CHOSEN_ONLY':
        sendCmd('SET_RECORD_CHOSEN_ONLY', { enabled: message.enabled });
        sendResponse({ ok: true });
        break;

      case 'SET_CHOSEN_SPEAKERS':
        sendCmd('SET_CHOSEN_SPEAKERS', { list: message.list });
        sendResponse({ ok: true });
        break;

      case 'FORCE_NO_SCREEN_SHARE':
        sendCmd('FORCE_NO_SCREEN_SHARE', { enabled: message.enabled });
        sendResponse({ ok: true });
        break;

      case 'SET_AUDIO_TRACKS':
        sendCmd('SET_AUDIO_TRACKS', { list: message.list });
        sendResponse({ ok: true });
        break;

      case 'SET_VIP_LIST':
        sendCmd('SET_VIP_LIST', { list: message.list });
        sendResponse({ ok: true });
        break;

      case 'SET_VIPS_ENABLED':
        sendCmd('SET_VIPS_ENABLED', { enabled: message.enabled });
        sendResponse({ ok: true });
        break;

      case 'GET_STATUS':
        ensurePageInjected();
        sendCmd('STATUS');
        sendResponse({ ok: true });
        break;

      case 'FORCE_REINJECT':
        pendingPageCommands = [];
        ensurePageInjected();
        sendCmd('RESCAN_MEDIA');
        setTimeout(() => sendCmd('STATUS'), 250);
        sendResponse({ ok: true });
        break;

      case 'RUN_PENDING_COMBINE':
        ensurePageInjected();
        runPendingCombine(message.job || currentPendingCombine)
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;

      case 'DEFER_PENDING_COMBINE':
        deferPendingCombine();
        sendResponse({ ok: true });
        break;

      case 'CANCEL_PENDING_COMBINE':
        cancelPendingCombine()
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;

      case 'PAGE_PING':
        pageInjected = true;
        flushPendingPageCommands();
        sendResponse({ ok: true });
        break;

      default:
        break;
    }
    return true; // keep channel open for async
  });

  // ─── WebM Duration Fixer (EBML Patcher) ───────────────────────────────────
  const EBML_SECTIONS = {
    0xa45dfa3: { name: 'EBML', type: 'Container' },
    0x286: { name: 'EBMLVersion', type: 'Uint' },
    0x2f7: { name: 'EBMLReadVersion', type: 'Uint' },
    0x2f2: { name: 'EBMLMaxIDLength', type: 'Uint' },
    0x2f3: { name: 'EBMLMaxSizeLength', type: 'Uint' },
    0x282: { name: 'DocType', type: 'String' },
    0x287: { name: 'DocTypeVersion', type: 'Uint' },
    0x285: { name: 'DocTypeReadVersion', type: 'Uint' },
    0x6c: { name: 'Void', type: 'Binary' },
    0x3f: { name: 'CRC-32', type: 'Binary' },
    0xb538667: { name: 'SignatureSlot', type: 'Container' },
    0x3e8a: { name: 'SignatureAlgo', type: 'Uint' },
    0x3e9a: { name: 'SignatureHash', type: 'Uint' },
    0x3ea5: { name: 'SignaturePublicKey', type: 'Binary' },
    0x3eb5: { name: 'Signature', type: 'Binary' },
    0x3e5b: { name: 'SignatureElements', type: 'Container' },
    0x3e7b: { name: 'SignatureElementList', type: 'Container' },
    0x2532: { name: 'SignedElement', type: 'Binary' },
    0x8538067: { name: 'Segment', type: 'Container' },
    0x14d9b74: { name: 'SeekHead', type: 'Container' },
    0xdbb: { name: 'Seek', type: 'Container' },
    0x13ab: { name: 'SeekID', type: 'Binary' },
    0x13ac: { name: 'SeekPosition', type: 'Uint' },
    0x549a966: { name: 'Info', type: 'Container' },
    0x33a4: { name: 'SegmentUID', type: 'Binary' },
    0x3384: { name: 'SegmentFilename', type: 'String' },
    0x1cb923: { name: 'PrevUID', type: 'Binary' },
    0x1c83ab: { name: 'PrevFilename', type: 'String' },
    0x1eb923: { name: 'NextUID', type: 'Binary' },
    0x1e83bb: { name: 'NextFilename', type: 'String' },
    0x444: { name: 'SegmentFamily', type: 'Binary' },
    0x2924: { name: 'ChapterTranslate', type: 'Container' },
    0x29fc: { name: 'ChapterTranslateEditionUID', type: 'Uint' },
    0x29bf: { name: 'ChapterTranslateCodec', type: 'Uint' },
    0x29a5: { name: 'ChapterTranslateID', type: 'Binary' },
    0xad7b1: { name: 'TimecodeScale', type: 'Uint' },
    0x489: { name: 'Duration', type: 'Float' },
    0x461: { name: 'DateUTC', type: 'Date' },
    0x3ba9: { name: 'Title', type: 'String' },
    0xd80: { name: 'MuxingApp', type: 'String' },
    0x1741: { name: 'WritingApp', type: 'String' },
    0x67: { name: 'Timecode', type: 'Uint' },
    0x1854: { name: 'SilentTracks', type: 'Container' },
    0x18d7: { name: 'SilentTrackNumber', type: 'Uint' },
    0x27: { name: 'Position', type: 'Uint' },
    0x2b: { name: 'PrevSize', type: 'Uint' },
    0x23: { name: 'SimpleBlock', type: 'Binary' },
    0x20: { name: 'BlockGroup', type: 'Container' },
    0x21: { name: 'Block', type: 'Binary' },
    0x22: { name: 'BlockVirtual', type: 'Binary' },
    0x35a1: { name: 'BlockAdditions', type: 'Container' },
    0x26: { name: 'BlockMore', type: 'Container' },
    0x6e: { name: 'BlockAddID', type: 'Uint' },
    0x25: { name: 'BlockAdditional', type: 'Binary' },
    0x1b: { name: 'BlockDuration', type: 'Uint' },
    0x7a: { name: 'ReferencePriority', type: 'Uint' },
    0x7b: { name: 'ReferenceBlock', type: 'Int' },
    0x7d: { name: 'ReferenceVirtual', type: 'Int' },
    0x24: { name: 'CodecState', type: 'Binary' },
    0x35a2: { name: 'DiscardPadding', type: 'Int' },
    0xe: { name: 'Slices', type: 'Container' },
    0x68: { name: 'TimeSlice', type: 'Container' },
    0x4c: { name: 'LaceNumber', type: 'Uint' },
    0x4d: { name: 'FrameNumber', type: 'Uint' },
    0x4b: { name: 'BlockAdditionID', type: 'Uint' },
    0x4e: { name: 'Delay', type: 'Uint' },
    0x4f: { name: 'SliceDuration', type: 'Uint' },
    0x48: { name: 'ReferenceFrame', type: 'Container' },
    0x49: { name: 'ReferenceOffset', type: 'Uint' },
    0x4a: { name: 'ReferenceTimeCode', type: 'Uint' },
    0x2f: { name: 'EncryptedBlock', type: 'Binary' },
    0x654ae6b: { name: 'Tracks', type: 'Container' },
    0x2e: { name: 'TrackEntry', type: 'Container' },
    0x57: { name: 'TrackNumber', type: 'Uint' },
    0x33c5: { name: 'TrackUID', type: 'Uint' },
    0x3: { name: 'TrackType', type: 'Uint' },
    0x39: { name: 'FlagEnabled', type: 'Uint' },
    0x8: { name: 'FlagDefault', type: 'Uint' },
    0x15aa: { name: 'FlagForced', type: 'Uint' },
    0x1c: { name: 'FlagLacing', type: 'Uint' },
    0x2de7: { name: 'MinCache', type: 'Uint' },
    0x2df8: { name: 'MaxCache', type: 'Uint' },
    0x3e383: { name: 'DefaultDuration', type: 'Uint' },
    0x34e7a: { name: 'DefaultDecodedFieldDuration', type: 'Uint' },
    0x3314f: { name: 'TrackTimecodeScale', type: 'Float' },
    0x137f: { name: 'TrackOffset', type: 'Int' },
    0x15ee: { name: 'MaxBlockAdditionID', type: 'Uint' },
    0x136e: { name: 'Name', type: 'String' },
    0x2b59c: { name: 'Language', type: 'String' },
    0x6: { name: 'CodecID', type: 'String' },
    0x23a2: { name: 'CodecPrivate', type: 'Binary' },
    0x58688: { name: 'CodecName', type: 'String' },
    0x3446: { name: 'AttachmentLink', type: 'Uint' },
    0x1a9697: { name: 'CodecSettings', type: 'String' },
    0x1b4040: { name: 'CodecInfoURL', type: 'String' },
    0x6b240: { name: 'CodecDownloadURL', type: 'String' },
    0x2a: { name: 'CodecDecodeAll', type: 'Uint' },
    0x2fab: { name: 'TrackOverlay', type: 'Uint' },
    0x16aa: { name: 'CodecDelay', type: 'Uint' },
    0x16bb: { name: 'SeekPreRoll', type: 'Uint' },
    0x2624: { name: 'TrackTranslate', type: 'Container' },
    0x26fc: { name: 'TrackTranslateEditionUID', type: 'Uint' },
    0x26bf: { name: 'TrackTranslateCodec', type: 'Uint' },
    0x26a5: { name: 'TrackTranslateTrackID', type: 'Binary' },
    0x60: { name: 'Video', type: 'Container' },
    0x1a: { name: 'FlagInterlaced', type: 'Uint' },
    0x13b8: { name: 'StereoMode', type: 'Uint' },
    0x13c0: { name: 'AlphaMode', type: 'Uint' },
    0x13b9: { name: 'OldStereoMode', type: 'Uint' },
    0x30: { name: 'PixelWidth', type: 'Uint' },
    0x3a: { name: 'PixelHeight', type: 'Uint' },
    0x14aa: { name: 'PixelCropBottom', type: 'Uint' },
    0x14bb: { name: 'PixelCropTop', type: 'Uint' },
    0x14cc: { name: 'PixelCropLeft', type: 'Uint' },
    0x14dd: { name: 'PixelCropRight', type: 'Uint' },
    0x14b0: { name: 'DisplayWidth', type: 'Uint' },
    0x14ba: { name: 'DisplayHeight', type: 'Uint' },
    0x14b2: { name: 'DisplayUnit', type: 'Uint' },
    0x14b3: { name: 'AspectRatioType', type: 'Uint' },
    0xeb524: { name: 'ColourSpace', type: 'Binary' },
    0xfb523: { name: 'GammaValue', type: 'Float' },
    0x383e3: { name: 'FrameRate', type: 'Float' },
    0x61: { name: 'Audio', type: 'Container' },
    0x35: { name: 'SamplingFrequency', type: 'Float' },
    0x38b5: { name: 'OutputSamplingFrequency', type: 'Float' },
    0x1f: { name: 'Channels', type: 'Uint' },
    0x3d7b: { name: 'ChannelPositions', type: 'Binary' },
    0x2264: { name: 'BitDepth', type: 'Uint' },
    0x62: { name: 'TrackOperation', type: 'Container' },
    0x63: { name: 'TrackCombinePlanes', type: 'Container' },
    0x64: { name: 'TrackPlane', type: 'Container' },
    0x65: { name: 'TrackPlaneUID', type: 'Uint' },
    0x66: { name: 'TrackPlaneType', type: 'Uint' },
    0x69: { name: 'TrackJoinBlocks', type: 'Container' },
    0x6d: { name: 'TrackJoinUID', type: 'Uint' },
    0x40: { name: 'TrickTrackUID', type: 'Uint' },
    0x41: { name: 'TrickTrackSegmentUID', type: 'Binary' },
    0x46: { name: 'TrickTrackFlag', type: 'Uint' },
    0x47: { name: 'TrickMasterTrackUID', type: 'Uint' },
    0x44: { name: 'TrickMasterTrackSegmentUID', type: 'Binary' },
    0x2d80: { name: 'ContentEncodings', type: 'Container' },
    0x2240: { name: 'ContentEncoding', type: 'Container' },
    0x1031: { name: 'ContentEncodingOrder', type: 'Uint' },
    0x1032: { name: 'ContentEncodingScope', type: 'Uint' },
    0x1033: { name: 'ContentEncodingType', type: 'Uint' },
    0x1034: { name: 'ContentCompression', type: 'Container' },
    0x254: { name: 'ContentCompAlgo', type: 'Uint' },
    0x255: { name: 'ContentCompSettings', type: 'Binary' },
    0x1035: { name: 'ContentEncryption', type: 'Container' },
    0x7e1: { name: 'ContentEncAlgo', type: 'Uint' },
    0x7e2: { name: 'ContentEncKeyID', type: 'Binary' },
    0x7e3: { name: 'ContentSignature', type: 'Binary' },
    0x7e4: { name: 'ContentSigKeyID', type: 'Binary' },
    0x7e5: { name: 'ContentSigAlgo', type: 'Uint' },
    0x7e6: { name: 'ContentSigHashAlgo', type: 'Uint' },
    0xc53bb6b: { name: 'Cues', type: 'Container' },
    0x3b: { name: 'CuePoint', type: 'Container' },
    0x33: { name: 'CueTime', type: 'Uint' },
    0x37: { name: 'CueTrackPositions', type: 'Container' },
    0x77: { name: 'CueTrack', type: 'Uint' },
    0x71: { name: 'CueClusterPosition', type: 'Uint' },
    0x70: { name: 'CueRelativePosition', type: 'Uint' },
    0x32: { name: 'CueDuration', type: 'Uint' },
    0x1378: { name: 'CueBlockNumber', type: 'Uint' },
    0x6a: { name: 'CueCodecState', type: 'Uint' },
    0x5b: { name: 'CueReference', type: 'Container' },
    0x16: { name: 'CueRefTime', type: 'Uint' },
    0x17: { name: 'CueRefCluster', type: 'Uint' },
    0x135f: { name: 'CueRefNumber', type: 'Uint' },
    0x6b: { name: 'CueRefCodecState', type: 'Uint' },
    0x941a469: { name: 'Attachments', type: 'Container' },
    0x21a7: { name: 'AttachedFile', type: 'Container' },
    0x67e: { name: 'FileDescription', type: 'String' },
    0x66e: { name: 'FileName', type: 'String' },
    0x660: { name: 'FileMimeType', type: 'String' },
    0x65c: { name: 'FileData', type: 'Binary' },
    0x6ae: { name: 'FileUID', type: 'Uint' },
    0x675: { name: 'FileReferral', type: 'Binary' },
    0x661: { name: 'FileUsedStartTime', type: 'Uint' },
    0x662: { name: 'FileUsedEndTime', type: 'Uint' },
    0x43a770: { name: 'Chapters', type: 'Container' },
    0x5b9: { name: 'EditionEntry', type: 'Container' },
    0x5bc: { name: 'EditionUID', type: 'Uint' },
    0x5bd: { name: 'EditionFlagHidden', type: 'Uint' },
    0x5db: { name: 'EditionFlagDefault', type: 'Uint' },
    0x5dd: { name: 'EditionFlagOrdered', type: 'Uint' },
    0x36: { name: 'ChapterAtom', type: 'Container' },
    0x33c4: { name: 'ChapterUID', type: 'Uint' },
    0x1654: { name: 'ChapterStringUID', type: 'String' },
    0x11: { name: 'ChapterTimeStart', type: 'Uint' },
    0x12: { name: 'ChapterTimeEnd', type: 'Uint' },
    0x18: { name: 'ChapterFlagHidden', type: 'Uint' },
    0x598: { name: 'ChapterFlagEnabled', type: 'Uint' },
    0x2e67: { name: 'ChapterSegmentUID', type: 'Binary' },
    0x2ebc: { name: 'ChapterSegmentEditionUID', type: 'Uint' },
    0x23c3: { name: 'ChapterPhysicalEquiv', type: 'Uint' },
    0xf: { name: 'ChapterTrack', type: 'Container' },
    0x9: { name: 'ChapterTrackNumber', type: 'Uint' },
    0x0: { name: 'ChapterDisplay', type: 'Container' },
    0x5: { name: 'ChapString', type: 'String' },
    0x37c: { name: 'ChapLanguage', type: 'String' },
    0x37e: { name: 'ChapCountry', type: 'String' },
    0x2944: { name: 'ChapProcess', type: 'Container' },
    0x2955: { name: 'ChapProcessCodecID', type: 'Uint' },
    0x50d: { name: 'ChapProcessPrivate', type: 'Binary' },
    0x2911: { name: 'ChapProcessCommand', type: 'Container' },
    0x2922: { name: 'ChapProcessTime', type: 'Uint' },
    0x2933: { name: 'ChapProcessData', type: 'Binary' },
    0x254c367: { name: 'Tags', type: 'Container' },
    0x3373: { name: 'Tag', type: 'Container' },
    0x23c0: { name: 'Targets', type: 'Container' },
    0x28ca: { name: 'TargetTypeValue', type: 'Uint' },
    0x23ca: { name: 'TargetType', type: 'String' },
    0x23c5: { name: 'TagTrackUID', type: 'Uint' },
    0x23c9: { name: 'TagEditionUID', type: 'Uint' },
    0x23c4: { name: 'TagChapterUID', type: 'Uint' },
    0x23c6: { name: 'TagAttachmentUID', type: 'Uint' },
    0x27c8: { name: 'SimpleTag', type: 'Container' },
    0x5a3: { name: 'TagName', type: 'String' },
    0x47a: { name: 'TagLanguage', type: 'String' },
    0x484: { name: 'TagDefault', type: 'Uint' },
    0x487: { name: 'TagString', type: 'String' },
    0x485: { name: 'TagBinary', type: 'Binary' }
  };

  function doInherit(newClass, baseClass) {
    newClass.prototype = Object.create(baseClass.prototype);
    newClass.prototype.constructor = newClass;
  }

  function WebmBase(name, type) {
    this.name = name || 'Unknown';
    this.type = type || 'Unknown';
  }
  WebmBase.prototype.updateBySource = function() { };
  WebmBase.prototype.setSource = function(source) {
    this.source = source;
    this.updateBySource();
  };
  WebmBase.prototype.updateByData = function() { };
  WebmBase.prototype.setData = function(data) {
    this.data = data;
    this.updateByData();
  };

  function WebmUint(name, type) {
    WebmBase.call(this, name, type || 'Uint');
  }
  doInherit(WebmUint, WebmBase);
  function padHex(hex) {
    return hex.length % 2 === 1 ? '0' + hex : hex;
  }
  WebmUint.prototype.updateBySource = function() {
    this.data = '';
    for (var i = 0; i < this.source.length; i++) {
      var hex = this.source[i].toString(16);
      this.data += padHex(hex);
    }
  };
  WebmUint.prototype.updateByData = function() {
    var length = this.data.length / 2;
    this.source = new Uint8Array(length);
    for (var i = 0; i < length; i++) {
      var hex = this.data.substr(i * 2, 2);
      this.source[i] = parseInt(hex, 16);
    }
  };
  WebmUint.prototype.getValue = function() {
    return parseInt(this.data, 16);
  };
  WebmUint.prototype.setValue = function(value) {
    this.setData(padHex(value.toString(16)));
  };

  function WebmFloat(name, type) {
    WebmBase.call(this, name, type || 'Float');
  }
  doInherit(WebmFloat, WebmBase);
  WebmFloat.prototype.getFloatArrayType = function() {
    return this.source && this.source.length === 4 ? Float32Array : Float64Array;
  };
  WebmFloat.prototype.updateBySource = function() {
    var byteArray = this.source.reverse();
    var floatArrayType = this.getFloatArrayType();
    var floatArray = new floatArrayType(byteArray.buffer);
    this.data = floatArray[0];
  };
  WebmFloat.prototype.updateByData = function() {
    var floatArrayType = this.getFloatArrayType();
    var floatArray = new floatArrayType([ this.data ]);
    var byteArray = new Uint8Array(floatArray.buffer);
    this.source = byteArray.reverse();
  };
  WebmFloat.prototype.getValue = function() {
    return this.data;
  };
  WebmFloat.prototype.setValue = function(value) {
    this.setData(value);
  };

  function WebmContainer(name, type) {
    WebmBase.call(this, name, type || 'Container');
  }
  doInherit(WebmContainer, WebmBase);
  WebmContainer.prototype.readByte = function() {
    return this.source[this.offset++];
  };
  WebmContainer.prototype.readUint = function() {
    var firstByte = this.readByte();
    var bytes = 8 - firstByte.toString(2).length;
    var value = firstByte - (1 << (7 - bytes));
    for (var i = 0; i < bytes; i++) {
      value *= 256;
      value += this.readByte();
    }
    return value;
  };
  WebmContainer.prototype.updateBySource = function() {
    this.data = [];
    for (this.offset = 0; this.offset < this.source.length; this.offset = end) {
      var id = this.readUint();
      var len = this.readUint();
      var end = Math.min(this.offset + len, this.source.length);
      var data = this.source.slice(this.offset, end);

      var info = EBML_SECTIONS[id] || { name: 'Unknown', type: 'Unknown' };
      var ctr = WebmBase;
      switch (info.type) {
        case 'Container':
          ctr = WebmContainer;
          break;
        case 'Uint':
          ctr = WebmUint;
          break;
        case 'Float':
          ctr = WebmFloat;
          break;
      }
      var section = new ctr(info.name, info.type);
      section.setSource(data);
      this.data.push({
        id: id,
        idHex: id.toString(16),
        data: section
      });
    }
  };
  WebmContainer.prototype.writeUint = function(x, draft) {
    for (var bytes = 1, flag = 0x80; x >= flag && bytes < 8; bytes++, flag *= 0x80) { }

    if (!draft) {
      var value = flag + x;
      for (var i = bytes - 1; i >= 0; i--) {
        var c = value % 256;
        this.source[this.offset + i] = c;
        value = (value - c) / 256;
      }
    }
    this.offset += bytes;
  };
  WebmContainer.prototype.writeSections = function(draft) {
    this.offset = 0;
    for (var i = 0; i < this.data.length; i++) {
      var section = this.data[i],
          content = section.data.source,
          contentLength = content.length;
      this.writeUint(section.id, draft);
      this.writeUint(contentLength, draft);
      if (!draft) {
        this.source.set(content, this.offset);
      }
      this.offset += contentLength;
    }
    return this.offset;
  };
  WebmContainer.prototype.updateByData = function() {
    var length = this.writeSections('draft');
    this.source = new Uint8Array(length);
    this.writeSections();
  };
  WebmContainer.prototype.getSectionById = function(id) {
    for (var i = 0; i < this.data.length; i++) {
      var section = this.data[i];
      if (section.id === id) {
        return section.data;
      }
    }
    return null;
  };

  function WebmFile(source) {
    WebmContainer.call(this, 'File', 'File');
    this.setSource(source);
  }
  doInherit(WebmFile, WebmContainer);
  WebmFile.prototype.fixDuration = function(duration) {
    var segmentSection = this.getSectionById(0x8538067);
    if (!segmentSection) return false;

    var infoSection = segmentSection.getSectionById(0x549a966);
    if (!infoSection) return false;

    var timeScaleSection = infoSection.getSectionById(0xad7b1);
    if (!timeScaleSection) return false;

    var durationSection = infoSection.getSectionById(0x489);
    if (durationSection) {
      if (durationSection.getValue() <= 0) {
        durationSection.setValue(duration);
      } else {
        return false;
      }
    } else {
      durationSection = new WebmFloat('Duration', 'Float');
      durationSection.setValue(duration);
      infoSection.data.push({
        id: 0x489,
        data: durationSection
      });
    }

    timeScaleSection.setValue(1000000); // 1 ms
    infoSection.updateByData();
    segmentSection.updateByData();
    this.updateByData();
    return true;
  };
  WebmFile.prototype.toBlob = function(mimeType) {
    return new Blob([ this.source.buffer ], { type: mimeType || 'video/webm' });
  };

  function fixWebmDuration(blob, duration) {
    return new Promise(function(resolve) {
      try {
        var reader = new FileReader();
        reader.onloadend = function() {
          try {
            var file = new WebmFile(new Uint8Array(reader.result));
            if (file.fixDuration(duration)) {
              resolve(file.toBlob(blob.type));
              return;
            }
          } catch (ex) {
            console.error('[MeetRecorder] fixWebmDuration processing exception:', ex);
          }
          resolve(blob);
        };
        reader.readAsArrayBuffer(blob);
      } catch (ex) {
        console.error('[MeetRecorder] fixWebmDuration reader exception:', ex);
        resolve(blob);
      }
    });
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  injectPageScript();
  loadPendingCombine();
  console.log('[MeetRecorder] content_script.js loaded ✓');
})();
