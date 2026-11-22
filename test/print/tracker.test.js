'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { trackRuns } = require('../../src/print/tracker');

/** An engine whose job states follow a script: states[jobRef] is consumed one poll at a time. */
function scripted(states) {
  const cancelled = [];
  const polls = {};
  return {
    cancelled,
    polls,
    async jobStatus(_printer, ref) {
      polls[ref] = (polls[ref] || 0) + 1;
      const list = states[ref];
      const i = Math.min(polls[ref] - 1, list.length - 1);
      const s = list[i];
      if (s instanceof Error) throw s;
      return typeof s === 'string' ? { state: s } : s;
    },
    async cancel(_p, ref) {
      cancelled.push(ref);
    },
  };
}

// A clock that moves only when the tracker sleeps
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms), advance: (ms) => (t += ms) };
}

const run = (refs) => refs.map((jobRef) => ({ jobRef, run: {} }));

test('resolves when every run has completed', async () => {
  const e = scripted({ 1: ['pending', 'printing', 'completed'], 2: ['pending', 'completed'] });
  const updates = [];
  const out = await trackRuns(e, 'P', run(['1', '2']), { ...clock(), onUpdate: (u) => updates.push(u.state) });
  assert.deepEqual(out, { runs: 2 });
  assert.deepEqual(updates, ['printing', 'ok']);
});

test('a failed run rejects, and runs still queued are cancelled', async () => {
  const e = scripted({ 1: ['completed'], 2: [{ state: 'failed', reason: 'The printer stopped the job.' }], 3: ['pending'] });
  await assert.rejects(trackRuns(e, 'P', run(['1', '2', '3']), clock()), (err) => err.code === 'DRIVER_FAILED' && /stopped the job/.test(err.message));
  assert.deepEqual(e.cancelled.sort(), ['2', '3']);
});

test('a job deleted on this computer is CANCELLED, which is not retried', async () => {
  const e = scripted({ 1: [{ state: 'failed', reason: 'Cancelled on this computer.', cancelled: true }] });
  await assert.rejects(trackRuns(e, 'P', run(['1']), clock()), (err) => err.code === 'CANCELLED' && err.retryable === false);
});

test('a held job reports what the printer needs, then continues when it is fixed', async () => {
  const e = scripted({ 1: ['printing', { state: 'held', reason: 'Out of paper. Load paper in the printer.' }, { state: 'held', reason: 'Out of paper. Load paper in the printer.' }, 'printing', 'completed'] });
  const updates = [];
  await trackRuns(e, 'P', run(['1']), { ...clock(), onUpdate: (u) => updates.push([u.state, u.reason]) });
  assert.deepEqual(updates, [['printing', undefined], ['attention', 'Out of paper. Load paper in the printer.'], ['printing', undefined], ['ok', undefined]]);
});

test('a job held for too long fails as NEEDS_ATTENTION', async () => {
  const e = scripted({ 1: [{ state: 'held', reason: 'Paper jam.' }] });
  await assert.rejects(trackRuns(e, 'P', run(['1']), { ...clock(), attentionTimeoutMs: 5000 }), (err) => err.code === 'NEEDS_ATTENTION' && err.printerIssue);
  assert.deepEqual(e.cancelled, ['1']);
});

test('the whole file has a time limit', async () => {
  const e = scripted({ 1: ['pending'] });
  await assert.rejects(trackRuns(e, 'P', run(['1']), { ...clock(), timeoutMs: 10_000 }), (err) => err.code === 'TIMEOUT');
});

test('a job missing from the queue several times in a row is treated as finished', async () => {
  const e = scripted({ 1: ['unknown'] });
  const out = await trackRuns(e, 'P', run(['1']), { ...clock(), unknownPolls: 3 });
  assert.deepEqual(out, { runs: 1 });
  assert.equal(e.polls['1'], 3);
  // ...but one unknown answer among real ones does not count
  const e2 = scripted({ 1: ['unknown', 'printing', 'unknown', 'completed'] });
  await trackRuns(e2, 'P', run(['1']), clock());
  assert.equal(e2.polls['1'], 4);
});

test('a print system that errors for a while does not end the job', async () => {
  const e = scripted({ 1: [new Error('CUPS did not answer'), new Error('CUPS did not answer'), 'completed'] });
  const updates = [];
  await trackRuns(e, 'P', run(['1']), { ...clock(), onUpdate: (u) => updates.push(u.state) });
  assert.deepEqual(updates, ['attention', 'ok']);
});

test('a job that sits pending for a long time explains why when it can', async () => {
  const c = clock();
  const e = scripted({ 1: ['pending', 'pending', 'pending', 'completed'] });
  const updates = [];
  await trackRuns(e, 'P', run(['1']), {
    ...c,
    pollMs: 30_000,
    describePending: () => 'The printer is offline. Check that it is on and connected.',
    onUpdate: (u) => updates.push([u.state, u.reason]),
  });
  assert.deepEqual(updates[0], ['attention', 'The printer is offline. Check that it is on and connected.']);
});
