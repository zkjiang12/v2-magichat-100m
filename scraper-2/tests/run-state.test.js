import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyDiscoveredCandidate } from '../src/qualification.js';
import {
  collectMissingQueuedHandles,
  mergeCampaignSeen,
  ownSeenRecords,
  serializeRunStateForStorage,
} from '../src/run-state.js';

const RUN_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_RUN_ID = '22222222-2222-2222-2222-222222222222';

test('serializeRunStateForStorage strips seen and keeps everything else', () => {
  const state = {
    version: 1,
    acceptedCount: 3,
    qualificationQueue: ['a', 'b'],
    frontier: [{ handle: 'seed1' }],
    seen: { a: { handle: 'a', status: 'queued' } },
  };

  const parsed = JSON.parse(serializeRunStateForStorage(state));
  assert.equal(parsed.seen, undefined);
  assert.equal(parsed.acceptedCount, 3);
  assert.deepEqual(parsed.qualificationQueue, ['a', 'b']);
  assert.deepEqual(parsed.frontier, [{ handle: 'seed1' }]);
  // The live state object is untouched; only the serialized copy drops seen.
  assert.ok(state.seen.a);
});

test('serializeRunStateForStorage handles null and non-object state', () => {
  assert.equal(serializeRunStateForStorage(null), JSON.stringify(null));
  assert.equal(serializeRunStateForStorage(undefined), JSON.stringify(undefined));
});

test('mergeCampaignSeen: table status wins over blob status', () => {
  const blobSeen = {
    a: { handle: 'a', status: 'queued', followersCount: 1200 },
  };
  const tableRows = [
    { handle: 'a', status: 'accepted', source_seed: 'seed1', run_id: RUN_ID },
  ];

  const seen = mergeCampaignSeen({ blobSeen, tableRows, runId: RUN_ID });
  assert.equal(seen.a.status, 'accepted');
  // Blob-only fields survive the merge.
  assert.equal(seen.a.followersCount, 1200);
  assert.equal(seen.a.fromOtherRun, false);
});

test('mergeCampaignSeen: rows from other runs are flagged', () => {
  const seen = mergeCampaignSeen({
    blobSeen: {},
    tableRows: [
      { handle: 'mine', status: 'queued', source_seed: null, run_id: RUN_ID },
      { handle: 'theirs', status: 'accepted', source_seed: 's', run_id: OTHER_RUN_ID },
    ],
    runId: RUN_ID,
  });

  assert.equal(seen.mine.fromOtherRun, false);
  assert.equal(seen.theirs.fromOtherRun, true);
});

test('mergeCampaignSeen: blob-only handles are preserved', () => {
  const seen = mergeCampaignSeen({
    blobSeen: { legacy: { handle: 'legacy', status: 'rejected' } },
    tableRows: [],
    runId: RUN_ID,
  });
  assert.equal(seen.legacy.status, 'rejected');
});

test('collectMissingQueuedHandles requeues own queued handles missing from the queue', () => {
  const seen = {
    inQueue: { handle: 'inQueue', status: 'queued', runId: RUN_ID, fromOtherRun: false },
    missing: { handle: 'missing', status: 'queued', runId: RUN_ID, fromOtherRun: false },
    theirs: { handle: 'theirs', status: 'queued', runId: OTHER_RUN_ID, fromOtherRun: true },
    done: { handle: 'done', status: 'accepted', runId: RUN_ID, fromOtherRun: false },
  };

  const missing = collectMissingQueuedHandles({
    seen,
    qualificationQueue: ['inQueue'],
    runId: RUN_ID,
  });
  assert.deepEqual(missing, ['missing']);
});

test('collectMissingQueuedHandles recovers own cap_skipped handles (extend flow)', () => {
  const seen = {
    capped: { handle: 'capped', status: 'cap_skipped', runId: RUN_ID, fromOtherRun: false },
    theirCapped: { handle: 'theirCapped', status: 'cap_skipped', runId: OTHER_RUN_ID, fromOtherRun: true },
    rejected: { handle: 'rejected', status: 'rejected', runId: RUN_ID, fromOtherRun: false },
    failed: { handle: 'failed', status: 'failed', runId: RUN_ID, fromOtherRun: false },
  };

  const missing = collectMissingQueuedHandles({
    seen,
    qualificationQueue: [],
    runId: RUN_ID,
  });
  assert.deepEqual(missing, ['capped']);
});

test('ownSeenRecords excludes records hydrated from other runs', () => {
  const seen = {
    a: { handle: 'a', status: 'queued' },
    b: { handle: 'b', status: 'accepted', fromOtherRun: true },
  };
  assert.deepEqual(ownSeenRecords(seen).map((record) => record.handle), ['a']);
});

test('classifyDiscoveredCandidate mirrors the original prefilter order', () => {
  const config = {
    instagramRequireVerified: true,
    instagramFollowingPrefilter: true,
    instagramFollowerThreshold: 1000,
    instagramFollowerMax: 50000,
  };

  assert.equal(
    classifyDiscoveredCandidate({ candidate: { isPrivate: true, isVerified: true }, config }),
    'filtered_private',
  );
  assert.equal(
    classifyDiscoveredCandidate({ candidate: { isPrivate: false, isVerified: false }, config }),
    'filtered_unverified',
  );
  assert.equal(
    classifyDiscoveredCandidate({
      candidate: { isPrivate: false, isVerified: true, followersCount: 500 },
      config,
    }),
    'filtered_followers',
  );
  assert.equal(
    classifyDiscoveredCandidate({
      candidate: { isPrivate: false, isVerified: true, followersCount: 90000 },
      config,
    }),
    'filtered_followers',
  );
  assert.equal(
    classifyDiscoveredCandidate({
      candidate: { isPrivate: false, isVerified: true, followersCount: 2000, hardNo: true },
      config,
    }),
    'filtered_hard_no',
  );
  assert.equal(
    classifyDiscoveredCandidate({
      candidate: { isPrivate: false, isVerified: true, followersCount: 2000 },
      config,
    }),
    'queued',
  );
});

test('classifyDiscoveredCandidate: unknown follower count is not filtered', () => {
  const config = {
    instagramRequireVerified: false,
    instagramFollowingPrefilter: true,
    instagramFollowerThreshold: 1000,
    instagramFollowerMax: 50000,
  };
  assert.equal(
    classifyDiscoveredCandidate({ candidate: { isPrivate: null, followersCount: null }, config }),
    'queued',
  );
});
