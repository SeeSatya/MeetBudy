# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Meet Budy" — an unpacked Chrome MV3 extension that records Google Meet screen shares plus participant audio, entirely in-browser. No build step, no bundler, no package manager. To run it: load the folder via `chrome://extensions` → Developer Mode → Load unpacked. After any code change you must click the extension's reload icon **and** hard-refresh (`Ctrl+Shift+R`) any open Meet tab — content scripts only re-inject on a fresh page load.

There are no tests, no lint config, and no CI. Validation is manual: record a real Meet call and read the popup Logs panel + the Meet tab's DevTools console (`[MeetRecorder]` / `[MeetBudyMuxer]` / `[ffmpeg]` prefixes).

## Why the architecture is the way it is

Google Meet is WebRTC — there is no stream URL to grab. The only way to capture remote media is to intercept it inside the page before Meet uses it. That single constraint dictates the whole design:

**Four execution contexts, each in its own file, talking only by message-passing:**

- **`injected.js`** runs in the **page's main world** (injected as a `<script>` tag by content_script, because the extension's isolated world can't patch the page's `RTCPeerConnection`). This is where everything real happens: it patches `RTCPeerConnection` via `Reflect.construct` to capture every incoming audio/video track, builds the Web Audio mixing graph, runs the canvas compositor, and owns the `MediaRecorder`(s). ~2300 lines — the heart of the project. It cannot use any `chrome.*` API; it talks to the outside only via `window.postMessage` with `source: 'MEET_REC_PAGE'` (out) / `'MEET_REC_CMD'` (in).
- **`content_script.js`** runs in the **extension's isolated world** on meet.google.com. It injects injected.js, bridges page↔extension messages, owns IndexedDB chunk assembly + the WebM duration fixer, triggers downloads, and drives the optional ffmpeg mux. Has `chrome.*` access.
- **`background.js`** is the service worker — a stateless message relay between popup and the active Meet tab, plus it persists `recordingState` to `chrome.storage.local` so the popup can restore mid-recording on reopen.
- **`popup/`** is the UI (vanilla HTML/CSS/JS, no framework). Sends commands, renders state, manages the audio-track and VIP configuration.

**Message flow for any user action** (e.g. Start): popup → `chrome.runtime.sendMessage` → background → `chrome.tabs.sendMessage` → content_script → `window.postMessage` → injected.js. Events flow back the reverse way. When adding a new command you must thread it through **all four** files: a `case` in injected.js's `window.addEventListener('message')` switch, the relay allowlist in `background.js`, the bridge in content_script.js, and the sender in popup.js.

## Audio engine (the part most likely to bite you)

The Web Audio graph in `injected.js` is per-track: `[per-source GainNodes] → [track mixer GainNode] → [gate GainNode] → [MediaStreamAudioDestinationNode]`. The **gate** is held at gain 0 until recording starts and is what mute/unmute toggles. `rebuildAudioGraph()` re-wires which participant sources feed which track mixer based on the popup's track config (`customAudioTracks`, each `{id, name, targets[]}` where targets are `'EVERYONE'`, `'VIP_ONLY'`, `'ME'`, or a participant name).

Two Chrome WebRTC quirks are load-bearing — do not "simplify" them away:
1. `createMediaStreamSource` on a **remote** track yields silence unless the same MediaStream is also attached to a live `HTMLMediaElement`. We attach a hidden muted `<audio>` sink per remote track to prime it.
2. Chrome honors only the **first** `createMediaStreamSource` per remote track. The analyser (for speaker-volume detection) must tap the *same* source node, never create a second one.

**Multi-track output:** browsers can't mux multiple audio tracks into one MediaRecorder file. So `startRecording()` spins up **N parallel MediaRecorders** — one main (video + track #1 audio) and one audio-only per additional track, each writing chunks to IndexedDB under `${recordingId}__t${trackId}`. On stop, content_script downloads each separately, **then** optionally muxes them into one MKV.

## The mux pipeline (`muxer.js` + `vendor/ffmpeg/`)

ffmpeg.wasm remuxes the N raw files into a single MKV with all audio tracks **and** fixes the cluster timestamps that make chunked MediaRecorder output unplayable in WMP/VLC. It is strictly optional and **degrades safely**: if `vendor/ffmpeg/ffmpeg-core.js` + `.wasm` are absent, `isAvailable()` returns false and the step is skipped — you keep the raw files. The `RECORDING_STOPPED` handler in content_script.js is deliberately ordered **raw-save first, mux second, clear IDB last**, so a mux crash can never lose a recording.

Critical MV3 gotcha already solved here: a content script **cannot** `new Worker('chrome-extension://...')` — Worker construction is gated by the page origin. So muxer.js `fetch()`es the core JS as text + wasm as bytes and builds a **Blob-URL worker** with the core inlined and the wasm passed via `wasmBinary`. Don't refactor this back to a direct extension-URL worker.

ffmpeg vendor files are not committed (32MB). Install them with:
```
$dest = "vendor\ffmpeg"; $base = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd"
Invoke-WebRequest "$base/ffmpeg-core.js"   -OutFile "$dest\ffmpeg-core.js"
Invoke-WebRequest "$base/ffmpeg-core.wasm" -OutFile "$dest\ffmpeg-core.wasm"
```
(0.12.x has no separate `worker.js`.) Output files: `*_full.mkv` (main), `*_track-N-NAME.webm` (each extra audio), `*_combined.mkv` (muxed).

## Google Meet DOM is unstable — treat it as hostile

Meet's DOM changes often and **virtualizes participant tiles**: in an 80+ person call only ~3–9 `[data-participant-id]` tiles exist in the DOM at any moment, so you can never enumerate everyone by scraping. Known-good signals as of mid-2026 (verify with the `window.__meetRecDumpDOM()` helper at the bottom of injected.js before trusting any selector):
- Participant name: the `[aria-label^="More options for <Name>"]` button inside a tile.
- Self tile: identified by self-only UI strings (`"You're continuously framed"`, `"Backgrounds and effects"`, `frame_person`, `visual_effects`) — `[data-self-name]` no longer exists.
- Avatars: `img[src*="googleusercontent"]`; upgrade resolution by rewriting `=s31-...` → `=s200-...`.
- Screen share: a 1920×1080-ish `<video>` plus a `<section aria-label="Presentation">`. WebRTC track probing (resolution/contentHint heuristics in `probeVideoTrack`) is the primary detector; DOM is the fallback.

## Persistence & known weak spots

- Recording chunks live in IndexedDB (`MeetRecorderDB`/`chunks`) keyed by recordingId, so a network drop or tab reload doesn't lose data. They're cleared only after successful download+mux.
- The canvas compositor runs at 30fps and the audio analysers poll on timers — on mobile (e.g. Mises browser) or large meetings this is the main cause of lag; multiple parallel MediaRecorders compound it.
- Speaker overlay cards render only when **no** screen share is active (so they don't cover slides); see the `showingScreen` guard in `drawCompositorFrame`.
- Open follow-ups not yet fixed: AudioContext nodes aren't fully disconnected across track lifecycles (memory growth over a long session), and popup state can desync if closed mid-recording.
