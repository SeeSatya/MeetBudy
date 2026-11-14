# Meet Budy — Google Meet Recorder

Record Google Meet presentations and available meeting audio locally with an unpacked Chrome Manifest V3 extension. No build step or recording server is required. Your microphone is excluded by default and can be enabled with **YOUR MIC**.

## Installation

1. Download or clone this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the `MeetBud` folder containing `manifest.json`.
4. Pin the extension to the toolbar, then open or refresh your Google Meet tab.

After updating the source, reload the extension in `chrome://extensions` and hard-refresh the Meet tab with `Ctrl+Shift+R`. Existing tabs need a fresh page load to receive the updated recording code.

## Usage

1. Join a Google Meet meeting where participants have agreed to recording.
2. Open the Meet Budy popup. Use **Refresh** if media is missing.
3. On first use, read the recording-permission notice and click **OK**.
4. Choose whether to include your microphone, meeting voices, and presentation video. Configure additional audio outputs or VIPs if needed.
5. Start recording. A presentation appears when detected; otherwise the recording uses the background with active speaker cards.
6. Pause/resume as needed, then stop recording and wait for saving to finish.
7. Check the downloaded files before deleting any retained recording data.

| Source | Recording behavior |
|---|---|
| Detected presentation | Included when **STREAMs** is enabled |
| Available remote audio | Included by default; **VOICEs** controls recording mute |
| Your microphone | Excluded by default; **YOUR MIC** uses the microphone track Meet is sending |
| Your webcam | Excluded from presentation capture when identifiable as a local camera preview |
| Active speaker names/photos | Shown over the background, while no presentation is being drawn |

Muting your microphone inside Meet prevents it from sending your voice. Meet Budy does not acquire a separate microphone stream. Recording mute controls do not mute what other meeting participants hear.

## Participant names and photos

At recording startup, Meet Budy scans available participant metadata and begins loading profile photos before capture. During recording it refreshes identities independently of speech, including while presenting or paused. New tiles, later names/photos, and changes to existing media bindings update the cache. Stopping releases the session's refresh work and cached speaker state.

Direct media-to-tile associations take priority. Camera-off speakers without a direct association require repeated, unambiguous audio/active-speaker evidence. The recorder uses a name/initial or generic speaker fallback while identity or image data is unavailable.

Failed photo requests retry after a short delay; stalled requests are replaced so they can recover during the same recording. Proven identities remain attached to live incoming tracks across Stop/Start, while image requests and speaker history are released between sessions.

Photo preloading uses a bounded cache of 50 images. Larger visible participant lists keep loaded photos stable, and active speakers can load additional photos on demand. Distinct participant IDs prevent someone with your display name from being mistaken for you; identity changes also update named audio routing.

Google Meet virtualizes participant tiles, so people who have never appeared in available metadata cannot all be discovered by scraping. Mixed audio and overlapping speech can make attribution ambiguous. Profile images also load asynchronously and can fail. Automated checks cover these code paths; a live meeting is still required to verify current Meet layouts and actual recorded playback.

## Presentation detection

The detector uses explicit screen-capture signals such as `detail`/`text` content hints, screen-related track labels, display-surface metadata, and Meet presentation labels. These signals can identify a presentation below 720p.

Without an explicit signal, the resolution fallback requires **at least 1280 × 720 in both dimensions**. Complete decoded dimensions take precedence over track settings. Enlarging a webcam tile does not make it a presentation. Extension probes and resolution-only local camera previews are excluded from DOM candidates, and an inferred candidate cannot replace an active presentation.

Explicit camera metadata vetoes the resolution fallback. Cached DOM videos are checked against their current media track, a live presentation can keep playing when its tile disappears, and re-enabling **STREAMs** restores detection for existing incoming video tracks.

During recording, detection continues to look for later presentations, including when the previous share remains visible, and rechecks the selected video's metadata. Camera labels added after initial probe checks retire mistaken selections. If Meet reuses a webcam receiver for a presentation, the recorder restores its playback probe so tile removal does not interrupt capture. Existing receivers are rechecked for late explicit presentation metadata even when their tiles are absent.

Resolution remains a heuristic: a high-resolution webcam without usable camera metadata can be ambiguous. The recorder captures one selected presentation at a time and keeps canvas dimensions fixed within a recording session.

## Audio outputs and recording files

The default output contains presentation/background video and the available remote audio mix. Additional configured outputs are recorded as separate audio files. Targets can include `EVERYONE`, `VIP_ONLY`, `ME`, or resolved participant names. Named/VIP selection depends on usable participant identity and the audio tracks Meet actually supplies; it cannot separate speakers inside an already mixed track.

Changes to output configuration during recording apply to the next recording. The active session retains its output configuration through final saving.

Raw outputs receive duration and seek metadata without reencoding:

- WebM-compatible codecs, including VP8/VP9/AV1 video, use `.webm`.
- Codecs requiring Matroska use `.mkv`.
- An optional local ffmpeg.wasm remux can combine multiple outputs into one MKV after the raw files are saved.

The optional remux requires `vendor/ffmpeg/ffmpeg-core.js` and `ffmpeg-core.wasm`. Raw downloads remain available when the remuxer is absent or fails. Playback depends on installed codec support; VLC or a browser is often suitable for WebM files.

## Network drops and saved recording recovery

Recording chunks are committed to Meet-origin IndexedDB every two seconds. Silent incoming audio and static presentations still count as available media. Ten seconds without incoming meeting media triggers automatic Stop, including while paused. Reconnecting within that grace period cancels the countdown.

Stop before leaving when possible. Chrome may show a generic leave-page warning during recording or saving; cancelling it leaves recording running. Forced closure can bypass the warning and lose media that has not reached storage.

Retained recordings remain listed independently of later sessions. Available actions include:

- **Save recording**: download the saved portion of a recovered recording. An incomplete warning means some output may be missing.
- **Do it**: combine already-saved raw outputs when ffmpeg.wasm is available.
- **Later**: postpone a combine reminder for ten minutes.
- **Keep raw files**: clear the extension's retained copy after downloading raw outputs.
- **Discard recording**: delete retained recording data.
- **Retry cleanup**: retry a previously failed storage cleanup.

Cleanup affects retained extension/site data, not files already downloaded. Open a Google Meet tab in the same browser profile when recovery needs access to the recording's storage origin. Recovery cannot recreate chunks that were never committed.

## Troubleshooting

| Problem | What to check |
|---|---|
| Gray toolbar icon or no Meet tab | Use the active HTTPS `meet.google.com` tab and join a meeting |
| No detected media | Refresh in the popup; after a source update, reload the extension and hard-refresh Meet |
| Webcam mistaken for a share | Confirm the updated extension is loaded; unhinted high-resolution cameras can remain ambiguous |
| Missing speaker name/photo | Check whether Meet exposes the tile/name/photo; allow image loading and inspect popup Logs |
| No recorded audio | Confirm the source is sending audio, **VOICEs** is enabled, and any named/VIP targets resolve correctly |
| Your voice is missing | Enable **YOUR MIC** and unmute your microphone in Meet |
| Recording stops automatically | Check for ten seconds without incoming media, then inspect Logs and the saved output |
| File will not play | Check codec support with VLC or a browser; inspect any metadata/incomplete warnings |

Long recordings, large meetings, and multiple parallel audio outputs increase CPU and memory use. Check the popup **Logs** panel for chunk counts, saved sizes, and errors. Page console messages use the `[MeetRecorder]` prefix.

## Development and verification

The extension uses plain JavaScript with no package installation or build step:

```text
MeetBud/
├── manifest.json          Extension manifest
├── injected.js            WebRTC capture, identity resolution, audio mixing, compositor
├── content_script.js      Extension bridge, IndexedDB storage, downloads and recovery
├── background.js          Tab routing and persistent recording/recovery state
├── webm_metadata.js       Container duration and seek metadata
├── muxer.js               Optional ffmpeg.wasm remux
├── popup/                 Recording controls and settings
├── icons/                 Toolbar icons
├── tests/                 Source-executing browser/extension fixtures and regressions
└── docs/                  Project documentation and verification reports
```

Run with Node 18 or newer:

```sh
node --test tests/*.test.cjs
node --check injected.js
```

For the identity/presentation regressions specifically:

```sh
node --test tests/participant-identities.test.cjs tests/screen-share-detection.test.cjs
```

The tests execute real extension source with simulated browser APIs. The optional real ffmpeg.wasm test runs when its vendor files are present and otherwise skips. Real Meet recording, native image loading, playback, browser close dialogs, and memory measurements require manual validation.

See the [participant identity and presentation verification guide](docs/meet-identity-verification.md), [resource lifecycle report](docs/memory-leak-fixes.md), [recording safety report](docs/recording-safety-compatibility.md), and [project documentation](docs/MeetBudy-Project-Documentation.md).

`.gitignore` excludes local credentials, agent/editor state, browser profiles, downloads, generated verification artifacts, caches, and extension packages. Source files, tests, example configuration, and documentation screenshots remain eligible for commits. Put temporary verification output in `artifacts/` and intentionally shared evidence in `docs/`.

## Privacy and permitted use

Obtain explicit permission from the host and participants before recording. Personal use only: do not sell recordings, use them commercially, or spam. Recording without consent may violate applicable privacy laws.

Recording and remuxing run locally. Meet still communicates over the network, and profile photos may load from Google-hosted URLs. Handle recordings and retained browser storage according to your participants' agreements.
