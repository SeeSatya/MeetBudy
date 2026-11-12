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
  const PENDING_COMBINE_KEY = 'meetBudyPendingCombine:';

  // ─── IndexedDB Setup ──────────────────────────────────────────────────────
  const DB_NAME    = 'MeetRecorderDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'chunks';

  let db                 = null;
  let dbOpening          = null;
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
  let activeCombine = null;
  let startRequested = null;
  let startDispatched = false;
  let ownTabId = null;
  const bridgeInstanceId = 'bridge_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  let pendingLoadGeneration = 0;
  let recoveryScan = null;
  let rescanStatusTimer = null;
  const savingOutputs = new Set();
  window.addEventListener('beforeunload', event => {
    if (!currentRecordingId && !startRequested && !savingOutputs.size && !activeCombine) return;
    event.preventDefault();
    event.returnValue = '';
  });
  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    if (currentRecordingId || startRequested) sendCmd('STOP');
    if (activeCombine) {
      activeCombine.controller.abort();
      try { activeCombine.mux?.terminate(); } catch (_) {}
    }
  });

  // ─── IndexedDB helpers ────────────────────────────────────────────────────
  function openDB(forceReopen = false) {
    if (dbOpening) return dbOpening;
    if (db && !forceReopen) return Promise.resolve(db);
    if (db) { try { db.close(); } catch (_) {} db = null; }
    const opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORE_NAME)) {
          const store = d.createObjectStore(STORE_NAME, { autoIncrement: true });
          store.createIndex('by_recording', 'recordingId', { unique: false });
        }
      };
      req.onsuccess = e => {
        const handle = e.target.result;
        db = handle;
        handle.onversionchange = () => { try { handle.close(); } catch (_) {} if (db === handle) db = null; };
        handle.onclose = () => { if (db === handle) db = null; };
        resolve(handle);
      };
      req.onerror = e => reject(e.target.error);
      req.onblocked = () => console.warn('[MeetRecorder] Recording database is blocked; saved data is retained');
    });
    dbOpening = opening;
    const release = () => { if (dbOpening === opening) dbOpening = null; };
    opening.then(release, release);
    return opening;
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
      tx.onabort     = () => reject(tx.error || new Error('Recording transaction aborted'));
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
      tx.onabort    = () => reject(tx.error || new Error('Recording read aborted'));
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
      tx.onabort    = () => reject(tx.error || new Error('Recording deletion aborted'));
      cursor.onerror = () => reject(cursor.error);
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
  const MAX_INJECTION_ATTEMPTS = 5;
  const MAX_QUEUED_COMMANDS = 32;
  let injectionAttempt = null;
  let injectionRetry = null;
  let injectionAttempts = 0;
  function retireInjectionAttempt(attempt) {
    if (!attempt) return;
    clearTimeout(attempt.timer);
    if (attempt.script) {
      attempt.script.onload = attempt.script.onerror = null;
      attempt.script.remove();
    }
    if (injectionAttempt === attempt) injectionAttempt = null;
  }
  function markPageReady() {
    pageInjected = true;
    retireInjectionAttempt(injectionAttempt);
    clearTimeout(injectionRetry);
    injectionRetry = null;
    injectionAttempts = 0;
    flushPendingPageCommands();
  }
  function injectPageScript() {
    if (pageInjected || injectionAttempt || injectionRetry || injectionAttempts >= MAX_INJECTION_ATTEMPTS) return;
    const attempt = { script: document.createElement('script'), timer: null };
    injectionAttempt = attempt;
    injectionAttempts++;
    const fail = () => {
      if (injectionAttempt !== attempt || pageInjected) return;
      retireInjectionAttempt(attempt);
      if (injectionAttempts >= MAX_INJECTION_ATTEMPTS) {
        const abandoned = startRequested;
        pendingPageCommands = [];
        startRequested = null;
        if (abandoned) cleanupJob(abandoned).catch(() => {});
        toPopup('STATUS', { state: 'error', message: 'Recorder injection failed. Reload the Meet tab or retry Rescan.' });
        return;
      }
      injectionRetry = setTimeout(() => { injectionRetry = null; injectPageScript(); }, 1000 * injectionAttempts);
    };
    const script = attempt.script;
    script.src = chrome.runtime.getURL('injected.js') + '?t=' + Date.now();
    script.onload = () => {
      if (injectionAttempt !== attempt) return;
      script.onload = script.onerror = null;
      script.remove();
      // A guarded, already-installed page script does not emit INJECTED again.
      sendCmd('INIT', { bgUrl: chrome.runtime.getURL('background_image.png') }, { queueIfNotReady: false });
      sendCmd('STATUS', {}, { queueIfNotReady: false });
    };
    script.onerror = fail;
    attempt.timer = setTimeout(fail, 3000);
    try { (document.head || document.documentElement).prepend(script); }
    catch (_) { fail(); }
  }
  function sendCmd(cmd, extra = {}, opts = {}) {
    const payload = { source: MSG_SOURCE_CMD, cmd, ...extra };
    if (!pageInjected && opts.queueIfNotReady !== false && cmd !== 'INIT') {
      if (injectionAttempts >= MAX_INJECTION_ATTEMPTS) return false;
      // Coalesce configuration only inside the current lifecycle segment.
      if (cmd === 'STATUS' || cmd.startsWith('SET_') || cmd === 'FORCE_NO_SCREEN_SHARE') {
        for (let i = pendingPageCommands.length - 1; i >= 0; i--) {
          if (['START', 'STOP', 'PAUSE', 'RESUME'].includes(pendingPageCommands[i].cmd)) break;
          if (pendingPageCommands[i].cmd === cmd) { pendingPageCommands[i] = payload; injectPageScript(); return true; }
        }
      }
      if (pendingPageCommands.length >= MAX_QUEUED_COMMANDS) {
        toPopup('STATUS', { state: 'error', message: 'Recorder is not ready; command queue is full.' });
        return false;
      }
      pendingPageCommands.push(payload);
      injectPageScript();
      return true;
    }
    window.postMessage(payload, '*');
    return true;
  }
  function flushPendingPageCommands() {
    if (!pageInjected) return;
    const queue = pendingPageCommands;
    pendingPageCommands = [];
    queue.forEach(payload => window.postMessage(payload, '*'));
  }
  function ensurePageInjected() { injectPageScript(); }

  // ─── Popup Broadcasting ───────────────────────────────────────────────────
  function toPopup(type, payload) {
    const scoped = { ...payload, contextId: bridgeInstanceId, tabId: ownTabId };
    if (type === 'STATUS') {
      scoped.scope = payload.scope || 'page';
      scoped.recordingId = payload.recordingId ?? null;
    } else if (type === 'CHUNK' || type === 'STATUS_RESPONSE') scoped.recordingId = currentRecordingId;
    if (type === 'STATUS' && scoped.scope !== 'job' && scoped.recordingId && currentRecordingId &&
        scoped.recordingId !== currentRecordingId && scoped.state !== 'combine_pending') return;
    chrome.runtime.sendMessage({ type, payload: scoped }).catch(() => {});
  }

  // ─── State broadcasting → background (for popup restore) ─────────────────
  function broadcastRecordingState(isRecording, isPaused = false, recordingId = currentRecordingId) {
    chrome.runtime.sendMessage({
      type: 'RECORDING_STATE_UPDATE',
      state: {
        isRecording,
        isPaused,
        startTime:   isRecording ? recordingStartTime : null,
        recordingId,
        contextId: bridgeInstanceId,
      },
    }).catch(() => {});
  }

  // ─── Download Trigger ─────────────────────────────────────────────────────
  async function rebuildBlobFromChunks(recordingId, mimeType) {
    const buffers = await loadAllChunks(recordingId);
    return buffers.length ? new Blob(buffers, { type: mimeType || buffers[0]?.type || 'video/webm' }) : null;
  }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    let a = null;
    let scheduled = false;
    const dispose = () => { a?.remove(); URL.revokeObjectURL(url); };
    try {
      a = document.createElement('a');
      a.style.display = 'none'; a.href = url; a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(dispose, 3000);
      scheduled = true;
    } finally { if (!scheduled) dispose(); }
  }

  async function assembleAndDownload(recordingId, mimeType, opts = {}) {
    const { fileLabel = '', fixDuration = true, silentEmpty = false, keepChunks = false, startTime = recordingStartTime, signal } = opts;
    const status = payload => toPopup('STATUS', { ...payload, scope: 'job', recordingId });
    status({ state: 'assembling', message: `Assembling ${fileLabel || 'recording'}…` });

    let buffers;
    try {
      buffers = await loadAllChunks(recordingId);
    } catch (err) {
      status({ state: 'error', message: `Load failed: ${err?.message}` });
      throw err;
    }

    if (!buffers || buffers.length === 0) {
      if (!silentEmpty) {
        status({
          state: 'error',
          message: `No data recorded${fileLabel ? ` for ${fileLabel}` : ''}. (Chunks may not have saved)`,
        });
      }
      return null;
    }

    if (signal?.aborted) throw new Error('Saved recording operation cancelled');
    let finalBlob = new Blob(buffers, { type: mimeType || 'video/webm' });
    let ext = mimeType?.includes('matroska') || mimeType?.includes('mkv') || mimeType?.includes('h264') ? 'mkv' : 'webm';
    let metadataWarning = null;
    if (fixDuration) {
      status({ state: 'assembling', message: 'Finalizing recording duration and seek index…' });
      try {
        if (!window.MeetBudyMetadata?.finalize) throw new Error('Recording metadata helper is unavailable');
        const repaired = await window.MeetBudyMetadata.finalize(finalBlob, { signal });
        finalBlob = repaired.blob;
        ext = repaired.extension;
      } catch (error) {
        if (signal?.aborted) throw error;
        metadataWarning = error.message;
        status({ state: 'metadata_warning', message: 'Metadata repair failed; saving original bytes and retaining recovery data: ' + error.message });
      }
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeLabel = fileLabel ? `_${fileLabel.replace(/[^a-z0-9-_]+/gi, '-')}` : '';
    const filename  = `meet-recording-${ts}${safeLabel}.${ext}`;

    if (signal?.aborted) throw new Error('Saved recording operation cancelled');
    downloadBlob(finalBlob, filename);

    if (!keepChunks && !metadataWarning) await clearChunks(recordingId);

    status({
      state: 'downloaded',
      recordingId,
      message: `Saved: ${filename}`,
      filename,
      sizeMB: (finalBlob.size / 1_048_576).toFixed(1),
    });
    return { filename, sizeMB: (finalBlob.size / 1_048_576).toFixed(1), metadataWarning };
  }

  function jobStore(action, extra = {}) {
    return new Promise((resolve, reject) => chrome.runtime.sendMessage({ type: 'JOB_STORE', action, ...extra }, response => {
      const error = chrome.runtime.lastError;
      if (error || !response?.ok) reject(new Error(error?.message || response?.error || 'Recording catalog unavailable'));
      else { if (response.tabId !== undefined) ownTabId = response.tabId; resolve(response); }
    }));
  }
  const jobId = job => typeof job === 'string' ? job : job?.id || job?.recordingId;
  async function getPendingJob(job) {
    const id = jobId(job || currentPendingCombine);
    if (!id) throw new Error('Choose a saved recording first');
    const result = (await jobStore('get', { jobId: id })).job;
    if (!result) throw new Error('Recording job no longer exists');
    if (result.origin !== location.origin) throw new Error('Recording belongs to another storage origin');
    return result;
  }
  async function updateJob(job, changes, operation) {
    return (await jobStore('update', { jobId: jobId(job), revision: job.revision, changes,
      executionToken: operation?.token, documentId: bridgeInstanceId })).job;
  }
  async function savePendingCombine(job) {
    if (!job) return; // Removing a singleton must never erase another recording.
    const saved = (await jobStore('create', { job: { ...job, id: jobId(job), origin: location.origin, state: job.state || 'pending' } })).job;
    await loadPendingCombine();
    return saved;
  }
  async function loadPendingCombine() {
    const generation = ++pendingLoadGeneration;
    const jobs = (await jobStore('list')).jobs.filter(job => job.origin === location.origin && !['recording', 'preparing', 'combining'].includes(job.state));
    if (generation !== pendingLoadGeneration) return;
    jobs.sort((a, b) => (a.nextPromptAt || 0) - (b.nextPromptAt || 0) || a.createdAt - b.createdAt);
    currentPendingCombine = jobs[0] || null;
    if (currentPendingCombine) toPopup('STATUS', { scope: 'job', recordingId: currentPendingCombine.recordingId,
      state: 'combine_pending', message: 'Saved recordings are available', data: currentPendingCombine });
  }
  async function cleanupJob(job, operation) {
    job = await getPendingJob(job);
    if (operation && job.executionToken !== operation.token) throw new Error('Recording execution owner changed');
    job = await updateJob(job, { state: 'cleanup', nextPromptAt: 0 }, operation);
    // The tombstone remains until every deletion commits, including on reload.
    const related = (await recordingIdsInDB()).filter(id => id.startsWith(job.recordingId + '__t'));
    for (const id of new Set([job.recordingId, ...(job.secondaries || []).map(sec => sec.recordingId), ...related])) await clearChunks(id);
    await jobStore('remove', { jobId: job.id, revision: job.revision });
    await loadPendingCombine();
  }
  function waitForOperation(promise, operation) {
    if (operation.controller.signal.aborted) return Promise.reject(new Error('Combine cancelled'));
    return new Promise((resolve, reject) => {
      const signal = operation.controller.signal;
      const abort = () => reject(new Error('Combine cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      const finish = fn => value => { signal.removeEventListener('abort', abort); fn(value); };
      Promise.resolve(promise).then(finish(resolve), finish(reject));
    });
  }
  async function runPendingCombine(requestedJob = currentPendingCombine) {
    if (combineInProgress) throw new Error('A saved recording operation is already running');
    const operation = { id: jobId(requestedJob), token: 'run_' + Date.now() + '_' + Math.random().toString(36).slice(2),
      acquired: false, controller: new AbortController(), mux: window.MeetBudyMuxer };
    activeCombine = operation;
    combineInProgress = true;
    try {
      let job = await getPendingJob(requestedJob);
      if (!['pending', 'recovery'].includes(job.state)) throw new Error('Recording is busy or awaiting cleanup');
      job = (await jobStore('claim', { jobId: job.id, revision: job.revision,
        executionToken: operation.token, documentId: bridgeInstanceId })).job;
      operation.acquired = true;
      if (operation.controller.signal.aborted) throw new Error('Combine cancelled');
      if (job.needsRawSave) {
        const raw = await waitForOperation(assembleAndDownload(job.recordingId, job.mimeType, { fileLabel: 'recovered', keepChunks: true, startTime: job.startTime || null, signal: operation.controller.signal }), operation);
        if (!raw) throw new Error('Saved recording has no main data; discard it to clear remaining tracks');
        if (raw.metadataWarning) throw new Error('Original output saved; metadata repair failed. Recovery data is retained.');
        for (const sec of job.secondaries || []) {
          const saved = await waitForOperation(assembleAndDownload(sec.recordingId, sec.mimeType, { fileLabel: 'track-' + sec.trackId, keepChunks: true, signal: operation.controller.signal }), operation);
          if (!saved || saved.metadataWarning) throw new Error('Secondary output is missing or metadata repair failed; recovery data is retained.');
        }
        if (!(job.secondaries || []).length) {
          if (operation.controller.signal.aborted) throw new Error('Combine cancelled');
          await cleanupJob(job, operation);
          return raw;
        }
      }
      if (!operation.mux || !(await waitForOperation(operation.mux.isAvailable(), operation))) throw new Error('ffmpeg vendor files not found; raw files remain saved');
      toPopup('STATUS', { scope: 'job', recordingId: job.recordingId, state: 'assembling', message: 'Muxing combined MKV (ffmpeg)…' });
      const mainBlob = await waitForOperation(rebuildBlobFromChunks(job.recordingId, job.mimeType), operation);
      if (!mainBlob?.size) throw new Error('Saved recording has no main data; discard it to clear remaining tracks');
      const secondaries = [];
      for (const sec of job.secondaries || []) {
        const blob = await waitForOperation(rebuildBlobFromChunks(sec.recordingId, sec.mimeType), operation);
        if (!blob?.size) throw new Error('Saved audio track is empty; raw data remains available');
        secondaries.push(blob);
      }
      const mainExt = /matroska|mkv/.test(job.mimeType || '') ? 'mkv' : 'webm';
      const muxBlob = await waitForOperation(operation.mux.muxToMkv(mainBlob, secondaries, mainExt, { signal: operation.controller.signal }), operation);
      if (operation.controller.signal.aborted) throw new Error('Combine cancelled');
      const current = await getPendingJob(job);
      if (current.state !== 'combining' || current.executionToken !== operation.token) throw new Error('Combine cancelled');
      downloadBlob(muxBlob, 'meet-recording-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '_combined.mkv');
      await cleanupJob(current, operation);
      toPopup('STATUS', { scope: 'job', recordingId: job.recordingId, state: 'downloaded', message: 'Combined MKV saved', filename: 'combined.mkv', sizeMB: (muxBlob.size / 1048576).toFixed(1) });
      return muxBlob;
    } finally {
      if (activeCombine === operation) { activeCombine = null; combineInProgress = false; }
      if (operation.acquired) {
        try { operation.mux?.terminate(); } catch (_) {}
        await jobStore('release', { jobId: operation.id, executionToken: operation.token,
          documentId: bridgeInstanceId }).catch(() => {});
      }
      await loadPendingCombine().catch(() => {});
    }
  }
  async function deferPendingCombine(requestedJob = currentPendingCombine) {
    const job = await getPendingJob(requestedJob);
    if (!['pending', 'recovery'].includes(job.state)) throw new Error('Recording is busy or awaiting cleanup');
    await updateJob(job, { nextPromptAt: Date.now() + 10 * 60 * 1000 });
    await loadPendingCombine();
  }
  async function cancelPendingCombine(requestedJob = currentPendingCombine) {
    const id = jobId(requestedJob);
    if (activeCombine?.id === id) {
      activeCombine.controller.abort();
      try { activeCombine.mux?.terminate(); } catch (_) {}
    }
    let job = await getPendingJob(requestedJob);
    if (['recording', 'preparing'].includes(job.state)) throw new Error('Stop the recording before discarding it');
    job = await updateJob(job, { state: 'cleanup_requested' });
    await cleanupJob(job);
    toPopup('STATUS', { scope: 'job', recordingId: job.recordingId, state: 'aborted', message: 'Saved recording discarded' });
  }

  async function recordingIdsInDB() {
    const d = await openDB();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE_NAME, 'readonly');
      const ids = [];
      const cursor = tx.objectStore(STORE_NAME).index('by_recording').openKeyCursor(null, 'nextunique');
      cursor.onsuccess = e => { const c = e.target.result; if (c) { ids.push(c.key); c.continue(); } };
      cursor.onerror = () => reject(cursor.error);
      tx.oncomplete = () => resolve(ids);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('Recording recovery scan failed'));
    });
  }
  function recoverStoredRecordings() {
    if (recoveryScan || currentRecordingId || startRequested || savingOutputs.size || activeCombine) return recoveryScan;
    recoveryScan = (async () => {
      const { jobs, tabId } = await jobStore('list');
      const ids = await recordingIdsInDB();
      if (currentRecordingId || startRequested || savingOutputs.size || activeCombine) return;
      for (const job of jobs.filter(job => job.origin === location.origin)) {
        if (savingOutputs.has(job.recordingId) || activeCombine?.id === job.id) continue;
        const inactiveOwner = job.ownerTabId === tabId && ['recording', 'preparing'].includes(job.state);
        if (!inactiveOwner && !['pending', 'recovery'].includes(job.state)) continue;
        const existingIds = new Set((job.secondaries || []).map(sec => sec.recordingId));
        const missing = ids.filter(id => id.startsWith(job.recordingId + '__t') && !existingIds.has(id))
          .map(id => ({ recordingId: id, trackId: id.slice((job.recordingId + '__t').length), name: 'recovered', mimeType: 'audio/webm' }));
        if (inactiveOwner || missing.length) {
          if (inactiveOwner && !ids.some(id => id === job.recordingId || id.startsWith(job.recordingId + '__t'))) await cleanupJob(job).catch(() => {});
          else await updateJob(job, { state: 'recovery', needsRawSave: true, incomplete: true, secondaries: [...(job.secondaries || []), ...missing] }).catch(() => {});
        }
      }
      const known = new Set(jobs.filter(job => job.origin === location.origin).map(job => job.recordingId));
      const groups = new Map();
      for (const id of ids) {
        const match = /^(.*)__t(.+)$/.exec(id);
        const mainId = match ? match[1] : id;
        if (known.has(mainId)) continue;
        if (!groups.has(mainId)) groups.set(mainId, []);
        if (match) groups.get(mainId).push({ recordingId: id, trackId: match[2], name: 'recovered', mimeType: 'audio/webm' });
      }
      for (const [id, secondaries] of groups) await savePendingCombine({ id, recordingId: id, mimeType: 'video/webm', secondaries,
        state: 'recovery', needsRawSave: true, incomplete: true, createdAt: Date.now(), nextPromptAt: 0 });
      await loadPendingCombine();
    })().catch(error => toPopup('STATUS', { scope: 'job', state: 'error', message: 'Saved recording recovery failed: ' + error.message }))
      .finally(() => { recoveryScan = null; });
    return recoveryScan;
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const changed = Object.keys(changes).some(key => key.startsWith(PENDING_COMBINE_KEY));
    if (!changed) return;
    const entry = activeCombine && changes[PENDING_COMBINE_KEY + encodeURIComponent(activeCombine.id)];
    if (entry && (['cleanup_requested', 'cleanup'].includes(entry.newValue?.state) ||
        (activeCombine.acquired && entry.newValue?.executionToken !== activeCombine.token))) {
      activeCombine.controller.abort();
      try { activeCombine.mux?.terminate(); } catch (_) {}
    }
    loadPendingCombine().catch(() => {});
  });

  // ─── Message Handler (from injected.js via window) ────────────────────────
  window.addEventListener('message', async (e) => {
    if (!e.data || e.data.source !== MSG_SOURCE_OUT) return;
    const { type, event, data, chunk } = e.data;
    const contextRecordingId = data?.recordingId || currentRecordingId || startRequested;
    markPageReady();

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
          markPageReady();
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

        case 'MEETING_ACTIVITY':
          toPopup('STATUS', { scope: 'recording', ...data });
          break;

        case 'RECORDING_STARTED':
          // Sync recordingId back from injected.js in case it generated its own
          if (data?.recordingId) currentRecordingId = data.recordingId;
          startRequested = null;
          startDispatched = false;
          savePendingCombine({ recordingId: currentRecordingId, mimeType: data?.mimeType || 'video/webm', state: 'recording', secondaries: [], createdAt: Date.now(), startTime: data?.startTime || Date.now() }).catch(error => toPopup('STATUS', { scope: 'job', recordingId: contextRecordingId, state: 'error', message: 'Recording recovery catalog failed: ' + error.message }));
          lastMimeType       = data?.mimeType || 'video/webm';
          recordingStartTime = data?.startTime || Date.now();
          broadcastRecordingState(true, false);
          toPopup('STATUS', {
            state:     'recording',
            scope: 'recording',
            message:   'Recording…',
            startTime: recordingStartTime,
            recordingId: currentRecordingId,
            mimeType:  data?.mimeType,
            hasVideo:  data?.hasVideo,
            hasAudio:  data?.hasAudio,
          });
          break;

        case 'RECORDING_PAUSED':
          broadcastRecordingState(true, true);
          toPopup('STATUS', {
            state: 'paused',
            scope: 'recording',
            recordingId: contextRecordingId,
            message: 'Recording paused',
            startTime: recordingStartTime,
          });
          break;

        case 'RECORDING_RESUMED':
          broadcastRecordingState(true, false);
          toPopup('STATUS', {
            state: 'recording',
            scope: 'recording',
            recordingId: contextRecordingId,
            message: 'Recording…',
            startTime: recordingStartTime,
          });
          break;

        case 'RECORDING_STOPPED': {
          const rid = data?.recordingId || currentRecordingId;
          const mime = data?.mimeType || lastMimeType;
          const started = data?.startTime || recordingStartTime;
          const stoppedAt = data?.stoppedAt || Date.now();
          const secondaries = Array.isArray(data?.secondaries) ? data.secondaries : [];
          if (!rid) break;
          // Retire only this session's bridge state before asynchronous assembly.
          broadcastRecordingState(false, false, rid);
          if (currentRecordingId === rid) {
            currentRecordingId = null; recordingStartTime = null; chunkCount = 0; totalBytes = 0;
          }
          if (startRequested === rid) startRequested = null;
          toPopup('STATUS', { scope: 'recording', state: 'stopped', recordingId: rid, message: 'Recording stopped; saving output…' });
          savingOutputs.add(rid);
          try {
            let job = await savePendingCombine({ recordingId: rid, mimeType: mime, secondaries, state: 'preparing', createdAt: Date.now(), startTime: started, stoppedAt });
            job = await updateJob(job, { mimeType: mime, secondaries, state: 'preparing', startTime: started, stoppedAt, incomplete: !!data?.incomplete, needsRawSave: true });
            if (data?.writeFailed) {
              await updateJob(job, { state: 'recovery', writeFailed: true });
              toPopup('STATUS', { scope: 'job', recordingId: rid, state: 'error', message: 'Recording storage failed. Saved chunks are retained for recovery; output may be incomplete.' });
              break;
            }
            const main = await assembleAndDownload(rid, mime, { fileLabel: 'full', keepChunks: true, startTime: started });
            let complete = !!main && !main.metadataWarning && !data?.incomplete;
            for (const sec of secondaries) {
              const result = await assembleAndDownload(sec.recordingId, sec.mimeType, { fileLabel: 'track-' + sec.trackId + '-' + (sec.name || 'track'), silentEmpty: true, keepChunks: true });
              complete = !!result && !result.metadataWarning && complete;
            }
            job = await getPendingJob(job);
            if (!complete) {
              await updateJob(job, { state: 'recovery', needsRawSave: true });
              toPopup('STATUS', { scope: 'job', recordingId: rid, state: 'error', message: 'Recording may be incomplete or metadata repair failed; saved chunks remain recoverable.' });
            } else if (secondaries.length) {
              await updateJob(job, { state: 'pending', needsRawSave: false, nextPromptAt: 0 });
              await loadPendingCombine();
            } else await cleanupJob(job);
          } catch (error) {
            const job = await jobStore('get', { jobId: rid }).then(result => result.job).catch(() => null);
            if (job?.state === 'preparing') await updateJob(job, { state: 'recovery', needsRawSave: true }).catch(() => {});
            toPopup('STATUS', { scope: 'job', recordingId: rid, state: 'error', message: 'Recording save/cleanup failed; data retained: ' + error.message });
          } finally { savingOutputs.delete(rid); }
          break;
        }

        case 'RECORDING_IDLE': {
          if (currentRecordingId && contextRecordingId !== currentRecordingId) break;
          // Page-side recorder is already gone; clear our state and force the
          // popup back to idle so a stuck "recording" UI can recover.
          const abandoned = startRequested;
          broadcastRecordingState(false, false);
          startRequested = null;
          currentRecordingId = null;
          chunkCount         = 0;
          totalBytes         = 0;
          recordingStartTime = null;
          if (abandoned) cleanupJob(abandoned).catch(() => {});
          recoverStoredRecordings();
          toPopup('STATUS', { scope: 'recording', recordingId: contextRecordingId, state: 'aborted', message: 'Recording was not active — reset.' });
          break;
        }

        case 'STATUS_RESPONSE':
          if (!data?.isRecording && !currentRecordingId && !startRequested) recoverStoredRecordings();
          toPopup('STATUS_RESPONSE', data);
          break;

        case 'ERROR':
          toPopup('STATUS', { recordingId: contextRecordingId, state: 'error', message: data });
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
    if (['STOP_RECORDING', 'PAUSE_RECORDING', 'RESUME_RECORDING'].includes(message.type) &&
        ((message.recordingId && currentRecordingId && message.recordingId !== currentRecordingId) ||
         (message.contextId && message.contextId !== bridgeInstanceId))) {
      sendResponse({ ok: false, error: 'Recording context changed; refresh its status' });
      return true;
    }
    switch (message.type) {
      case 'GET_EXECUTION_STATE':
        sendResponse({ documentId: bridgeInstanceId, jobId: activeCombine?.id || null,
          executionToken: activeCombine?.token || null, recordingId: currentRecordingId || startRequested, savingRecordingIds: Array.from(savingOutputs) });
        break;
      case 'START_RECORDING': {
        if (currentRecordingId || startRequested || recoveryScan) { sendResponse({ ok: false, error: 'Recorder is busy' }); break; }
        const id = 'rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        startRequested = id;
        startDispatched = false;
        savePendingCombine({ recordingId: id, mimeType: 'video/webm', secondaries: [], state: 'preparing', createdAt: Date.now(), nextPromptAt: 0 })
          .then(() => {
            if (startRequested !== id) { cleanupJob(id).catch(() => {}); throw new Error('Recording start cancelled'); }
            const accepted = sendCmd('START', { recordingId: id, bgUrl: chrome.runtime.getURL('background_image.png') });
            if (!accepted) { startRequested = null; cleanupJob(id).catch(() => {}); throw new Error('Recorder is not ready'); }
            startDispatched = true;
            sendResponse({ ok: true });
          }).catch(error => { if (startRequested === id) startRequested = null; sendResponse({ ok: false, error: error.message }); });
        return true;
      }

      case 'STOP_RECORDING':
        if (startRequested && !startDispatched) startRequested = null;
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
        // Explicit retry resets only a failed attempt, preserving queued STOP.
        if (!pageInjected) {
          retireInjectionAttempt(injectionAttempt); clearTimeout(injectionRetry); injectionRetry = null; injectionAttempts = 0;
        }
        ensurePageInjected();
        sendCmd('RESCAN_MEDIA');
        clearTimeout(rescanStatusTimer);
        rescanStatusTimer = setTimeout(() => { rescanStatusTimer = null; sendCmd('STATUS'); }, 250);
        sendResponse({ ok: true });
        break;

      case 'RUN_PENDING_COMBINE':
        ensurePageInjected();
        runPendingCombine(message.jobId || message.job || currentPendingCombine)
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;

      case 'DEFER_PENDING_COMBINE':
        deferPendingCombine(message.jobId || message.job || currentPendingCombine)
          .then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error.message }));
        return true;

      case 'CANCEL_PENDING_COMBINE':
        cancelPendingCombine(message.jobId || message.job || currentPendingCombine)
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;

      case 'PAGE_PING':
        markPageReady();
        sendResponse({ ok: true });
        break;

      default:
        break;
    }
    return true; // keep channel open for async
  });

  // ─── Boot ─────────────────────────────────────────────────────────────────
  injectPageScript();
  loadPendingCombine().catch(error => console.error('[MeetRecorder] Saved recording catalog unavailable:', error));
  console.log('[MeetRecorder] content_script.js loaded ✓');
})();
