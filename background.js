/**
 * background.js — Service Worker for Meet Recorder extension.
 * Acts as a message relay between popup and content scripts across tabs.
 * Also persists recording state so the popup can restore correctly on reopen.
 */

// ── In-memory recording state (lives as long as service worker is alive) ─────
let recordingState = {
  isRecording: false,
  startTime:   null,
  recordingId: null,
  tabId:       null,
};

// ── Tab state cache: tabId → latest status payload ───────────────────────────
const tabState = new Map();
let recordingStateRevision = 0;
function retireRecordingState(message = 'Recording context closed') {
  const retired = recordingState;
  recordingStateRevision++;
  recordingState = { isRecording: false, isPaused: false, startTime: null, recordingId: null, tabId: null, contextId: null };
  chrome.storage.local.set({ meetRecorderState: recordingState });
  chrome.runtime.sendMessage({ type: 'STATUS', payload: { scope: 'recording', state: 'stopped',
    recordingId: retired.recordingId, contextId: retired.contextId, tabId: retired.tabId, message } }).catch(() => {});
}

// One storage key per recording prevents unrelated tabs replacing each other.
// All catalog mutations go through this worker and serialize per job, including
// popup cancellation while a content operation is waiting for ffmpeg/IDB.
const JOB_PREFIX = 'meetBudyPendingCombine:';
const LEGACY_JOB_KEY = 'meetBudyPendingCombine';
const jobMutations = new Map();
const jobKey = id => JOB_PREFIX + encodeURIComponent(id);
function storageCall(method, value) {
  return new Promise((resolve, reject) => chrome.storage.local[method](value, result => {
    const error = chrome.runtime.lastError;
    error ? reject(new Error(error.message)) : resolve(result);
  }));
}
function serializeJob(id, fn) {
  const previous = jobMutations.get(id) || Promise.resolve();
  const task = previous.catch(() => {}).then(fn);
  jobMutations.set(id, task);
  const release = () => { if (jobMutations.get(id) === task) jobMutations.delete(id); };
  task.then(release, release);
  return task;
}
async function getJob(id) { return (await storageCall('get', jobKey(id)))[jobKey(id)] || null; }
async function listJobs() {
  const stored = await storageCall('get', null);
  const legacy = stored[LEGACY_JOB_KEY];
  if (legacy?.recordingId) {
    await serializeJob(legacy.recordingId, async () => {
      if (!(await getJob(legacy.recordingId))) {
        const job = { ...legacy, id: legacy.recordingId, origin: 'https://meet.google.com', state: 'pending', revision: 1 };
        await storageCall('set', { [jobKey(job.id)]: job });
      }
      await storageCall('remove', LEGACY_JOB_KEY);
    });
    return listJobs();
  }
  const jobs = Object.entries(stored).filter(([key]) => key.startsWith(JOB_PREFIX)).map(([, job]) => job);
  // Service-worker/browser restart loses JS state, not durable execution claims.
  // Ask the owning document before retiring one; an unresponsive live context
  // is retained conservatively instead of having its claim stolen.
  const result = [];
  for (const job of jobs) result.push(job.state === 'combining'
    ? await recoverExecution(job.id, job.executionToken)
    : ['recording', 'preparing'].includes(job.state) ? await recoverRecordingJob(job.id) : job);
  return result.filter(Boolean);
}
function executionState(tabId) {
  return new Promise(resolve => {
    let done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => finish({ unknown: true }), 5000);
    try {
      chrome.tabs.sendMessage(tabId, { type: 'GET_EXECUTION_STATE' }, response => {
        finish(chrome.runtime.lastError ? null : response);
      });
    } catch (_) { finish(null); }
  });
}
function recoverRecordingJob(id) {
  return serializeJob(id, async () => {
    const current = await getJob(id);
    if (!current || !['recording', 'preparing'].includes(current.state)) return current;
    const response = await executionState(current.ownerTabId);
    if (response?.unknown || response?.recordingId === current.recordingId || response?.savingRecordingIds?.includes(current.recordingId)) return current;
    const job = { ...current, state: 'recovery', needsRawSave: true, incomplete: true, revision: current.revision + 1 };
    await storageCall('set', { [jobKey(id)]: job });
    return job;
  });
}
function recoverExecution(id, token, closedTabId) {
  return serializeJob(id, async () => {
    const current = await getJob(id);
    if (!current || current.state !== 'combining' || current.executionToken !== token) return current;
    const tabId = current.executionTabId ?? current.ownerTabId;
    const response = tabId === closedTabId ? null : await executionState(tabId);
    if (response?.unknown || (response?.jobId === id && response?.executionToken === token &&
        response?.documentId === current.executionDocumentId)) return current;
    const job = { ...current, state: 'recovery', needsRawSave: true,
      executionToken: null, executionTabId: null, executionDocumentId: null, revision: current.revision + 1 };
    await storageCall('set', { [jobKey(id)]: job });
    return job;
  });
}
async function mutateJob(message, sender) {
  const id = message.jobId || message.job?.id || message.job?.recordingId;
  if (typeof id !== 'string' || !id || id.length > 180) throw new Error('Recording identity is missing');
  return serializeJob(id, async () => {
    const existing = await getJob(id);
    if (message.action === 'get') return existing;
    if (message.action === 'create') {
      if (existing) return existing;
      const origin = sender.tab?.url ? new URL(sender.tab.url).origin : (message.job.origin || 'https://meet.google.com');
      const job = { ...message.job, id, recordingId: message.job.recordingId || id, origin,
        ownerTabId: sender.tab?.id ?? message.job.ownerTabId ?? null, revision: 1 };
      await storageCall('set', { [jobKey(id)]: job });
      return job;
    }
    if (!existing) throw new Error('Recording job no longer exists');
    if (message.revision !== undefined && message.revision !== existing.revision) throw new Error('Recording job changed; retry the action');
    if (message.action === 'claim') {
      if (!['pending', 'recovery'].includes(existing.state)) throw new Error('Recording is busy or awaiting cleanup');
      if (!Number.isInteger(sender.tab?.id) || sender.tab.id < 0 || !message.executionToken || !message.documentId) throw new Error('Execution owner is missing');
      const job = { ...existing, state: 'combining', executionToken: message.executionToken,
        executionTabId: sender.tab.id, executionDocumentId: message.documentId, revision: existing.revision + 1 };
      await storageCall('set', { [jobKey(id)]: job });
      return job;
    }
    if (message.action === 'release') {
      if (existing.state !== 'combining' || existing.executionToken !== message.executionToken ||
          existing.executionTabId !== sender.tab?.id || existing.executionDocumentId !== message.documentId) return existing;
      const job = { ...existing, state: existing.needsRawSave ? 'recovery' : 'pending',
        executionToken: null, executionTabId: null, executionDocumentId: null, revision: existing.revision + 1 };
      await storageCall('set', { [jobKey(id)]: job });
      return job;
    }
    if (message.action === 'remove') {
      if (existing.state !== 'cleanup') throw new Error('Recording cleanup has not completed');
      await storageCall('remove', jobKey(id));
      return null;
    }
    const changes = message.changes || {};
    if (changes.state === 'combining') throw new Error('Use an owned execution claim');
    if (existing.state === 'combining' && changes.state !== 'cleanup_requested' &&
        (message.executionToken !== existing.executionToken || sender.tab?.id !== existing.executionTabId ||
         message.documentId !== existing.executionDocumentId)) throw new Error('Recording execution belongs to another context');
    if ((existing.state === 'cleanup_requested' || existing.state === 'cleanup') &&
        changes.state && changes.state !== 'cleanup' && changes.state !== 'cleanup_requested') {
      throw new Error('Recording is awaiting cleanup');
    }
    // Identity/source and the durable catalog key cannot be rewritten by a
    // stale caller's snapshot. Revision checks protect the matching job.
    const job = { ...existing, ...changes, id: existing.id, recordingId: existing.recordingId,
      origin: existing.origin, ownerTabId: existing.ownerTabId,
      executionToken: existing.executionToken, executionTabId: existing.executionTabId,
      executionDocumentId: existing.executionDocumentId, revision: existing.revision + 1 };
    await storageCall('set', { [jobKey(id)]: job });
    return job;
  });
}
async function routeJobAction(message) {
  const id = message.jobId || message.job?.id || message.job?.recordingId;
  let job = await getJob(id);
  if (!job) throw new Error('Recording job no longer exists');
  if (message.type === 'DEFER_PENDING_COMBINE') {
    if (['recording', 'preparing', 'combining', 'cleanup', 'cleanup_requested'].includes(job.state)) throw new Error('This recording is busy');
    job = await mutateJob({ action: 'update', jobId: id, revision: job.revision,
      changes: { nextPromptAt: Date.now() + 10 * 60 * 1000 } }, {});
    return { ok: true, job };
  }
  if (message.type === 'CANCEL_PENDING_COMBINE') {
    if (job.state === 'recording' || job.state === 'preparing') throw new Error('Stop the recording before discarding it');
    job = await mutateJob({ action: 'update', jobId: id, changes: { state: 'cleanup_requested', nextPromptAt: 0 } }, {});
  }
  const tabs = await new Promise(resolve => chrome.tabs.query({ url: 'https://meet.google.com/*' }, resolve));
  const candidates = (tabs || []).filter(tab => tab.url && new URL(tab.url).origin === job.origin)
    .sort((a, b) => Number(b.id === (job.executionTabId ?? job.ownerTabId)) - Number(a.id === (job.executionTabId ?? job.ownerTabId)));
  for (const tab of candidates) {
    const response = await new Promise(resolve => chrome.tabs.sendMessage(tab.id, { ...message, jobId: id, job }, result => {
      resolve(chrome.runtime.lastError ? null : result);
    }));
    if (response) return response;
  }
  throw new Error('Open a Google Meet tab to finish recording cleanup; saved data remains recoverable');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (message.type === 'JOB_STORE') {
    (message.action === 'list' ? listJobs().then(jobs => ({ jobs, tabId })) :
      mutateJob(message, sender).then(job => ({ job, tabId })))
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (['RUN_PENDING_COMBINE', 'DEFER_PENDING_COMBINE', 'CANCEL_PENDING_COMBINE'].includes(message.type)) {
    routeJobAction(message).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  // ── Recording state updates FROM content_script ───────────────────────────
  if (message.type === 'RECORDING_STATE_UPDATE') {
    if (!message.state?.isRecording && recordingState.isRecording &&
        (tabId !== recordingState.tabId || message.state?.recordingId !== recordingState.recordingId)) {
      sendResponse({ ok: true });
      return true;
    }
    recordingStateRevision++;
    recordingState = {
      ...recordingState,
      ...message.state,
      tabId: message.state?.isRecording ? tabId ?? recordingState.tabId : null,
      recordingId: message.state?.isRecording ? message.state.recordingId : null,
    };
    // Persist to storage so it survives service worker restarts
    chrome.storage.local.set({ meetRecorderState: recordingState });
    sendResponse({ ok: true });
    return true;
  }

  // ── Popup asks for current recording state (on open) ─────────────────────
  if (message.type === 'GET_RECORDING_STATE') {
    // Try in-memory first, then fall back to storage
    if (recordingState.isRecording) {
      sendResponse(recordingState);
    } else {
      const revision = recordingStateRevision;
      storageCall('get', 'meetRecorderState').then(async data => {
        const stored = data.meetRecorderState || { isRecording: false };
        const live = stored.isRecording ? await executionState(stored.tabId) : null;
        if (revision !== recordingStateRevision) { sendResponse(recordingState); return; }
        if (stored.isRecording && !live?.unknown && live?.recordingId !== stored.recordingId) {
          recordingState = stored;
          retireRecordingState('Recording page is unavailable; committed chunks remain recoverable');
          sendResponse(recordingState);
        } else sendResponse(stored);
      }).catch(() => sendResponse({ isRecording: false }));
      return true; // async
    }
    return true;
  }

  // ── Messages FROM content_script → forward to popup ──────────────────────
  if (message.type === 'STATUS_RESPONSE' && tabId !== undefined) {
    if (recordingState.isRecording && recordingState.tabId === tabId && !message.payload?.isRecording) retireRecordingState('Recording is no longer active in this tab');
    chrome.runtime.sendMessage({ ...message, payload: { ...message.payload, tabId } }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'STATUS' || message.type === 'CHUNK' || message.type === 'AUDIO') {
    if (tabId && message.type === 'STATUS') {
      tabState.set(tabId, message.payload);
    }
    // Broadcast to all extension views (popup)
    chrome.runtime.sendMessage({ ...message, payload: { ...message.payload, tabId: tabId ?? message.payload?.tabId } }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  // ── Messages FROM popup → forward to active Meet tab ─────────────────────
  if (
    message.type === 'START_RECORDING'      ||
    message.type === 'STOP_RECORDING'       ||
    message.type === 'PAUSE_RECORDING'      ||
    message.type === 'RESUME_RECORDING'     ||
    message.type === 'SET_RECORD_MY_MIC'    ||
    message.type === 'SET_MUTE'             ||
    message.type === 'SET_RECORD_CHOSEN_ONLY' ||
    message.type === 'SET_CHOSEN_SPEAKERS'  ||
    message.type === 'FORCE_NO_SCREEN_SHARE' ||
    message.type === 'SET_AUDIO_TRACKS'     ||
    message.type === 'SET_VIP_LIST'         ||
    message.type === 'SET_VIPS_ENABLED'     ||
    message.type === 'GET_STATUS'           ||
    message.type === 'FORCE_REINJECT'       ||
    message.type === 'RUN_PENDING_COMBINE'  ||
    message.type === 'DEFER_PENDING_COMBINE' ||
    message.type === 'CANCEL_PENDING_COMBINE'
  ) {
    let responded = false;
    const respondOnce = (payload) => {
      if (responded) return;
      responded = true;
      sendResponse(payload);
    };

    const injectContentScripts = (targetTabId, callback) => {
      if (!targetTabId || !chrome.scripting?.executeScript) {
        callback?.({ ok: false, error: 'Cannot inject into this tab' });
        return;
      }
      chrome.scripting.executeScript(
        {
          target: { tabId: targetTabId },
          files: ['webm_metadata.js', 'muxer.js', 'content_script.js'],
        },
        () => {
          if (chrome.runtime.lastError) {
            callback?.({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          callback?.({ ok: true });
        }
      );
    };

    const sendToTabId = (targetTabId, onFailure) => {
      if (!targetTabId) {
        if (onFailure) onFailure();
        return;
      }
      if (message.type === 'FORCE_REINJECT') {
        injectContentScripts(targetTabId, (injectResult) => {
          if (!injectResult?.ok) {
            respondOnce(injectResult);
            return;
          }
          chrome.tabs.sendMessage(targetTabId, message, (resp) => {
            if (chrome.runtime.lastError) {
              respondOnce({ ok: false, error: chrome.runtime.lastError.message });
              return;
            }
            respondOnce(resp || { ok: true });
          });
        });
        return;
      }
      chrome.tabs.sendMessage(targetTabId, message, (resp) => {
        if (chrome.runtime.lastError) {
          if (onFailure) onFailure();
          else respondOnce({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        respondOnce(resp || { ok: true });
      });
    };

    if (Number.isInteger(message.targetTabId) && ['STOP_RECORDING', 'PAUSE_RECORDING', 'RESUME_RECORDING'].includes(message.type)) {
      sendToTabId(message.targetTabId);
      return true;
    }
    if (message.type === 'START_RECORDING') {
      if (message.consentAcknowledged !== true) {
        respondOnce({ ok: false, error: 'Confirm host and participant permission before recording' });
        return true;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        const tab = tabs?.[0];
        if (!tab || !isMeetUrl(tab.url)) respondOnce({ ok: false, error: 'Recording is available only on the active Google Meet website' });
        else sendToTabId(tab.id);
      });
      return true;
    }
    if (recordingState.isRecording && recordingState.tabId) {
      sendToTabId(recordingState.tabId, () => respondOnce({ ok: false, error: 'Recording tab is unavailable; reopen Meet to recover saved chunks' }));
      return true;
    }

    chrome.tabs.query({ url: 'https://meet.google.com/*', active: true }, (tabs) => {
      const target = tabs?.[0];
      if (target) {
        sendToTabId(target.id, () => {
          chrome.tabs.query({ url: 'https://meet.google.com/*' }, (allTabs) => {
            if (!allTabs?.length) {
              respondOnce({ ok: false, error: 'No Google Meet tab found' });
              return;
            }
            sendToTabId(allTabs[0].id);
          });
        });
        return;
      }

      // Try any Meet tab
      chrome.tabs.query({ url: 'https://meet.google.com/*' }, (allTabs) => {
        if (!allTabs?.length) {
          respondOnce({ ok: false, error: 'No Google Meet tab found' });
          return;
        }
        sendToTabId(allTabs[0].id);
      });
    });
    return true; // async
  }
});

// ── Clear state when service worker restarts: reload from storage ─────────────
const startupStateRevision = recordingStateRevision;
chrome.storage.local.get('meetRecorderState', async data => {
  const stored = data.meetRecorderState;
  if (!stored) return;
  const live = stored.isRecording ? await executionState(stored.tabId) : null;
  if (startupStateRevision !== recordingStateRevision) return;
  recordingState = stored;
  if (stored.isRecording && !live?.unknown && live?.recordingId !== stored.recordingId) {
    retireRecordingState('Recording page is unavailable; committed chunks remain recoverable');
  } else recordingStateRevision++;
});

// Clean up state when tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  // Each popup can follow a different recording from the singleton restore
  // state, so its selected tab's closure must be reported independently.
  chrome.runtime.sendMessage({ type: 'TAB_CLOSED', payload: { tabId } }).catch(() => {});
  listJobs().then(async jobs => {
    for (const job of jobs.filter(job => job.state === 'combining' && job.executionTabId === tabId)) {
      await recoverExecution(job.id, job.executionToken, tabId).catch(() => {});
    }
    for (const job of jobs.filter(job => job.ownerTabId === tabId && ['recording', 'preparing'].includes(job.state))) {
      await mutateJob({ action: 'update', jobId: job.id, revision: job.revision,
        changes: { state: 'recovery', needsRawSave: true } }, {}).catch(() => {});
    }
  }).catch(() => {});
  if (recordingState.tabId === tabId) {
    retireRecordingState();
  }
});

console.log('[MeetRecorder] background service worker started ✓');
listJobs().catch(() => {});

// Eligibility is per tab; the inactive action default covers new/unknown tabs.
function isMeetUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'meet.google.com' && !url.port; }
  catch (_) { return false; }
}
function updateAction(tabId, url) {
  if (!chrome.action || !Number.isInteger(tabId)) return;
  const eligible = isMeetUrl(url), path = {};
  for (const size of [16, 48, 128]) path[size] = `icons/icon${size}${eligible ? '' : '-inactive'}.png`;
  Promise.resolve(chrome.action.setIcon({ tabId, path })).catch(() => {});
  Promise.resolve(chrome.action.setTitle({ tabId, title: eligible ? 'Meet Budy — Google Meet recording' : 'Meet Budy — unavailable on this website' })).catch(() => {});
}
chrome.tabs.query({}, tabs => { for (const tab of tabs || []) updateAction(tab.id, tab.url); });
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url || change.status === 'loading') updateAction(tabId, change.url || tab.url);
  if (change.status === 'loading' && recordingState.tabId === tabId) retireRecordingState('Recording page changed; saved data remains recoverable');
});
chrome.tabs.onActivated.addListener(({ tabId }) => { chrome.tabs.get(tabId, tab => {
  if (!chrome.runtime.lastError && tab) updateAction(tabId, tab.url);
}); });
