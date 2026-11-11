# Memory and recording-resource lifecycle fixes

Repeated participant changes, overlapping recording operations, failed injection/mux startup, and deferred recordings could leave resources or recording data without a cleanup owner. The fixes give observed media, each accepted recording, each mux operation, and each saved recording an explicit owner that survives asynchronous completion and failures.

The audit confirmed the following retention paths. Native recording/worker resources and persistent IndexedDB data are distinguished from ordinary JavaScript metadata; no Chrome heap size or leak rate was measured.

| ID | Trigger and retained/lost resource | Fix |
| --- | --- | --- |
| F1 | Overlapping START while audio resume is pending loses recorder/canvas handles; refused starts change recording IDs. | Reserve startup synchronously and capture immutable session IDs/output descriptors. The bridge guards and consumes the accepted completion identity. |
| F2 | Three-second cleanup from recording A operates on recording B's mutable globals. | Retire the exact owning session after final recorder events and writes; remove delayed global cleanup. |
| F3 | Main recorder stop/error leaves independent secondary audio recorders running. | One idempotent finalization path stops every owned recorder and waits for its final data/stop event. |
| F4 | Startup/partial graph failures and inactive Stop leave capture tracks, handlers, sinks, or nodes allocated. | Transactional startup and partial-allocation rollback release owned resources and return idle. |
| F5 | `track.stop()` can end media without an `ended` event; closed peers leave observed media registered. | Full idempotent track retirement handles events, ended-readyState sweeps, and actual peer close. Live shared media and recoverable failed/disconnected peers keep ownership. |
| F6 | Normal video departure leaves stream/participant metadata entries. | Audio and video share the complete per-track forgetting path; metadata still referenced by live tracks remains available. |
| F7 | Disposed camera probes remain reachable through track listeners. | Remove the probe's terminal/media listeners, timers, DOM, and `srcObject` when it is disposed. |
| F8 | Compositor Worker constructor/post failures retain Blob URLs or partially created workers. | Revoke URLs in finally and terminate partially owned workers before fallback. |
| F9 | Editing/deleting active outputs drops final chunk/download ownership. | Keep the session output catalog and destinations until finalization; apply output configuration edits to the next recording. Ending an input stream is not described as guaranteed permanent native encoder retention. |
| F10 | Failed/unready injection accumulates script elements, retries, and queued commands. | One tracked attempt, detached/removed scripts, bounded retries and queue, config coalescing across explicit lifecycle boundaries, and an existing-page readiness handshake. |
| F11 | Partial mux initialization, hung calls, or active reinjection lose worker/URL cleanup and cancellation. | Stable mux API, early disposal ownership, fetch/RPC cancellation and deadlines, settled pending calls, exact-instance finally, and input/partial-output filesystem cleanup. |
| F12 | A later/deleted job overwrites the singleton pending-combine catalog; failed cleanup removes metadata before deleting chunks. | Durable per-recording keys, serialized revision/token-checked ownership, job-specific routing, cleanup tombstones, and discoverable recovery for stored recording groups. |

## Recording and media ownership

An accepted session owns its ID/MIME/output metadata, canvas capture, recorder entries, final events, and accepted write promises. Completion carries that immutable catalog only after final events and writes settle. A failed write retains saved portions as possibly incomplete recovery data. Slow storage can delay completion; media capture retires once recorder final events finish.

The remote audio source and hidden priming sink remain live while their Meet track is live, and the analyser taps that same source. Ordinary recording Stop preserves these reusable services. Teardown stops extension-owned canvas/output tracks and disconnects its taps; it does not stop live Meet microphone/receiver tracks. Failed ICE is recoverable, so exact source/sink/probe identity survives recovery. Actual closed peers and ended media release their registrations.

Independent review also exposed two setup/recovery problems: treating ICE failure as permanent, and allowing next-graph allocation failure to suppress saved-session completion. Follow-up fixes preserve ICE recovery and isolate next-configuration setup from terminal notification. Every accepted retry rebuilds the entire audio route before recorder startup; persistent routing failure rolls back to idle rather than announcing an output with no remote input.

## Saved recordings and mux operations

Raw files are assembled/downloaded before optional combining. Deferred jobs remain individually addressable across subsequent recordings and tabs. A cleanup request is persisted before deleting its IDB rows, and matching metadata is removed only after committed deletion transactions. Read/save/delete errors and an unavailable owner retain recovery or cleanup entries. The popup selects individual recordings and offers save, combine, defer, discard, and retry-cleanup actions.

An accepted combine claim records a unique execution token and the actual tab/document running it, separately from its original recording source. Rejected contenders and late releases cannot clear another accepted claim. Background liveness queries recover vanished execution contexts after fallback-tab close, reload, or restart; an unknown timed-out owner is retained rather than overwritten. Saved-job progress/errors and recording controls carry identity/context, preserving an unrelated active recording's timer and Stop/Pause controls. Reminder scheduling selects the earliest due job even if the selected job is deferred.

Every removed tab emits an explicit tab-close event. The popup retires the selected tab's identity, timer, and controls on its first close notification even if another recording owns global state; closing an unrelated tab or repeating an old close notification preserves the currently selected live recording. This fixes stale controls after selected-document destruction without clearing another tab's recording or saved rows.

The mux API owns partial allocations before worker creation, aborts canceled loading, rejects abandoned calls, and releases its exact worker/URL on completion or failure. Initialization waits are bounded to 30 seconds, vendor availability probes to 10 seconds, and run calls to 10 minutes. The generated worker unlinks inputs and partial output in finally. Source fetching/inlining into a page-origin Blob worker preserves the MV3 loading constraint.

Download disposal owns the Blob URL before anchor allocation, so even an anchor-allocation exception revokes it. Repeated Rescan requests share one delayed status timer; the original request storm was temporary allocation rather than a demonstrated persistent timer leak.

## Verification

```sh
node --test tests/page-lifecycle.test.cjs tests/extension-lifecycle.test.cjs
```

At final verification on 2026-11-11, **100 tests passed: 40 page and 60 extension checks, with no failures or skips**. Node 18+ is sufficient for the simulated lifecycle tests; no dependency installation is needed. One optional test uses the installed real ffmpeg.wasm core and skips when its two vendor files are absent. Production and test JavaScript syntax checks and `git diff --check` passed. Independent final source/integration review approved the exact production/test/fixture hashes within the validation limits below, with no substantiated material remaining objection.

The fixtures execute actual source, instrumented only in memory. Assertions inventory owned tracks/nodes/sinks/probes/listeners, workers/URLs, final-event/write ordering, graph connections, cancellation, and durable jobs/IDB rows. Coverage includes participant churn, explicit stop without ended, rapid starts/stops, native-style error schedules, config edits, partial failures, ICE recovery, reinjection, hung workers, two-tab catalog races, failed cleanup, and recovery.

Regression sensitivity was checked without reverting working files:

```sh
MEETBUD_SOURCE_REF=277f6c5 node --test --test-name-pattern='Natural audio/video departure|Explicit stop without ended|failWorker:|rejected duplicate START|Finalization awaits every' tests/page-lifecycle.test.cjs
MEETBUD_SOURCE_REF=277f6c5 node --test --test-name-pattern='Injection failure churn|Mux partial initialization.*(constructor-failure|reject-init)|Deferred A survives|Rejected duplicate bridge START|Generated worker finally.*exec failure' tests/extension-lifecycle.test.cjs
```

The five selected page checks and six selected extension checks fail on the original source and pass with the fixes. Review follow-ups added two completion/ICE regressions and eight routing regressions that fail on their exact earlier reviewed source snapshots. Nine extension ownership/status/allocation/reminder/Rescan regressions also fail the exact first reviewed extension source. The independent extension adversarial suite passes all 18 cases after those corrections. Prior independent page challenges pass 16 event/storage cases and 11 recovery/failure cases; an independent reviewer also accepted all eight complete-route-before-start/rollback checks.

The selected-tab close regression also fails the exact last reviewed background/popup snapshot and passes with the final close notification fix. It destroys the selected bridge, delivers closure before refreshing another active tab, and verifies duplicate old closure cannot retire the new selection. A companion case verifies closing another tab preserves selected controls/timer. Seven fresh independently authored closure/control schedules pass, including paused, sole-owner, two-popup, unrelated-close, first-delivery, batched-refresh, and replay cases.

Final independent verification also passed the original 18 extension challenges, three asynchronous ownership/liveness/recovery checks, one actual page/content integration check, one adapted asynchronous storage-owner check, and all 35 page/routing challenges. The preserved earlier seven-case extra diagnostic returned six passes and one obsolete expectation failure: it requires old B controls to remain unchanged after B closure plus an explicit selection of active A, then requires idle on replay. The reviewer independently adjudicated that assertion as inconsistent with the required first-close/Refresh/duplicate semantics; the seven fresh cases verify those legal schedules. This is source/integration readiness approval, not a hosted GitHub review or universal no-leak guarantee.

The real WASM test sends two invalid 1 MiB inputs through the actual generated worker handler. The original handler left **2,097,152 input bytes** in its virtual filesystem after failed execution; the fixed handler leaves both input paths and partial `output.mkv` absent. This establishes filesystem cleanup, not a Chrome memory decrease.

An independent real-core handler test also ran two failed executions and produced a three-mapped-stream MKV remux result of **22,460 bytes**, with input/output paths removed after each handler call. It did not test encoded playback in Chrome or native worker memory reclamation.

## Limits and browser validation

No live Meet session, Chrome heap/GC/native media measurement, Blob-worker CSP launch, encoded output playback, OS download completion, or native tab-destruction/IDB scheduling test was performed. Simulated lifecycle counts and real Node-hosted WASM cleanup do not establish native byte retention or failure frequency in Meet. A successful download here means browser download initiation. Addressable deferred/recovery recordings and reusable live-media services are intentional retained resources.

Browser validation should reload the extension and hard-refresh Meet, record multiple outputs, pause/resume and stop, immediately record again, change next-session outputs, replace/retire participants, and exercise ICE recovery. Confirm every output plays and audio reaches new outputs after a failed setup/retry. Defer two recordings, make a single-output recording, reopen the popup/tab, save each retained recording, and retry failed cleanup. Inspect resource and IDB ownership separately from JS/native peak memory.
