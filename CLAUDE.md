# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Meet Budy" — an unpacked Chrome MV3 extension that records Google Meet screen shares plus participant audio, entirely in-browser. No build step, no bundler, no package manager. To run it: load the folder via `chrome://extensions` → Developer Mode → Load unpacked. After any code change you must click the extension's reload icon **and** hard-refresh (`Ctrl+Shift+R`) any open Meet tab — content scripts only re-inject on a fresh page load.

Run the source-executing lifecycle tests with `node --test tests/*.test.cjs` (Node 18+; no package installation). The fixtures simulate browser/extension APIs and check resource ownership, event ordering, failures, and recovery. One test uses the optional installed ffmpeg core and skips when vendor files are absent. There is no lint config or CI. Native browser validation still requires recording a real Meet call and reading the popup Logs panel + the Meet tab's DevTools console (`[MeetRecorder]` / `[MeetBudyMuxer]` / `[ffmpeg]` prefixes). See `docs/memory-leak-fixes.md` for scope and verification limits.

## Why the architecture is the way it is

Google Meet is WebRTC — there is no stream URL to grab. The only way to capture remote media is to intercept it inside the page before Meet uses it. That single constraint dictates the whole design:

**Four execution contexts, each in its own file, talking only by message-passing:**

- **`injected.js`** runs in the **page's main world** (injected as a `<script>` tag by content_script, because the extension's isolated world can't patch the page's `RTCPeerConnection`). This is where everything real happens: it patches `RTCPeerConnection` via `Reflect.construct` to capture every incoming audio/video track, builds the Web Audio mixing graph, runs the canvas compositor, and owns the `MediaRecorder`(s). ~2300 lines — the heart of the project. It cannot use any `chrome.*` API; it talks to the outside only via `window.postMessage` with `source: 'MEET_REC_PAGE'` (out) / `'MEET_REC_CMD'` (in).
- **`content_script.js`** runs in the **extension's isolated world** on meet.google.com. It injects injected.js, bridges page↔extension messages, owns IndexedDB chunk assembly, calls `webm_metadata.js` for complete-container metadata, triggers downloads, and drives the optional ffmpeg mux. Has `chrome.*` access.
- **`background.js`** is the service worker — it relays messages, persists `recordingState`, serializes revision-checked mutations of per-recording recovery jobs, and routes saved-recording actions to a tab with the matching storage origin. Accepted combine claims have execution tokens plus actual tab/document ownership, separate from immutable recording source ownership. Only the matching accepted owner may release a claim; liveness queries reconcile claims after close/reload/restart and preserve unknown owners conservatively.
- **`popup/`** is the UI (vanilla HTML/CSS/JS, no framework). Sends commands, renders state, manages the audio-track and VIP configuration.

**Message flow for any user action** (e.g. Start): popup → `chrome.runtime.sendMessage` → background → `chrome.tabs.sendMessage` → content_script → `window.postMessage` → injected.js. Events flow back the reverse way. When adding a new command you must thread it through **all four** files: a `case` in injected.js's `window.addEventListener('message')` switch, the relay allowlist in `background.js`, the bridge in content_script.js, and the sender in popup.js.

## Audio engine (the part most likely to bite you)

The Web Audio graph in `injected.js` is per-track: `[per-source GainNodes] → [track mixer GainNode] → [gate GainNode] → [MediaStreamAudioDestinationNode]`. The **gate** is held at gain 0 until recording starts and is what mute/unmute toggles. `rebuildAudioGraph()` re-wires which participant sources feed which track mixer based on the popup's track config (`customAudioTracks`, each `{id, name, targets[]}` where targets are `'EVERYONE'`, `'VIP_ONLY'`, `'ME'`, or a participant name).

Two Chrome WebRTC quirks are load-bearing — do not "simplify" them away:
1. `createMediaStreamSource` on a **remote** track yields silence unless the same MediaStream is also attached to a live `HTMLMediaElement`. We attach a hidden muted `<audio>` sink per remote track to prime it.
2. Chrome honors only the **first** `createMediaStreamSource` per remote track. The analyser (for speaker-volume detection) must tap the *same* source node, never create a second one.

**Multi-track output:** browsers can't mux multiple audio tracks into one MediaRecorder file. So `startRecording()` spins up **N parallel MediaRecorders** — one main (video + track #1 audio) and one audio-only per additional track, each writing chunks to IndexedDB under `${recordingId}__t${trackId}`. On stop, content_script downloads each separately, **then** optionally muxes them into one MKV.

Each accepted recording session owns immutable IDs/output metadata, its recorders/canvas, final events, and pending chunk writes. START remains guarded through startup and finalization. Output configuration edits apply to the next session. Completion follows all final recorder events and accepted write transactions; consume its `recordingId`, `mimeType`, `secondaries`, and `writeFailed` in the bridge. Retire observed tracks on ended/ended readyState or actual peer close; failed/disconnected ICE states can recover and must preserve the original source/sink. Rebuild every accepted session's routing before starting recorders, including after a failed next-graph setup.

## The mux pipeline (`muxer.js` + `vendor/ffmpeg/`)

ffmpeg.wasm remuxes the N raw files into a single MKV with all audio tracks **and** fixes the cluster timestamps that make chunked MediaRecorder output unplayable in WMP/VLC. It is strictly optional: if `vendor/ffmpeg/ffmpeg-core.js` + `.wasm` are absent, `isAvailable()` returns false — raw files remain available. The `RECORDING_STOPPED` handler in content_script.js is deliberately ordered **raw-save first, mux second, clear IDB last**. Raw main and secondary outputs first pass through `MeetBudyMetadata.finalize`, which builds a finite Segment, media-timestamp Duration, SeekHead and real Cues while preserving encoded blocks as Blob slices. Do not restore the first-chunk duration patcher or estimate duration from recovery wall time. Use the returned container MIME/extension; metadata failure must retain recovery data and report an honest warning. Capture the exact mux API for an operation and terminate it in finally. Its stable installation guard, cancellation/deadlines, partial-allocation disposer, and worker filesystem finally must release failed or abandoned work.

Critical MV3 gotcha already solved here: a content script **cannot** `new Worker('chrome-extension://...')` — Worker construction is gated by the page origin. So muxer.js `fetch()`es the core JS as text + wasm as bytes and builds a **Blob-URL worker** with the core inlined and the wasm passed via `wasmBinary`. Don't refactor this back to a direct extension-URL worker.

ffmpeg vendor files are not committed (32MB). Install them with:
```
$dest = "vendor\ffmpeg"; $base = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd"
Invoke-WebRequest "$base/ffmpeg-core.js"   -OutFile "$dest\ffmpeg-core.js"
Invoke-WebRequest "$base/ffmpeg-core.wasm" -OutFile "$dest\ffmpeg-core.wasm"
```
(0.12.x has no separate `worker.js`.) Output files: `*_full.webm` or `*_full.mkv` according to the container and codecs (main), `*_track-N-NAME.webm` for WebM audio (each extra output), `*_combined.mkv` (optional muxed output).

## Google Meet DOM is unstable — treat it as hostile

Meet's DOM changes often and **virtualizes participant tiles**: in an 80+ person call only ~3–9 `[data-participant-id]` tiles exist in the DOM at any moment, so you can never enumerate everyone by scraping. Known-good signals as of mid-2026 (verify with the `window.__meetRecDumpDOM()` helper at the bottom of injected.js before trusting any selector):
- Participant name: the `[aria-label^="More options for <Name>"]` button inside a tile.
- Self tile: identified by self-only UI strings (`"You're continuously framed"`, `"Backgrounds and effects"`, `frame_person`, `visual_effects`) — `[data-self-name]` no longer exists.
- Avatars: `img[src*="googleusercontent"]`; upgrade resolution by rewriting `=s31-...` → `=s200-...`.
- Screen share: a 1920×1080-ish `<video>` plus a `<section aria-label="Presentation">`. WebRTC track probing (resolution/contentHint heuristics in `probeVideoTrack`) is the primary detector; DOM is the fallback.

## Persistence & known weak spots

- Recording chunks live in IndexedDB (`MeetRecorderDB`/`chunks`) keyed by recordingId. Durable per-recording jobs use `meetBudyPendingCombine:<encoded ID>` storage keys; retained recordings remain discoverable across later recordings/reload. Raw-save failure or `writeFailed` keeps recovery ownership. Cleanup requests persist before deletion and remain retryable until every deletion transaction commits. Scope recording/job statuses and controls by ID/tab/document so saved-job progress or late callbacks cannot reset an unrelated active recording. Background emits `TAB_CLOSED` for every removed tab; popup retires only its matching selected tab even when a different tab owns global recording state. A download success here means browser download initiation, not independently observed OS completion.
- The canvas compositor runs at 30fps and the audio analysers poll on timers — on mobile (e.g. Mises browser) or large meetings this is the main cause of lag; multiple parallel MediaRecorders compound it.
- Speaker overlay cards render only when **no** screen share is active (so they don't cover slides); see the `showingScreen` guard in `drawCompositorFrame`.
- Lifecycle tests cover retirement of track nodes/sinks/probes/listeners, session rollback/finalization, worker/URL disposal, and saved-recording ownership. Reusable live-media AudioContext/source/mixer services are intentional page-lifetime resources. Genuine Meet/Chrome heap, native media allocation, output playback, and long-session behavior still require manual validation; popup state under those native schedules has not been comprehensively measured.

## Recording safety and availability

The popup requires a fresh host/participant permission acknowledgement for Start and displays the personal-use restriction. Background allows Start only on the active HTTPS Google Meet tab. Stop and saved-job actions retain explicit recording ownership. Toolbar availability is per tab, with grayscale defaults for unsupported sites.

Incoming meeting-media availability drives a 10-second Stop countdown, including while paused. Generated compositor/mixer tracks, local microphone/preview tracks and extension sinks cannot keep the meeting alive. Silent audio and static presentations remain available media. Preserve receiver/source ownership across temporary ICE failures so a reconnect can cancel the countdown.

Request `beforeunload` confirmation while starting, recording, finalizing or saving; never stop on a cancelled close attempt. `pagehide` can flush best-effort on actual teardown. Chrome controls dialog policy; forced shutdown bypasses it. Recorder stop and storage flush have bounded waits; timed-out completion is incomplete and must retain committed chunks for recovery. A late callback cannot reset a later session. See `docs/recording-safety-compatibility.md` for native checks and limits.
