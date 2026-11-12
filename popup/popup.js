/**
 * popup.js — UI logic for Meet Budy v1.0.0.
 * Manages recording state, timer, custom audio tracks, VIP selection, and toggles.
 */
(function () {
  'use strict';

  // ─── DOM refs ────────────────────────────────────────────────────────────
  const consentAcknowledged = document.getElementById('consentAcknowledged');
  const btnRecord          = document.getElementById('btnRecord');
  const btnPause           = document.getElementById('btnPause');
  const svgPause           = document.getElementById('svgPause');
  const svgResume          = document.getElementById('svgResume');
  const btnStatus          = document.getElementById('btnStatus');
  const modalCombine       = document.getElementById('modalCombine');
  const combinePromptText  = document.getElementById('combinePromptText');
  const btnCombineNow      = document.getElementById('btnCombineNow');
  const btnCombineLater    = document.getElementById('btnCombineLater');
  const btnCombineNever    = document.getElementById('btnCombineNever');
  const timerDisplay       = document.getElementById('timerDisplay');
  
  const statStream         = document.getElementById('statStream');
  const statVoices         = document.getElementById('statVoices');
  const statVips           = document.getElementById('statVips');
  
  const linkSettings       = document.getElementById('linkSettings');
  const linkLogs           = document.getElementById('linkLogs');
  const panelSettings      = document.getElementById('panelSettings');
  const panelLogs          = document.getElementById('panelLogs');
  
  const toggleAdvanceMode  = document.getElementById('toggleAdvanceMode');
  const btnReinject        = document.getElementById('btnReinject');
  const logContainer       = document.getElementById('logContainer');
  const logClear           = document.getElementById('logClear');
  const statusMsg          = document.getElementById('statusMsg');

  // Big grid cards & switches
  const cardMyMic          = document.getElementById('cardMyMic');
  const cardVoices         = document.getElementById('cardVoices');
  const cardVips           = document.getElementById('cardVips');
  const cardStreams        = document.getElementById('cardStreams');
  
  const toggleMyMic        = document.getElementById('toggleMyMic');
  const toggleVoices       = document.getElementById('toggleVoices');
  const toggleVips         = document.getElementById('toggleVips');
  const toggleStreams      = document.getElementById('toggleStreams');

  // Accordions
  const accordionAudio     = document.getElementById('accordionAudio');
  const accordionVips      = document.getElementById('accordionVips');
  const headerAudio        = document.getElementById('headerAudio');
  const headerVips        = document.getElementById('headerVips');
  const btnAddTrack        = document.getElementById('btnAddTrack');
  const btnAddVip          = document.getElementById('btnAddVip');
  
  const trackList          = document.getElementById('trackList');
  const vipList            = document.getElementById('vipList');

  // Modals
  const modalTrack         = document.getElementById('modalTrack');
  const modalTrackTitle    = document.getElementById('modalTrackTitle');
  const modalTrackList     = document.getElementById('modalTrackList');
  const btnDeleteTrack     = document.getElementById('btnDeleteTrack');
  const btnCancelTrack     = document.getElementById('btnCancelTrack');
  
  const modalVip           = document.getElementById('modalVip');
  const modalVipList       = document.getElementById('modalVipList');
  const btnCancelVip       = document.getElementById('btnCancelVip');
  const PENDING_COMBINE_KEY = 'meetBudyPendingCombine:';
  const pendingRecordingSelect = document.getElementById('pendingRecordingSelect');

  // ─── Constants ───────────────────────────────────────────────────────────
  const X_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  // ─── State ───────────────────────────────────────────────────────────────
  let siteAvailable = true;
  let isRecording     = false;
  let activeRecordingId = null;
  let activeRecordingContextId = null;
  let activeRecordingTabId = null;
  let isPausedState   = false;
  let hasScreenShare  = false;
  let audioSourcesCount = 0;
  let timerInterval   = null;
  let startTime       = null;
  let totalChunks     = 0;
  let sizeMB          = '0.0';
  
  let audioTracks     = [{ id: 1, name: 'EVERYONE', targets: ['EVERYONE'] }];
  let vips            = [];
  let activeParticipants = []; // resolved list of participants in call: [{ name, avatarUrl }]
  let currentEditingTrackId = null;
  let pendingCombineJob = null;
  let pendingCombineTimer = null;
  let pendingCombineJobs = [];
  let pendingJobsLoad = 0;

  // ─── Track helpers ───────────────────────────────────────────────────────
  function renumberTracks() {
    audioTracks.forEach((t, i) => { t.id = i + 1; });
  }

  // ─── Timer ───────────────────────────────────────────────────────────────
  function formatTime(ms) {
    const s  = Math.floor(Math.max(0, ms) / 1000);
    const h  = Math.floor(s / 3600);
    const m  = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return [h, m, ss].map(n => String(n).padStart(2, '0')).join(':');
  }

  function startTimer(fromTimestamp = null) {
    startTime = fromTimestamp || Date.now();
    if (timerInterval) clearInterval(timerInterval);
    timerDisplay.textContent = formatTime(Date.now() - startTime);
    timerInterval = setInterval(() => {
      timerDisplay.textContent = formatTime(Date.now() - startTime);
    }, 500);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function resetTimer() {
    stopTimer();
    startTime = null;
    timerDisplay.textContent = '00:00:00';
  }

  // ─── Logs & Messages ──────────────────────────────────────────────────────
  function addLog(text, level = 'info') {
    if (!logContainer) return;
    const logDiv = document.createElement('div');
    let color = 'var(--text-muted)';
    if (level === 'error') color = 'var(--red)';
    else if (level === 'warn') color = 'var(--amber)';
    else if (level === 'success') color = 'var(--green)';
    else if (level === 'info') color = '#b892ff';

    const timeStr = new Date().toTimeString().split(' ')[0];
    logDiv.style.color = color;
    logDiv.style.wordBreak = 'break-all';
    logDiv.textContent = `[${timeStr}] ${text}`;
    logContainer.appendChild(logDiv);

    while (logContainer.children.length > 30) {
      logContainer.removeChild(logContainer.firstChild);
    }
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  function setMsg(text, type = '') {
    statusMsg.textContent = text;
    statusMsg.className = `status-msg${type ? ' ' + type : ''}`;
    let logLevel = 'info';
    if (type === 'error') logLevel = 'error';
    else if (type === 'success') logLevel = 'success';
    addLog(text, logLevel);
  }

  function clearPendingCombineTimer() {
    if (pendingCombineTimer) {
      clearTimeout(pendingCombineTimer);
      pendingCombineTimer = null;
    }
  }

  function showCombinePrompt(job, text) {
    pendingCombineJob = job || pendingCombineJob;
    if (!modalCombine || !pendingCombineJob) return;
    const cleanup = ['cleanup', 'cleanup_requested'].includes(pendingCombineJob.state);
    const busy = pendingCombineJob.state === 'combining';
    const recovery = !!pendingCombineJob.needsRawSave;
    if (combinePromptText) combinePromptText.textContent = cleanup
      ? 'Recording cleanup is pending. Retry to finish removing its saved copy.'
      : busy ? 'This recording is being combined. You can cancel it and keep the raw files.'
      : recovery ? ((pendingCombineJob.writeFailed || pendingCombineJob.incomplete)
        ? 'Some recording data failed to save. Recover the saved portion or discard it; the file may be incomplete.'
        : 'A saved recording can be recovered. Save it now or discard its saved data.')
      : (text || 'Combined encoding is ready. Do you want to run it now?');
    if (btnCombineNow) { btnCombineNow.textContent = cleanup ? 'Retry cleanup' : recovery ? 'Save recording' : 'Do it'; btnCombineNow.disabled = busy; }
    if (btnCombineLater) btnCombineLater.disabled = cleanup || busy;
    if (btnCombineNever) btnCombineNever.textContent = recovery ? 'Discard recording' : 'Keep raw files';
    modalCombine.classList.add('visible');
  }
  function hideCombinePrompt() { modalCombine?.classList.remove('visible'); }
  function scheduleCombineReminder(job, delayMs = 10 * 60 * 1000) {
    clearPendingCombineTimer();
    pendingCombineTimer = setTimeout(() => {
      pendingCombineTimer = null;
      loadPendingCombineFromStorage();
    }, delayMs);
  }
  function loadPendingCombineFromStorage() {
    const generation = ++pendingJobsLoad;
    chrome.runtime.sendMessage({ type: 'JOB_STORE', action: 'list' }, response => {
      if (chrome.runtime.lastError || !response?.ok || generation !== pendingJobsLoad) return;
      pendingCombineJobs = (response.jobs || []).filter(job => !['preparing', 'recording'].includes(job.state));
      pendingCombineJobs.sort((a, b) => (a.nextPromptAt || 0) - (b.nextPromptAt || 0) || a.createdAt - b.createdAt);
      const selected = pendingCombineJobs.find(job => job.id === pendingCombineJob?.id);
      const isDue = job => ['cleanup', 'cleanup_requested', 'combining'].includes(job.state) || !job.nextPromptAt || job.nextPromptAt <= Date.now();
      const due = pendingCombineJobs.find(isDue);
      pendingCombineJob = selected && isDue(selected) ? selected : due || selected || pendingCombineJobs[0] || null;
      clearPendingCombineTimer();
      if (pendingRecordingSelect) {
        pendingRecordingSelect.innerHTML = '';
        for (const job of pendingCombineJobs) {
          const option = document.createElement('option');
          option.value = job.id;
          option.textContent = new Date(job.createdAt || Date.now()).toLocaleString() + (job.needsRawSave ? ' — recovery' : ' — combined file');
          pendingRecordingSelect.appendChild(option);
        }
        pendingRecordingSelect.value = pendingCombineJob?.id || '';
        pendingRecordingSelect.style.display = pendingCombineJobs.length > 1 ? '' : 'none';
      }
      if (!pendingCombineJob) { hideCombinePrompt(); return; }
      const delay = Math.max(0, (pendingCombineJob.nextPromptAt || 0) - Date.now());
      if (delay && !['cleanup', 'cleanup_requested', 'combining'].includes(pendingCombineJob.state)) {
        const earliest = pendingCombineJobs[0];
        hideCombinePrompt(); scheduleCombineReminder(earliest, Math.max(0, (earliest.nextPromptAt || 0) - Date.now()));
      } else showCombinePrompt(pendingCombineJob);
    });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some(key => key.startsWith(PENDING_COMBINE_KEY) || key === 'meetBudyPendingCombine')) loadPendingCombineFromStorage();
  });

  // ─── Accordion Toggles ───────────────────────────────────────────────────
  function initAccordions() {
    headerAudio.addEventListener('click', (e) => {
      if (e.target.closest('#btnAddTrack')) return;
      accordionAudio.classList.toggle('collapsed');
    });

    headerVips.addEventListener('click', (e) => {
      if (e.target.closest('#btnAddVip')) return;
      accordionVips.classList.toggle('collapsed');
    });
  }

  // ─── UI Rendering (Pills) ────────────────────────────────────────────────
  function renderAudioTracks() {
    trackList.innerHTML = '';
    if (audioTracks.length === 0) {
      trackList.innerHTML = '<div class="empty-state">No audio tracks. Tap + to add one.</div>';
      return;
    }
    audioTracks.forEach((track, index) => {
      const pill = document.createElement('div');
      pill.className = 'track-pill' + (index % 2 === 1 ? ' alt-layout' : '');

      const badge = document.createElement('span');
      badge.className = 'pill-badge';
      badge.innerHTML = `<span class="badge-num">${track.id}</span><span class="badge-x">${X_SVG}</span>`;
      badge.title = 'Click to remove track';
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        if (audioTracks.length <= 1) {
          addLog('At least one track is required.', 'warn');
          return;
        }
        audioTracks = audioTracks.filter(t => t.id !== track.id);
        renumberTracks();
        saveState();
        renderAudioTracks();
        syncTracksWithTab();
        addLog(`Removed track: ${track.name}`, 'info');
      });

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = track.name;

      pill.appendChild(badge);
      pill.appendChild(name);
      pill.addEventListener('click', () => openTrackSettings(track.id));
      trackList.appendChild(pill);
    });
  }

  function renderVipsList() {
    vipList.innerHTML = '';
    
    // Read cached participants list to fetch avatars if available
    const participantMap = new Map();
    activeParticipants.forEach(p => participantMap.set(p.name, p.avatarUrl));

    if (vips.length === 0) {
      statVips.textContent = 0;
      vipList.innerHTML = '<div class="empty-state">No VIPs yet. Tap + to add.</div>';
      return;
    }

    vips.forEach((vipName, index) => {
      const pill = document.createElement('div');
      const avatarUrl = participantMap.get(vipName);
      pill.className = 'vip-pill' + (index % 2 === 1 ? ' alt-layout' : '');

      const badge = document.createElement('span');
      badge.className = 'pill-badge with-avatar';
      const initial = vipName.charAt(0).toUpperCase();
      const avatarInner = avatarUrl
        ? `<img src="${avatarUrl}" alt="${vipName}" />`
        : `<span class="badge-num">${initial}</span>`;
      badge.innerHTML = `${avatarInner}<span class="badge-x">${X_SVG}</span>`;
      badge.title = 'Click to remove VIP';
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        vips = vips.filter(n => n !== vipName);
        saveState();
        renderVipsList();
        syncVipsWithTab();
        addLog(`Removed VIP: ${vipName}`, 'info');
      });

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = vipName;

      pill.appendChild(badge);
      pill.appendChild(name);
      vipList.appendChild(pill);
    });
    statVips.textContent = vips.length;
  }

  // ─── Dialogs / Modals ────────────────────────────────────────────────────
  function openTrackSettings(trackId) {
    currentEditingTrackId = trackId;
    const track = audioTracks.find(t => t.id === trackId);
    if (!track) return;
    
    modalTrackTitle.textContent = `Edit Audio Track ${trackId}`;
    btnDeleteTrack.style.display = audioTracks.length > 1 ? 'inline-block' : 'none';
    
    modalTrackList.innerHTML = '';
    
    // 1. Add standard roles
    const roles = [
      { key: 'EVERYONE', label: 'EVERYONE (All Voices)' },
      { key: 'VIP_ONLY', label: 'VIP ONLY (VIP voices only)' },
      { key: 'ME', label: 'ME (Your mic only)' }
    ];
    
    roles.forEach(role => {
      createModalCheckbox(modalTrackList, role.label, track.targets.includes(role.key), (checked) => {
        if (checked) {
          if (!track.targets.includes(role.key)) track.targets.push(role.key);
        } else {
          track.targets = track.targets.filter(t => t !== role.key);
        }
        updateTrackName(track);
        saveState();
        renderAudioTracks();
        syncTracksWithTab();
      });
    });

    // Divider
    if (activeParticipants.length > 0) {
      const hr = document.createElement('div');
      hr.style.cssText = 'height: 1px; background: rgba(255,255,255,0.05); margin: 6px 0;';
      modalTrackList.appendChild(hr);
    }
    
    // 2. Add active call participants list
    activeParticipants.forEach(p => {
      const isChecked = track.targets.includes(p.name);
      createModalCheckbox(modalTrackList, p.name, isChecked, (checked) => {
        if (checked) {
          if (!track.targets.includes(p.name)) track.targets.push(p.name);
        } else {
          track.targets = track.targets.filter(t => t !== p.name);
        }
        updateTrackName(track);
        saveState();
        renderAudioTracks();
        syncTracksWithTab();
      });
    });
    
    modalTrack.classList.add('visible');
  }

  function updateTrackName(track) {
    if (track.targets.includes('EVERYONE')) {
      track.name = 'EVERYONE';
    } else if (track.targets.includes('ME') && track.targets.length === 1) {
      track.name = 'ME';
    } else if (track.targets.includes('VIP_ONLY') && track.targets.length === 1) {
      track.name = 'VIP ONLY';
    } else if (track.targets.length === 0) {
      track.name = 'MUTED';
    } else {
      // Create a concatenated name
      const names = track.targets.map(t => {
        if (t === 'VIP_ONLY') return 'VIPs';
        if (t === 'ME') return 'ME';
        return t.split(' ')[0]; // first name
      });
      track.name = names.join(' + ');
      if (track.name.length > 18) {
        track.name = track.name.slice(0, 15) + '...';
      }
    }
  }

  function createModalCheckbox(container, labelText, isChecked, onChange) {
    const item = document.createElement('label');
    item.className = 'modal-item';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = labelText;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isChecked;
    checkbox.addEventListener('change', () => onChange(checkbox.checked));

    item.appendChild(label);
    item.appendChild(checkbox);
    container.appendChild(item);
  }

  function openVipSelection() {
    modalVipList.innerHTML = '';
    
    if (activeParticipants.length === 0) {
      modalVipList.innerHTML = '<div style="font-size: 10px; color: var(--text-dim); text-align: center; padding: 12px 0;">No participants detected in this call yet.</div>';
    } else {
      activeParticipants.forEach(p => {
        const isChecked = vips.includes(p.name);
        createModalCheckbox(modalVipList, p.name, isChecked, (checked) => {
          if (checked) {
            if (!vips.includes(p.name)) vips.push(p.name);
          } else {
            vips = vips.filter(name => name !== p.name);
          }
          saveState();
          renderVipsList();
          syncVipsWithTab();
        });
      });
    }
    modalVip.classList.add('visible');
  }

  // ─── Toggles & Card Border Sync ──────────────────────────────────────────
  function syncCardStyles() {
    cardMyMic.classList.toggle('active', toggleMyMic.checked);
    cardVoices.classList.toggle('active', toggleVoices.checked);
    cardVips.classList.toggle('active', toggleVips.checked);
    cardStreams.classList.toggle('active', toggleStreams.checked);
    
    // VOICEs dependency
    if (toggleVoices.checked) {
      accordionAudio.classList.remove('disabled-panel');
    } else {
      accordionAudio.classList.add('disabled-panel');
    }
    
    // VIPs dependency
    if (toggleVips.checked) {
      accordionVips.classList.remove('disabled-panel');
    } else {
      accordionVips.classList.add('disabled-panel');
    }
  }

  function handleToggleChange(type, input) {
    syncCardStyles();
    saveState(); // Persist every toggle change immediately
    
    let messageType = '';
    let payload = {};

    switch (type) {
      case 'MY_MIC':
        messageType = 'SET_RECORD_MY_MIC';
        payload = { enabled: input.checked };
        break;
      case 'VOICES':
        messageType = 'SET_MUTE'; // inverted logic: checked = NOT muted
        payload = { mute: !input.checked };
        break;
      case 'STREAMS':
        messageType = 'FORCE_NO_SCREEN_SHARE'; // inverted logic: checked = screen sharing allowed
        payload = { enabled: !input.checked };
        break;
      case 'VIPS':
        messageType = 'SET_VIPS_ENABLED';
        payload = { enabled: input.checked };
        break;
    }

    if (messageType) {
      chrome.runtime.sendMessage({ type: messageType, ...payload });
      addLog(`${type} toggled: ${input.checked}`, 'info');
    }
  }

  // ─── State Persistence ───────────────────────────────────────────────────
  function saveState() {
    chrome.storage.local.set({
      meetBudyTracks:        audioTracks,
      meetBudyVips:          vips,
      meetBudyAdvanceMode:   toggleAdvanceMode.checked,
      // Save all 4 toggle states so they survive popup close/reopen
      meetBudyToggleMyMic:   toggleMyMic.checked,
      meetBudyToggleVoices:  toggleVoices.checked,
      meetBudyToggleVips:    toggleVips.checked,
      meetBudyToggleStreams:  toggleStreams.checked,
    });
  }

  function loadState(callback) {
    const KEYS = [
      'meetBudyTracks', 'meetBudyVips', 'meetBudyAdvanceMode',
      'meetBudyToggleMyMic', 'meetBudyToggleVoices',
      'meetBudyToggleVips',  'meetBudyToggleStreams',
    ];
    chrome.storage.local.get(KEYS, (data) => {
      if (data.meetBudyTracks) audioTracks = data.meetBudyTracks;
      if (data.meetBudyVips)   vips         = data.meetBudyVips;
      if (toggleAdvanceMode && data.meetBudyAdvanceMode !== undefined) {
        toggleAdvanceMode.checked = data.meetBudyAdvanceMode;
      }

      // ── Restore toggle states; Voices & Streams default to ON ──────────
      toggleMyMic.checked   = data.meetBudyToggleMyMic  ?? false;
      toggleVoices.checked  = data.meetBudyToggleVoices  !== undefined ? data.meetBudyToggleVoices  : true;
      toggleVips.checked    = data.meetBudyToggleVips    ?? false;
      toggleStreams.checked  = data.meetBudyToggleStreams  !== undefined ? data.meetBudyToggleStreams  : true;

      // ── Apply card/accordion states IMMEDIATELY (fixes timing bug) ─────
      // Without this, accordions remain clickable until the async GET_STATUS
      // response arrives, even though the stored toggle says disabled.
      syncCardStyles();

      if (callback) callback();
    });
  }

  function syncTracksWithTab() {
    chrome.runtime.sendMessage({ type: 'SET_AUDIO_TRACKS', list: audioTracks });
  }

  function syncVipsWithTab() {
    chrome.runtime.sendMessage({ type: 'SET_VIP_LIST', list: vips });
  }

  // ─── Recording UI Updates ───────────────────────────────────────────────
  function enterRecordingUI(existingStartTime = null) {
    isRecording = true;
    btnRecord.className = 'btn-record-circle recording';
    btnRecord.title = 'Stop Recording';
    btnRecord.removeAttribute('disabled');
    btnPause.removeAttribute('disabled');
    
    if (isPausedState) {
      svgPause.style.display = 'none';
      svgResume.style.display = 'block';
      stopTimer();
    } else {
      svgPause.style.display = 'block';
      svgResume.style.display = 'none';
      startTimer(existingStartTime);
    }
  }

  function exitRecordingUI() {
    isRecording = false;
    activeRecordingId = null;
    activeRecordingContextId = null;
    activeRecordingTabId = null;
    isPausedState = false;
    btnRecord.className = 'btn-record-circle idle';
    btnRecord.title = 'Start Recording';
    btnPause.setAttribute('disabled', 'true');
    svgPause.style.display = 'block';
    svgResume.style.display = 'none';
    stopTimer();
  }

  function setIsPausedUI(paused) {
    isPausedState = paused;
    if (paused) {
      svgPause.style.display = 'none';
      svgResume.style.display = 'block';
      stopTimer();
      setMsg('Recording is PAUSED.', 'info');
    } else {
      svgPause.style.display = 'block';
      svgResume.style.display = 'none';
      if (isRecording) {
        startTimer(startTime);
        setMsg('Recording is active.', 'info');
      }
    }
  }

  // ─── Message Listener (Relay from Tab) ──────────────────────────────────
  function belongsToActiveRecording(payload) {
    if (!isRecording) return true;
    if (payload?.recordingId && activeRecordingId && payload.recordingId !== activeRecordingId) return false;
    if (payload?.contextId && activeRecordingContextId && payload.contextId !== activeRecordingContextId) return false;
    return true;
  }
  chrome.runtime.onMessage.addListener((message) => {
    const { type, payload } = message;

    if (type === 'STATUS') {
      handleStatus(payload);
    } else if (type === 'TAB_CLOSED') {
      if (isRecording && payload?.tabId === activeRecordingTabId) {
        exitRecordingUI();
        resetTimer();
        btnRecord.removeAttribute('disabled');
        setMsg('Recording tab closed.', 'info');
      }
    } else if (type === 'LOG') {
      addLog(payload.text, payload.level || 'info');
    } else if (type === 'CHUNK') {
      if (!belongsToActiveRecording(payload)) return;
      totalChunks = payload.count;
      sizeMB = payload.totalMB;
      setMsg(`Recording • ${payload.count} chunks (${payload.totalMB} MB)`, 'info');
    } else if (type === 'AUDIO') {
      if (!belongsToActiveRecording(payload)) return;
      audioSourcesCount = payload.sources;
      statVoices.textContent = payload.sources;
      addLog(`Audio sources updated: ${payload.sources}`, 'info');
    } else if (type === 'STATUS_RESPONSE') {
      if (isRecording && payload.tabId !== null && payload.tabId !== undefined && payload.tabId === activeRecordingTabId) {
        if (!payload.isRecording) {
          exitRecordingUI(); resetTimer(); btnRecord.removeAttribute('disabled'); return;
        }
        activeRecordingContextId = payload.contextId || activeRecordingContextId;
      }
      if (!belongsToActiveRecording(payload)) return;
      // Stream detection stats
      hasScreenShare = !!payload.hasScreenShare;
      statStream.textContent = payload.hasScreenShare ? '1' : '0';
      statVoices.textContent = payload.audioSources;

      // Sync active participants
      activeParticipants = payload.participants || [];
      renderVipsList(); // re-render to check avatars

      // Update checkboxes state from live tab
      toggleMyMic.checked   = !!payload.recordMyMic;
      toggleVoices.checked  = !payload.isRecordingMuted;   // inverted
      toggleStreams.checked  = !payload.forceNoScreenShare; // inverted
      toggleVips.checked    = !!payload.vipsEnabled;
      
      syncCardStyles();
      saveState(); // Persist tab-reported state so next popup open is instant

      if (payload.isRecording) {
        activeRecordingId = payload.recordingId || activeRecordingId;
        activeRecordingContextId = payload.contextId || activeRecordingContextId;
        activeRecordingTabId = payload.tabId ?? activeRecordingTabId;
        isPausedState = !!payload.isPaused;
        enterRecordingUI(startTime);
        setIsPausedUI(isPausedState);
      }
    } else if (type === 'PENDING_COMBINE') {
      loadPendingCombineFromStorage();
    }
  });

  function handleStatus(payload) {
    if (!payload) return;
    const { state, message, data } = payload;
    if (payload.scope === 'job') {
      if (state === 'combine_pending') loadPendingCombineFromStorage();
      if (isRecording) addLog(message || 'Saved recording updated', state === 'error' ? 'error' : 'info');
      else setMsg(message || 'Saved recording updated', state === 'error' ? 'error' : 'info');
      return;
    }
    if (!belongsToActiveRecording(payload)) return;
    if (isRecording && payload.scope === 'page' && state === 'error') {
      setMsg(message || 'Recorder reported an error', 'error');
      return; // Only a terminal recording event retires live recorder controls.
    }

    switch (state) {
      case 'activity_countdown':
      case 'activity_restored':
        setMsg(message, 'info');
        break;

      case 'metadata_warning':
        setMsg(message, 'error');
        break;

      case 'ready':
        if (!isRecording) setMsg(siteAvailable ? 'Ready to record.' : 'Recording is available only on Google Meet. Open meet.google.com to start.', 'info');
        break;

      case 'screen_detected':
        hasScreenShare = true;
        statStream.textContent = '1';
        setMsg(`🖥️ Screen share detected — ready to record!`, 'success');
        break;

      case 'screen_ended':
        hasScreenShare = false;
        statStream.textContent = '0';
        setMsg('Screen share ended.', '');
        break;

      case 'recording':
        activeRecordingId = payload.recordingId || activeRecordingId;
        activeRecordingContextId = payload.contextId || activeRecordingContextId;
        activeRecordingTabId = payload.tabId ?? activeRecordingTabId;
        isPausedState = false;
        enterRecordingUI(payload.startTime || null);
        setIsPausedUI(false);
        setMsg(`Recording started.`, 'success');
        break;

      case 'paused':
        activeRecordingId = payload.recordingId || activeRecordingId;
        activeRecordingContextId = payload.contextId || activeRecordingContextId;
        activeRecordingTabId = payload.tabId ?? activeRecordingTabId;
        isPausedState = true;
        enterRecordingUI(payload.startTime || null);
        setIsPausedUI(true);
        break;

      case 'stopped':
        exitRecordingUI();
        resetTimer();
        btnRecord.removeAttribute('disabled');
        setMsg(message || 'Recording stopped; saving output…', 'info');
        break;

      case 'stopping':
      case 'assembling':
        stopTimer();
        btnRecord.setAttribute('disabled', 'true');
        btnPause.setAttribute('disabled', 'true');
        setMsg('⏳ Assembling recording file…', 'info');
        break;

      case 'downloaded':
        exitRecordingUI();
        resetTimer();
        btnRecord.removeAttribute('disabled');
        btnPause.setAttribute('disabled', 'true');
        setMsg(`✅ Saved: ${payload.filename} (${payload.sizeMB} MB)`, 'success');
        break;

      case 'combine_pending':
        loadPendingCombineFromStorage();
        setMsg('Combined encoding pending.', 'info');
        break;

      case 'aborted':
        exitRecordingUI();
        resetTimer();
        btnRecord.removeAttribute('disabled');
        btnPause.setAttribute('disabled', 'true');
        setMsg(message || 'Recording reset.', 'warn');
        break;

      case 'error':
        setMsg(`❌ ${message || payload.message}`, 'error');
        if (isRecording) exitRecordingUI();
        resetTimer();
        btnRecord.removeAttribute('disabled');
        break;
    }
  }

  // ─── Button Events & Listeners ───────────────────────────────────────────
  function initButtonListeners() {
    // Record button (idle = start, recording = stop)
    btnRecord.addEventListener('click', () => {
      if (isRecording) {
        // Stop recording
        btnRecord.setAttribute('disabled', 'true');
        btnPause.setAttribute('disabled', 'true');
        setMsg('Stopping recording…', 'info');
        chrome.runtime.sendMessage({ type: 'STOP_RECORDING', targetTabId: activeRecordingTabId,
          recordingId: activeRecordingId, contextId: activeRecordingContextId }, (resp) => {
          if (chrome.runtime.lastError || !resp?.ok) {
            setMsg('❌ Could not reach Meet tab.', 'error');
            btnRecord.removeAttribute('disabled');
          }
        });
      } else {
        // Start recording
        if (!siteAvailable) { setMsg('Recording is available only on the active Google Meet website.', 'error'); return; }
        btnRecord.setAttribute('disabled', 'true');
        setMsg('Starting recording…', 'info');
        syncTracksWithTab(); // send final tracks config
        syncVipsWithTab(); // send final VIPs list
        if (!consentAcknowledged?.checked) {
          btnRecord.removeAttribute('disabled');
          setMsg('Confirm meeting host and participant permission before recording.', 'error');
          return;
        }
        chrome.runtime.sendMessage({ type: 'START_RECORDING', consentAcknowledged: true }, (resp) => {
          if (resp?.ok) consentAcknowledged.checked = false;
          if (chrome.runtime.lastError || !resp?.ok) {
            btnRecord.removeAttribute('disabled');
            setMsg('❌ Could not start recording: ' + (resp?.error || 'make sure Google Meet is open'), 'error');
          }
        });
      }
    });

    // Pause/Resume button
    btnPause.addEventListener('click', () => {
      if (!isRecording) return;
      const type = isPausedState ? 'RESUME_RECORDING' : 'PAUSE_RECORDING';
      setMsg(`${isPausedState ? 'Resuming' : 'Pausing'} recording…`, 'info');
      chrome.runtime.sendMessage({ type, targetTabId: activeRecordingTabId,
        recordingId: activeRecordingId, contextId: activeRecordingContextId }, (resp) => {
        if (chrome.runtime.lastError || !resp?.ok) {
          setMsg('❌ Could not reach Meet tab.', 'error');
        }
      });
    });

    // Reload button
    btnStatus.addEventListener('click', () => {
      setMsg('Refreshing tab status…', 'info');
      chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (resp) => {
        if (chrome.runtime.lastError || !resp?.ok) {
          setMsg(`Refresh failed: ${resp?.error || chrome.runtime.lastError?.message || 'Meet tab not reachable'}`, 'error');
        }
      });
    });

    if (btnReinject) {
      btnReinject.addEventListener('click', () => {
        btnReinject.setAttribute('disabled', 'true');
        setMsg('Rescanning recorder state…', 'info');
        chrome.runtime.sendMessage({ type: 'FORCE_REINJECT' }, (resp) => {
          btnReinject.removeAttribute('disabled');
          if (chrome.runtime.lastError || !resp?.ok) {
            setMsg(`Rescan failed: ${resp?.error || chrome.runtime.lastError?.message || 'Meet tab not reachable'}`, 'error');
            return;
          }
          setMsg('Recorder rescanned. Refreshing status…', 'success');
          chrome.runtime.sendMessage({ type: 'GET_STATUS' });
        });
      });
    }

    if (pendingRecordingSelect) {
      pendingRecordingSelect.addEventListener('change', () => {
        pendingCombineJob = pendingCombineJobs.find(job => job.id === pendingRecordingSelect.value) || null;
        clearPendingCombineTimer();
        showCombinePrompt(pendingCombineJob);
      });
    }
    if (btnCombineNow) {
      btnCombineNow.addEventListener('click', () => {
        if (!pendingCombineJob) return;
        const job = pendingCombineJob;
        const cleanup = ['cleanup', 'cleanup_requested'].includes(job.state);
        hideCombinePrompt(); clearPendingCombineTimer();
        setMsg(cleanup ? 'Finishing recording cleanup…' : 'Saving recording…', 'info');
        chrome.runtime.sendMessage({ type: cleanup ? 'CANCEL_PENDING_COMBINE' : 'RUN_PENDING_COMBINE', jobId: job.id, job }, resp => {
          if (chrome.runtime.lastError || !resp?.ok) setMsg('Saved recording action failed: ' + (resp?.error || chrome.runtime.lastError?.message || 'unknown error'), 'error');
          loadPendingCombineFromStorage();
        });
      });
    }
    if (btnCombineLater) {
      btnCombineLater.addEventListener('click', () => {
        if (!pendingCombineJob) return;
        const job = pendingCombineJob;
        hideCombinePrompt();
        chrome.runtime.sendMessage({ type: 'DEFER_PENDING_COMBINE', jobId: job.id, job }, resp => {
          if (chrome.runtime.lastError || !resp?.ok) setMsg('Could not postpone saved recording: ' + (resp?.error || chrome.runtime.lastError?.message || 'unknown error'), 'error');
          else setMsg('Saved recording postponed for 10 minutes.', 'info');
          loadPendingCombineFromStorage();
        });
      });
    }
    if (btnCombineNever) {
      btnCombineNever.addEventListener('click', () => {
        if (!pendingCombineJob) return;
        const job = pendingCombineJob;
        hideCombinePrompt(); clearPendingCombineTimer();
        // Background records a cleanup request before contacting the data owner.
        // A closed/unreachable tab therefore retains a durable retry entry.
        chrome.runtime.sendMessage({ type: 'CANCEL_PENDING_COMBINE', jobId: job.id, job }, resp => {
          if (chrome.runtime.lastError || !resp?.ok) setMsg('Cleanup remains pending: ' + (resp?.error || chrome.runtime.lastError?.message || 'open a Meet tab to retry'), 'error');
          else setMsg('Saved recording copy cleared.', 'info');
          loadPendingCombineFromStorage();
        });
      });
    }

    // Settings & Logs open as themed modals
    linkSettings.addEventListener('click', () => panelSettings.classList.add('visible'));
    linkLogs.addEventListener('click', () => panelLogs.classList.add('visible'));

    // Generic close handlers (data-close="modalId")
    document.querySelectorAll('[data-close]').forEach(el => {
      el.addEventListener('click', () => {
        const target = document.getElementById(el.getAttribute('data-close'));
        if (target) target.classList.remove('visible');
      });
    });
    // Click outside the .modal closes the overlay
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.classList.remove('visible');
      });
    });

    if (logClear) {
      logClear.addEventListener('click', () => {
        logContainer.innerHTML = '';
        addLog('Logs cleared', 'info');
      });
    }

    // Toggle Switches change listeners
    toggleMyMic.addEventListener('change', () => handleToggleChange('MY_MIC', toggleMyMic));
    toggleVoices.addEventListener('change', () => handleToggleChange('VOICES', toggleVoices));
    toggleVips.addEventListener('change', () => handleToggleChange('VIPS', toggleVips));
    toggleStreams.addEventListener('change', () => handleToggleChange('STREAMS', toggleStreams));

    if (toggleAdvanceMode) {
      toggleAdvanceMode.addEventListener('change', () => {
        saveState();
        addLog(`Advance Mode: ${toggleAdvanceMode.checked}`, 'info');
      });
    }

    // Modal action buttons
    btnCancelTrack.addEventListener('click', () => modalTrack.classList.remove('visible'));
    btnCancelVip.addEventListener('click', () => modalVip.classList.remove('visible'));
    
    // Add Track
    btnAddTrack.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!toggleVoices.checked) return; // ignore if disabled
      const newId = audioTracks.length + 1;
      audioTracks.push({ id: newId, name: `TRACK ${newId}`, targets: [] });
      renumberTracks();
      saveState();
      renderAudioTracks();
      syncTracksWithTab();
      openTrackSettings(newId);
    });

    // Delete Track
    btnDeleteTrack.addEventListener('click', () => {
      if (currentEditingTrackId && audioTracks.length > 1) {
        audioTracks = audioTracks.filter(t => t.id !== currentEditingTrackId);
        renumberTracks();
        saveState();
        renderAudioTracks();
        syncTracksWithTab();
        modalTrack.classList.remove('visible');
      }
    });

    // Add VIP
    btnAddVip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!toggleVips.checked) return;
      openVipSelection();
    });
  }

  // ─── Initialize ──────────────────────────────────────────────────────────
  function init() {
    loadState(() => {
      renderAudioTracks();
      renderVipsList();
      initAccordions();
      initButtonListeners();
      loadPendingCombineFromStorage();
      
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        try { const url = new URL(tabs?.[0]?.url); siteAvailable = url.protocol === 'https:' && url.hostname === 'meet.google.com' && !url.port; }
        catch (_) { siteAvailable = false; }
        if (!siteAvailable && !isRecording) setMsg('Recording is available only on Google Meet. Open meet.google.com to start.', 'info');
      });
      // Get initial status from tab and sync local lists
      chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATE' }, (resp) => {
        if (chrome.runtime.lastError) return;

        if (resp && resp.isRecording && resp.startTime) {
          activeRecordingId = resp.recordingId;
          activeRecordingContextId = resp.contextId || null;
          activeRecordingTabId = resp.tabId ?? null;
          startTime = resp.startTime;
          isPausedState = !!resp.isPaused;
          enterRecordingUI(resp.startTime);
          setIsPausedUI(isPausedState);
        }
        
        setTimeout(() => {
          chrome.runtime.sendMessage({ type: 'GET_STATUS' });
          syncTracksWithTab();
          syncVipsWithTab();
        }, 200);
      });
    });
  }

  init();

})();
