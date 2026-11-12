# Meet Recorder — Chrome Extension

> **Record Google Meet screen shares** with all remote participants' audio, directly in your browser. No third-party software needed. Your mic is **never** recorded.

---

# IMPORTANT :
It has some issues, which i have fixed in the updated versions but not in this version. Some of those issues are :

> Stream Change crash
- If there are no screen sharing and suddenly someone screenshares even if for some seconds it either will not detect it and no screen will be captured, else it will detected it and crash

> No individual voices
- If you choosed to record audios from individuals then it won't work unless there are only 3-4 people

> Injection issue
- If you see no voice streams in the top (should be 3 or more but not 0), then its a injection issue which means reacording won't work
- If that happends close the entire browser and reopen the browser and then open the link

> Re-injection issue
- If if you click on re-inject in the setting it either won't work else it will make it worse, so **DO NOT CLICK RE-INJECT** its a warning.

> Combination issue 
- You won't face it if you didn't add multiple track so don't worry
- But if you did see 3 options like `never`, `later`, or `do it` then click never just to be in the safe side

> Pausing issue
- Pausing doesn't work, don't try it

> Recording safety
- Stop before leaving when possible. After 10 seconds without incoming meeting media, the recorder stops automatically and saves the available output.
- Chrome may show a leave-page warning during recording or saving. Forced closure can bypass it; reopen Meet to recover chunks already committed to storage.

> Playback
- Raw downloads receive duration and seek metadata without reencoding. VP8/VP9/AV1 recordings use `.webm`; codecs that require Matroska use `.mkv`.
- Player support still depends on the encoded codecs. Metadata repair cannot install missing Windows decoders.

> Ignore Stream
- Doesn't work

## Useful INFO :
- If you doute if the recording is working or not, click on logs which will show up the logging and also size of the file as well as per chunk.
- Do not switch tabs if the google meet can go to picture-and-picture mode
- Your mic button (if turned on) will record your voices which are being send to google meet, which means if you are muted your voices are not being recorded. So keep it off
- Recording may get heavy so make sure you have good enough ram freed.
- Do not close the meeting tab once it been opned else the injection will failed and you may need to reopen the entire browser.
- Record doesn't do much so if you see video stream 0 while the screen sharing is on (not the webcam) then reopening the browser is the solution (this issue has been fixed in newer version)

## Installation

> **No build step needed** — load directly as an unpacked extension.

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `MeetRecorder` folder
5. The extension icon will appear in your toolbar — **pin it** for easy access

---

## Usage

```
1. Join a Google Meet session
2. Wait for a participant to start presenting (screen share)
3. Click the Meet Recorder icon in the toolbar
4. The popup will show "Screen share detected!" when ready
5. Confirm permission from the meeting host and participants in the popup
6. Click [ ⏺ Start Recording ]
7. When done → click [ ⏹ Stop & Download ]
8. The recording downloads with its correct .webm or .mkv extension
```

### What gets recorded
| Track | Recorded? |
|---|---|
| Presenter's screen share | ✅ Yes |
| All remote participants' audio | ✅ Yes |
| Your own microphone | ❌ No |
| Your own webcam | ❌ No |

---

## File Structure

```
MeetRecorder/
├── manifest.json        ← Extension manifest (MV3)
├── injected.js          ← Runs in page context; patches RTCPeerConnection
├── content_script.js    ← Bridge: IndexedDB storage + download trigger
├── background.js        ← Service worker: message relay between popup ↔ tabs
├── popup/
│   ├── popup.html       ← UI (dark theme, live stats, timer)
│   └── popup.js         ← UI logic
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Technical Notes

### Recording format and metadata
Every raw output, including additional audio tracks, is finalized with a complete container size, media-timestamp duration, a seek header and keyframe cues. Encoded audio and video remain unchanged. The finalizer reads small headers and retains media as Blob slices, avoiding a second full copy of a long recording.

VP8/VP9/AV1 with WebM-compatible audio use `.webm`. H.264 or other non-WebM codecs use `.mkv` with the Matroska document type. If metadata repair fails, the raw output remains available with a warning. Playback depends on the codecs supported by your player. Typical WebM players include:
- Chrome, Firefox, Edge browsers
- VLC media player
- Most modern video editors (DaVinci Resolve, etc.)

### Resilience to network drops
Chunks are saved to **IndexedDB** every 2 seconds. If your internet drops:
- The WebRTC connection may briefly drop, but the recorder keeps any data already buffered
- Incoming media restored within the 10-second inactivity countdown cancels automatic Stop
- Silent audio and a static presentation still count as available media; ending only a screen share does not stop recording while other incoming media remains
- You won't lose data that was already saved to IndexedDB

### Screen share detection
The extension uses stacked heuristics (most to least reliable):
1. `track.contentHint === 'detail'` or `'text'` (Chrome sets this for screen captures)
2. Track label matches `/screen|window|tab|display/i`
3. Resolution check after 1.5s — screen shares are typically ≥1280px wide vs. webcams (640px)
4. Fallback: last video track received (since screen share usually appears after webcam)

### Audio mixing
All **incoming** audio tracks from `RTCPeerConnection.ontrack` are routed through:
```
MediaStreamAudioSourceNode → AudioContext → MediaStreamAudioDestinationNode (mixer)
```
The mixed output is a single audio track recorded alongside the screen video.

---

## Saved recording recovery

Recordings kept for later combining remain listed independently, so a later recording does not replace an earlier saved recording. When the popup offers saved recordings, select the recording you want to act on.

- **Save recording** downloads the saved portion of a recovered recording. An incomplete-save warning means some data failed to persist and the recovered file may be incomplete.
- **Do it** combines a recording whose raw files have already been saved, when the optional ffmpeg files are installed. **Later** postpones its reminder for ten minutes.
- **Keep raw files** clears the extension's saved copy after raw downloads; **Discard recording** clears a recovered recording's saved copy. These actions do not delete files already downloaded.
- **Retry cleanup** finishes a previous cleanup request. Open a Google Meet tab if the data owner is unavailable; failed cleanup retains its recovery entry for another attempt.

START is guarded while a recording is starting or finalizing. Audio output configuration changes during recording apply to the next recording, preserving the current outputs through final save. Stop before leaving when possible. Chrome controls whether to show the generic leave-page confirmation and typically requires prior interaction with the Meet page. Cancelling that confirmation leaves recording running. Accepting closure, a crash or forced shutdown may lose the latest uncommitted media; recovery cannot recreate data that never reached storage.

Saving or cleaning up an older recording preserves the current recording's timer and controls. Choosing **Later** for one saved recording still allows other due recordings to prompt. Retained jobs can recover when the tab actually combining them closes or reloads.

If the selected meeting tab closes, its timer and recording controls return to idle while another tab's active recording remains intact. Refresh can select that remaining meeting tab.

## Verification

Run the lifecycle regression suite with Node 18 or later; no dependency installation or build step is needed:

```sh
node --test tests/*.test.cjs
```

The tests execute the extension source with simulated browser APIs. The optional real ffmpeg.wasm cleanup test runs when `vendor/ffmpeg/ffmpeg-core.js` and `ffmpeg-core.wasm` are installed and otherwise skips. The [memory/resource lifecycle report](docs/memory-leak-fixes.md) explains the leak findings, fixes, and verification limits. The [recording safety and compatibility report](docs/recording-safety-compatibility.md) documents the new behavior and native validation checklist. Real Chrome/Meet recording, browser quit dialogs, Windows playback and native memory measurements require manual validation.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "No Google Meet tab found" | Make sure you're on `meet.google.com` and have joined a meeting |
| Screen share not detected | Click 🔄 Refresh — the presenter may have shared before the extension loaded |
| No audio in recording | Confirm participants have unmuted themselves in Meet |
| `.webm` won't play on Windows | Install [VLC](https://www.videolan.org/) or use Chrome to open the file |
| Recording stopped automatically | Incoming meeting media was unavailable for 10 seconds; check the popup Logs and saved output |
| Gray toolbar icon | Open the active tab on `https://meet.google.com`; recording cannot start from another website |

---

## Privacy & Legal

> ⚠️ **Only record meetings where you have explicit consent from all participants.**  
> Recording without consent may violate privacy laws (GDPR, ECPA, etc.) in your jurisdiction.  
> Personal use only: do not sell recordings, use them commercially, or spam. Obtain explicit permission from the meeting host and participants before each recording.
