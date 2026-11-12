# Recording safety and playback compatibility

This change addresses five problems: missing consent guidance, an always-colored toolbar icon, incomplete recording-container metadata, accidental closure during active work, and recordings that continue or hang after a meeting ends.

## Causes

- The popup did not show the README's recording-consent guidance. A first-use notice now explains permission and personal-use requirements; OK is remembered locally.
- The extension action used the same colored icon on every website. Starting from an unsupported active site could silently target another open Meet tab.
- The old duration fixer rewrote only the first stored chunk. It converted an unknown-size Segment into a finite Segment covering that chunk, then concatenated the remaining chunks outside the declared container. It also described a seek index without generating Cues, changed TimecodeScale, skipped secondary audio metadata, and used the time of recovery to estimate duration.
- Capture and finalization belong to the Meet document. There was no unload warning for active work, and destroying that document also destroys its native recorder callbacks.
- The canvas compositor and audio mixer produce their own live tracks. They remain live after remote meeting tracks disappear, so MediaRecorder does not reliably stop itself. Finalization also waited indefinitely for native stop events.

## Browser and codec limits

Chrome controls the generic leave-page confirmation, its wording, and whether to show it. A `beforeunload` request generally requires prior interaction with the Meet page. Clicking the extension popup alone does not guarantee that interaction. An extension cannot directly invoke Chrome's download-in-progress quit dialog.

Cancelling a close attempt must leave the recording running. Actual document teardown can request a best-effort flush, but a crash, forced process termination, or accepted browser shutdown can discard the last unsaved media. Recovery preserves committed IndexedDB chunks; it cannot recreate bytes that were never committed. Stop waits up to five seconds for final recorder callbacks and ten seconds for accepted storage writes. A timeout retains the saved recording as incomplete for recovery and prevents late callbacks from affecting a later recording. A delayed database open/reopen must also check that its recording session still owns the write before creating a transaction; otherwise it could recreate an orphan tail after recovery cleared the committed header. Existing transactions serialize with recovery reads through IndexedDB.

Container repair reads the full assembled stream, preserves TimestampScale and track descriptions, computes duration from media timestamps and generates a SeekHead and Cues with positions into a complete finite Segment. Main and secondary audio outputs both receive repair without reencoding. H.264 and other non-WebM codecs use a Matroska document type and `.mkv` extension. Malformed or unsupported input falls back to the original bytes with a warning and retained recovery data. It cannot add a missing decoder to Windows Media Player or another application. Playback still depends on support for the recording's codecs, especially Opus and VP8/VP9 or H.264 where applicable.

The meeting-loss timeout measures availability of incoming meeting media, rather than audible volume or screen movement. Local senders, self-preview tiles and the extension's own compositor, mixer and media sinks cannot keep the meeting active. Silent audio and a static presentation can remain valid streams. Browser timer throttling can delay the observed timeout; it cannot guarantee a precise wall-clock stop during suspension.

## Automated validation

`node --test tests/*.test.cjs` passes 123 tests with no skips when the bundled ffmpeg files are present. Source-executing regressions cover Start without a permission checkbox and active-site routing, per-tab icons, countdown/restoration/paused capture, close cancellation and teardown, recorder/storage deadlines, restart recovery, ownership during active saves, delayed database reopen after recovery, and metadata sizes/timestamps/cue addresses/fallback/cancellation. Syntax, manifest resource paths and inactive-icon dimensions/grayscale also pass checks.

Generated samples with actual ffmpeg.wasm verify VP8/VP9 with Opus, H.264/Matroska with Opus, and audio-only Opus. Repaired output decodes, preserves encoded packet hashes, and supports seeking into multiple-cluster samples with matching packet hashes. These samples verify codec/container behavior, not native Meet recording or Windows player support.

## Native validation checklist

1. Reload the unpacked extension and hard-refresh Meet tabs so the new page and content scripts are installed.
2. On a non-Meet page, verify the gray toolbar icon and unavailable-site explanation. Navigate to Meet and back, including a lookalike host, and check that availability follows the current tab.
3. On a fresh installation, verify that the permission notice appears before using the controls. Click OK and reopen the popup: the notice should stay hidden, with only Settings and Logs in the menu and no permission checkbox. Verify that Start, Stop and saved-recording recovery remain usable.
4. Record with one and multiple audio outputs. Stop normally, then open the saved files and seek near the end in Chrome, VLC and Windows players with the relevant codecs installed.
5. Leave a call through Meet's UI while retaining the tab. Check the 10-second countdown and automatic final save. End only a presentation while other participants remain; the recording should continue. Repeat with silent participants and a static screen.
6. Disconnect and reconnect during the countdown. Incoming media recovery should cancel it. Repeat while recording is paused.
7. Interact with the Meet page, then attempt reload, tab closure and browser closure during recording and saving. Cancel the browser's confirmation and verify recording continues. Complete Stop and verify the active-work warning is removed.
8. Force-close a recording tab, reopen Meet, and recover the committed portion. Check that an incomplete-save warning remains honest and that a later recording is unaffected.

Automated validation and implementation details are recorded in the pull request. Native Chrome/Meet interaction, browser confirmation policy and Windows playback require the checks above; simulated browser tests cannot establish those outcomes.
