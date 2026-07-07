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

> SAVE issue
- CLICK STOP BUTTON BEFORE THE MEETING ENDS, ELSE YOU WILL LOSE THE RECORIDNG
- Same for reload, stop the recording before reload

> Dual Video
- This is just for safe guard, 2 different video files will be saved one with `.webm` and other with `.mkv`
- The mkv is the watchable video where as the Webm may not be playable.

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
5. Click [ ⏺ Start Recording ]
6. When done → click [ ⏹ Stop & Download ]
7. A .webm file downloads automatically to your Downloads folder
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

### Why `.webm` format?
`MediaRecorder` on Chrome natively outputs VP8/VP9 + Opus audio as `.webm`. This plays in:
- Chrome, Firefox, Edge browsers
- VLC media player
- Most modern video editors (DaVinci Resolve, etc.)

### Resilience to network drops
Chunks are saved to **IndexedDB** every 2 seconds. If your internet drops:
- The WebRTC connection may briefly drop, but the recorder keeps any data already buffered
- When Meet reconnects, new tracks are automatically detected and recording resumes
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

## Troubleshooting

| Problem | Fix |
|---|---|
| "No Google Meet tab found" | Make sure you're on `meet.google.com` and have joined a meeting |
| Screen share not detected | Click 🔄 Refresh — the presenter may have shared before the extension loaded |
| No audio in recording | Confirm participants have unmuted themselves in Meet |
| `.webm` won't play on Windows | Install [VLC](https://www.videolan.org/) or use Chrome to open the file |
| Recording stopped mid-way | Screen share was ended by the presenter — re-record when they share again |

---

## Privacy & Legal

> ⚠️ **Only record meetings where you have explicit consent from all participants.**  
> Recording without consent may violate privacy laws (GDPR, ECPA, etc.) in your jurisdiction.  
> This tool is intended for legitimate team use (e.g., your own team's meeting records).
