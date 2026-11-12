'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { environment, cluster, drain, waitForRun, popup, vm } = require('./fixtures/extension-runtime.cjs');
const prefix = 'meetBudyPendingCombine:';
const getJob = (e, id) => e.group.stored[prefix + encodeURIComponent(id)];
const liveWorkers = e => e.workers.filter(worker => !worker.terminated);
const scripts = e => e.document.document.head.children.filter(el => el.tagName === 'SCRIPT');
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

// Inventory resources and durable chunk ownership after actual source behavior.
test('Injection failure churn removes every failed script and bounds retries/commands', async () => {
  const e = environment(); await drain();
  for (let i = 0; i < 100; i++) await e.command('SET_AUDIO_TRACKS', { list: [{ id: i, targets: ['EVERYONE'] }] });
  assert.equal(scripts(e).length, 1);
  assert.equal(e.window.__content.state().pendingCount, 1);
  for (let i = 0; i < 8; i++) { const script = scripts(e)[0]; script?.onerror?.(); await e.time.advance(20000); }
  assert.equal(scripts(e).length, 0);
  assert.equal(e.window.__content.state().pendingCount, 0);
  assert(e.document.all.filter(el => el.tagName === 'SCRIPT').length <= 5);
});

test('Readiness handshake with an already-installed page flushes lifecycle order once', async () => {
  const e = environment(); await drain();
  e.window.__content.sendCmd('START', { recordingId: 'A' });
  e.window.__content.sendCmd('STOP');
  scripts(e)[0].onload();
  assert.equal(scripts(e).length, 0);
  assert(e.posts.some(p => p.cmd === 'STATUS'));
  await e.page('STATUS_RESPONSE', { isRecording: true });
  const lifecycle = e.posts.filter(p => p.cmd === 'START' || p.cmd === 'STOP').map(p => p.cmd);
  assert.deepEqual(lifecycle, ['START', 'STOP']);
  await e.page('STATUS_RESPONSE', { isRecording: true });
  assert.equal(e.posts.filter(p => p.cmd === 'START').length, 1);
  await e.time.advance(30000); assert.equal(scripts(e).length, 0);
});

test('Configuration coalescing preserves commands across recording boundaries', async () => {
  const e = environment(); await drain();
  e.window.__content.sendCmd('SET_MUTE', { mute: true });
  e.window.__content.sendCmd('START');
  e.window.__content.sendCmd('SET_MUTE', { mute: false });
  e.window.__content.sendCmd('SET_MUTE', { mute: true });
  e.window.__content.sendCmd('STOP');
  await e.page('INJECTED');
  assert.deepEqual(e.posts.map(p => p.cmd), ['SET_MUTE', 'START', 'SET_MUTE', 'STOP']);
});

for (const mode of ['constructor-failure', 'reject-init', 'fatal-init', 'post-init-failure', 'decode-init']) {
  test('Mux partial initialization releases URLs and workers: ' + mode, async () => {
    const e = environment({ mode, bootContent: false });
    for (let i = 0; i < 3; i++) {
      await assert.rejects(e.window.MeetBudyMuxer.muxToMkv(new Blob(['input']), []));
      e.window.MeetBudyMuxer.terminate();
    }
    assert.equal(e.urls.size, 0); assert.equal(liveWorkers(e).length, 0);
    assert.equal(e.window.__mux.state().loading, false);
    assert.equal(e.time.timers.size, 0);
  });
}

test('Mux cancellation settles hung initialization and allows a later load', async () => {
  const e = environment({ mode: 'hung-init', bootContent: false });
  const run = e.window.MeetBudyMuxer.muxToMkv(new Blob(['input']), []); run.catch(() => {});
  await drain(); e.window.MeetBudyMuxer.terminate();
  await assert.rejects(run, /cancel/i);
  assert.equal(e.urls.size, 0); assert.equal(liveWorkers(e).length, 0);
  e.faults.mode = 'success';
  assert((await e.window.MeetBudyMuxer.muxToMkv(new Blob(['input']), [])).size > 0);
  e.window.MeetBudyMuxer.terminate(); assert.equal(e.urls.size, 0);
});

test('Mux canceled pending fetch cannot publish resources after its late reply', async () => {
  const e = environment({ bootContent: false }), gate = deferred();
  e.faults.fetchWait = gate.promise;
  const run = e.window.MeetBudyMuxer.muxToMkv(new Blob(['input']), []); run.catch(() => {});
  await drain(); e.window.MeetBudyMuxer.terminate();
  await assert.rejects(run, /cancel/i);
  gate.resolve(); await drain();
  assert.equal(e.workers.length, 0); assert.equal(e.urls.size, 0);
});

for (const mode of ['hung-init', 'hung-run']) {
  test('Mux deadline rejects nonresponsive worker and disposes it: ' + mode, async () => {
    const e = environment({ mode, bootContent: false });
    const run = e.window.MeetBudyMuxer.muxToMkv(new Blob(['input']), []); run.catch(() => {});
    await drain(); await e.time.advance(11 * 60 * 1000);
    await assert.rejects(run, /timed out/);
    assert.equal(e.urls.size, 0); assert.equal(liveWorkers(e).length, 0);
    assert.equal(e.time.timers.size, 0);
  });
}

for (const mode of ['reject-run', 'fatal-run', 'post-run-failure', 'decode-run']) {
  test('Failed combine keeps its job while finally disposing exact mux owner: ' + mode, async () => {
    const e = environment({ mode }); await e.finish('A');
    await assert.rejects(e.window.__content.runPendingCombine(e.job('A')));
    assert.equal(liveWorkers(e).length, 0);
    assert.equal(getJob(e, 'A').state, 'pending'); assert.equal(e.group.db.rows.length, 4);
    await e.time.advance(3000); assert.equal(e.urls.size, 0);
  });
}

test('Actual background FORCE_REINJECT preserves running mux identity and final disposal', async () => {
  const e = environment({ mode: 'hung-run' }); await e.finish('A');
  const mux = e.window.MeetBudyMuxer;
  const run = e.window.__content.runPendingCombine(e.job('A')); await waitForRun(e);
  await e.group.dispatch({ type: 'FORCE_REINJECT' }, {});
  assert.equal(e.window.MeetBudyMuxer, mux);
  assert.equal(e.runtimeListeners.length, 1); assert.equal(e.pageListeners.length, 1);
  e.workers[0].reply(); await run;
  assert.equal(liveWorkers(e).length, 0); assert.equal(e.group.db.rows.length, 0);
  await e.time.advance(3000); assert.equal(e.urls.size, 0);
});

test('Deferred A survives multitrack B and single-output C, including reload', async () => {
  const e = environment(); await e.finish('A'); await e.window.__content.deferPendingCombine(e.job('A'));
  await e.finish('B'); await e.finish('C', false);
  assert(getJob(e, 'A')); assert(getJob(e, 'B')); assert(!getJob(e, 'C'));
  assert.equal(e.group.db.rows.length, 8);
  const reload = environment({ group: e.group, id: 8 }); await drain();
  await reload.window.__content.cancelPendingCombine(e.job('B'));
  assert(getJob(e, 'A')); assert(!getJob(e, 'B')); assert.equal(e.group.db.rows.length, 4);
  await reload.window.__content.cancelPendingCombine(e.job('A'));
  assert.equal(e.group.db.rows.length, 0); assert.equal(e.group.jobKeys().length, 0);
});

test('Completing A does not erase B created while A is combining', async () => {
  const e = environment({ mode: 'hung-run' }); await e.finish('A');
  const run = e.window.__content.runPendingCombine(e.job('A')); await waitForRun(e);
  await e.finish('B'); e.workers[0].reply(); await run;
  assert(!getJob(e, 'A')); assert(getJob(e, 'B')); assert.equal(e.group.db.rows.length, 4);
});

test('Two tabs atomically retain distinct jobs and stale A cancellation preserves B', async () => {
  const group = cluster(), a = environment({ group, id: 7 }), b = environment({ group, id: 8 });
  await Promise.all([a.finish('A'), b.finish('B')]);
  assert.equal(group.jobKeys().length, 2); assert.equal(group.db.rows.length, 8);
  await a.window.__content.cancelPendingCombine(a.job('A'));
  assert(getJob(b, 'B')); assert.equal(group.db.rows.length, 4);
  await b.window.__content.cancelPendingCombine(b.job('B')); assert.equal(group.jobKeys().length, 0);
});

for (const fault of ['delete', 'abortDelete']) {
  test('Failed cleanup retains a durable tombstone and succeeds on retry: ' + fault, async () => {
    const e = environment(); await e.finish('A'); e.group.db.faults[fault] = true;
    await assert.rejects(e.window.__content.cancelPendingCombine(e.job('A')), /fixture deletion/);
    assert.equal(getJob(e, 'A').state, 'cleanup'); assert.equal(e.group.db.rows.length, 4);
    e.group.db.faults[fault] = false;
    await e.window.__content.cancelPendingCombine(e.job('A'));
    assert.equal(e.group.db.rows.length, 0); assert(!getJob(e, 'A'));
  });
}

test('Popup cancel with no reachable tab preserves a cleanup request for later recovery', async () => {
  const e = environment(); await e.finish('A');
  await popup(e); e.unreachable = true;
  await e.document.get('btnCombineNever').click(); await drain();
  assert.equal(getJob(e, 'A').state, 'cleanup_requested'); assert.equal(e.group.db.rows.length, 4);
  e.unreachable = false;
  const result = await e.group.dispatch({ type: 'CANCEL_PENDING_COMBINE', jobId: 'A' });
  assert.equal(result.ok, true); assert.equal(e.group.db.rows.length, 0);
});

test('Active cancellation settles hung run, resets busy state and suppresses late output', async () => {
  const e = environment({ mode: 'hung-run' }); await e.finish('A');
  const run = e.window.__content.runPendingCombine(e.job('A')); run.catch(() => {}); await waitForRun(e);
  const before = e.document.all.filter(el => el.tagName === 'A').length;
  const result = await e.group.dispatch({ type: 'CANCEL_PENDING_COMBINE', jobId: 'A' });
  assert.equal(result.ok, true); await assert.rejects(run, /cancel/i);
  e.workers[0].reply(); await drain();
  assert.equal(e.document.all.filter(el => el.tagName === 'A').length, before);
  assert.equal(e.window.__content.state().combineInProgress, false);
  assert.equal(liveWorkers(e).length, 0); assert.equal(e.group.db.rows.length, 0);
});

test('Read error is not treated as empty data and retains retriable ownership', async () => {
  const e = environment(); await e.finish('A'); e.group.db.faults.read = true;
  await assert.rejects(e.window.__content.runPendingCombine(e.job('A')), /read failed/);
  assert.equal(getJob(e, 'A').state, 'pending'); assert.equal(e.group.db.rows.length, 4);
});

test('Single-output raw save failure retains chunks and a recoverable job', async () => {
  const e = environment(); e.faults.download = true; await e.finish('A', false);
  assert.equal(e.group.db.rows.length, 2); assert.equal(getJob(e, 'A').state, 'recovery');
  assert.equal(e.urls.size, 0); assert(e.document.all.filter(el => el.tagName === 'A').every(el => !el.parentNode));
});

test('Stopped write failure reports incompleteness and retains immutable ID/MIME and chunks', async () => {
  const e = environment(); await e.finish('A', false, { writeFailed: true, mimeType: 'video/x-matroska' });
  assert.equal(getJob(e, 'A').state, 'recovery'); assert.equal(getJob(e, 'A').mimeType, 'video/x-matroska');
  assert.equal(getJob(e, 'A').writeFailed, true); assert.equal(e.group.db.rows.length, 2);
  assert.equal(e.document.all.filter(el => el.tagName === 'A').length, 0);
});

test('Rejected duplicate bridge START preserves current recording identity', async () => {
  const e = environment(); await e.page('RECORDING_STARTED', { recordingId: 'A', mimeType: 'video/x-matroska' });
  const response = (await e.command('START_RECORDING'))[0];
  assert.equal(response.ok, false); assert.equal(e.window.__content.state().currentRecordingId, 'A');
  e.seed('A'); await e.page('RECORDING_STOPPED', { recordingId: 'A', mimeType: 'video/x-matroska', secondaries: [] });
  assert.equal(e.group.db.rows.length, 0);
  assert(e.document.all.some(el => el.download?.endsWith('.mkv')));
});

test('Recovering uncataloged recording IDs does not delete them and supports raw save', async () => {
  const e = environment(); e.seed('old'); await e.page('STATUS_RESPONSE', { isRecording: false }); await drain();
  assert.equal(getJob(e, 'old').state, 'recovery'); assert.equal(e.group.db.rows.length, 2);
  await e.window.__content.runPendingCombine('old');
  assert.equal(e.group.db.rows.length, 0); assert(!getJob(e, 'old'));
});

test('Recovery inventory excludes active jobs from another tab', async () => {
  const group = cluster(), a = environment({ group, id: 7 }), b = environment({ group, id: 8 });
  await a.page('RECORDING_STARTED', { recordingId: 'active', mimeType: 'video/webm' }); a.seed('active');
  await b.page('STATUS_RESPONSE', { isRecording: false }); await drain();
  assert(['recording', 'preparing'].includes(getJob(a, 'active').state));
  assert.equal(group.jobKeys().length, 1); assert.equal(group.db.rows.length, 2);
});

test('Concurrent IDB opens share one handle and late old close cannot erase newer connection', async () => {
  const e = environment({ bootContent: true }); await drain();
  const handles = await Promise.all([e.window.__content.openDB(), e.window.__content.openDB(), e.window.__content.openDB()]);
  assert.equal(new Set(handles).size, 1); assert.equal(e.group.db.handles.length, 1);
  const newer = await e.window.__content.openDB(true); handles[0].onclose();
  assert.equal(await e.window.__content.openDB(), newer); assert.equal(e.group.db.handles.length, 2);
});

test('Legacy pending singleton migrates without deleting its data', async () => {
  const group = cluster(); group.stored.meetBudyPendingCombine = { recordingId: 'legacy', mimeType: 'video/webm', secondaries: [], createdAt: 1 };
  const e = environment({ group }); e.seed('legacy'); await drain();
  assert(getJob(e, 'legacy')); assert(!group.stored.meetBudyPendingCombine); assert.equal(group.db.rows.length, 2);
});

for (const fail of ['write', 'exec', 'read']) {
  test('Generated worker finally removes partial inputs/output on ' + fail + ' failure', async () => {
    const e = environment({ bootContent: false }), files = new Map(), messages = [];
    const core = { FS: { writeFile(name, data) { files.set(name, data); if (fail === 'write' && name === 'input1.webm') throw new Error('write failed'); },
      readFile(name) { if (fail === 'read') throw new Error('read failed'); return files.get(name); }, unlink(name) { files.delete(name); } },
      exec() { files.set('output.mkv', new Uint8Array(20)); return fail === 'exec' ? 1 : 0; } };
    const self = { postMessage: message => messages.push(message) };
    vm.runInNewContext(e.window.__mux.buildWorkerScript(''), { self, createFFmpegCore: async () => core });
    await self.onmessage({ data: { id: 1, cmd: 'init', wasmBinary: new ArrayBuffer(1) } });
    await self.onmessage({ data: { id: 2, cmd: 'run', files: [{ name: 'input0.webm', data: new Uint8Array(1024) }, { name: 'input1.webm', data: new Uint8Array(1024) }], args: [] } });
    assert.equal(messages.at(-1).ok, false); assert.equal(files.size, 0);
  });
}

test('STOP before async start catalog completes cannot dispatch a late START', async () => {
  const e = environment(); await drain();
  const starting = e.command('START_RECORDING');
  await e.command('STOP_RECORDING');
  const response = (await starting)[0]; await drain();
  assert.equal(response.ok, false);
  await e.page('INJECTED');
  assert.equal(e.posts.filter(post => post.cmd === 'START').length, 0);
  assert.equal(e.group.jobKeys().length, 0);
});

test('Recovery fills missing secondary metadata and discard clears every related recording ID', async () => {
  const e = environment(); await e.finish('A');
  e.seed('A__t3');
  await e.page('STATUS_RESPONSE', { isRecording: false }); await drain();
  assert(getJob(e, 'A').secondaries.some(sec => sec.recordingId === 'A__t3'));
  await e.window.__content.cancelPendingCombine('A');
  assert.equal(e.group.db.rows.length, 0); assert.equal(e.group.jobKeys().length, 0);
});

test('Popup lists multiple saved jobs and sends the selected immutable job identity', async () => {
  const e = environment(); await e.finish('A'); await e.finish('B');
  await popup(e);
  const select = e.document.get('pendingRecordingSelect');
  assert.equal(select.children.length, 2);
  select.value = 'B'; await select.emit('change', { target: select });
  await e.document.get('btnCombineLater').click(); await drain();
  assert(getJob(e, 'B').nextPromptAt > e.time.now()); assert.equal(getJob(e, 'A').nextPromptAt, 0);
});

test('Same-job concurrent combines serialize their durable claim', async () => {
  const group = cluster(), a = environment({ group, id: 7, mode: 'hung-run' }), b = environment({ group, id: 8, mode: 'hung-run' });
  await a.finish('A');
  const first = a.window.__content.runPendingCombine('A'); first.catch(() => {}); await waitForRun(a);
  await assert.rejects(b.window.__content.runPendingCombine('A'), /busy/);
  assert.equal(b.workers.length, 0);
  await group.dispatch({ type: 'CANCEL_PENDING_COMBINE', jobId: 'A' });
  await assert.rejects(first, /cancel/i);
});

test('Actual ffmpeg.wasm failed exec releases input files in the generated handler', async t => {
  const fs = require('node:fs'), path = require('node:path');
  const corePath = path.join(__dirname, '../vendor/ffmpeg/ffmpeg-core.js');
  const wasmPath = path.join(__dirname, '../vendor/ffmpeg/ffmpeg-core.wasm');
  if (!fs.existsSync(corePath) || !fs.existsSync(wasmPath)) { t.skip('Optional ffmpeg vendor files are not installed'); return; }
  const e = environment({ bootContent: false }), messages = [], self = { postMessage: message => messages.push(message) };
  const context = vm.createContext({ self, createFFmpegCore: require(corePath), Uint8Array, ArrayBuffer });
  vm.runInContext(e.window.__mux.buildWorkerScript('') + '\nself.__core = () => core;', context);
  await self.onmessage({ data: { id: 1, cmd: 'init', wasmBinary: fs.readFileSync(wasmPath) } });
  assert.equal(messages.at(-1).ok, true);
  const files = [{ name: 'input0.webm', data: new Uint8Array(1024 * 1024) }, { name: 'input1.webm', data: new Uint8Array(1024 * 1024) }];
  await self.onmessage({ data: { id: 2, cmd: 'run', files, args: ['-y', '-i', 'input0.webm', '-i', 'input1.webm', '-c', 'copy', '-f', 'matroska', 'output.mkv'] } });
  assert.equal(messages.at(-1).ok, false);
  for (const file of files) assert.throws(() => self.__core().FS.stat(file.name));
  assert.throws(() => self.__core().FS.stat('output.mkv'));
});

test('Unready lifecycle flood is bounded and reports refused commands', async () => {
  const e = environment(); await drain();
  let refused = 0;
  for (let i = 0; i < 100; i++) if (!e.window.__content.sendCmd(i % 2 ? 'STOP' : 'PAUSE')) refused++;
  assert.equal(e.window.__content.state().pendingCount, 32); assert.equal(refused, 68);
  assert.equal(scripts(e).length, 1);
});

// Review regressions bind claims to accepted executions and keep saved work
// separate from a live recording's controls, including cross-document messages.
test('Rejected competing run leaves the durable combining claim intact', async () => {
  const group = cluster(), a = environment({ group, id: 7, mode: 'hung-run' }), b = environment({ group, id: 8, mode: 'hung-run' });
  await a.finish('owned');
  const run = a.window.__content.runPendingCombine('owned'); run.catch(() => {}); await waitForRun(a);
  const accepted = structuredClone(getJob(a, 'owned'));
  await assert.rejects(b.window.__content.runPendingCombine('owned'), /busy/);
  assert.equal(getJob(a, 'owned').state, 'combining');
  assert.equal(getJob(a, 'owned').revision, accepted.revision);
  assert.equal(getJob(a, 'owned').executionToken, accepted.executionToken);
  await assert.rejects(b.window.__content.runPendingCombine('owned'), /busy/);
  assert.equal(liveWorkers(a).length + liveWorkers(b).length, 1);
  await group.dispatch({ type: 'CANCEL_PENDING_COMBINE', jobId: 'owned' }); await assert.rejects(run, /cancel/i);
});

test('Actual fallback execution close restores recovery and keeps original source identity', async () => {
  const group = cluster(), original = environment({ group, id: 7 }), fallback = environment({ group, id: 8, mode: 'hung-run' });
  await original.finish('fallback'); group.removeTab(7); await drain();
  const run = group.dispatch({ type: 'RUN_PENDING_COMBINE', jobId: 'fallback' }); await waitForRun(fallback);
  const accepted = structuredClone(getJob(fallback, 'fallback'));
  group.removeTab(8); fallback.workers.forEach(worker => worker.terminate()); await drain();
  const reload = environment({ group, id: 9 }); await reload.page('STATUS_RESPONSE', { isRecording: false });
  assert.equal(getJob(reload, 'fallback').state, 'recovery');
  assert.equal(accepted.ownerTabId, 7); assert.equal(accepted.executionTabId, 8);
  assert(accepted.executionDocumentId); assert(accepted.executionToken);
  const ui = await popup(reload); assert.equal(reload.document.get('btnCombineNow').disabled, false);
  assert.equal(ui.state().job.id, 'fallback');
  await group.dispatch({ type: 'CANCEL_PENDING_COMBINE', jobId: 'fallback' }); await run;
  assert.equal(group.db.rows.length, 0);
});

test('Fallback document reload restores its stale execution claim', async () => {
  const group = cluster(), original = environment({ group, id: 7 }), fallback = environment({ group, id: 8, mode: 'hung-run' });
  await original.finish('reload'); group.removeTab(7); await drain();
  const run = group.dispatch({ type: 'RUN_PENDING_COMBINE', jobId: 'reload' }); await waitForRun(fallback);
  const accepted = structuredClone(getJob(fallback, 'reload'));
  fallback.workers.forEach(worker => worker.terminate());
  const reloaded = environment({ group, id: 8 }); await reloaded.page('STATUS_RESPONSE', { isRecording: false });
  await reloaded.window.__content.loadPendingCombine();
  assert.equal(getJob(reloaded, 'reload').state, 'recovery');
  assert.equal(getJob(reloaded, 'reload').executionToken, null);
  assert.equal(accepted.ownerTabId, 7); assert.equal(accepted.executionTabId, 8);
  await group.dispatch({ type: 'CANCEL_PENDING_COMBINE', jobId: 'reload' }); await run;
  assert.equal(group.db.rows.length, 0);
});

test('Service-worker restart verifies and preserves another live execution claim', async () => {
  const e = environment({ mode: 'hung-run' }); await e.finish('restart-live');
  const run = e.window.__content.runPendingCombine('restart-live'); run.catch(() => {}); await waitForRun(e);
  const accepted = structuredClone(getJob(e, 'restart-live'));
  e.group.restartBackground(); await drain();
  const listed = await e.group.dispatch({ type: 'JOB_STORE', action: 'list' });
  assert.equal(listed.jobs.find(job => job.id === 'restart-live').state, 'combining');
  assert.equal(getJob(e, 'restart-live').executionToken, accepted.executionToken);
  assert.equal(getJob(e, 'restart-live').revision, accepted.revision);
  await e.group.dispatch({ type: 'CANCEL_PENDING_COMBINE', jobId: 'restart-live' }); await assert.rejects(run, /cancel/i);
});

test('Browser-context restart without close event recovers a vanished execution owner', async () => {
  const e = environment({ mode: 'hung-run' }); await e.finish('restart-gone');
  const run = e.window.__content.runPendingCombine('restart-gone'); run.catch(() => {}); await waitForRun(e);
  e.group.tabs.clear(); e.workers.forEach(worker => worker.terminate());
  e.group.restartBackground(); await drain();
  const reopened = environment({ group: e.group, id: 15 }); await reopened.page('STATUS_RESPONSE', { isRecording: false });
  assert.equal(getJob(reopened, 'restart-gone').state, 'recovery');
  assert.equal(getJob(reopened, 'restart-gone').executionToken, null);
  await e.group.dispatch({ type: 'CANCEL_PENDING_COMBINE', jobId: 'restart-gone' }); await assert.rejects(run, /cancel/i);
  assert.equal(e.group.db.rows.length, 0);
});

const recordingControls = (e, ui) => ({
  isRecording: ui.state().isRecording, startTime: ui.state().startTime, timerInterval: ui.state().timerInterval,
  title: e.document.get('btnRecord').title, recordDisabled: e.document.get('btnRecord').attrs.disabled,
  pauseDisabled: e.document.get('btnPause').attrs.disabled,
});

test('Saved-job progress preserves a newer active recording timer and controls', async () => {
  const e = environment(); await e.finish('saved-progress');
  await e.page('RECORDING_STARTED', { recordingId: 'live-progress', mimeType: 'video/webm' });
  const ui = await popup(e); ui.handleStatus({ state: 'recording', recordingId: 'live-progress', startTime: e.time.now() });
  const before = recordingControls(e, ui), sent = e.sent.length;
  await e.window.__content.runPendingCombine('saved-progress');
  for (const message of e.sent.slice(sent).filter(m => m.type === 'STATUS')) ui.handleStatus(message.payload);
  assert.deepEqual(recordingControls(e, ui), before);
  assert.equal(e.window.__content.state().currentRecordingId, 'live-progress');
});

test('Delayed write-failed completion preserves a newer recording UI', async () => {
  const e = environment(); await e.page('RECORDING_STARTED', { recordingId: 'old-failed', mimeType: 'video/x-matroska' }); e.seed('old-failed');
  const gate = deferred(), get = e.group.local.get;
  e.group.local.get = function(key, callback) { if (key === prefix + 'old-failed') gate.promise.then(() => get.call(this, key, callback)); else return get.call(this, key, callback); };
  const stop = e.page('RECORDING_STOPPED', { recordingId: 'old-failed', mimeType: 'video/x-matroska', secondaries: [], writeFailed: true }); await drain();
  await e.page('RECORDING_STARTED', { recordingId: 'new-live', mimeType: 'video/webm' });
  const ui = await popup(e); ui.handleStatus({ state: 'recording', recordingId: 'new-live', startTime: e.time.now() });
  const before = recordingControls(e, ui), sent = e.sent.length;
  gate.resolve(); await stop;
  for (const message of e.sent.slice(sent).filter(m => m.type === 'STATUS')) ui.handleStatus(message.payload);
  assert.deepEqual(recordingControls(e, ui), before);
  assert.equal(getJob(e, 'old-failed').writeFailed, true);
});

test('Other-tab status and chunk broadcasts cannot reset the selected recording controls', async () => {
  const group = cluster(), a = environment({ group, id: 7 }), b = environment({ group, id: 8 });
  await a.finish('tab-a-saved'); await b.page('RECORDING_STARTED', { recordingId: 'tab-b-live', mimeType: 'video/webm' });
  const ui = await popup(b); const started = b.sent.find(m => m.type === 'STATUS' && m.payload.state === 'recording'); ui.message(started);
  const before = recordingControls(b, ui), sent = a.sent.length;
  await a.window.__content.runPendingCombine('tab-a-saved');
  for (const message of a.sent.slice(sent)) ui.message(message);
  ui.message({ type: 'STATUS', payload: { scope: 'recording', state: 'aborted', recordingId: 'tab-b-live', contextId: 'another-document' } });
  ui.message({ type: 'CHUNK', payload: { count: 99, totalMB: '99', recordingId: 'foreign', contextId: 'another-document' } });
  assert.deepEqual(recordingControls(b, ui), before);
  assert.equal(ui.state().activeRecordingId, 'tab-b-live');
});

test('Started recording restores the enabled Stop control after async START', async () => {
  const e = environment(); await e.page('INJECTED'); const ui = await popup(e);
  await e.document.get('btnRecord').click(); await drain();
  assert.equal(e.document.get('btnRecord').attrs.disabled, 'true');
  const start = e.posts.find(post => post.cmd === 'START'); assert(start);
  const sent = e.sent.length; await e.page('RECORDING_STARTED', { recordingId: start.recordingId, mimeType: 'video/webm' });
  for (const message of e.sent.slice(sent)) ui.message(message);
  assert.equal(e.document.get('btnRecord').attrs.disabled, undefined);
  assert.equal(e.document.get('btnRecord').title, 'Stop Recording');
  assert.equal(ui.state().isRecording, true);
});

test('Anchor allocation failure revokes its already-owned URL', async () => {
  const e = environment(), create = e.context.document.createElement;
  e.context.document.createElement = tag => { if (tag === 'a') throw new Error('fixture anchor allocation failed'); return create(tag); };
  await e.finish('anchor-failed', false);
  assert.equal(e.urls.size, 0); assert.equal(e.group.db.rows.length, 2);
  assert.equal(getJob(e, 'anchor-failed').state, 'recovery');
});

test('Deferring selected B immediately exposes due A', async () => {
  const e = environment(); await e.finish('due-A'); await e.finish('due-B'); const ui = await popup(e);
  const select = e.document.get('pendingRecordingSelect'); select.value = 'due-B'; await select.emit('change', { target: select });
  await e.document.get('btnCombineLater').click(); await drain();
  assert.equal(ui.state().job.id, 'due-A'); assert.equal(e.document.get('modalCombine').classList.contains('visible'), true);
});

test('Earliest due reminder is independent of a later selected deferred job', async () => {
  const e = environment(); await e.finish('early'); await e.finish('late'); const ui = await popup(e);
  const select = e.document.get('pendingRecordingSelect'); select.value = 'late'; await select.emit('change', { target: select });
  await e.group.dispatch({ type: 'JOB_STORE', action: 'update', jobId: 'early', changes: { nextPromptAt: e.time.now() + 1000 } });
  await e.group.dispatch({ type: 'JOB_STORE', action: 'update', jobId: 'late', changes: { nextPromptAt: e.time.now() + 10000 } }); await drain();
  const timer = e.time.timers.get(ui.state().timer);
  assert.equal(timer.due, e.time.now() + 1000);
  await e.time.advance(1000); assert.equal(ui.state().job.id, 'early'); assert.equal(e.document.get('modalCombine').classList.contains('visible'), true);
});

test('Rescan request storm coalesces its delayed status timer', async () => {
  const e = environment(); await e.page('INJECTED');
  for (let i = 0; i < 200; i++) await e.command('FORCE_REINJECT');
  const ownedTimers = e.time.timers.size; await e.time.advance(3000);
  assert(ownedTimers <= 1); assert.equal(e.time.timers.size, 0);
});

test('Selected recording Stop targets its own tab after another tab starts recording', async () => {
  const group = cluster(), a = environment({ group, id: 7 }), b = environment({ group, id: 8 });
  await b.page('RECORDING_STARTED', { recordingId: 'selected', mimeType: 'video/webm' });
  const ui = await popup(b);
  const selected = group.backgroundMessages.find(m => m.type === 'STATUS' && m.payload.recordingId === 'selected' && m.payload.state === 'recording');
  ui.message(selected); assert.equal(ui.state().activeRecordingTabId, 8);
  await a.page('RECORDING_STARTED', { recordingId: 'other', mimeType: 'video/webm' });
  for (const message of a.sent) ui.message(message);
  const aBefore = a.posts.filter(p => p.cmd === 'STOP').length, bBefore = b.posts.filter(p => p.cmd === 'STOP').length;
  await b.document.get('btnRecord').click(); await drain();
  assert.equal(a.posts.filter(p => p.cmd === 'STOP').length, aBefore);
  assert.equal(b.posts.filter(p => p.cmd === 'STOP').length, bBefore + 1);
  assert.equal(ui.state().activeRecordingId, 'selected');
});

test('Closing only the selected recording context retires its controls and saved recording state', async () => {
  const e = environment(); await e.page('RECORDING_STARTED', { recordingId: 'closed-live', mimeType: 'video/webm' });
  const ui = await popup(e); ui.message(e.group.backgroundMessages.find(m => m.type === 'STATUS' && m.payload.state === 'recording'));
  e.group.removeTab(7); await drain();
  for (const message of e.group.backgroundMessages.filter(m => m.type === 'STATUS' && m.payload.state === 'stopped')) ui.message(message);
  assert.equal(ui.state().isRecording, false); assert.equal(e.group.stored.meetRecorderState.isRecording, false);
  assert.equal(e.document.get('btnRecord').attrs.disabled, undefined);
});

test('Selected tab close retires its controls when another recording owns global state', async () => {
  const group = cluster(), a = environment({ group, id: 7 }), b = environment({ group, id: 8 });
  await a.page('INJECTED'); await b.page('INJECTED');
  await b.page('RECORDING_STARTED', { recordingId: 'selected-closed', mimeType: 'video/webm' }); b.seed('selected-closed');
  const ui = await popup(b);
  ui.message(group.backgroundMessages.find(m => m.type === 'STATUS' && m.payload.recordingId === 'selected-closed' && m.payload.state === 'recording'));
  const oldTimer = ui.state().timerInterval; assert(oldTimer);
  await a.page('RECORDING_STARTED', { recordingId: 'other-live', mimeType: 'video/webm' }); a.seed('other-live');
  ui.message(group.backgroundMessages.find(m => m.type === 'STATUS' && m.payload.recordingId === 'other-live' && m.payload.state === 'recording'));
  assert.equal(ui.state().activeRecordingTabId, 8); assert.equal(group.stored.meetRecorderState.tabId, 7);
  // Native closure destroys the old bridge; notification cannot depend on its
  // storage listener, page callbacks, or stopped-event cleanup.
  group.changes.splice(1, 1); b.runtimeListeners.length = 0; b.pageListeners.length = 0;
  const index = group.backgroundMessages.length;
  group.removeTab(8); await drain(); await drain();
  for (const message of group.backgroundMessages.slice(index)) ui.message(message);
  assert.equal(ui.state().isRecording, false); assert.equal(ui.state().activeRecordingTabId, null);
  assert.equal(ui.state().timerInterval, null); assert.equal(b.time.timers.has(oldTimer), false);
  assert.equal(b.document.get('btnRecord').attrs.disabled, undefined);
  assert.equal(b.document.get('btnRecord').title, 'Start Recording');
  assert.equal(b.document.get('btnPause').attrs.disabled, 'true');
  assert.equal(getJob(b, 'selected-closed').state, 'recovery');
  assert.equal(group.stored.meetRecorderState.isRecording, true); assert.equal(group.stored.meetRecorderState.tabId, 7);
  assert.equal(getJob(a, 'other-live').state, 'recording');
  assert.equal(group.db.rows.length, 4);
  // A subsequent explicit refresh may legitimately select the remaining live
  // recording. Closing B again must not retire A after that selection.
  const refreshIndex = group.backgroundMessages.length;
  await a.page('STATUS_RESPONSE', { isRecording: true, recordingId: 'other-live', audioSources: 1 });
  for (const message of group.backgroundMessages.slice(refreshIndex)) ui.message(message);
  assert.equal(ui.state().activeRecordingTabId, 7); assert.equal(ui.state().isRecording, true);
  ui.message({ type: 'TAB_CLOSED', payload: { tabId: 8 } });
  assert.equal(ui.state().isRecording, true); assert.equal(ui.state().activeRecordingTabId, 7);
});

test('Another tab close preserves selected recording controls and timer', async () => {
  const group = cluster(), a = environment({ group, id: 7 }), b = environment({ group, id: 8 });
  await b.page('RECORDING_STARTED', { recordingId: 'selected-live', mimeType: 'video/webm' });
  const ui = await popup(b);
  ui.message(group.backgroundMessages.find(m => m.type === 'STATUS' && m.payload.recordingId === 'selected-live' && m.payload.state === 'recording'));
  await a.page('RECORDING_STARTED', { recordingId: 'other-closed', mimeType: 'video/webm' });
  const before = ui.state(), index = group.backgroundMessages.length;
  group.removeTab(7); await drain();
  for (const message of group.backgroundMessages.slice(index)) ui.message(message);
  assert.equal(ui.state().isRecording, true); assert.equal(ui.state().activeRecordingId, before.activeRecordingId);
  assert.equal(ui.state().activeRecordingTabId, 8); assert.equal(ui.state().timerInterval, before.timerInterval);
  assert.equal(b.document.get('btnRecord').title, 'Stop Recording');
  assert.equal(b.document.get('btnPause').attrs.disabled, undefined);
});

test('Definitively idle replacement document retires same-tab stale UI but not another tab', async () => {
  const e = environment(); await e.page('RECORDING_STARTED', { recordingId: 'old-document', mimeType: 'video/webm' });
  const ui = await popup(e); ui.message(e.group.backgroundMessages.find(m => m.type === 'STATUS' && m.payload.state === 'recording'));
  ui.message({ type: 'STATUS_RESPONSE', payload: { isRecording: false, tabId: 8, contextId: 'foreign' } });
  assert.equal(ui.state().isRecording, true);
  const replacement = environment({ group: e.group, id: 7 }); await replacement.page('STATUS_RESPONSE', { isRecording: false });
  for (const message of e.group.backgroundMessages.filter(m => m.type === 'STATUS_RESPONSE' || (m.type === 'STATUS' && m.payload.state === 'stopped'))) ui.message(message);
  assert.equal(ui.state().isRecording, false); assert.equal(e.group.stored.meetRecorderState.isRecording, false);
});

test('Late release from an earlier accepted token cannot retire a newer same-document run', async () => {
  const e = environment({ mode: 'hung-run' }); await e.finish('token-reuse');
  const first = e.window.__content.runPendingCombine('token-reuse'); first.catch(() => {}); await waitForRun(e);
  const oldOwner = structuredClone(getJob(e, 'token-reuse'));
  e.workers.at(-1).onerror({ message: 'fixture failed run' }); await assert.rejects(first, /failed run/);
  const count = e.workers.length;
  const current = e.window.__content.runPendingCombine('token-reuse'); current.catch(() => {}); await waitForRun(e, count);
  const newOwner = structuredClone(getJob(e, 'token-reuse'));
  const result = await e.group.dispatch({ type: 'JOB_STORE', action: 'release', jobId: 'token-reuse',
    executionToken: oldOwner.executionToken, documentId: oldOwner.executionDocumentId }, { tab: { id: 7 } });
  assert.equal(result.ok, true); assert.equal(getJob(e, 'token-reuse').state, 'combining');
  assert.equal(getJob(e, 'token-reuse').revision, newOwner.revision);
  assert.equal(getJob(e, 'token-reuse').executionToken, newOwner.executionToken);
  assert.notEqual(newOwner.executionToken, oldOwner.executionToken);
  await e.group.dispatch({ type: 'CANCEL_PENDING_COMBINE', jobId: 'token-reuse' }); await assert.rejects(current, /cancel/i);
});
