# Participant identity and presentation verification

These fixes address recording cards that retain missing names/photos and webcam tiles that the presentation detector accepts too readily. Automated checks execute the actual page recorder with simulated DOM, WebRTC, image, timer, and recording APIs. They cannot establish compatibility with every live Google Meet layout or native browser schedule.

## Automated checks

Run with Node 18 or newer; no dependencies or build step are needed:

```sh
node --test tests/participant-identities.test.cjs tests/screen-share-detection.test.cjs
node --test tests/*.test.cjs
node --check injected.js
git diff --check
```

The existing lifecycle, metadata, recovery, and recording-safety suites must continue to pass. Identity checks exercise startup before speech, later metadata and participant changes, stale associations, and resource cleanup. Presentation checks exercise the 1280 × 720 boundary and explicit presentation signals independently of rendered tile size, plus DOM-video reuse, presentation-tile removal, re-enabling detection, and explicit camera metadata.

## Recorded automated result

On 2026-11-14, the complete source-executing suite passed **244 tests**, with no failures or skips. This includes **42 participant-identity tests** and **79 presentation-detection tests**. JavaScript syntax and whitespace checks also passed.

Additional regressions reproduce status/identity ordering affecting named audio routes, late local-name routing, duplicate local/remote display names, reassignment after a direct media binding disappears, same-URL photo recovery, full-cache photo stability, text-only names, and presentation ancestors containing participant-bearing labels. Presentation regressions also cover new explicit shares with both tiles visible, selection stability across probe order and STREAMs toggles, restored playback after a webcam receiver becomes a virtualized presentation, and late explicit metadata on receivers with no visible tile. Failures were reproduced before their fixes, then checked against the updated source. Final independent GPT-6.1 Sol reviews at medium/high effort are ready with no actionable confirmed blockers. The final presentation review also passed 48 additional ordering scenarios and 15 integration checks; removing the latest receiver-refresh fix in memory reproduced all seven related failures.

## Live meeting acceptance check (not performed here)

1. Reload the unpacked extension in `chrome://extensions`, then hard-refresh the Meet tab. Join a consented meeting with at least three people so a single remote tile cannot conceal attribution errors.
2. Start recording with cameras off, then have each participant speak immediately. Inspect the background speaker cards and the first seconds of downloaded playback for the correct names/photos. Cards appear while speakers are active; they remain hidden over a presentation.
3. Have a new person join during recording and speak immediately. Toggle their camera, change Meet's layout, and scroll or open the People panel so identities that were previously off-screen become available. Check that the new name/photo appears without a second recording or a multi-minute wait.
4. Test delayed/failed avatar loading, then restore connectivity. Confirm a name/initial fallback renders while the image is unavailable and that the photo replaces it after loading.
5. Have different participants alternate and overlap speech. Check that no remote card acquires the local user's identity, and that tiles or media reused by Meet do not retain another person's name/photo.
6. Test webcam-only video at 640 × 480 and 960 × 540, including an enlarged tile. Then start/stop a 1280 × 720 or higher presentation. Check that webcam-only video keeps the background and a real share displays the presentation. Also test a lower-resolution share with an explicit presentation hint and a high-resolution webcam carrying an explicit camera hint. Start another presentation while the previous tile remains visible and confirm it is detected. With two simultaneous shares, hide the selected tile and toggle STREAMs or pause/resume; confirm the selected live share remains recorded until it ends or a new presentation is selected.
7. Stop and restart recording, pause/resume it, and repeat joining/leaving. Confirm that new sessions use current identities and previous observers/timers do not update a later recording.

Capture screenshots or a short playback sample of the first speaker, a late joiner, and the presentation transition, using participants who agree to sharing that evidence. No live-meeting screenshots or playback proof are supplied by the automated tests.

## Limits

Meet virtualizes participant tiles. A person who has never appeared in available DOM/media metadata cannot be enumerated reliably by scraping, and a server-mixed audio track cannot always be assigned to one speaker before usable speaking evidence exists. A remote image request is asynchronous and can fail. The recorder should eagerly collect and refresh identities that Meet exposes, preload available photos, retry failures, and use safe placeholders when evidence is missing; code review cannot guarantee a name/photo that Meet has not supplied.
