import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claimNextSenderRun,
  claimSenderRunById,
  handleSenderCommand,
  incrementSenderRunCounters,
  normalizeSenderRunCounters,
} from '../src/sender-runs.js';

test('claimNextSenderRun claims requested runs only', async () => {
  const client = {
    async query(sql, params) {
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
      assert.match(sql, /status = 'requested'/);
      assert.doesNotMatch(sql, /status in \('requested', 'paused'\)/);
      assert.deepEqual(params, ['day_in_life_creators']);
      return { rows: [{ id: 'run-1', status: 'running' }] };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
  };

  const run = await claimNextSenderRun(pool, { campaign: 'day_in_life_creators' });
  assert.equal(run.id, 'run-1');
});

test('claimSenderRunById claims only the requested campaign run', async () => {
  const client = {
    async query(sql, params) {
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
      assert.match(sql, /campaign = \$1/);
      assert.match(sql, /id = \$2/);
      assert.match(sql, /status = 'requested'/);
      assert.deepEqual(params, ['day_in_life_creators', 'run-2']);
      return { rows: [{ id: 'run-2', status: 'running' }] };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
  };

  const run = await claimSenderRunById(pool, {
    campaign: 'day_in_life_creators',
    runId: 'run-2',
  });
  assert.equal(run.id, 'run-2');
});

test('sender run counters normalize and increment outcomes', () => {
  let counters = normalizeSenderRunCounters({ sent: 1, ignored: 10 });
  assert.deepEqual(counters, {
    attempted: 0,
    sent: 1,
    dry_run: 0,
    skipped: 0,
    failed_retryable: 0,
    failed_final: 0,
  });

  counters = incrementSenderRunCounters(counters, 'dry_run');
  counters = incrementSenderRunCounters(counters, 'failed_retryable');

  assert.deepEqual(counters, {
    attempted: 2,
    sent: 1,
    dry_run: 1,
    skipped: 0,
    failed_retryable: 1,
    failed_final: 0,
  });
});

test('handleSenderCommand pauses and applies command', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };

  const result = await handleSenderCommand(pool, {
    runId: 'run-1',
    counters: { attempted: 1, dry_run: 1 },
    command: { id: 'cmd-1', command: 'pause' },
  });

  assert.equal(result, 'paused');
  assert.match(calls[0].sql, /status = 'paused'/);
  assert.match(calls[1].sql, /status = 'applied'/);
});

test('handleSenderCommand stops and applies command', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };

  const result = await handleSenderCommand(pool, {
    runId: 'run-1',
    counters: { attempted: 1, sent: 1 },
    command: { id: 'cmd-1', command: 'stop' },
  });

  assert.equal(result, 'stopped');
  assert.match(calls[0].sql, /status = \$2/);
  assert.equal(calls[0].params[1], 'stopped');
  assert.match(calls[1].sql, /status = 'applied'/);
});
