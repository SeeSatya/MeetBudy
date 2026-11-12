# Meet Budy — Project Documentation

An installation, usage, architecture, and maintenance guide for the MeetBud project.

| Item | Value |
| --- | --- |
| Extension name | Meet Budy |
| Repository folder | MeetBud |
| Manifest version | Chrome Manifest V3 |
| Extension version | 1.0.0, as declared in `manifest.json` |
| Documentation date | November 12, 2026 |
| Source snapshot | Git commit `3b89844` |
| Main platform | Desktop Chrome, on `https://meet.google.com/*` |
| Implementation | JavaScript, HTML, CSS, browser media APIs, IndexedDB |
| Build system | None; load the source folder directly |

This guide describes the checked-in implementation. Older files use the name “Meet Recorder,” and comments contain other internal version labels. The manifest is the authority for the packaged extension name and version. The existing README includes historical warnings that do not fully describe the current implementation; current source behavior and remaining browser-validation limits are distinguished below.

## Contents

1. [Project overview](#1-project-overview)
2. [Requirements and installation](#2-requirements-and-installation)
3. [Recording a meeting](#3-recording-a-meeting)
4. [Controls, audio tracks, and VIPs](#4-controls-audio-tracks-and-vips)
5. [Output files and optional FFmpeg](#5-output-files-and-optional-ffmpeg)
6. [Saved recordings and recovery](#6-saved-recordings-and-recovery)
7. [Architecture and source layout](#7-architecture-and-source-layout)
8. [Media capture internals](#8-media-capture-internals)
9. [Messaging reference](#9-messaging-reference)
10. [Storage and resource ownership](#10-storage-and-resource-ownership)
11. [Development and verification](#11-development-and-verification)
12. [Troubleshooting and limitations](#12-troubleshooting-and-limitations)
13. [Permissions, privacy, and distribution](#13-permissions-privacy-and-distribution)

## 1. Project overview

Meet Budy is an unpacked Chrome extension that records a Google Meet presentation and participant audio inside the browser. It intercepts incoming WebRTC media, mixes selected audio sources, and records a canvas that shows either a presentation or a background with speaker cards.

The project has no application server, database server, account system, bundler, or package-manager setup. Recording and optional file combining run locally. The extension contains no recording-upload feature.

### Main capabilities

- Capture a detected screen share without opening a separate screen-selection dialog.
- Record remote participant audio in a default “EVERYONE” mix.
- Optionally include the user's microphone from the audio track Meet is already sending.
- Configure additional audio outputs using roles or resolved participant names.
- Select VIP participants and create VIP-only mixes.
- Show a background and participant name/avatar cards when no presentation is being drawn.
- Save recording chunks incrementally to IndexedDB.
- Download the main recording and separate additional audio files.
- Optionally combine outputs into a single MKV using locally installed ffmpeg.wasm.
- Keep deferred recordings separately and recover stored portions after interrupted saves.
- Expose stream counts, a timer, settings, and recording logs in the popup.

### What the recording contains

| Source | Behavior |
| --- | --- |
| Detected presentation | Drawn into the recording canvas when STREAMs is enabled |
| Remote participant audio | Included according to the output's selected targets; VOICEs must be enabled |
| Your microphone | Off by default; requires YOUR MIC and an applicable output target |
| Your webcam | Not directly recorded as a webcam video |
| Other participants' webcams | Not intentionally recorded as a meeting grid; video classification uses heuristics |
| Background and speaker cards | Drawn when no screen share is being displayed |

Screen-share classification is heuristic, so a high-resolution camera can be misclassified. “EVERYONE” refers to available captured sources, not a guarantee that every meeting participant has an independently identifiable audio track.

## 2. Requirements and installation

### Requirements

- Desktop Chrome with Manifest V3, WebRTC, Web Audio, `MediaRecorder`, canvas capture, and IndexedDB support.
- Access to a Google Meet meeting.
- Enough local disk space and memory for recording, file assembly, and optional combining.
- Node.js 18 or later only if you want to run the automated regression tests.
- Internet access to download the optional FFmpeg core during setup. The installed core is loaded from extension resources during combining.

Other Chromium browsers may support the extension, but this repository does not establish a complete compatibility matrix. Mobile-browser performance and behavior need separate validation.

### Install as an unpacked extension

1. Obtain the project folder and extract it if necessary.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the project root: the folder containing `manifest.json`, not `popup/` or `docs/`.
6. Pin Meet Budy from Chrome's extension menu.
7. Reload any already-open Meet page before using the recorder. Ideally, install the extension before opening the meeting.

There is no `npm install`, build command, `.env` file, or server to start.

### After changing extension code

Click the extension's reload button in `chrome://extensions`, then hard-refresh the Meet page using `Ctrl+Shift+R` or the platform equivalent. Stop and save any active recording first. Reloading the extension alone does not replace code already running in an open page.

## 3. Recording a meeting

1. Join a Google Meet meeting with the extension already installed.
2. Open the extension popup and use **Reload Streams & Voices** to inspect current media.
3. Confirm VOICEs is enabled. Leave YOUR MIC disabled unless you want your own outgoing audio included.
4. Configure audio tracks and VIPs before starting, if needed.
5. If you want presentation video, confirm a presenter is sharing and the STREAM count reflects detection.
6. Click the circular record button to start.
7. Open **Logs** to inspect recording events, saved chunk counts, and size information.
8. Click the record button again to stop. Let file assembly and download initiation finish.
9. Check Chrome's downloads and open the generated files to confirm playback and audio.
10. If multiple audio outputs were recorded, act on the saved-recording prompt to combine them, defer the job, or keep only the raw downloads.

The recorder can start without a screen share; it then records the background and speaker cards. Presentations appearing or ending during recording are handled by the compositor's detection and fallback logic. Validate those transitions in your actual browser before relying on a long recording.

**Stop before leaving the meeting, closing the tab, reloading the page, or restarting Chrome.** Recovery can restore persisted chunks, but cannot recreate final media events or data that never reached storage.

The popup does not need to stay open for the page's recorder to run. Reopening it restores recording controls from extension state and requests fresh page status.

## 4. Controls, audio tracks, and VIPs

### Popup controls

| Control | Purpose | Initial default |
| --- | --- | --- |
| Record button | Start recording, then stop and save | Idle |
| Pause button | Pause or resume owned recorders | Disabled while idle |
| Reload Streams & Voices | Request current status and rescan available media | Available |
| YOUR MIC | Include eligible outgoing Meet microphone audio | Off |
| VOICEs | Open or mute recording audio gates; turning it off mutes all recording outputs | On |
| STREAMs | Allow presentations; turning it off forces the background view | On |
| VIPs | Enable VIP-based routing and VIP selection controls | Off |
| Settings | Open Advance Mode and Re-inject Recorder controls | Closed |
| Logs | Show recording diagnostics and clear displayed logs | Closed |

VOICEs controls the recording mix; it does not mute participants inside Meet. YOUR MIC uses an existing live, enabled sender track rather than requesting independent microphone access. A muted or unavailable Meet microphone may therefore provide no usable local audio.

Pause/resume exists in the current implementation and is covered by simulated lifecycle tests. The old README warns that pausing is unreliable; real-browser timing, duration metadata, and resulting playback still require validation. The displayed timer and duration metadata should not be treated as an exact measurement of recorded media time across pauses or delayed recovery.

Advance Mode is stored as a UI preference. The current implementation does not establish a separate recording engine or distinct capture mode behind that setting.

### Configuring audio outputs

The default output is track 1, named **EVERYONE**. Open **Audio Tracks**, click **+** to add an output, and choose its targets. Click an existing track pill to edit it.

| Target | Routing rule |
| --- | --- |
| `EVERYONE` | Include captured remote audio, and local audio when YOUR MIC permits it |
| `VIP_ONLY` | Include remote sources resolved to VIP names while VIPs is enabled |
| `ME` | Include eligible local microphone audio while YOUR MIC is enabled |
| Participant name | Include a source whose resolved participant name matches the selection |

An output can select more than one target. A newly added output starts with no targets, so choose its sources before recording. At least one output remains available; adding or removing outputs renumbers the configured tracks.

Example configuration:

```text
Track 1: EVERYONE
Track 2: VIP_ONLY
Track 3: ME
```

This creates one presentation-plus-main-mix recording and two separate audio recordings. Enable VIPs and select VIP names for track 2; enable YOUR MIC and make sure Meet is sending your microphone for track 3.

**Audio-output configuration edits during recording apply to the next recording.** The active session retains its original output IDs, names, targets, and recording destinations through final save. Audio mute, microphone, and VIP controls have their own routing effects; configure them before capture for predictable output.

### VIP and participant identification

Enable VIPs, open the VIP list, and choose participants from the currently resolved names. Those names and output settings persist across popup reopenings.

Google Meet virtualizes participant tiles, so the DOM may show only a small fraction of a large call. Name-to-audio matching also depends on WebRTC stream IDs and available DOM metadata. Individual and VIP-only outputs can therefore miss or misidentify sources in larger meetings. The default broad mix depends less on participant-name resolution.

### Re-injection

The Settings panel provides **Re-inject Recorder → Inject**. Current code guards against duplicate page installation and preserves the managed mux API. The historical README explicitly warns against this control. Use extension reload plus a fresh Meet page as the standard recovery procedure, and test manual re-injection outside an important recording.

## 5. Output files and optional FFmpeg

### Raw outputs

Chrome's supported recording MIME types determine the main container. The preference order is:

1. `video/x-matroska;codecs=h264,opus`
2. `video/webm;codecs=h264,opus`
3. `video/webm;codecs=vp8,opus`
4. `video/webm;codecs=vp9,opus`
5. `video/webm`

The first supported type is used. Additional audio-only recorders use WebM/Opus when supported, with an audio/WebM fallback.

| Filename pattern | Contents |
| --- | --- |
| `meet-recording-<timestamp>_full.mkv` or `_full.webm` | Canvas video and the first audio mix |
| `meet-recording-<timestamp>_track-<id>-<name>.webm` | An additional audio output |
| `meet-recording-<timestamp>_combined.mkv` | Optional combined video with all recorded audio mixes |
| `meet-recording-<timestamp>_recovered.<extension>` | Main file assembled from retained chunks during recovery |

The raw main recording is not automatically saved in both MKV and WebM. Its extension follows the selected MIME type. Additional audio tracks are separate files because the browser recorder cannot produce the desired multi-audio-track container directly.

### Install optional ffmpeg.wasm

Only these two files are required by the current loader:

```text
vendor/ffmpeg/ffmpeg-core.js
vendor/ffmpeg/ffmpeg-core.wasm
```

They are present in this reviewed workspace, but are vendor assets that may be absent from another checkout. The documented core version is `@ffmpeg/core@0.12.6`, using its single-threaded UMD distribution.

Linux/macOS, from the project root:

```sh
mkdir -p vendor/ffmpeg
curl -fL https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js -o vendor/ffmpeg/ffmpeg-core.js
curl -fL https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm -o vendor/ffmpeg/ffmpeg-core.wasm
```

Windows PowerShell, from the project root:

```powershell
New-Item -ItemType Directory -Force -Path 'vendor\ffmpeg' | Out-Null
Invoke-WebRequest 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js' -OutFile 'vendor\ffmpeg\ffmpeg-core.js'
Invoke-WebRequest 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm' -OutFile 'vendor\ffmpeg\ffmpeg-core.wasm'
```

Reload the extension and refresh Meet after installation. A separate `ffmpeg-core.worker.js` is not used by this loader; the old vendor README's three-file instructions are outdated.

### Combining behavior

Stopping a multi-output recording initiates raw downloads first and retains its chunks for the saved-recording prompt. **Do it** remuxes those outputs into MKV using FFmpeg with `-c copy`: existing encoded video/audio are copied rather than re-encoded. The combined file contains the main video, main audio, and each secondary audio stream, with audio titles such as `main-mix` and `track-1`.

FFmpeg rewrites container metadata and can improve seekability of chunked recordings. Playback must still be verified in the intended player. Combining is an additional user action; merely installing the core does not automatically combine every stopped recording.

Missing vendor files or a failed combine leave saved data available for retry. Raw downloads remain usable independently. Single-output recordings follow the raw-save-and-cleanup path and are not automatically sent through FFmpeg for remuxing.

## 6. Saved recordings and recovery

The saved-recording dialog lists retained jobs independently. Starting a later recording does not replace a previous deferred job. Select the intended recording before acting.

| Action | Effect |
| --- | --- |
| **Do it** | Combine a pending recording whose raw outputs have already been saved |
| **Later** | Defer that job's reminder for ten minutes |
| **Keep raw files** | Clear the extension's retained chunks and job after raw downloads; cancel a combine if applicable |
| **Save recording** | Download retained portions of an interrupted or failed recording; a multi-output recovery can then attempt combining |
| **Discard recording** | Delete the selected recovery job's stored media |
| **Retry cleanup** | Finish deletion previously requested but not fully committed |

These cleanup actions affect the browser's retained copy, not files already downloaded to disk. For multi-output recovery, raw saves happen before FFmpeg availability is checked; a missing core can produce a combine error even after recovered raw downloads have been initiated.

Recovery records can survive page reloads and service-worker restarts if media chunks and catalog data persisted. The bridge can also inventory stored recording IDs that lack catalog entries and create recovery jobs. Metadata reconstructed this way may be incomplete.

A `writeFailed` warning means some media did not persist. **Save recording** recovers only the saved portion, and the result may be incomplete or unplayable. Browser storage removal, clearing Meet site data, or missing chunks cannot be undone by this mechanism.

If a job's original tab has closed, a reachable Meet tab with the same storage origin can handle saved-recording actions. Open a Meet tab and retry if the storage owner is unavailable. Failed cleanup keeps a durable entry until deletion succeeds.

Recording controls are scoped to their selected recording and tab. Progress from an older saved job should not reset a newer recording's timer or controls. Closing the selected tab retires its controls; refreshing can select a remaining meeting tab. This is preservation of independent contexts, not a unified multi-meeting dashboard.

## 7. Architecture and source layout

The extension has four execution contexts and an optional worker-based mux service.

| Component | Context | Responsibility |
| --- | --- | --- |
| `injected.js` | Meet page's main JavaScript world | Patch WebRTC, observe media, mix audio, identify speakers, draw canvas, own recorders, write chunks |
| `content_script.js` | Extension isolated world on Meet | Inject page code, bridge messages, assemble/download files, recover stored recordings, run saved jobs |
| `background.js` | MV3 service worker | Relay commands/events, persist recording state, serialize recovery-job updates, route jobs and reconcile execution owners |
| `popup/popup.html` | Extension popup | Interface layout, inline styling, settings and dialogs |
| `popup/popup.js` | Extension popup | Commands, timers, logs, track/VIP preferences, job selection, state rendering |
| `muxer.js` | Content-script context plus Blob worker | Load local FFmpeg core, invoke remuxing, cancel and dispose resources |

The isolated content script cannot directly replace the page's `RTCPeerConnection`. It injects `injected.js` through a script element so interception happens in the page's main world. Page code cannot call `chrome.*`, so extension actions travel through the bridge.

```text
MeetBud/
├── manifest.json
├── background.js
├── content_script.js
├── injected.js
├── muxer.js
├── background_image.png
├── background_image_OLD.png
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── popup/
│   ├── popup.html
│   └── popup.js
├── vendor/ffmpeg/
│   ├── README.txt
│   ├── ffmpeg-core.js       # optional local vendor asset
│   └── ffmpeg-core.wasm     # optional local vendor asset
├── tests/
│   ├── page-lifecycle.test.cjs
│   ├── extension-lifecycle.test.cjs
│   └── fixtures/
│       ├── page-runtime.cjs
│       └── extension-runtime.cjs
├── docs/
│   ├── memory-leak-fixes.md
│   └── MeetBudy-Project-Documentation.md
├── README.md
├── CLAUDE.md
└── .gitignore
```

`background_image.png` is the active compositor background. The older image is retained in the repository. `CLAUDE.md` describes development constraints; `docs/memory-leak-fixes.md` provides the detailed lifecycle audit and historical verification evidence.

## 8. Media capture internals

### WebRTC interception and detection

The page wraps `RTCPeerConnection` using `Reflect.construct`, installs track/lifetime observers, and keeps incoming audio/video registrations. It also scans existing media elements to recover visible tracks when possible. Late injection cannot guarantee capture of every peer or source that existed before interception.

Screen-share detection combines:

- Track labels containing screen, window, tab, display, or monitor.
- `contentHint` values `detail` or `text`.
- Probe video dimensions; one current heuristic treats at least 960 × 540 as screen-like.
- Meet DOM presentation sections and suitable existing video elements.

Probes check metadata, resize events, and delayed observations, and retire their listeners, timers, media elements, and references when no longer needed. Google Meet can change its DOM and media behavior independently of this extension.

### Audio graph

For each remote input, the extension creates a reusable source, an analyser, and a gain node. Matching sources feed each output's mixer, recording gate, and destination:

```text
Remote WebRTC audio track
  → MediaStreamAudioSourceNode
      → AnalyserNode for volume/speaker detection
      → Per-source GainNode
          → Output mixer GainNode
              → Recording gate GainNode
                  → MediaStreamAudioDestinationNode
                      → MediaRecorder audio input
```

Two Chrome-specific constraints are essential to this implementation:

1. A hidden, muted audio element attached to the remote stream primes Web Audio capture.
2. Volume analysis reuses the same source node rather than creating a second source for the remote track.

The local microphone is taken from a live, enabled WebRTC sender and routed only when requested. The code does not independently invoke `getUserMedia()` or `getDisplayMedia()` to capture microphone or desktop media.

### Canvas compositor

The canvas targets 30 frames per second. A Blob worker drives drawing ticks when available, with a page timer fallback. Resolution defaults to 1920 × 1080 and can lock to detected presentation dimensions. Presentation frames are fitted to the canvas. Without a presentation, the background is drawn with speaker overlays based on audio levels and DOM identity/highlight signals.

Speaker cards are deliberately drawn only when no presentation is being shown, keeping slides unobstructed. The compositor records the canvas rather than the whole browser window or Meet UI.

### Recording sessions

The main `MediaRecorder` receives canvas video and the first audio mix. Each additional mix has an independent audio-only recorder. Requested encoding rates are 3,000,000 bits/second for main video and 128,000 bits/second for each recorder's audio; these are encoder requests, not guarantees of file size or quality.

Recorders request data on a two-second timeslice. Chunks are written directly from page code to IndexedDB; lightweight `CHUNK_SAVED` events report progress instead of sending full media blobs through extension messaging.

An accepted session captures immutable output metadata and reserves startup before asynchronous setup. Duplicate starts are refused while that session is starting, active, or finalizing. Stop finalizes every owned recorder and waits for terminal events and accepted storage writes before advertising completion. Unexpected main-recorder stop/error also finalizes independent secondary outputs.

## 9. Messaging reference

User commands follow this route:

```text
Popup
  → chrome.runtime.sendMessage
  → Background service worker
  → chrome.tabs.sendMessage
  → Content script
  → window.postMessage, source: MEET_REC_CMD
  → Page recorder
```

Page events return through `window.postMessage` with source `MEET_REC_PAGE`, then the content script and background relay them to extension views. Saved-recording commands are handled by the extension-side job pipeline rather than the page recorder.

### Common commands

| Extension message | Page command or handler | Main payload |
| --- | --- | --- |
| `START_RECORDING` | `START` | Bridge creates the recording ID and supplies the background URL |
| `STOP_RECORDING` | `STOP` | Optional `targetTabId` for selected recording |
| `PAUSE_RECORDING` | `PAUSE` | Optional `targetTabId` |
| `RESUME_RECORDING` | `RESUME` | Optional `targetTabId` |
| `GET_STATUS` | `STATUS` | Status request |
| `SET_RECORD_MY_MIC` | Same name | `enabled` |
| `SET_MUTE` | Same name | `mute` |
| `FORCE_NO_SCREEN_SHARE` | Same name | `enabled` |
| `SET_AUDIO_TRACKS` | Same name | `list` of `{ id, name, targets }` |
| `SET_VIP_LIST` | Same name | `list` of participant names |
| `SET_VIPS_ENABLED` | Same name | `enabled` |
| `SET_RECORD_CHOSEN_ONLY` | Same name | `enabled`; lower-level routing control |
| `SET_CHOSEN_SPEAKERS` | Same name | `list`; lower-level routing control |
| `FORCE_REINJECT` | Injection retry plus `RESCAN_MEDIA` and status | Bridge-managed operation |
| `RUN_PENDING_COMBINE` | Saved-job execution | Selected `jobId` or job identity |
| `DEFER_PENDING_COMBINE` | Saved-job deferral | Selected job identity |
| `CANCEL_PENDING_COMBINE` | Saved-job cancellation/cleanup | Selected job identity |
| `JOB_STORE` | Background catalog mutation/query | `action`, job ID, revision, execution metadata as applicable |
| `GET_RECORDING_STATE` | Background state lookup | No page command |

Important page events include `INJECTED`, `AUDIO_TRACK_ADDED`, `SCREEN_SHARE_DETECTED`, `SCREEN_SHARE_ENDED`, `RECORDING_STARTED`, `CHUNK_SAVED`, `RECORDING_PAUSED`, `RECORDING_RESUMED`, `RECORDING_STOPPED`, and `STATUS_RESPONSE`, plus diagnostic `INFO`, `WARN`, and `ERROR` events.

The bridge emits scoped `STATUS`, `CHUNK`, and `AUDIO` messages. Recording ID, context ID, and tab ID prevent unrelated jobs or late callbacks from changing current controls. `TAB_CLOSED` lets the popup retire its selected closed context.

To add a page-level command, update the popup sender, background relay allowlist, content-script bridge, and page command switch together. Extension-only job commands follow their catalog/routing handlers instead.

## 10. Storage and resource ownership

### IndexedDB media storage

| Property | Value |
| --- | --- |
| Database | `MeetRecorderDB` |
| Schema version | `1` |
| Object store | `chunks`, with auto-increment keys |
| Index | `by_recording`, on `recordingId` |
| Stored row | `{ recordingId, data }`, where `data` is a media chunk |
| Main recording ID | Session recording ID |
| Secondary recording ID | `<recordingId>__t<trackId>` |

Media storage is associated with the Meet page origin. Both page code and the content bridge access the same named database. Connections can be reopened after close/version-change errors. Write success follows transaction completion, not merely acceptance of an add request.

On stop, the bridge assembles chunks into a Blob and attempts duration metadata repair on the main file's first chunk. Downloads are initiated using a temporary anchor and Blob URL. A “downloaded” status means browser download initiation; the extension does not independently verify operating-system completion or file playback.

### Extension-local metadata

`chrome.storage.local` stores:

- `meetRecorderState`: current/global recording-state metadata.
- `meetBudyTracks`: configured audio outputs.
- `meetBudyVips`: selected VIP names.
- `meetBudyAdvanceMode`: Advance Mode preference.
- `meetBudyToggleMyMic`, `meetBudyToggleVoices`, `meetBudyToggleVips`, and `meetBudyToggleStreams`: popup toggles.
- `meetBudyPendingCombine:<encoded recording ID>`: individual retained recording jobs.

The legacy singleton `meetBudyPendingCombine` is migrated to a per-recording key. Recovery jobs include source origin, recording/output metadata, status, revision, and reminder information. Accepted combine claims additionally record an execution token and actual tab/document ownership.

Common job states are `preparing`, `recording`, `pending`, `combining`, `recovery`, `cleanup`, and `cleanup_requested`. Updates serialize per job and check revisions or execution ownership where required. A late release cannot retire a newer accepted execution claim.

### Cleanup guarantees and limits

- Cleanup metadata is persisted before deleting related chunks.
- Catalog removal follows committed deletion transactions.
- Failed reads, writes, saves, or cleanup preserve a retryable job where possible.
- Combining captures its exact mux owner and disposes it after success or failure.
- FFmpeg worker inputs and partial output are unlinked in a `finally` block.
- Vendor probes have a ten-second deadline; initialization has a thirty-second deadline; run calls have a ten-minute deadline.
- Ended media and closed peers retire observers, sinks, probes, and metadata.
- Recoverable disconnected/failed ICE states preserve live source ownership.

The reusable AudioContext and live remote source/sink graph intentionally remain while Meet media is live. Deferred chunks are also intentional retention. Stop disposes session capture resources without stopping Meet-owned live receiver or microphone tracks. These ownership rules do not establish a universal native-memory bound.

## 11. Development and verification

### Working on the source

1. Edit the relevant JavaScript or popup files directly.
2. Preserve page/extension execution-context boundaries.
3. Thread new commands through their complete message route.
4. Preserve immutable recording metadata and exact async resource ownership.
5. Reload the extension and hard-refresh Meet before manual verification.

For mux changes, retain the page-origin Blob-worker loader. A content script cannot simply construct a worker from a `chrome-extension://` URL in the page context. The current loader fetches local core source and WASM bytes, inlines the source into a Blob worker, and supplies the WASM through `wasmBinary`.

### Automated regression suite

Run from the project root with Node.js 18+:

```sh
node --test tests/page-lifecycle.test.cjs tests/extension-lifecycle.test.cjs
```

No dependencies need to be installed. The fixtures simulate browser, media, extension messaging, timers, storage, and worker APIs while executing the actual project source. The optional real FFmpeg core test runs when both vendor files exist and skips otherwise.

Coverage includes track churn, peer closure and ICE recovery, duplicate/aborted starts, recorder finalization, write ordering, output configuration changes, partial-allocation rollback, injection queues, worker cancellation/disposal, multiple retained jobs, tab/document ownership, failed cleanup, reminders, and popup controls.

The suite was rerun for this documentation on November 12, 2026: **100 tests passed, with zero failures and zero skips**, using Node.js 18.19.1 and the available optional FFmpeg assets. This is source/lifecycle validation, not a live Chrome/Meet recording test.

Basic source syntax and whitespace checks are also available:

```sh
node --check background.js
node --check content_script.js
node --check injected.js
node --check muxer.js
node --check popup/popup.js
git diff --check
```

There is no configured lint tool, package script, or CI workflow in the reviewed checkout.

### Manual Chrome/Meet checks

Use a short test meeting to verify:

1. Presentation and background capture, including presentation start/end transitions.
2. Remote audio, optional local audio, and each configured output.
3. Pause/resume, Stop, download completion, seekability, and playback.
4. Starting a new recording immediately after the previous session finalizes.
5. Editing next-session outputs without losing current outputs.
6. Participant arrival/departure and connection recovery.
7. Deferring two jobs, making another recording, and recovering each independently.
8. Missing-core/failed-combine behavior and retryable cleanup.
9. Selected-tab closure and control preservation for another live meeting tab.

Inspect the popup **Logs**, the Meet tab's DevTools console (`[MeetRecorder]`, `[MeetBudyMuxer]`, and `[ffmpeg]` prefixes), Chrome downloads, and IndexedDB storage. Native memory, browser worker/CSP behavior, real Meet DOM matching, and long-session stability require real-browser measurement.

## 12. Troubleshooting and limitations

| Symptom | Checks and response |
| --- | --- |
| No Google Meet tab found | Open a `meet.google.com` meeting and request status again |
| Zero voices despite active speakers | Confirm early injection; stop any recording, reload the extension, and open/refresh Meet; a full browser restart is a historical workaround |
| Presentation not detected | Enable STREAMs, request refreshed status, and verify the presenter is sharing; test a fresh Meet page if interception was late |
| Background appears instead of slides | Check STREAMs and presentation detection; classification or an unavailable video element can force fallback |
| Your voice is missing | Enable YOUR MIC, select `ME`, `EVERYONE`, or your name in the output, and ensure Meet is sending an enabled microphone track |
| All output audio is silent | Enable VOICEs, check output targets, source detection, and logs; validate with a short playback sample |
| Individual/VIP output is incomplete | Check VIPs, name resolution, and selected targets; large-call virtualization and source matching remain limitations |
| Additional audio file is empty | A new output may have no targets or no matching captured source; configure it before the next recording |
| Combine says vendor files missing | Install the two FFmpeg assets, reload, and retry the retained job; raw files are saved independently |
| Combine fails or stalls | Inspect logs and retained-job state; canceled/failed work can be retried, or choose Keep raw files |
| Recovered recording warns of missing data | Save the available portion and inspect playback; unsaved chunks cannot be restored |
| Cleanup remains pending | Open a Meet tab, select the job, and use Retry cleanup |
| Seekbar or playback is broken | Try a compatible browser or VLC; an optional combined MKV may improve metadata, but codec support and file integrity still matter |
| High CPU or memory use | Use fewer parallel audio outputs and shorter recordings; canvas drawing, media encoding, full Blob assembly, and FFmpeg increase load |
| Controls refer to an old meeting | Refresh status; selected-tab closure should return those controls to idle |

### Remaining practical limits

- Google Meet DOM selectors, localized labels, and WebRTC behavior can change.
- Independently identifying every participant in a large call is not guaranteed.
- Resolution-based presentation detection can misclassify high-resolution webcam video.
- Storage quotas, browser/site-data removal, and interrupted finalization can lose media.
- Two-second chunking does not guarantee zero data loss on a crash or unload.
- Full file assembly and combining can consume substantial memory even when persistent leaks are fixed.
- Browser backgrounding, picture-in-picture, throttling, and mobile resource limits can affect capture.
- Simulated lifecycle tests do not prove native Chrome memory reclamation, actual encoded playback, OS download completion, or indefinite recording stability.

The older README reports stream-change crashes, unreliable individual voices, injection/re-injection failures, pause problems, combine concerns, and losing recordings when the tab closes. Current source includes lifecycle and recovery improvements, but those reports should not be treated as universally resolved in every real-browser scenario without manual validation.

## 13. Permissions, privacy, and distribution

### Manifest permissions

| Permission | Purpose in this extension |
| --- | --- |
| `storage` | Persist preferences, recording state, and recovery jobs |
| `downloads` | Declared for downloading; current assembly initiates downloads through Blob anchors |
| `activeTab` | Declared access to the active tab |
| `scripting` | Inject content scripts for supported reinjection/recovery paths |
| `tabs` | Locate Meet tabs, route actions, and handle closed contexts |
| `https://meet.google.com/*` host access | Run capture and storage bridge code on Meet |

The extension exposes its injected script, compositor background, mux script, and optional FFmpeg assets to matching Meet pages through `web_accessible_resources`. Its extension-page CSP permits self-hosted scripts and WASM evaluation through `wasm-unsafe-eval`.

### Privacy

The reviewed code processes recording media locally and does not include a cloud recording service or automatic recording uploads. Media chunks remain in browser storage until the relevant save/cleanup workflow removes them; downloaded files remain on disk independently. Participant names and selected VIP preferences are retained in extension-local storage, and the compositor can use participant avatar URLs obtained from the Meet page.

Record meetings only with appropriate participant consent and according to applicable meeting policies and laws. Treat local recordings, browser storage, and shared downloads as potentially sensitive.

### Packaging and licensing

The documented distribution method is an unpacked project folder. No Chrome Web Store publishing workflow, automated release process, or project `LICENSE` file is present in the reviewed checkout. Add an explicit project license before distributing under assumed reuse terms, and review the separate licensing obligations of FFmpeg and any other bundled assets.

For deeper implementation history and validation boundaries, see `docs/memory-leak-fixes.md` in the project folder.
