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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  // ── Recording state updates FROM content_script ───────────────────────────
  if (message.type === 'RECORDING_STATE_UPDATE') {
    recordingState = {
      ...recordingState,
      ...message.state,
      tabId: message.state?.isRecording ? tabId ?? recordingState.tabId : null,
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
      chrome.storage.local.get('meetRecorderState', (data) => {
        sendResponse(data.meetRecorderState || { isRecording: false });
      });
      return true; // async
    }
    return true;
  }

  // ── Messages FROM content_script → forward to popup ──────────────────────
  if (message.type === 'STATUS' || message.type === 'CHUNK' || message.type === 'AUDIO') {
    if (tabId && message.type === 'STATUS') {
      tabState.set(tabId, message.payload);
    }
    // Broadcast to all extension views (popup)
    chrome.runtime.sendMessage(message).catch(() => {});
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
          files: ['muxer.js', 'content_script.js'],
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

    if (recordingState.isRecording && recordingState.tabId) {
      sendToTabId(recordingState.tabId, () => {
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

          chrome.tabs.query({ url: 'https://meet.google.com/*' }, (allTabs) => {
            if (!allTabs?.length) {
              respondOnce({ ok: false, error: 'No Google Meet tab found' });
              return;
            }
            sendToTabId(allTabs[0].id);
          });
        });
      });
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
chrome.storage.local.get('meetRecorderState', (data) => {
  if (data.meetRecorderState) {
    recordingState = data.meetRecorderState;
  }
});

// Clean up state when tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  if (recordingState.tabId === tabId) {
    recordingState = { ...recordingState, tabId: null };
    chrome.storage.local.set({ meetRecorderState: recordingState });
  }
});

console.log('[MeetRecorder] background service worker started ✓');
