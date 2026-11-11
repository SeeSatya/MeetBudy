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
    // Calculate duration and fix WebM seekability/metadata
    const duration = startTime ? (Date.now() - startTime) : 0;
    console.log(`[MeetRecorder] Raw recording duration: ${duration} ms`);

    let firstBlob = buffers[0];
    if (fixDuration && duration > 1000 && firstBlob) {
      status({ state: 'assembling', message: 'Injecting seek index (duration)…' });
      try {
        const patchedFirstBlob = await fixWebmDuration(firstBlob, duration);
        buffers[0] = patchedFirstBlob;
        console.log('[MeetRecorder] WebM duration injected successfully on the first chunk');
      } catch (err) {
        console.error('[MeetRecorder] WebM duration fixing failed on first chunk:', err);
      }
    }

    const finalBlob = new Blob(buffers, { type: mimeType || 'video/webm' });

    const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const isAudio  = mimeType && mimeType.startsWith('audio/');
    const ext      = isAudio
      ? 'webm'
      : ((mimeType && (mimeType.includes('matroska') || mimeType.includes('mkv'))) ? 'mkv' : 'webm');
    const safeLabel = fileLabel ? `_${fileLabel.replace(/[^a-z0-9-_]+/gi, '-')}` : '';
    const filename  = `meet-recording-${ts}${safeLabel}.${ext}`;

    if (signal?.aborted) throw new Error('Saved recording operation cancelled');
    downloadBlob(finalBlob, filename);

    if (!keepChunks) await clearChunks(recordingId);

    status({
      state: 'downloaded',
      recordingId,
      message: `Saved: ${filename}`,
      filename,
      sizeMB: (finalBlob.size / 1_048_576).toFixed(1),
    });
    return { filename, sizeMB: (finalBlob.size / 1_048_576).toFixed(1) };
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
        for (const sec of job.secondaries || []) await waitForOperation(assembleAndDownload(sec.recordingId, sec.mimeType, { fileLabel: 'track-' + sec.trackId, fixDuration: false, keepChunks: true, signal: operation.controller.signal }), operation);
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
    if (recoveryScan || currentRecordingId || startRequested) return recoveryScan;
    recoveryScan = (async () => {
      const { jobs, tabId } = await jobStore('list');
      const ids = await recordingIdsInDB();
      for (const job of jobs.filter(job => job.origin === location.origin)) {
        const inactiveOwner = job.ownerTabId === tabId && ['recording', 'preparing'].includes(job.state);
        if (!inactiveOwner && !['pending', 'recovery'].includes(job.state)) continue;
        const existingIds = new Set((job.secondaries || []).map(sec => sec.recordingId));
        const missing = ids.filter(id => id.startsWith(job.recordingId + '__t') && !existingIds.has(id))
          .map(id => ({ recordingId: id, trackId: id.slice((job.recordingId + '__t').length), name: 'recovered', mimeType: 'audio/webm' }));
        if (inactiveOwner || missing.length) {
          if (inactiveOwner && !ids.some(id => id === job.recordingId || id.startsWith(job.recordingId + '__t'))) await cleanupJob(job).catch(() => {});
          else await updateJob(job, { state: 'recovery', needsRawSave: true, secondaries: [...(job.secondaries || []), ...missing] }).catch(() => {});
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
        state: 'recovery', needsRawSave: true, createdAt: Date.now(), nextPromptAt: 0 });
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

        case 'RECORDING_STARTED':
          // Sync recordingId back from injected.js in case it generated its own
          if (data?.recordingId) currentRecordingId = data.recordingId;
          startRequested = null;
          startDispatched = false;
          savePendingCombine({ recordingId: currentRecordingId, mimeType: data?.mimeType || 'video/webm', state: 'recording', secondaries: [], createdAt: Date.now(), startTime: Date.now() }).catch(error => toPopup('STATUS', { scope: 'job', recordingId: contextRecordingId, state: 'error', message: 'Recording recovery catalog failed: ' + error.message }));
          lastMimeType       = data?.mimeType || 'video/webm';
          recordingStartTime = Date.now();
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
          const started = recordingStartTime;
          const secondaries = Array.isArray(data?.secondaries) ? data.secondaries : [];
          if (!rid) break;
          // Retire only this session's bridge state before asynchronous assembly.
          broadcastRecordingState(false, false, rid);
          if (currentRecordingId === rid) {
            currentRecordingId = null; recordingStartTime = null; chunkCount = 0; totalBytes = 0;
          }
          if (startRequested === rid) startRequested = null;
          toPopup('STATUS', { scope: 'recording', state: 'stopped', recordingId: rid, message: 'Recording stopped; saving output…' });
          try {
            let job = await savePendingCombine({ recordingId: rid, mimeType: mime, secondaries, state: 'preparing', createdAt: Date.now(), startTime: started });
            job = await updateJob(job, { mimeType: mime, secondaries, state: 'preparing', startTime: started, needsRawSave: true });
            if (data?.writeFailed) {
              await updateJob(job, { state: 'recovery', writeFailed: true });
              toPopup('STATUS', { scope: 'job', recordingId: rid, state: 'error', message: 'Recording storage failed. Saved chunks are retained for recovery; output may be incomplete.' });
              break;
            }
            const main = await assembleAndDownload(rid, mime, { fileLabel: 'full', keepChunks: true, startTime: started });
            let complete = !!main;
            for (const sec of secondaries) {
              const result = await assembleAndDownload(sec.recordingId, sec.mimeType, { fileLabel: 'track-' + sec.trackId + '-' + (sec.name || 'track'), fixDuration: false, silentEmpty: true, keepChunks: true });
              complete = !!result && complete;
            }
            job = await getPendingJob(job);
            if (!complete) {
              await updateJob(job, { state: 'recovery', needsRawSave: true });
              toPopup('STATUS', { scope: 'job', recordingId: rid, state: 'error', message: 'Some recording data is missing; saved chunks remain recoverable.' });
            } else if (secondaries.length) {
              await updateJob(job, { state: 'pending', needsRawSave: false, nextPromptAt: 0 });
              await loadPendingCombine();
            } else await cleanupJob(job);
          } catch (error) {
            const job = await jobStore('get', { jobId: rid }).then(result => result.job).catch(() => null);
            if (job?.state === 'preparing') await updateJob(job, { state: 'recovery', needsRawSave: true }).catch(() => {});
            toPopup('STATUS', { scope: 'job', recordingId: rid, state: 'error', message: 'Recording save/cleanup failed; data retained: ' + error.message });
          }
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
          executionToken: activeCombine?.token || null });
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
  loadPendingCombine().catch(error => console.error('[MeetRecorder] Saved recording catalog unavailable:', error));
  console.log('[MeetRecorder] content_script.js loaded ✓');
})();
