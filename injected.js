/**
 * injected.js — Runs in the PAGE's JavaScript context (not extension sandbox).
 *
 * KEY ARCHITECTURE ENHANCEMENTS (v1.5.3):
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Robust Speaker DOM Scraper:
 *    Queries computed style borders, shadows, and outlines matching the active
 *    speaker highlight colors (light blue, classic blue, green) across all tiles
 *    to guarantee we identify speaking participants.
 * 2. WebRTC Stream ID Matching:
 *    Maps incoming audio track IDs to WebRTC stream IDs, matching them with
 *    corresponding video stream elements to resolve names and avatars.
 * 3. Glowing Green Speaker Boxes:
 *    Renders speaking participants inside a distinct, green-themed card
 *    (green border, dark green background) for high visibility.
 * 4. Webcam Probe Cleanup & Sender-Based Local Mic Hook (v1.5.2)
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function () {
  'use strict';

  if (window.__meetRecorderInjected) {
    console.warn('[MeetRecorder] injected.js already active; skipping duplicate injection');
    return;
  }
  window.__meetRecorderInjected = true;

  const MSG_SOURCE_OUT = 'MEET_REC_PAGE';
  const MSG_SOURCE_CMD = 'MEET_REC_CMD';

  // ── Shared IndexedDB constants ─────────────────────────────────────────────
  const IDB_NAME    = 'MeetRecorderDB';
  const IDB_VERSION = 1;
  const IDB_STORE   = 'chunks';

  // ─── State ────────────────────────────────────────────────────────────────
  let audioCtx          = null;
  let audioDestNode     = null;
  let recordingGainNode = null; // Global gain node for recording mute

  const audioSources   = new Map(); // trackId → MediaStreamAudioSourceNode
  const audioLevels    = new Map(); // trackId → volume level (0 to 1)
  const trackGainNodes = new Map(); // trackId → GainNode for individual mix control
  const trackStreamMap = new Map(); // trackId → streamId (for WebRTC matching)
  const audioTracks    = new Map(); // trackId → MediaStreamTrack (v1.6.0)
  const trackSinkEls   = new Map(); // trackId → hidden <audio> sink (Chrome WebRTC priming)
  const trackAnalysers = new Map(); // trackId → { analyser, dataArray, track } (single-loop volume poll)
  let   volumePollId   = null;      // single setTimeout id driving ALL volume reads
  let   localMicData   = null;      // Uint8Array buffer for the local mic analyser

  const allVideoTracks          = [];
  const activeScreenShareTracks = [];
  let screenShareTrack          = null;
  let forceNoScreenShare        = false; // user override: treat canvas as no screenshare
  const videoProbes             = new Map(); // trackId → <video> element
  const domVideoElements        = new Map(); // trackId → Meet-owned <video> element
  let lastScreenShareDomScan    = 0;

  let mediaRecorder     = null;
  let isRecording       = false;
  let recordMimeType    = '';
  let currentRecordId   = null;
  let chunksSaved       = 0;
  let bytesSaved        = 0;

  // Background cozy image state
  let currentBgUrl = '';
  const bgImg = new Image();
  let bgLoaded = false;
  bgImg.onload = () => {
    bgLoaded = true;
    console.log('[MeetRecorder] Cozy background image loaded successfully');
  };
  bgImg.onerror = (err) => {
    console.error('[MeetRecorder] Failed to load cozy background image:', err);
  };

  // Canvas Compositor state
  let canvasElement = null;
  let canvasCtx = null;
  let recordingCanvasStream = null;
  let timerWorker = null;
  let canvasIntervalId = null;

  // Resolution Locking State
  let lockedWidth = 1920;
  let lockedHeight = 1080;
  let isResolutionLocked = false;

  // Audio mix controls
  let recordRemoteMics = true;
  let recordMyMic = false;
  let isRecordingMuted = false;
  let recordChosenOnly = false;
  let chosenSpeakers = [];
  let localMicGainNode = null;
  let customAudioTracks = [{ id: 1, name: 'EVERYONE', targets: ['EVERYONE'] }];
  let vipList = [];
  let vipsEnabled = false;
  const trackDestNodes = new Map();
  const trackGains     = new Map();
  // Secondary audio-only MediaRecorders, one per custom track beyond #1.
  // Map<trackId, { recorder, recordingId, name, mimeType, chunksSaved, bytesSaved }>
  const secondaryRecorders = new Map();
  const AUDIO_ONLY_MIME = 'audio/webm;codecs=opus';

  // Active Peer Connections
  const activePeerConnections = new Set();
  let currentLocalMicTrack = null;
  let localMicSourceNode = null;
  let localMicAnalyser = null;
  let localMicVolume = 0;
  const audioTrackToParticipant = new Map(); // trackId -> { name, avatarUrl }

  // IndexedDB database instance
  let idb = null;
  let idbPromise = null;

  // ─── IndexedDB Connection caching ──────────────────────────────────────────
  // Forget the cached connection so the next openIDB() reopens a fresh one.
  function resetIDB() {
    idb = null;
    idbPromise = null;
  }

  function openIDB() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise((resolve, reject) => {
      if (idb) return resolve(idb);
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(IDB_STORE)) {
          const store = d.createObjectStore(IDB_STORE, { autoIncrement: true });
          store.createIndex('by_recording', 'recordingId', { unique: false });
        }
      };
      req.onsuccess = (e) => {
        idb = e.target.result;
        // When the extension is reloaded (or another connection upgrades the
        // DB), our handle enters a closing state and every later transaction
        // throws "database connection is closing". Drop the cached handle on
        // those events so the next write transparently reopens.
        idb.onversionchange = () => { try { idb.close(); } catch (_) {} resetIDB(); };
        idb.onclose         = () => { resetIDB(); };
        resolve(idb);
      };
      req.onerror = (e) => {
        console.error('[MeetRecorder] IDB open error:', e.target.error);
        idbPromise = null;
        reject(e.target.error);
      };
    });
    return idbPromise;
  }

  function isIDBConnClosing(err) {
    return !!err && (
      err.name === 'InvalidStateError' ||
      /connection is closing|database connection is closing/i.test(err.message || '')
    );
  }

  function writeChunkOnce(db, recordingId, chunkData) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        // transaction() throws synchronously when the connection is closing
        tx = db.transaction(IDB_STORE, 'readwrite');
      } catch (err) {
        reject(err);
        return;
      }
      const store = tx.objectStore(IDB_STORE);
      const req   = store.add({ recordingId, data: chunkData });
      req.onerror   = () => reject(req.error);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  }

  function writeChunkToDB(recordingId, chunkData) {
    return openIDB().then(db => writeChunkOnce(db, recordingId, chunkData))
      .catch(err => {
        if (!isIDBConnClosing(err)) throw err;
        // Stale connection — forget it and retry once with a fresh handle.
        console.warn('[MeetRecorder] IDB connection was closing, reopening…');
        resetIDB();
        return openIDB().then(db => writeChunkOnce(db, recordingId, chunkData));
      });
  }

  // ─── Audio Context & Mixing ────────────────────────────────────────────────
  // Per-track node chain: [source gains] → [mixer] → [gate] → [destination]
  //   trackMixers : trackId → GainNode  (sources feed here; always gain=1)
  //   trackGains  : trackId → GainNode  (recording gate; 0 until rec starts; mute control)
  //   trackDestNodes: trackId → MediaStreamDestination
  const trackMixers = new Map(); // NEW: per-track source mixer

  function ensureAudioCtx() {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContext();

      // Build Track 1 node chain
      audioDestNode = audioCtx.createMediaStreamDestination();
      recordingGainNode = audioCtx.createGain(); // Track 1 gate
      recordingGainNode.gain.setValueAtTime(0, audioCtx.currentTime);
      recordingGainNode.connect(audioDestNode);

      const track1Mixer = audioCtx.createGain(); // Track 1 mixer
      track1Mixer.gain.setValueAtTime(1, audioCtx.currentTime);
      track1Mixer.connect(recordingGainNode);

      trackMixers.set(1, track1Mixer);
      trackDestNodes.set(1, audioDestNode);
      trackGains.set(1, recordingGainNode);

      console.log('[MeetRecorder] AudioContext created and audio graph initialized');
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return { audioCtx, audioDestNode };
  }

  function ensureTrackNodes(trackId) {
    if (!audioCtx) return null;

    // Return existing nodes
    if (trackMixers.has(trackId)) {
      return {
        destNode:  trackDestNodes.get(trackId),
        gateNode:  trackGains.get(trackId),
        mixerNode: trackMixers.get(trackId),
      };
    }

    // Build new chain for track 2+
    const destNode  = audioCtx.createMediaStreamDestination();
    const gateNode  = audioCtx.createGain();
    const mixerNode = audioCtx.createGain();

    gateNode.gain.setValueAtTime(0, audioCtx.currentTime); // silent until recording
    mixerNode.gain.setValueAtTime(1, audioCtx.currentTime);

    mixerNode.connect(gateNode);
    gateNode.connect(destNode);

    trackMixers.set(trackId, mixerNode);
    trackGains.set(trackId, gateNode);
    trackDestNodes.set(trackId, destNode);

    console.log(`[MeetRecorder] Created mixer→gate→dest chain for track ${trackId}`);
    return { destNode, gateNode, mixerNode };
  }

  function reconcileCustomTrackNodes() {
    const liveIds = new Set(customAudioTracks.map(track => track.id));
    liveIds.add(1);

    trackMixers.forEach((mixerNode, trackId) => {
      if (liveIds.has(trackId)) return;

      try { mixerNode.disconnect(); } catch (_) {}

      const gateNode = trackGains.get(trackId);
      if (gateNode) {
        try { gateNode.disconnect(); } catch (_) {}
      }

      const destNode = trackDestNodes.get(trackId);
      if (destNode?.stream) {
        try { destNode.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
      }

      trackMixers.delete(trackId);
      trackGains.delete(trackId);
      trackDestNodes.delete(trackId);
      secondaryRecorders.delete(trackId);
      console.log(`[MeetRecorder] Pruned stale custom audio track nodes for track ${trackId}`);
    });
  }

  function rebuildAudioGraph() {
    if (!audioCtx) return;
    console.log('[MeetRecorder] Rebuilding WebAudio graph connections...');

    // 1. Disconnect all per-source gain nodes from any previous routing
    trackGainNodes.forEach(gNode => {
      try { gNode.disconnect(); } catch (_) {}
    });

    // 2. Disconnect local mic gain node
    if (localMicGainNode) {
      try { localMicGainNode.disconnect(); } catch (_) {}
    }

    // 3. For each custom track, route the appropriate sources into its MIXER node
    customAudioTracks.forEach(track => {
      const nodes = ensureTrackNodes(track.id);
      if (!nodes) return;

      // Use the mixer node as the target so sources bypass the gate
      const targetMixer = nodes.mixerNode || nodes.gateNode;
      const targets = track.targets || [];
      const includeEveryone = targets.includes('EVERYONE');
      const includeVipOnly  = targets.includes('VIP_ONLY');
      const includeMe       = targets.includes('ME');

      // A. Connect remote audio sources to this track's mixer
      if (recordRemoteMics) {
        audioSources.forEach((srcNode, trackId) => {
          const pInfo = getParticipantForTrack(trackId);
          const name  = pInfo ? pInfo.name : null;
          const isVip = name && vipList.includes(name);

          let connect = false;
          if (includeEveryone) {
            connect = true;
          } else if (includeVipOnly && vipsEnabled && isVip) {
            connect = true;
          } else if (name && targets.includes(name)) {
            connect = true;
          }

          if (connect) {
            const srcGain = trackGainNodes.get(trackId);
            if (srcGain) srcGain.connect(targetMixer);
          }
        });
      }

      // B. Connect local microphone to this track's mixer
      if (recordMyMic && !isRecordingMuted && localMicGainNode) {
        let connectLocalMic = false;
        const localInfo = getLocalUserInfo();
        const localName = localInfo ? localInfo.name : 'You';

        if (includeEveryone || includeMe || targets.includes(localName)) {
          connectLocalMic = true;
        }

        if (connectLocalMic) localMicGainNode.connect(targetMixer);
      }
    });

    console.log('[MeetRecorder] WebAudio graph connections rebuilt successfully.');
  }

  function updateTrackGains() {
    audioSources.forEach((srcNode, trackId) => {
      const gainNode = trackGainNodes.get(trackId);
      if (gainNode) {
        let targetGain = 0;
        if (recordRemoteMics) {
          if (recordChosenOnly) {
            const pInfo = getParticipantForTrack(trackId);
            if (pInfo && chosenSpeakers.includes(pInfo.name)) {
              targetGain = 1;
            }
          } else {
            targetGain = 1;
          }
        }
        gainNode.gain.setTargetAtTime(targetGain, audioCtx.currentTime, 0.05);
      }
    });
  }

  // ─── Local mic sender interception ──────────────────────────────────────────
  function getActiveLocalSentAudioTrack() {
    for (const pc of activePeerConnections) {
      try {
        const senders = pc.getSenders();
        for (const sender of senders) {
          const track = sender.track;
          if (track && track.kind === 'audio' && track.readyState === 'live' && track.enabled) {
            return track;
          }
        }
      } catch (_) {}
    }
    return null;
  }

  function addLocalMicTrack(track) {
    if (!track) return;
    try {
      const { audioCtx } = ensureAudioCtx();
      if (localMicSourceNode) {
        try { localMicSourceNode.disconnect(); } catch (_) {}
      }
      if (localMicAnalyser) {
        try { localMicAnalyser.disconnect(); } catch (_) {}
        localMicAnalyser = null;
      }
      localMicSourceNode = audioCtx.createMediaStreamSource(new MediaStream([track]));
      if (!localMicGainNode) {
        localMicGainNode = audioCtx.createGain();
        localMicGainNode.gain.setValueAtTime(1, audioCtx.currentTime);
      }
      localMicSourceNode.connect(localMicGainNode);
      rebuildAudioGraph();
      
      // Setup local mic volume monitoring — read by the shared volume poller.
      localMicAnalyser = audioCtx.createAnalyser();
      localMicAnalyser.fftSize = 64;
      localMicSourceNode.connect(localMicAnalyser);
      localMicData = new Uint8Array(localMicAnalyser.frequencyBinCount);
      ensureVolumePoll();

      console.log('[MeetRecorder] Local microphone connected to recording and volume monitoring active');
    } catch (err) {
      console.error('[MeetRecorder] Error adding local mic track:', err);
    }
  }

  function removeLocalMicTrack() {
    if (localMicSourceNode) {
      try { localMicSourceNode.disconnect(); } catch (_) {}
      localMicSourceNode = null;
    }
    if (localMicGainNode) {
      try { localMicGainNode.disconnect(); } catch (_) {}
      localMicGainNode = null;
    }
    if (localMicAnalyser) {
      try { localMicAnalyser.disconnect(); } catch (_) {}
    }
    localMicAnalyser = null;
    localMicData = null;
    localMicVolume = 0;
    console.log('[MeetRecorder] Local microphone disconnected from recording');
  }

  function updateLocalMicSource() {
    if (!isRecording) {
      removeLocalMicTrack();
      currentLocalMicTrack = null;
      return;
    }

    if (!recordMyMic || isRecordingMuted) {
      removeLocalMicTrack();
      currentLocalMicTrack = null;
      return;
    }

    const activeTrack = getActiveLocalSentAudioTrack();
    
    if (activeTrack) {
      if (currentLocalMicTrack !== activeTrack) {
        currentLocalMicTrack = activeTrack;
        addLocalMicTrack(activeTrack);
      }
    } else {
      if (currentLocalMicTrack) {
        removeLocalMicTrack();
        currentLocalMicTrack = null;
      }
    }
  }

  function setRecordMyMic(enabled) {
    recordMyMic = enabled;
    updateLocalMicSource();
  }

  // Mutes or unmutes the recording by zeroing all track GATE gains
  function setMuteAllMics(mute) {
    isRecordingMuted = mute;
    if (isRecording && audioCtx) {
      const targetGain = mute ? 0 : 1;
      // Gate gains live in trackGains map — set all to target
      trackGains.forEach(gateNode => {
        try { gateNode.gain.setTargetAtTime(targetGain, audioCtx.currentTime, 0.05); } catch (_) {}
      });
      console.log(`[MeetRecorder] All track recording gates set to: ${mute} (gain → ${targetGain})`);
    }
    updateLocalMicSource();
    rebuildAudioGraph();
  }

  // ─── Remote Audio Track Monitor & Graph Connection ───────────────────────────
  function connectAndMonitorAudioTrack(track) {
    if (audioSources.has(track.id)) return;
    try {
      const { audioCtx } = ensureAudioCtx();

      // Chrome WebRTC quirk: createMediaStreamSource on a remote audio track yields
      // silence unless the same MediaStream is also attached to an HTMLMediaElement.
      // We attach to a hidden, muted <audio> sink to prime the track. The sink is
      // muted so we don't double-play audio that Meet is already rendering.
      const primingStream = new MediaStream([track]);
      const sink = document.createElement('audio');
      sink.srcObject = primingStream;
      sink.muted = true;
      sink.autoplay = true;
      sink.playsInline = true;
      sink.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none;left:-9999px;top:-9999px;';
      (document.body || document.documentElement).appendChild(sink);
      sink.play().catch(() => {});
      trackSinkEls.set(track.id, sink);

      const src = audioCtx.createMediaStreamSource(primingStream);
      const gainNode = audioCtx.createGain();
      
      src.connect(gainNode);

      audioSources.set(track.id, src);
      trackGainNodes.set(track.id, gainNode);

      // Tap the analyser off the SAME source node.
      monitorAudioTrack(track, src);

      // Initial gain is open, routing is handled dynamically in rebuildAudioGraph
      gainNode.gain.setValueAtTime(1, audioCtx.currentTime);
      rebuildAudioGraph();

      console.log(`[MeetRecorder] Track ${track.id} connected and routed`);
    } catch (err) {
      console.error('[MeetRecorder] connectAndMonitorAudioTrack error:', err);
    }
  }

  // Single source of truth for forgetting EVERY per-track map entry. Without this,
  // join/leave churn in large meetings leaks entries into the resolution caches
  // (audioTrackToParticipant, lastResolveTime, trackCorrelation, participantTileCache)
  // that disconnectAudioTrack never touched.
  function forgetTrack(trackId) {
    const streamId = trackStreamMap.get(trackId);
    trackStreamMap.delete(trackId);
    audioTrackToParticipant.delete(trackId);
    lastResolveTime.delete(trackId);
    trackCorrelation.delete(trackId);
    participantTileCache.delete(`track:${trackId}`);
    if (streamId) participantTileCache.delete(streamId);
    const an = trackAnalysers.get(trackId);
    if (an) {
      try { an.analyser.disconnect(); } catch (_) {}
      trackAnalysers.delete(trackId);
    }
  }

  function disconnectAudioTrack(trackId) {
    const node = audioSources.get(trackId);
    if (node) {
      try { node.disconnect(); } catch (_) {}
      audioSources.delete(trackId);
    }
    const gNode = trackGainNodes.get(trackId);
    if (gNode) {
      try { gNode.disconnect(); } catch (_) {}
      trackGainNodes.delete(trackId);
    }
    const sink = trackSinkEls.get(trackId);
    if (sink) {
      try { sink.srcObject = null; sink.remove(); } catch (_) {}
      trackSinkEls.delete(trackId);
    }
    audioLevels.delete(trackId);
    forgetTrack(trackId);
    rebuildAudioGraph();
  }

  function monitorAudioTrack(track, sourceNode) {
    // Tap volume off the source node already created in connectAndMonitorAudioTrack.
    // Chrome only honors one createMediaStreamSource per remote WebRTC track, so we
    // MUST reuse the existing node instead of creating a new one.
    //
    // Rather than spawning a per-track 10Hz setTimeout loop (N parallel loops in a
    // large meeting), we register the analyser and let a SINGLE shared poller read
    // every track per tick.
    try {
      const { audioCtx } = ensureAudioCtx();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      sourceNode.connect(analyser);
      trackAnalysers.set(track.id, {
        analyser,
        dataArray: new Uint8Array(analyser.frequencyBinCount),
        track,
      });
      ensureVolumePoll();
    } catch (err) {
      console.error('[MeetRecorder] monitorAudioTrack error:', err);
    }
  }

  // Single loop that reads ALL remote track analysers plus the local mic once per
  // 100ms tick. Self-stops when nothing is left to monitor.
  function ensureVolumePoll() {
    if (volumePollId) return;
    const tick = () => {
      // Remote tracks
      trackAnalysers.forEach((entry, trackId) => {
        const { analyser, dataArray, track } = entry;
        if (track.readyState !== 'live') {
          audioLevels.delete(trackId);
          try { analyser.disconnect(); } catch (_) {}
          trackAnalysers.delete(trackId);
          return;
        }
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const volume = (sum / dataArray.length) / 255;
        audioLevels.set(trackId, volume);
        if (volume > 0.02 && !track.__loggedFirstSound) {
          track.__loggedFirstSound = true;
          console.log(`[MeetRecorder] First non-silent sample on remote track ${trackId} (level=${volume.toFixed(3)})`);
        }
      });

      // Local mic — only meaningful while actively recording it unmuted.
      if (localMicAnalyser && localMicData &&
          isRecording && recordMyMic && !isRecordingMuted &&
          currentLocalMicTrack && currentLocalMicTrack.readyState === 'live') {
        localMicAnalyser.getByteFrequencyData(localMicData);
        let sum = 0;
        for (let i = 0; i < localMicData.length; i++) sum += localMicData[i];
        localMicVolume = (sum / localMicData.length) / 255;
      } else {
        localMicVolume = 0;
      }

      // Keep going only while there's something to watch.
      if (trackAnalysers.size === 0 && !localMicAnalyser) {
        volumePollId = null;
        return;
      }
      volumePollId = setTimeout(tick, 100);
    };
    volumePollId = setTimeout(tick, 100);
  }

  function addAudioTrack(track) {
    if (audioTracks.has(track.id)) return;
    audioTracks.set(track.id, track);

    // Always connect immediately — even before recording starts.
    // The master recordingGainNode is 0 when not recording so nothing leaks into output.
    // This pre-warms the AudioContext and ensures tracks are wired when Record is clicked.
    connectAndMonitorAudioTrack(track);

    postOut('AUDIO_TRACK_ADDED', { trackId: track.id, total: audioTracks.size });

    track.addEventListener('ended', () => {
      audioTracks.delete(track.id);
      disconnectAudioTrack(track.id);
      postOut('AUDIO_TRACK_REMOVED', { trackId: track.id, total: audioTracks.size });
    });
  }

  // ─── Screen Share Detection & Handling ─────────────────────────────────────
  function confirmScreenShare(track, method, extra = {}) {
    if (!activeScreenShareTracks.includes(track)) {
      activeScreenShareTracks.push(track);
    }
    if (screenShareTrack?.id !== track.id) {
      screenShareTrack = track;
      postOut('SCREEN_SHARE_DETECTED', { trackId: track.id, method, ...extra });
    }
  }

  function clearScreenShare(reason = 'unknown', trackId = null) {
    const hadScreen = !!screenShareTrack;
    activeScreenShareTracks.length = 0;
    domVideoElements.clear();
    screenShareTrack = null;
    if (hadScreen) {
      postOut('SCREEN_SHARE_ENDED', { trackId, reason });
    }
  }

  function getVideoElementForScreenShare(trackId) {
    const probeVid = videoProbes.get(trackId);
    if (probeVid && probeVid.readyState >= 2) return probeVid;

    const domVid = domVideoElements.get(trackId);
    if (domVid && domVid.isConnected && domVid.readyState >= 2) return domVid;

    return null;
  }

  function isLikelyScreenShareVideoElement(vid) {
    if (!vid || !vid.isConnected) return false;
    const rect = vid.getBoundingClientRect();
    const stream = vid.srcObject;
    const track = stream && typeof stream.getVideoTracks === 'function'
      ? stream.getVideoTracks().find(t => t.readyState === 'live')
      : null;
    const settings = track?.getSettings ? track.getSettings() : {};
    const label = [
      track?.label,
      vid.getAttribute('aria-label'),
      vid.closest('[aria-label]')?.getAttribute('aria-label'),
      vid.closest('[data-participant-id]')?.textContent,
    ].filter(Boolean).join(' ');

    if (/present|presentation|screen|sharing|shared|tab|window/i.test(label)) return true;
    if (settings.displaySurface && settings.displaySurface !== 'monitor') return true;
    if (settings.displaySurface) return true;
    if ((settings.width || 0) >= 960 || (settings.height || 0) >= 540) return true;

    // Defer final judgment until dimensions exist. Meet often initializes with 0x0.
    return rect.width >= Math.min(window.innerWidth * 0.45, 640) ||
           rect.height >= Math.min(window.innerHeight * 0.45, 360) ||
           vid.videoWidth >= 960 ||
           vid.videoHeight >= 540;
  }

  function scanDomForScreenShare(force = false) {
    const now = Date.now();
    if (!force && now - lastScreenShareDomScan < 1000) return;
    lastScreenShareDomScan = now;
    if (forceNoScreenShare) return;

    let best = null;
    let bestArea = 0;
    document.querySelectorAll('video').forEach(vid => {
      const stream = vid.srcObject;
      if (!stream || typeof stream.getVideoTracks !== 'function') return;
      const track = stream.getVideoTracks().find(t => t.readyState === 'live');
      if (!track) return;

      const settings = track.getSettings ? track.getSettings() : {};
      const label = `${track.label || ''} ${vid.getAttribute('aria-label') || ''} ${vid.closest('[aria-label]')?.getAttribute('aria-label') || ''} ${settings.displaySurface || ''}`.toLowerCase();
      const hasScreenHint = /present|presentation|screen|sharing|shared|tab|window/.test(label) || !!settings.displaySurface;
      const videoReady = vid.readyState >= 2 && (vid.videoWidth >= 960 || vid.videoHeight >= 540);
      const rect = vid.getBoundingClientRect();
      const largeEnough = rect.width >= Math.min(window.innerWidth * 0.45, 640) ||
        rect.height >= Math.min(window.innerHeight * 0.45, 360);

      if (!hasScreenHint && !videoReady && !largeEnough) return;

      const area = Math.max(rect.width * rect.height, (settings.width || 0) * (settings.height || 0), (vid.videoWidth || 0) * (vid.videoHeight || 0));
      if (area > bestArea) {
        best = {
          vid,
          track,
          resolution: `${vid.videoWidth || settings.width || 0}x${vid.videoHeight || settings.height || 0}`,
          settings,
        };
        bestArea = area;
      }
    });

    if (!best) return;
    domVideoElements.set(best.track.id, best.vid);
    if (!allVideoTracks.find(t => t.id === best.track.id)) {
      addVideoTrack(best.track);
    }
    confirmScreenShare(best.track, 'dom_scan', {
      resolution: best.resolution,
      displaySurface: best.settings?.displaySurface,
    });
  }

  function probeVideoTrack(track) {
    if (videoProbes.has(track.id)) return;
    
    let timers = [];
    
    const labelIsScreen = track.label && /screen|window|tab|display|monitor/i.test(track.label);
    const hintIsScreen = track.contentHint === 'detail' || track.contentHint === 'text';
    
    if (labelIsScreen || hintIsScreen) {
      confirmScreenShare(track, labelIsScreen ? 'label' : 'contentHint');
    }
    
    const vid = document.createElement('video');
    vid.style.cssText =
      'position:fixed;opacity:0;pointer-events:none;' +
      'width:1px;height:1px;top:-9999px;left:-9999px;z-index:-1;';
    vid.autoplay    = true;
    vid.muted       = true;
    vid.playsInline = true;
    vid.srcObject   = new MediaStream([track]);
    (document.body || document.documentElement).appendChild(vid);
    videoProbes.set(track.id, vid);
    
    const cleanupProbe = () => {
      timers.forEach(clearTimeout);
      vid.removeEventListener('loadedmetadata', check);
      vid.removeEventListener('resize', check);
      if (vid.isConnected) vid.remove();
      vid.srcObject = null;
      videoProbes.delete(track.id);
    };
    
    vid.play().catch(() => {});

    const check = () => {
      if (!vid.isConnected) return;
      const w = vid.videoWidth, h = vid.videoHeight;
      if (w > 0 && h > 0) {
        const labelIsScreen = track.label && /screen|window|tab|display|monitor/i.test(track.label);
        const hintIsScreen = track.contentHint === 'detail' || track.contentHint === 'text';
        const resIsScreen = w >= 960 && h >= 540;
        
        const isScreen = labelIsScreen || hintIsScreen || resIsScreen;
        
        if (isScreen) {
          confirmScreenShare(track, 'resolution', { resolution: `${w}x${h}` });
        } else {
          console.log(`[MeetRecorder] Track ${track.id} (${w}x${h}) identified as camera. Destroying probe element.`);
          cleanupProbe();
        }
      }
    };

    vid.addEventListener('loadedmetadata', check);
    vid.addEventListener('resize', check);
    
    // Assign timers after helper definitions to prevent Temporal Dead Zone ReferenceErrors
    timers = [300, 800, 1500, 3000, 6000, 12000].map(d => setTimeout(check, d));

    // Final timeout to clean up probe if it hasn't resolved (e.g. video is off or failed to load)
    const finalTimer = setTimeout(() => {
      if (vid.isConnected && !activeScreenShareTracks.includes(track)) {
        console.log(`[MeetRecorder] Track ${track.id} probe timed out without detecting screen. Cleaning up.`);
        cleanupProbe();
      }
    }, 15000);
    timers.push(finalTimer);

    track.addEventListener('ended', () => {
      cleanupProbe();
      videoProbes.delete(track.id);
    });
  }

  function addVideoTrack(track) {
    if (allVideoTracks.find(t => t.id === track.id)) return;
    allVideoTracks.push(track);
    postOut('VIDEO_TRACK_RECEIVED', {
      trackId: track.id, contentHint: track.contentHint,
      label: track.label, total: allVideoTracks.length,
    });

    probeVideoTrack(track);

    track.addEventListener('ended', () => {
      const idx = allVideoTracks.findIndex(t => t.id === track.id);
      if (idx !== -1) allVideoTracks.splice(idx, 1);
      domVideoElements.delete(track.id);
      
      const sIdx = activeScreenShareTracks.indexOf(track);
      if (sIdx !== -1) activeScreenShareTracks.splice(sIdx, 1);
      
      if (screenShareTrack?.id === track.id) {
        if (activeScreenShareTracks.length > 0) {
          screenShareTrack = activeScreenShareTracks[activeScreenShareTracks.length - 1];
          postOut('SCREEN_SHARE_DETECTED', { trackId: screenShareTrack.id, method: 'fallback_active_track' });
        } else {
          clearScreenShare('track_ended', track.id);
        }
      }
    });
  }

  function rescanExistingMediaElements() {
    let addedAudio = 0;
    let addedVideo = 0;

    document.querySelectorAll('video, audio').forEach(el => {
      const stream = el.srcObject;
      if (!stream || typeof stream.getTracks !== 'function') return;

      try {
        stream.getAudioTracks().forEach(track => {
          if (track.readyState !== 'live' || audioTracks.has(track.id)) return;
          trackStreamMap.set(track.id, stream.id);
          addAudioTrack(track);
          addedAudio++;
        });

        stream.getVideoTracks().forEach(track => {
          if (track.readyState !== 'live' || allVideoTracks.find(t => t.id === track.id)) return;
          trackStreamMap.set(track.id, stream.id);
          domVideoElements.set(track.id, el);
          addVideoTrack(track);
          addedVideo++;
        });
      } catch (err) {
        console.warn('[MeetRecorder] Existing media rescan skipped an element:', err);
      }
    });

    scanDomForScreenShare(true);
    postOut('INFO', `Media rescan complete: +${addedAudio} audio, +${addedVideo} video`);
  }

  // ─── RTCPeerConnection Patch & Tracker ─────────────────────────────────────
  const OrigPeerConn = window.RTCPeerConnection;

  function patchPeerConnection(pc) {
    activePeerConnections.add(pc);

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
        activePeerConnections.delete(pc);
      }
    });

    pc.addEventListener('track', (event) => {
      const { track, streams } = event;
      if (streams && streams[0]) {
        trackStreamMap.set(track.id, streams[0].id);
      }
      if (track.kind === 'audio')      addAudioTrack(track);
      else if (track.kind === 'video') addVideoTrack(track);
    });
  }

  // Use Reflect.construct for perfect constructor subclassing and prototype chain stability
  const PatchedRTCPeerConnection = function(config, constraints) {
    const pc = Reflect.construct(OrigPeerConn, [config, constraints], new.target || PatchedRTCPeerConnection);
    patchPeerConnection(pc);
    return pc;
  };
  PatchedRTCPeerConnection.prototype = OrigPeerConn.prototype;
  Object.setPrototypeOf(PatchedRTCPeerConnection, OrigPeerConn);
  
  for (const key of Object.getOwnPropertyNames(OrigPeerConn)) {
    if (key !== 'prototype' && key !== 'length' && key !== 'name') {
      try { PatchedRTCPeerConnection[key] = OrigPeerConn[key]; } catch (_) {}
    }
  }
  window.RTCPeerConnection = PatchedRTCPeerConnection;

  // Patch close on prototype to safely clean up connection tracking
  if (OrigPeerConn.prototype && typeof OrigPeerConn.prototype.close === 'function') {
    const origClose = OrigPeerConn.prototype.close;
    OrigPeerConn.prototype.close = function() {
      activePeerConnections.delete(this);
      return origClose.apply(this, arguments);
    };
  }

  // ─── MediaRecorder Mime list ──────────────────────────────────────────────
  const MIME_PRIORITY = [
    'video/x-matroska;codecs=h264,opus',
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ];

  function getBestMime() {
    for (const mime of MIME_PRIORITY) {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    }
    return '';
  }

  // ─── Speaker Mapping & DOM Heuristics ──────────────────────────────────────
  function isRealParticipantName(name) {
    if (!name) return false;
    const clean = name.toLowerCase().trim();
    
    // Length check
    if (clean.length < 2 || clean.length > 30) return false;
    
    // Blacklist exact matches (or exact phrases)
    const exactBlacklist = [
      "you're continuously framed", "2 joined", "0 also invited", "also invited",
      "add people", "meeting details", "host controls", "presentation",
      "your screen", "you are presenting", "you're presenting", "you",
      "people", "chat", "activities", "host control", "meeting info",
      "show info", "raise hand", "react", "send a message", "leave call",
      "hang up", "more options", "turn on", "turn off", "mute", "unmute",
      "captions", "audio settings", "video settings", "settings"
    ];
    if (exactBlacklist.includes(clean)) return false;
    
    // Blacklist keywords anywhere in the name (filters out Google Meet UI buttons/settings)
    const blacklistKeywords = [
      "background", "effect", "option", "pin", "mute", "unmute", "audio", "video",
      "present", "screen", "share", "sharing", "grid", "layout", "host", "control",
      "setting", "close", "minimize", "more", "menu", "participant", "people",
      "chat", "activity", "info", "help", "report", "feedback", "layout", "change"
    ];
    for (const kw of blacklistKeywords) {
      if (clean.includes(kw)) return false;
    }
    
    // Blacklist patterns that indicate system text
    const systemPatterns = [
      /^\d+$/,                  // purely digits
      /\d+:\d+/,                // time like "21:41" or "09:41" (matches anywhere)
      /\b(am|pm)\b/i,           // time suffix
      /^\d+\s+(joined|invited|people|others)/, // "2 joined", "0 invited"
      /joined the/,             // "joined the meeting"
      /left the/,               // "left the meeting"
      /continuously framed/,
      /presenting/,
      /presentation/,
      /sharing/,
      /@/,                      // email addresses
      /^\+/                     // phone numbers starting with +
    ];
    for (const regex of systemPatterns) {
      if (regex.test(clean)) return false;
    }
    
    return true;
  }

  let cachedLocalUserInfo = null;

  function cleanLabelText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function extractNameFromLabel(label) {
    const text = cleanLabelText(label);
    if (!text) return '';

    const patterns = [
      /Google Account:\s*([^(\n]+)/i,
      /(?:Signed in as|Account:)\s*([^(\n]+)/i,
      /^(.*?)(?:\s*\(|$)/,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const candidate = cleanLabelText(match[1]);
        if (candidate && candidate.toLowerCase() !== 'you') {
          return candidate;
        }
      }
    }

    return '';
  }

  function findRealSelfName() {
    const selectors = [
      'button[aria-label*="Google Account"]',
      'a[aria-label*="Google Account"]',
      '[aria-label*="Google Account"]',
    ];

    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        const label = node.getAttribute('aria-label') || node.title || node.textContent || '';
        const name = extractNameFromLabel(label);
        if (name) return name;
      }
    }

    const selfNameEls = document.querySelectorAll('[data-self-name]');
    for (const el of selfNameEls) {
      const val = cleanLabelText(el.getAttribute('data-self-name') || el.textContent || '');
      if (val && val.toLowerCase() !== 'you' && isRealParticipantName(val)) {
        return val;
      }
    }

    return '';
  }

  // ─── Tile-based participant scraping ──────────────────────────────────────
  // Verified against current (June 2026) Meet DOM via __meetRecDumpDOM:
  //   • [data-participant-id] tiles exist for every participant in the call
  //   • Local tile has self-only UI strings: "You're continuously framed",
  //     "Backgrounds and effects", and material icon ligature "frame_person"
  //   • Name lives in the "More options for <Name>" button aria-label, with
  //     fallback to the repeated-name pattern Meet renders as plain text
  //   • Avatar is an <img src*="googleusercontent"> inside the tile
  //   • [data-self-name] no longer exists in current Meet builds
  const SELF_MARKER_RE = /You're continuously framed|Backgrounds and effects|Backgrounds and visual effects|frame_person|visual_effects/;

  function extractNameFromTile(tile) {
    // First choice: "More options for <Name>" — most reliable name source
    const moreBtn = tile.querySelector('[aria-label^="More options for"], button[aria-label^="More options for"]');
    if (moreBtn) {
      const label = moreBtn.getAttribute('aria-label') || '';
      const m = label.match(/More options for\s+(.+?)(?:\s+Other|\s+\(.+\)|$)/i);
      if (m && m[1]) return m[1].trim();
    }

    // Fallback: textContent. Meet often renders the name doubled and surrounded
    // by UI strings ("frame_person", "more_vert", "Other", "devices").
    let text = (tile.textContent || '').replace(/\s+/g, ' ').trim();
    // Strip known UI noise
    text = text
      .replace(/frame_person/g, '|')
      .replace(/visual_effects/g, '|')
      .replace(/more_vert/g, '|')
      .replace(/You're continuously framed/g, '|')
      .replace(/Backgrounds and (?:visual )?effects/g, '|')
      .replace(/More options for[^|]*/g, '|')
      .replace(/devices?$/g, '|')
      .replace(/Other$/g, '|');
    const parts = text.split('|').map(s => s.trim()).filter(Boolean);
    // The first non-empty part is usually the name (possibly doubled)
    for (const part of parts) {
      // De-duplicate "Satyajit PandaSatyajit Panda" → "Satyajit Panda"
      const half = Math.floor(part.length / 2);
      if (half > 0 && part.slice(0, half) === part.slice(half)) {
        return part.slice(0, half).trim();
      }
      if (part.length > 1 && part.length < 60) return part;
    }
    return '';
  }

  function extractAvatarFromTile(tile) {
    // Prefer the higher-res image inside the tile if present; Meet ships both
    // s31 (sidebar thumbnail) and s200 (avatar bubble in the main view) variants.
    const imgs = tile.querySelectorAll('img[src*="googleusercontent"]');
    if (!imgs.length) return null;
    let best = imgs[0];
    let bestSize = 0;
    imgs.forEach(img => {
      const m = img.src.match(/=s(\d+)/);
      const size = m ? parseInt(m[1], 10) : 0;
      if (size > bestSize) { bestSize = size; best = img; }
    });
    // Upgrade the chosen URL to s200 in case only a small variant was present.
    return best.src.replace(/=s\d+/, '=s200');
  }

  function getMeetTiles() {
    const out = [];
    document.querySelectorAll('[data-participant-id]').forEach(tile => {
      const text = tile.textContent || '';
      const isSelf = SELF_MARKER_RE.test(text);
      const name = extractNameFromTile(tile);
      const avatarUrl = extractAvatarFromTile(tile);
      if (!name && !avatarUrl) return;
      out.push({
        participantId: tile.getAttribute('data-participant-id'),
        name,
        avatarUrl,
        isSelf,
      });
    });
    return out;
  }

  function getRemoteTiles() {
    return getMeetTiles().filter(t => !t.isSelf && t.name);
  }

  function getLocalUserInfo() {
    if (cachedLocalUserInfo && cachedLocalUserInfo.name !== 'You' && cachedLocalUserInfo.avatarUrl) {
      return cachedLocalUserInfo;
    }

    let name = 'You';
    let avatarUrl = null;

    // PRIMARY: find the self tile via marker text in [data-participant-id]
    const tiles = getMeetTiles();
    const selfTile = tiles.find(t => t.isSelf);
    if (selfTile) {
      if (selfTile.name) name = selfTile.name;
      if (selfTile.avatarUrl) avatarUrl = selfTile.avatarUrl;
    }

    // SECONDARY: legacy Google Account button (kept as fallback for older Meet builds)
    if (name === 'You' || !avatarUrl) {
      const accountBtn = document.querySelector('a[aria-label*="Google Account"], [aria-label*="Google Account"]');
      if (accountBtn) {
        const label = accountBtn.getAttribute('aria-label') || accountBtn.title || accountBtn.textContent || '';
        const extractedName = extractNameFromLabel(label);
        if (extractedName && name === 'You') name = extractedName;
        const img = accountBtn.querySelector('img');
        if (img && !avatarUrl) avatarUrl = img.src;
      }
    }

    if (name === 'You') {
      const realName = findRealSelfName();
      if (realName) name = realName;
    }

    cachedLocalUserInfo = { name, avatarUrl };
    return cachedLocalUserInfo;
  }

  function findNameAndAvatarFromElement(el) {
    // Only extract name/avatar if the element is a video, ensuring we start within a participant tile
    if (!el || el.tagName !== 'VIDEO') return null;
    
    let parent = el.parentElement;
    let depth = 0;
    // Restrict depth < 4 to prevent leakage out of the participant's specific tile container
    // and explicitly block traversing up to global document levels
    while (parent && parent !== document.body && parent !== document.documentElement && depth < 4) {
      const img = parent.querySelector('img[src*="googleusercontent"]');
      const fallbackImg = parent.querySelector('img');
      const avatarUrl = img ? img.src : (fallbackImg ? fallbackImg.src : null);
      
      let name = null;
      const nameEl = parent.querySelector('[data-self-name]');
      if (nameEl) {
        const val = (nameEl.getAttribute('data-self-name') || nameEl.textContent || '').trim();
        if (isRealParticipantName(val) || val.toLowerCase() === 'you') {
          name = val;
        }
      }
      
      if (!name) {
        const divs = parent.querySelectorAll('div, span');
        for (const d of divs) {
          // Ignore interactive elements (buttons, menus) overlaid on the tile
          if (d.closest('button, [role="button"], [role="menu"], [role="menuitem"], a')) {
            continue;
          }
          const text = d.textContent.trim();
          if (isRealParticipantName(text) || text.toLowerCase() === 'you') {
            if (d.childNodes.length === 1 && d.childNodes[0].nodeType === Node.TEXT_NODE) {
              name = text;
              break;
            }
          }
        }
      }
      
      if (name || avatarUrl) {
        if (name && name.toLowerCase() === 'you') {
          name = getLocalUserInfo().name || 'You';
        }
        if (name) {
          name = name.replace(/^[;,\s]+|[;,\s]+$/g, '').trim();
        }
        return { name: name || 'Participant', avatarUrl };
      }
      parent = parent.parentElement;
      depth++;
    }
    return null;
  }

  // Proactive participant tile cache — scanned on interval so speaker names are always ready
  const participantTileCache = new Map(); // streamId → { name, avatarUrl }
  const PARTICIPANT_TILE_CACHE_MAX = 120;
  let lastTileScanTime = 0;

  function pruneParticipantTileCache() {
    while (participantTileCache.size > PARTICIPANT_TILE_CACHE_MAX) {
      const oldestKey = participantTileCache.keys().next().value;
      participantTileCache.delete(oldestKey);
    }
  }

  function resolveParticipantFromVideoElement(vid, trackId = null) {
    if (!vid || vid.tagName !== 'VIDEO') return null;

    const stream = vid.srcObject;
    if (!stream) return null;

    const extracted = findNameAndAvatarFromElement(vid);
    if (extracted && extracted.name && extracted.name !== 'Participant') {
      participantTileCache.set(stream.id, extracted);
      if (trackId) participantTileCache.set(`track:${trackId}`, extracted);
      return extracted;
    }

    const tile = vid.closest('[data-participant-id]') || vid.parentElement;
    if (!tile) return null;

    const nameCandidates = [];
    const ariaLabel = tile.getAttribute('aria-label') || tile.getAttribute('title') || '';
    if (ariaLabel) nameCandidates.push(ariaLabel);

    const selfNameEl = tile.querySelector('[data-self-name]');
    if (selfNameEl) {
      nameCandidates.push(selfNameEl.getAttribute('data-self-name') || selfNameEl.textContent || '');
    }

    const textNodes = Array.from(tile.querySelectorAll('div, span'))
      .map(el => (el.childNodes.length === 1 && el.childNodes[0].nodeType === Node.TEXT_NODE) ? el.textContent : '')
      .filter(Boolean);
    nameCandidates.push(...textNodes);

    let name = '';
    for (const candidate of nameCandidates) {
      const clean = cleanLabelText(candidate);
      if (isRealParticipantName(clean) || clean.toLowerCase() === 'you') {
        name = clean;
        break;
      }
    }

    if (name && name.toLowerCase() === 'you') {
      name = getLocalUserInfo().name || 'You';
    }

    const img = tile.querySelector('img[src*="googleusercontent"], img');
    const avatarUrl = img ? img.src : null;

    if (name || avatarUrl) {
      const resolved = { name: name || 'Participant', avatarUrl };
      participantTileCache.set(stream.id, resolved);
      if (trackId) participantTileCache.set(`track:${trackId}`, resolved);
      return resolved;
    }

    return null;
  }

  function scanParticipantTiles() {
    const now = Date.now();
    if (now - lastTileScanTime < 2000) return; // only scan every 2 seconds
    lastTileScanTime = now;
    
    const videos = document.querySelectorAll('video');
    for (const vid of videos) {
      const stream = vid.srcObject;
      if (!stream) continue;
      if (participantTileCache.has(stream.id)) continue; // already resolved
      
      const result = resolveParticipantFromVideoElement(vid);
      if (result && result.name && result.name !== 'Participant') {
        participantTileCache.set(stream.id, result);
        // Cache by audio track stream IDs so remote speaker resolution works —
        // but ONLY if the resolution isn't the local user. Remote audio tracks
        // never identify as the local user; caching it would poison resolution.
        if (!isLocalIdentity(result)) {
          try {
            const aTracks = stream.getAudioTracks();
            if (aTracks && aTracks[0]) {
              participantTileCache.set(`track:${aTracks[0].id}`, result);
            }
          } catch(_) {}
        }
      }
    }
    pruneParticipantTileCache();
  }

  // Returns true if a resolved {name, avatarUrl} actually identifies the LOCAL user.
  // All entries in audioSources are remote (they come from RTCPeerConnection.ontrack,
  // which only fires for incoming tracks), so any "local" match is by definition a
  // DOM-walk misattribution and must be rejected.
  function isLocalIdentity(info) {
    if (!info) return false;
    if (info.name && info.name.toLowerCase() === 'you') return true;
    const localInfo = getLocalUserInfo();
    if (!localInfo) return false;
    if (localInfo.name && info.name && localInfo.name.toLowerCase() === info.name.toLowerCase()) return true;
    if (localInfo.avatarUrl && info.avatarUrl && localInfo.avatarUrl === info.avatarUrl) return true;
    return false;
  }

  function getParticipantForTrack(trackId) {
    // ZEROTH: tile-based resolution. With current Meet DOM (no <video> when
    // cameras are off, no [data-self-name]), this is the only reliable signal.
    // If there's exactly one remote participant tile, all remote audio is
    // attributable to them with 100% confidence.
    const remoteTiles = getRemoteTiles();
    if (remoteTiles.length === 1) {
      return { name: remoteTiles[0].name, avatarUrl: remoteTiles[0].avatarUrl };
    }

    // First: check proactive tile cache by track ID key
    const cachedByTrack = participantTileCache.get(`track:${trackId}`);
    if (cachedByTrack && !isLocalIdentity(cachedByTrack)) return cachedByTrack;
    // Cache poisoned with local identity from an earlier walk — evict so we can try again.
    if (cachedByTrack && isLocalIdentity(cachedByTrack)) {
      participantTileCache.delete(`track:${trackId}`);
    }

    const targetStreamId = trackStreamMap.get(trackId);
    if (!targetStreamId) return null;

    // Second: check proactive tile cache by stream ID
    const cachedByStream = participantTileCache.get(targetStreamId);
    if (cachedByStream && !isLocalIdentity(cachedByStream)) return cachedByStream;
    if (cachedByStream && isLocalIdentity(cachedByStream)) {
      participantTileCache.delete(targetStreamId);
    }

    // Third: direct match against visible video elements whose attached media includes this track.
    const videos = document.querySelectorAll('video');
    for (const vid of videos) {
      const stream = vid.srcObject;
      if (!stream) continue;

      try {
        const tracks = typeof stream.getTracks === 'function' ? stream.getTracks() : [];
        const hasTrack = tracks.some(t => t.id === trackId);
        if (hasTrack) {
          const p = resolveParticipantFromVideoElement(vid, trackId);
          if (p && p.name !== 'Participant' && !isLocalIdentity(p)) return p;
        }
      } catch (_) {}
    }

    // Fourth: live DOM lookup by known stream id
    for (const vid of videos) {
      const stream = vid.srcObject;
      if (!stream) continue;

      if (stream.id === targetStreamId) {
        const p = resolveParticipantFromVideoElement(vid, trackId);
        if (p && p.name !== 'Participant' && !isLocalIdentity(p)) {
          participantTileCache.set(stream.id, p);
          participantTileCache.set(`track:${trackId}`, p);
          return p;
        }
      }
    }

    return null;
  }

  // Helper: check if a computed style color string matches active speaker highlights (blue or green)
  function isBlueOrGreen(colorStr) {
    if (!colorStr) return false;
    const match = colorStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (match) {
      const r = parseInt(match[1]), g = parseInt(match[2]), b = parseInt(match[3]);
      // Blue: high blue, lower red (e.g. Google Blue #1a73e8 or Google Light Blue #8ab4f8)
      const isBlue = (b > 180 && b > r * 1.3 && r < 160);
      // Green: high green, lower red and blue (e.g. Discord speaking highlight or Meet host green)
      const isGreen = (g > 150 && g > r * 1.3 && g > b * 1.3 && r < 150 && b < 150);
      return isBlue || isGreen;
    }
    return false;
  }

  // Helper: check if a DOM element is highlighted as an active speaker (border, outline, box shadow)
  function isElementSpeaking(el) {
    if (!el) return false;
    // Highlight colors are never on buttons or setting panels
    if (el.closest('button, [role="button"], [role="menu"], [role="menuitem"], a')) {
      return false;
    }
    try {
      const style = window.getComputedStyle(el);
      
      const outlineColor = style.outlineColor;
      const outlineStyle = style.outlineStyle;
      const outlineWidth = parseFloat(style.outlineWidth) || 0;
      if (outlineWidth > 0 && outlineStyle !== 'none' && isBlueOrGreen(outlineColor)) {
        return true;
      }
      
      const borderColor = style.borderColor;
      const borderStyle = style.borderStyle;
      const borderWidth = parseFloat(style.borderWidth) || 0;
      if (borderWidth > 0 && borderStyle !== 'none' && isBlueOrGreen(borderColor)) {
        return true;
      }
      
      const boxShadow = style.boxShadow;
      if (boxShadow && boxShadow !== 'none' && isBlueOrGreen(boxShadow)) {
        return true;
      }
    } catch (_) {}
    return false;
  }

  // Helper: extract name and avatar from a participant tile container
  function extractNameAndAvatarFromTile(tileEl) {
    if (!tileEl) return null;
    
    const img = tileEl.querySelector('img[src*="googleusercontent"]');
    const avatarUrl = img ? img.src : null;
    
    let name = null;
    const nameEl = tileEl.querySelector('[data-self-name]');
    if (nameEl) {
      const val = (nameEl.getAttribute('data-self-name') || nameEl.textContent || '').trim();
      if (isRealParticipantName(val) || val.toLowerCase() === 'you') {
        name = val;
      }
    }
    
    if (!name) {
      const divs = tileEl.querySelectorAll('div, span');
      for (const d of divs) {
        // Skip interactive elements (e.g. "Backgrounds and effects" hover buttons)
        if (d.closest('button, [role="button"], [role="menu"], [role="menuitem"], a')) {
          continue;
        }
        const text = d.textContent.trim();
        if (isRealParticipantName(text) || text.toLowerCase() === 'you') {
          if (d.childNodes.length === 1 && d.childNodes[0].nodeType === Node.TEXT_NODE) {
            name = text;
            break;
          }
        }
      }
    }
    
    if (name) {
      if (name.toLowerCase() === 'you') {
        name = findRealSelfName() || 'You';
      }
      name = name.replace(/^[;,\s]+|[;,\s]+$/g, '').trim();
      return { name, avatarUrl };
    }
    return null;
  }

  // Scrapes the DOM for participant tiles highlighted as speaking (excluding local user)
  function scanActiveSpeakersFromDOM() {
    const speakers = [];
    // Get all tiles and filter to only leaf-most tiles (to prevent parent container matching leakage)
    const allTiles = Array.from(document.querySelectorAll('[data-participant-id]'));
    const tiles = allTiles.filter(tile => !tile.querySelector('[data-participant-id]'));
    
    const localInfo = getLocalUserInfo();
    const selfName = localInfo.name.toLowerCase();
    
    for (const tile of tiles) {
      // Exclude local self-preview tile to prevent remote audio tracks from correlating to the local user
      if (tile.querySelector('[data-self-name]') || tile.hasAttribute('data-self-name')) {
        continue;
      }
      
      // Exclude if tile text literally says "You"
      if (/\\bYou\\b/i.test(tile.textContent || '')) {
        continue;
      }
      
      // Meet paints the active-speaker highlight on the tile itself or a close
      // wrapper — never on deep descendants. Limit getComputedStyle to the tile
      // plus two shallow levels instead of every descendant <div>, which made this
      // O(tiles × divs) twice a second in large meetings.
      let speaking = isElementSpeaking(tile);
      if (!speaking) {
        const children = tile.children;
        outer:
        for (let i = 0; i < children.length; i++) {
          if (isElementSpeaking(children[i])) { speaking = true; break; }
          const grandkids = children[i].children;
          for (let j = 0; j < grandkids.length; j++) {
            if (isElementSpeaking(grandkids[j])) { speaking = true; break outer; }
          }
        }
      }
      
      if (speaking) {
        const info = extractNameAndAvatarFromTile(tile);
        if (info && info.name && info.name !== 'Participant') {
          const nameLower = info.name.toLowerCase();
          // Skip if matched name is local user
          if (nameLower === 'you' || nameLower === selfName) {
            continue;
          }
          // Strictly skip if avatar exact-matches local avatar (prevents cross-correlation)
          if (localInfo.avatarUrl && info.avatarUrl && localInfo.avatarUrl === info.avatarUrl) {
            continue;
          }
          speakers.push(info);
        }
      }
    }
    return speakers;
  }

  // ─── Drawing Utilities ────────────────────────────────────────────────────
  const avatarImageCache = new Map();
  const AVATAR_CACHE_MAX = 50;
  function getAvatarImage(url) {
    if (!url) return null;
    if (avatarImageCache.has(url)) {
      const cached = avatarImageCache.get(url);
      // Refresh LRU recency.
      avatarImageCache.delete(url);
      avatarImageCache.set(url, cached);
      return cached.complete ? cached : null;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    avatarImageCache.set(url, img);
    // Evict oldest entries once over the cap (Map preserves insertion order).
    while (avatarImageCache.size > AVATAR_CACHE_MAX) {
      const oldestKey = avatarImageCache.keys().next().value;
      avatarImageCache.delete(oldestKey);
    }
    return null;
  }

  function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight) {
    const words = text.split(' ');
    let line = '';
    const lines = [];
    
    for (let n = 0; n < words.length; n++) {
      let testLine = line + words[n] + ' ';
      let metrics = ctx.measureText(testLine);
      let testWidth = metrics.width;
      if (testWidth > maxWidth && n > 0) {
        lines.push(line.trim());
        line = words[n] + ' ';
      } else {
        line = testLine;
      }
    }
    lines.push(line.trim());
    
    // Ensure each line fits within maxWidth (truncate if single word is too long)
    for (let i = 0; i < lines.length; i++) {
      if (ctx.measureText(lines[i]).width > maxWidth) {
        let l = lines[i];
        while (l.length > 0 && ctx.measureText(l + '...').width > maxWidth) {
          l = l.slice(0, -1);
        }
        lines[i] = l + '...';
      }
    }
    
    // Draw at most 2 lines
    if (lines.length > 2) {
      let secondLine = lines[1];
      if (!secondLine.endsWith('...')) {
        secondLine = secondLine + '...';
      }
      while (secondLine.length > 4 && ctx.measureText(secondLine).width > maxWidth) {
        secondLine = secondLine.slice(0, -4) + '...';
      }
      lines[1] = secondLine;
    }
    
    const drawLines = lines.slice(0, 2);
    const offset = drawLines.length === 1 ? lineHeight / 2 : 0;
    drawLines.forEach((l, i) => {
      ctx.fillText(l, x, y + offset + i * lineHeight);
    });
  }

  function drawAvatar(ctx, x, y, size, name, avatarUrl, borderStyle = '#ffffff', borderWidth = 3) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x + size/2, y + size/2, size/2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    
    const img = getAvatarImage(avatarUrl);
    if (img) {
      ctx.drawImage(img, x, y, size, size);
    } else {
      const colors = ['#5b67f5', '#22c55e', '#ef4444', '#f59e0b', '#7c3aed', '#ec4899', '#06b6d4'];
      let hash = 0;
      for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
      }
      const color = colors[Math.abs(hash) % colors.length];
      ctx.fillStyle = color;
      ctx.fillRect(x, y, size, size);
      
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.floor(size * 0.45)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(name.charAt(0).toUpperCase(), x + size/2, y + size/2);
    }
    ctx.restore();
    
    if (borderStyle && borderWidth > 0) {
      ctx.beginPath();
      ctx.arc(x + size/2, y + size/2, size/2 - borderWidth/2, 0, Math.PI * 2);
      ctx.strokeStyle = borderStyle;
      ctx.lineWidth = borderWidth;
      ctx.stroke();
    }
  }

  function drawRoundedRect(ctx, x, y, width, height, radius, fill, stroke) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    if (fill) ctx.fill();
    if (stroke) ctx.stroke();
  }

  function drawImageCover(ctx, img, targetW, targetH) {
    const imgW = img.naturalWidth || img.width || targetW;
    const imgH = img.naturalHeight || img.height || targetH;
    
    const targetRatio = targetW / targetH;
    const imgRatio = imgW / imgH;
    
    let drawW = imgW;
    let drawH = imgH;
    let sx = 0;
    let sy = 0;
    
    if (imgRatio > targetRatio) {
      drawW = imgH * targetRatio;
      sx = (imgW - drawW) / 2;
    } else {
      drawH = imgW / targetRatio;
      sy = (imgH - drawH) / 2;
    }
    ctx.drawImage(img, sx, sy, drawW, drawH, 0, 0, targetW, targetH);
  }

  function drawVideoFit(ctx, vid, targetW, targetH) {
    const videoW = vid.videoWidth || targetW;
    const videoH = vid.videoHeight || targetH;
    
    const targetRatio = targetW / targetH;
    const videoRatio = videoW / videoH;
    
    let drawW = targetW;
    let drawH = targetH;
    let x = 0;
    let y = 0;
    
    if (videoRatio > targetRatio) {
      drawH = targetW / videoRatio;
      y = (targetH - drawH) / 2;
    } else {
      drawW = targetH * videoRatio;
      x = (targetW - drawW) / 2;
    }
    
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, targetW, targetH);
    
    ctx.drawImage(vid, x, y, drawW, drawH);
  }

  // ─── Speakers Overlay Composition ──────────────────────────────────────────
  const activeSpeakers = new Map();
  const lastResolveTime = new Map(); // trackId -> timestamp
  let localParticipantCached = null;
  let lastLocalResolveTime = 0;
  let lastLocalMicCheckTime = 0;
  const trackCorrelation = new Map(); // trackId -> Map(name -> score)
  let lastCorrelationTime = 0;

  function renderSpeakersOverlay(ctx) {
    const now = Date.now();
    
    // 1. Process local mic volume (cached & throttled to avoid layout thrashing)
    if (localMicVolume > 0.015) {
      if (!localParticipantCached || (now - lastLocalResolveTime > 3000)) {
        lastLocalResolveTime = now;
        localParticipantCached = getLocalUserInfo();
      }
      
      activeSpeakers.set(localParticipantCached.name, {
        name: localParticipantCached.name,
        avatarUrl: localParticipantCached.avatarUrl,
        lastSpokenTime: now
      });
    }
    
    // 2. Process active WebRTC volume detection levels for remote tracks (throttled DOM lookups)
    audioSources.forEach((srcNode, trackId) => {
      const level = audioLevels.get(trackId) || 0;
      if (level > 0.015) {
        let resolved = audioTrackToParticipant.get(trackId);

        // Reject any cached resolution that points at the local user — it's a
        // misattribution from an earlier DOM walk. Forces re-resolution.
        if (resolved && isLocalIdentity(resolved)) {
          audioTrackToParticipant.delete(trackId);
          resolved = null;
        }

        if (!resolved) {
          // Throttle DOM resolution attempts to once every 3 seconds per track
          const lastTry = lastResolveTime.get(trackId) || 0;
          if (now - lastTry > 3000) {
            lastResolveTime.set(trackId, now);
            const pInfo = getParticipantForTrack(trackId);
            if (pInfo && pInfo.name && pInfo.name !== 'Participant') {
              resolved = { name: pInfo.name, avatarUrl: pInfo.avatarUrl };
              audioTrackToParticipant.set(trackId, resolved);
            }
          }
          if (!resolved) {
            const cachedByTrack = participantTileCache.get(`track:${trackId}`);
            if (cachedByTrack) {
              resolved = cachedByTrack;
              audioTrackToParticipant.set(trackId, resolved);
            }
          }
        }

        // ALWAYS render something when we hear audio, even if the name hasn't
        // been resolved yet. Otherwise the user sees nothing for remote speakers
        // whose video tile isn't currently rendered (camera off, off-screen, etc).
        // Use the trackId as a stable key so the card stays put while we resolve.
        const speakerKey = resolved ? resolved.name : `track:${trackId}`;
        const displayName = resolved ? resolved.name : 'Speaker';
        const avatarUrl = resolved ? resolved.avatarUrl : null;
        
        // Clean up the unresolved placeholder key once resolution succeeds to prevent duplicate cards
        if (resolved) {
          activeSpeakers.delete(`track:${trackId}`);
        }
        
        activeSpeakers.set(speakerKey, {
          name: displayName,
          avatarUrl,
          lastSpokenTime: now,
        });
      }
    });
    
    // 2b. Also run a proactive tile scan (throttled to every 2s) so cache is always warm
    scanParticipantTiles();

    // 2c. Run correlation-based resolution (throttled to every 500ms) for camera-off speakers
    if (now - lastCorrelationTime > 500) {
      lastCorrelationTime = now;
      try {
        // Only the unresolved active tracks need correlation. Compute these FIRST
        // and skip the expensive DOM/getComputedStyle scan entirely when none remain
        // — in a settled meeting every track is already resolved, so this is a no-op.
        const activeTracks = [];
        audioSources.forEach((srcNode, trackId) => {
          const level = audioLevels.get(trackId) || 0;
          if (level > 0.015 && !audioTrackToParticipant.has(trackId)) {
            activeTracks.push(trackId);
          }
        });

        const domSpeakers = activeTracks.length > 0 ? scanActiveSpeakersFromDOM() : [];

        if (activeTracks.length > 0 && domSpeakers.length > 0) {
          activeTracks.forEach(trackId => {
            let scores = trackCorrelation.get(trackId);
            if (!scores) {
              scores = new Map();
              trackCorrelation.set(trackId, scores);
            }
            
            domSpeakers.forEach(speaker => {
              const currentScore = scores.get(speaker.name) || 0;
              const nextScore = currentScore + 1;
              scores.set(speaker.name, nextScore);
              
              if (nextScore >= 3) {
                let isHighest = true;
                scores.forEach((s, name) => {
                  if (name !== speaker.name && s >= nextScore) {
                    isHighest = false;
                  }
                });
                
                if (isHighest) {
                  const resolvedData = { name: speaker.name, avatarUrl: speaker.avatarUrl };
                  audioTrackToParticipant.set(trackId, resolvedData);
                  participantTileCache.set(`track:${trackId}`, resolvedData);
                  console.log(`[MeetRecorder] Correlation resolved track ${trackId} to camera-off participant: ${speaker.name}`);
                }
              }
            });
          });
        }
      } catch (err) {
        console.error('[MeetRecorder] Correlation logic error:', err);
      }
    }
    
    // 3. Filter speakers within 1s decay window
    const speakersToShow = [];
    activeSpeakers.forEach((speaker, name) => {
      if (now - speaker.lastSpokenTime < 1000) {
        speakersToShow.push(speaker);
      } else {
        activeSpeakers.delete(name);
      }
    });
    
    if (speakersToShow.length === 0) return;
    
    // 4. Render vertical cards in a beautiful centered grid with dynamic sizing
    const useCompact = speakersToShow.length > 4;
    
    const cardW = useCompact ? 140 : 180;
    const cardH = useCompact ? 170 : 220;
    const avatarSize = useCompact ? 70 : 100;
    const radius = useCompact ? 28 : 40;
    const fontSize = useCompact ? 13 : 16;
    const lineHeight = useCompact ? 16 : 20;
    const gapX = useCompact ? 16 : 24;
    const gapY = useCompact ? 16 : 24;
    
    const cols = useCompact ? 4 : speakersToShow.length;
    const rows = Math.ceil(speakersToShow.length / cols);
    const totalH = rows * cardH + (rows - 1) * gapY;
    const startY = Math.max(100, (lockedHeight - totalH) / 2);
    
    speakersToShow.forEach((speaker, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      
      // Centering row elements dynamically (perfect balance for odd numbers)
      const cardsInRow = (row === rows - 1) ? (speakersToShow.length - row * cols) : cols;
      const rowW = cardsInRow * cardW + (cardsInRow - 1) * gapX;
      const rowStartX = (lockedWidth - rowW) / 2;
      
      const x = rowStartX + col * (cardW + gapX);
      const y = startY + row * (cardH + gapY);
      
      const isSpeaking = (now - speaker.lastSpokenTime) < 300;
      
      ctx.save();
      
      // Shadow settings
      if (isSpeaking) {
        ctx.shadowColor = 'rgba(216, 180, 254, 0.45)'; // Lavender glow
        ctx.shadowBlur = useCompact ? 16 : 24;
      } else {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.6)'; // Normal dark shadow
        ctx.shadowBlur = useCompact ? 12 : 16;
      }
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 8;
      
      // Card background and border
      ctx.fillStyle = '#150d18'; // Dark plum
      if (isSpeaking) {
        ctx.strokeStyle = '#d8b4fe'; // Lavender border
        ctx.lineWidth = useCompact ? 3 : 4;
      } else {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'; // Subtle border
        ctx.lineWidth = 2;
      }
      
      // Draw card
      drawRoundedRect(ctx, x, y, cardW, cardH, radius, true, true);
      
      ctx.restore();
      
      // Avatar
      const avatarX = x + (cardW - avatarSize) / 2;
      const avatarY = y + (useCompact ? 16 : 24);
      drawAvatar(ctx, avatarX, avatarY, avatarSize, speaker.name, speaker.avatarUrl, 'rgba(255, 255, 255, 0.85)', useCompact ? 2 : 3);
      
      // Speaker Name
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${fontSize}px "Inter", "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      
      const nameY = y + (useCompact ? 16 : 24) + avatarSize + (useCompact ? 12 : 16);
      const nameMaxW = cardW - 24;
      
      drawWrappedText(ctx, speaker.name, x + cardW / 2, nameY, nameMaxW, lineHeight);
    });
  }

  // ─── Compositor Frame Tick ──────────────────────────────────────────────────
  function drawCompositorFrame() {
    if (!isRecording || (mediaRecorder && mediaRecorder.state === 'paused')) return;
    
    const now = Date.now();
    if (now - lastLocalMicCheckTime > 500) {
      lastLocalMicCheckTime = now;
      updateLocalMicSource();
    }

    try {
      let showingScreen = false;
      if (!forceNoScreenShare && (!screenShareTrack || screenShareTrack.readyState !== 'live')) {
        scanDomForScreenShare();
      }
      if (!forceNoScreenShare && screenShareTrack && screenShareTrack.readyState === 'live') {
        const probeVid = getVideoElementForScreenShare(screenShareTrack.id);
        if (probeVid) {
          if (!isResolutionLocked) {
            lockedWidth = probeVid.videoWidth || 1920;
            lockedHeight = probeVid.videoHeight || 1080;
            isResolutionLocked = true;
            canvasElement.width = lockedWidth;
            canvasElement.height = lockedHeight;
            postOut('INFO', `Compositor locked resolution to active screenshare: ${lockedWidth}x${lockedHeight}`);
          }
          drawVideoFit(canvasCtx, probeVid, lockedWidth, lockedHeight);
          showingScreen = true;
        }
      }
      
      if (!showingScreen) {
        const isBgReady = bgLoaded || (bgImg.complete && bgImg.naturalWidth > 0);
        if (isBgReady) {
          drawImageCover(canvasCtx, bgImg, lockedWidth, lockedHeight);
        } else {
          canvasCtx.fillStyle = '#0d0f1a';
          canvasCtx.fillRect(0, 0, lockedWidth, lockedHeight);
        }
      }
      
      // Only render speaker overlays when NO screen share is active. While a
      // presentation is on screen, the user explicitly does not want speaker
      // name/avatar cards covering the slides. On the cozy-background fallback,
      // overlays render normally so viewers still know who's talking.
      if (!showingScreen) {
        renderSpeakersOverlay(canvasCtx);
      }
      
    } catch (err) {
      console.error('[MeetRecorder] Compositor loop error:', err);
    }
  }

  // ─── Compositor Loop Helpers ────────────────────────────────────────────────
  function startCompositorLoop(callback) {
    stopCompositorLoop();
    try {
      const workerCode = `
        let timer = null;
        self.onmessage = (e) => {
          if (e.data === 'start') {
            if (timer) clearInterval(timer);
            timer = setInterval(() => self.postMessage('tick'), 1000 / 30);
          } else if (e.data === 'stop') {
            if (timer) { clearInterval(timer); timer = null; }
          }
        };
      `;
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      timerWorker = new Worker(workerUrl);
      timerWorker.onmessage = (e) => {
        if (e.data === 'tick') {
          callback();
        }
      };
      timerWorker.postMessage('start');
      console.log('[MeetRecorder] Compositor loop started via Web Worker timer');
      URL.revokeObjectURL(workerUrl);
    } catch (err) {
      console.warn('[MeetRecorder] Web Worker timer creation failed, falling back to page-level setInterval:', err);
      canvasIntervalId = setInterval(callback, 1000 / 30);
    }
  }

  function stopCompositorLoop() {
    if (timerWorker) {
      try {
        timerWorker.postMessage('stop');
        timerWorker.terminate();
      } catch (_) {}
      timerWorker = null;
    }
    if (canvasIntervalId) {
      clearInterval(canvasIntervalId);
      canvasIntervalId = null;
    }
    console.log('[MeetRecorder] Compositor loop stopped');
  }

  function cleanupRecordingResources() {
    stopCompositorLoop();

    if (mediaRecorder) {
      mediaRecorder.ondataavailable = null;
      mediaRecorder.onerror = null;
      mediaRecorder.onstop = null;
      mediaRecorder = null;
    }

    secondaryRecorders.forEach(entry => {
      if (!entry?.recorder) return;
      entry.recorder.ondataavailable = null;
      entry.recorder.onerror = null;
      entry.recorder.onstop = null;
    });
    secondaryRecorders.clear();

    if (recordingCanvasStream) {
      try { recordingCanvasStream.getTracks().forEach(track => track.stop()); } catch (_) {}
      recordingCanvasStream = null;
    }

    canvasElement = null;
    canvasCtx = null;
    isResolutionLocked = false;
  }

  // ─── Recording Pipeline ────────────────────────────────────────────────────
  async function startRecording() {
    if (isRecording) { postOut('WARN', 'Already recording'); return; }
    if (!currentRecordId) { postOut('ERROR', 'No recordingId — start aborted'); return; }

    // ALWAYS lock resolution at start! Canvas resizing mid-recording breaks MediaRecorder completely.
    isResolutionLocked = true;
    lockedWidth = 1920;
    lockedHeight = 1080;

    if (!forceNoScreenShare && screenShareTrack && screenShareTrack.readyState === 'live') {
      const probeVid = getVideoElementForScreenShare(screenShareTrack.id);
      if (probeVid && probeVid.videoWidth > 0 && probeVid.videoHeight > 0) {
        lockedWidth = probeVid.videoWidth;
        lockedHeight = probeVid.videoHeight;
        console.log(`[MeetRecorder] Resolution locked to pre-existing screenshare: ${lockedWidth}x${lockedHeight}`);
      }
    }

    canvasElement = document.createElement('canvas');
    canvasElement.width = lockedWidth;
    canvasElement.height = lockedHeight;
    canvasCtx = canvasElement.getContext('2d');

    recordMimeType = getBestMime();
    chunksSaved    = 0;
    bytesSaved     = 0;

    openIDB().catch(err => postOut('ERROR', `IDB pre-open failed: ${err.message}`));

    // ── Audio Setup ─────────────────────────────────────────────────────────
    // Tracks are ALREADY connected to the audio graph (ensureAudioCtx was called
    // when each track arrived in addAudioTrack). The master recordingGainNode
    // is at 0 — we just need to resume the AudioContext and flip it to 1.
    const { audioCtx: ctx, audioDestNode: destNode } = ensureAudioCtx();

    // Resume AudioContext (it was pre-created when tracks arrived, may be suspended)
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
        postOut('INFO', 'AudioContext resumed ✓');
      } catch (err) {
        postOut('WARN', `AudioContext resume failed: ${err.message}`);
      }
    }
    postOut('INFO', `AudioContext state: ${ctx.state} | Connected tracks: ${audioSources.size}`);

    // Open gates (0 → 1) for all configured tracks to start audio flowing
    const targetGain = isRecordingMuted ? 0 : 1;
    customAudioTracks.forEach(track => {
      const nodes = ensureTrackNodes(track.id);
      if (nodes && nodes.gateNode) {
        try {
          nodes.gateNode.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.05);
          postOut('INFO', `Recording gate opened for track ${track.id} (${track.name}) → gain=${targetGain} ✓`);
        } catch (_) {}
      }
    });

    // Kickstart AudioContext graph to ensure MediaRecorder gets initial data
    if (ctx.state === 'running') {
      try {
        const kickOsc = ctx.createOscillator();
        const kickGain = ctx.createGain();
        kickGain.gain.value = 0; // completely silent
        kickOsc.connect(kickGain);
        kickGain.connect(destNode);
        kickOsc.start();
        kickOsc.stop(ctx.currentTime + 0.1);
      } catch (err) {
        console.warn('[MeetRecorder] AudioContext kickstart failed:', err);
      }
    }

    // Connect local mic if enabled
    updateLocalMicSource();

    // ── Stream Assembly ──────────────────────────────────────────────────────
    const tracks = [];

    try {
      recordingCanvasStream = canvasElement.captureStream(30);
      const canvasTrack = recordingCanvasStream.getVideoTracks()[0];
      if (canvasTrack) {
        tracks.push(canvasTrack);
        postOut('INFO', 'Video channel bound to canvas compositor ✓');
      } else {
        throw new Error('Canvas captureStream returned no video tracks');
      }
    } catch (err) {
      postOut('ERROR', `Compositor initialization failed: ${err.message}`);
      cleanupRecordingResources();
      return;
    }

    // ── Main recorder: video + track #1 audio (the "everything" file) ──
    const primaryTrack = customAudioTracks[0] || { id: 1, name: 'EVERYONE' };
    const primaryNodes = ensureTrackNodes(primaryTrack.id);
    if (primaryNodes && primaryNodes.destNode) {
      const destTracks = primaryNodes.destNode.stream.getAudioTracks();
      if (destTracks.length > 0) {
        tracks.push(destTracks[0]);
        postOut('INFO', `Primary audio (track ${primaryTrack.id} ${primaryTrack.name}) bound ✓`);
      } else {
        postOut('WARN', `Primary track ${primaryTrack.id} destination has 0 audio tracks`);
      }
    }

    const stream = new MediaStream(tracks);
    postOut('INFO', `Main stream: ${stream.getVideoTracks().length} video, ${stream.getAudioTracks().length} audio`);

    try {
      mediaRecorder = new MediaRecorder(stream, {
        mimeType: recordMimeType,
        videoBitsPerSecond: 3_000_000,
        audioBitsPerSecond: 128_000,
      });
    } catch (err) {
      postOut('ERROR', `MediaRecorder init failed: ${err.message}`);
      cleanupRecordingResources();
      return;
    }

    // ── Secondary recorders: one audio-only file per remaining track ──
    secondaryRecorders.clear();
    const audioMime = MediaRecorder.isTypeSupported(AUDIO_ONLY_MIME)
      ? AUDIO_ONLY_MIME
      : 'audio/webm';
    customAudioTracks.slice(1).forEach(track => {
      const nodes = ensureTrackNodes(track.id);
      if (!nodes || !nodes.destNode) return;
      const audioTracks_ = nodes.destNode.stream.getAudioTracks();
      if (audioTracks_.length === 0) {
        postOut('WARN', `Secondary track ${track.id} (${track.name}) has 0 audio tracks`);
        return;
      }
      const secStream = new MediaStream([audioTracks_[0]]);
      let secRecorder;
      try {
        secRecorder = new MediaRecorder(secStream, { mimeType: audioMime, audioBitsPerSecond: 128_000 });
      } catch (err) {
        postOut('ERROR', `Secondary recorder init failed (track ${track.id}): ${err.message}`);
        return;
      }
      const secRecordingId = `${currentRecordId}__t${track.id}`;
      const entry = { recorder: secRecorder, recordingId: secRecordingId, name: track.name, mimeType: audioMime, chunksSaved: 0, bytesSaved: 0 };
      secRecorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) return;
        const blob = event.data;
        writeChunkToDB(secRecordingId, blob)
          .then(() => {
            entry.chunksSaved++;
            entry.bytesSaved += blob.size;
          })
          .catch(err => {
            console.error('[MeetRecorder] Secondary chunk save error:', err);
            postOut('ERROR', `Track ${track.id} chunk save failed: ${err?.message || err}`);
          });
      };
      secRecorder.onerror = (event) => {
        postOut('ERROR', `Secondary recorder ${track.id} error: ${event.error?.message || 'unknown'}`);
      };
      secondaryRecorders.set(track.id, entry);
      postOut('INFO', `Secondary audio recorder bound: track ${track.id} (${track.name}) → ${secRecordingId}`);
    });

    mediaRecorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      const rid = currentRecordId;
      const blob = event.data;
      writeChunkToDB(rid, blob)
        .then(() => {
          chunksSaved++;
          bytesSaved += blob.size;
          postOut('CHUNK_SAVED', {
            count:   chunksSaved,
            totalMB: (bytesSaved / 1_048_576).toFixed(2),
          });
        })
        .catch(err => {
          console.error('[MeetRecorder] Chunk pipeline error:', err);
          postOut('ERROR', `Chunk save failed: ${err?.message || err}`);
        });
    };

    mediaRecorder.onerror = (event) => {
      postOut('ERROR', `MediaRecorder error: ${event.error?.message || 'unknown'}`);
      isRecording = false;
      if (audioCtx) {
        trackGains.forEach(gainNode => {
          try { gainNode.gain.setTargetAtTime(0, audioCtx.currentTime, 0.05); } catch (_) {}
        });
      }
      stopCompositorLoop();
      updateLocalMicSource();
      setTimeout(cleanupRecordingResources, 3000);
    };

    mediaRecorder.onstop = () => {
      isRecording = false;
      if (audioCtx) {
        trackGains.forEach(gainNode => {
          try { gainNode.gain.setTargetAtTime(0, audioCtx.currentTime, 0.05); } catch (_) {}
        });
      }
      stopCompositorLoop();
      updateLocalMicSource();
      const secondaries = [];
      secondaryRecorders.forEach((entry, trackId) => {
        secondaries.push({
          trackId,
          name: entry.name,
          recordingId: entry.recordingId,
          mimeType: entry.mimeType,
          chunks: entry.chunksSaved,
          mb: (entry.bytesSaved / 1_048_576).toFixed(2),
        });
      });
      postOut('RECORDING_STOPPED', {
        totalChunks: chunksSaved,
        totalMB: (bytesSaved / 1_048_576).toFixed(2),
        secondaries,
      });
      setTimeout(cleanupRecordingResources, 3000);
    };

    isRecording = true;
    mediaRecorder.start(2000);
    secondaryRecorders.forEach((entry, trackId) => {
      try { entry.recorder.start(2000); } catch (err) {
        postOut('ERROR', `Failed to start secondary recorder ${trackId}: ${err.message}`);
      }
    });
    startCompositorLoop(drawCompositorFrame);

    postOut('RECORDING_STARTED', {
      mimeType:     recordMimeType,
      hasVideo:     true,
      hasAudio:     stream.getAudioTracks().length > 0,
      audioSources: audioSources.size, // Push to popup so it doesn't need refresh
      recordingId:  currentRecordId,
    });

    console.log(`[MeetRecorder] Recording started (id=${currentRecordId}, mime=${recordMimeType}, audioSources=${audioSources.size})`);
  }

  function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      // The recorder is already dead (e.g. it errored out earlier) but the
      // popup still thinks we're recording — clicking Stop otherwise no-ops
      // forever. Tell the outside to reset to idle so the UI un-sticks.
      postOut('WARN', 'Recorder not active');
      isRecording = false;
      stopCompositorLoop();
      postOut('RECORDING_IDLE', { reason: 'recorder-not-active' });
      return;
    }
    mediaRecorder.requestData();
    mediaRecorder.stop();
    secondaryRecorders.forEach((entry, trackId) => {
      try {
        if (entry.recorder.state !== 'inactive') {
          entry.recorder.requestData();
          entry.recorder.stop();
        }
      } catch (err) {
        postOut('WARN', `Secondary recorder ${trackId} stop failed: ${err.message}`);
      }
    });
    stopCompositorLoop();
    updateLocalMicSource();
  }

  function pauseRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.pause();
      secondaryRecorders.forEach(entry => {
        try { if (entry.recorder.state === 'recording') entry.recorder.pause(); } catch (_) {}
      });
      stopCompositorLoop();
      updateLocalMicSource();
      postOut('RECORDING_PAUSED');
      console.log('[MeetRecorder] Recording paused');
    }
  }

  function resumeRecording() {
    if (mediaRecorder && mediaRecorder.state === 'paused') {
      mediaRecorder.resume();
      secondaryRecorders.forEach(entry => {
        try { if (entry.recorder.state === 'paused') entry.recorder.resume(); } catch (_) {}
      });
      startCompositorLoop(drawCompositorFrame);
      postOut('RECORDING_RESUMED');
      console.log('[MeetRecorder] Recording resumed');
    }
  }

  // ─── Messaging ────────────────────────────────────────────────────────────
  function postOut(event, data) {
    window.postMessage({ source: MSG_SOURCE_OUT, type: 'EVENT', event, data }, '*');
  }

  window.addEventListener('message', (e) => {
    if (!e.data || e.data.source !== MSG_SOURCE_CMD) return;
    const { cmd, recordingId, bgUrl } = e.data;

    switch (cmd) {
      case 'INIT':
        currentBgUrl = bgUrl || '';
        if (currentBgUrl && bgImg.src !== currentBgUrl) {
          bgLoaded = false;
          bgImg.src = currentBgUrl;
          console.log('[MeetRecorder] Pre-loading cozy background from INIT command');
        }
        break;
      case 'START':
        currentRecordId = recordingId || `rec_${Date.now()}`;
        if (bgUrl && bgImg.src !== bgUrl) {
          bgLoaded = false;
          bgImg.src = bgUrl;
          console.log('[MeetRecorder] Loading cozy background from START command');
        }
        startRecording();
        break;
      case 'STOP':
        stopRecording();
        break;
      case 'PAUSE':
        pauseRecording();
        break;
      case 'RESUME':
        resumeRecording();
        break;
      case 'RESCAN_MEDIA':
        rescanExistingMediaElements();
        break;
      case 'SET_RECORD_MY_MIC':
        setRecordMyMic(!!e.data.enabled);
        break;
      case 'SET_MUTE':
        setMuteAllMics(!!e.data.mute);
        break;
      case 'SET_RECORD_CHOSEN_ONLY':
        recordChosenOnly = !!e.data.enabled;
        rebuildAudioGraph();
        console.log(`[MeetRecorder] recordChosenOnly set to: ${recordChosenOnly}`);
        break;
      case 'SET_CHOSEN_SPEAKERS':
        chosenSpeakers = e.data.list || [];
        rebuildAudioGraph();
        console.log('[MeetRecorder] chosenSpeakers set to:', chosenSpeakers);
        break;
      case 'FORCE_NO_SCREEN_SHARE':
        forceNoScreenShare = !!e.data.enabled;
        if (forceNoScreenShare) {
          postOut('INFO', 'Screenshare ignored — showing background');
        } else {
          postOut('INFO', 'Screenshare detection re-enabled');
        }
        console.log(`[MeetRecorder] forceNoScreenShare set to: ${forceNoScreenShare}`);
        break;
      case 'SET_AUDIO_TRACKS':
        customAudioTracks = e.data.list || [];
        reconcileCustomTrackNodes();
        rebuildAudioGraph();
        console.log('[MeetRecorder] customAudioTracks set to:', customAudioTracks);
        break;
      case 'SET_VIP_LIST':
        vipList = e.data.list || [];
        rebuildAudioGraph();
        console.log('[MeetRecorder] vipList set to:', vipList);
        break;
      case 'SET_VIPS_ENABLED':
        vipsEnabled = !!e.data.enabled;
        rebuildAudioGraph();
        console.log('[MeetRecorder] vipsEnabled set to:', vipsEnabled);
        break;
      case 'STATUS': {
        rescanExistingMediaElements();
        scanDomForScreenShare(true);
        const participants = [];
        audioTracks.forEach((track, trackId) => {
          const pInfo = getParticipantForTrack(trackId);
          if (pInfo && pInfo.name && !participants.some(p => p.name === pInfo.name)) {
            participants.push({ name: pInfo.name, avatarUrl: pInfo.avatarUrl });
          }
        });
        
        try {
          const domSpeakers = scanActiveSpeakersFromDOM();
          domSpeakers.forEach(s => {
            if (s.name && !participants.some(p => p.name === s.name)) {
              participants.push({ name: s.name, avatarUrl: s.avatarUrl });
            }
          });
        } catch (_) {}

        // Also scrape every [data-participant-id] tile so the popup VIP picker
        // shows everyone visible, even if they haven't spoken yet. Large-meeting
        // Meet virtualizes tiles to ~3-9 at a time so this list isn't complete,
        // but it's far better than the empty list we were sending.
        try {
          document.querySelectorAll('[data-participant-id]').forEach(tile => {
            const moreBtn = tile.querySelector('[aria-label^="More options for"]');
            if (!moreBtn) return;
            const label = moreBtn.getAttribute('aria-label') || '';
            const name = label.replace(/^More options for\s+/, '').trim();
            if (!name || participants.some(p => p.name === name)) return;
            const imgEl = tile.querySelector('img[src*="googleusercontent"][src*="s200"]')
                       || tile.querySelector('img[src*="googleusercontent"]');
            const avatarUrl = imgEl ? imgEl.src.replace(/=s\d+-/, '=s200-').replace(/\?theming$/, '') : null;
            participants.push({ name, avatarUrl });
          });
        } catch (_) {}

        postOut('STATUS_RESPONSE', {
          isRecording,
          isPaused: mediaRecorder ? mediaRecorder.state === 'paused' : false,
          hasScreenShare: !!screenShareTrack,
          videoTracks:    allVideoTracks.length,
          audioSources:   audioSources.size,
          mimeType:       recordMimeType,
          videoSizes:     allVideoTracks.map(t => ({
            id: t.id,
            w:  videoProbes.get(t.id)?.videoWidth  ?? 0,
            h:  videoProbes.get(t.id)?.videoHeight ?? 0,
          })),
          participants,
          recordRemoteMics,
          recordMyMic,
          isRecordingMuted,
          forceNoScreenShare,
          recordChosenOnly,
          chosenSpeakers,
          vipsEnabled,
          vipList,
          customAudioTracks
        });
        break;
      }
      default:
        break;
    }
  });

  const resumeAudio = () => {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().then(() => {
        console.log('[MeetRecorder] AudioContext resumed successfully');
        postOut('INFO', 'AudioContext resumed successfully via page gesture');
      }).catch(err => {
        console.warn('[MeetRecorder] AudioContext resume failed:', err);
        postOut('WARN', `AudioContext resume failed: ${err.message}`);
      });
    }
  };
  window.addEventListener('click', resumeAudio, { passive: true });
  window.addEventListener('mousedown', resumeAudio, { passive: true });
  window.addEventListener('keydown', resumeAudio, { passive: true });
  window.addEventListener('touchstart', resumeAudio, { passive: true });

  // ─── Debug helper — call __meetRecDumpDOM() in the Meet tab's DevTools to
  // print everything we can scrape about participants. Paste the output back to me.
  window.__meetRecDumpDOM = function() {
    const out = {
      url: location.href,
      selfNameAttrs: [],
      participantTiles: [],
      googleAccountButtons: [],
      videos: [],
      googleUserImgs: [],
      audioTracksKnown: [],
    };

    document.querySelectorAll('[data-self-name]').forEach(el => {
      out.selfNameAttrs.push({
        tag: el.tagName,
        attr: el.getAttribute('data-self-name'),
        text: (el.textContent || '').trim().slice(0, 80),
        parentTag: el.parentElement?.tagName,
      });
    });

    document.querySelectorAll('[data-participant-id]').forEach(el => {
      const img = el.querySelector('img');
      out.participantTiles.push({
        id: el.getAttribute('data-participant-id'),
        aria: el.getAttribute('aria-label'),
        textSample: (el.textContent || '').trim().slice(0, 120),
        imgSrc: img ? img.src : null,
        hasVideo: !!el.querySelector('video'),
      });
    });

    document.querySelectorAll('[aria-label*="Google Account"], a[aria-label*="Account"], button[aria-label*="Account"]').forEach(el => {
      out.googleAccountButtons.push({
        tag: el.tagName,
        aria: el.getAttribute('aria-label'),
        title: el.title,
        imgSrc: el.querySelector('img')?.src,
      });
    });

    document.querySelectorAll('video').forEach(vid => {
      const stream = vid.srcObject;
      out.videos.push({
        streamId: stream?.id,
        videoTracks: stream ? stream.getVideoTracks().map(t => ({ id: t.id, label: t.label })) : [],
        audioTracks: stream ? stream.getAudioTracks().map(t => ({ id: t.id, label: t.label })) : [],
        w: vid.videoWidth,
        h: vid.videoHeight,
        closestParticipantId: vid.closest('[data-participant-id]')?.getAttribute('data-participant-id'),
        parentChainText: (function() {
          let p = vid.parentElement, chain = [];
          for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
            chain.push({
              tag: p.tagName,
              cls: (p.className || '').toString().slice(0, 60),
              dataAttrs: Array.from(p.attributes).filter(a => a.name.startsWith('data-')).map(a => `${a.name}=${a.value}`).join(','),
              textSample: (p.textContent || '').trim().slice(0, 80),
            });
          }
          return chain;
        })(),
      });
    });

    document.querySelectorAll('img[src*="googleusercontent"]').forEach(img => {
      out.googleUserImgs.push({
        src: img.src.slice(0, 200),
        alt: img.alt,
        parentTag: img.parentElement?.tagName,
        closestParticipantId: img.closest('[data-participant-id]')?.getAttribute('data-participant-id'),
        closestAria: img.closest('[aria-label]')?.getAttribute('aria-label'),
      });
    });

    audioSources.forEach((_, trackId) => {
      out.audioTracksKnown.push({
        trackId,
        streamId: trackStreamMap.get(trackId),
        cachedName: audioTrackToParticipant.get(trackId)?.name,
        level: audioLevels.get(trackId),
      });
    });

    console.log('[MeetRecorder DEBUG DUMP]', JSON.stringify(out, null, 2));
    return out;
  };

  postOut('INJECTED', { version: '1.7.2' });
  console.log('[MeetRecorder] injected.js v1.7.2 active — tile-based participant resolver tuned to current Meet DOM (data-participant-id + self markers + s200 avatars)');
})();
