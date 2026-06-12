import assert from 'node:assert/strict';
import test from 'node:test';

import { instantlyAcceptedLists, resolveCampaignMapping } from '../src/instantly-sync.js';

test('day_in_life_us sync is restricted to its accepted routing lists', () => {
  assert.deepEqual(instantlyAcceptedLists('day_in_life_us'), [
    'target_now_california',
    'target_now_us',
    'business_day_in_life',
  ]);
});

test('no_us_evidence and reject are never synced for day_in_life_us', () => {
  const lists = instantlyAcceptedLists('day_in_life_us');
  assert.ok(!lists.includes('no_us_evidence'));
  assert.ok(!lists.includes('reject'));
});

test('score-only campaigns have no list restriction', () => {
  // day_in_life_creators accepts on fitScore alone (non-US creators are
  // accepted under good_not_now_non_us), and the ugc campaigns are scored by
  // rule with no routing-list gate — all must stay unrestricted so the sync
  // keeps its existing behavior for them.
  assert.equal(instantlyAcceptedLists('day_in_life_creators'), null);
  assert.equal(instantlyAcceptedLists('ugc_creators'), null);
  assert.equal(instantlyAcceptedLists('ugc_creators_email'), null);
});

test('unknown campaigns throw instead of silently syncing unrestricted', () => {
  assert.throws(() => instantlyAcceptedLists('nope_not_real'), /Unknown campaign/);
});

test('resolveCampaignMapping splits mapped and unmapped campaigns', () => {
  const { mapping, unmapped } = resolveCampaignMapping({
    env: { INSTANTLY_CAMPAIGN_ID_DAY_IN_LIFE_US: 'abc-123' },
    campaigns: ['day_in_life_us', 'ugc_creators'],
  });
  assert.deepEqual(mapping, { day_in_life_us: 'abc-123' });
  assert.deepEqual(unmapped, ['ugc_creators']);
});
