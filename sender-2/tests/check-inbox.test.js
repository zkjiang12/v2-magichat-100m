import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLeadMap,
  describeItem,
  extractCounterpartMessages,
  igTimestampToDate,
  mergeCapturedThreads,
  parseArgs,
} from '../src/check-inbox.js';

const VIEWER_PK = '999';
const CREATOR_PK = '111';

function inboxPayload(overrides = {}) {
  return {
    viewer: { pk: VIEWER_PK, username: 'magichat_sender' },
    inbox: {
      threads: [
        {
          thread_id: 'thread-1',
          viewer_id: VIEWER_PK,
          users: [{ pk: CREATOR_PK, username: 'Daily_Dani' }],
          items: [
            { item_id: 'item-2', user_id: CREATOR_PK, item_type: 'text', text: 'omg how does it work?', timestamp: '1770000000000000' },
            { item_id: 'item-1', user_id: VIEWER_PK, item_type: 'text', text: 'hey! founder of magichat here', timestamp: '1769000000000000' },
          ],
          ...overrides,
        },
      ],
    },
  };
}

test('mergeCapturedThreads combines inbox and thread payloads, deduping items', () => {
  const threadDetail = {
    thread: {
      thread_id: 'thread-1',
      viewer_id: VIEWER_PK,
      users: [{ pk: CREATOR_PK, username: 'daily_dani' }],
      items: [
        { item_id: 'item-3', user_id: CREATOR_PK, item_type: 'text', text: 'also what does it cost?', timestamp: '1770000100000000' },
        { item_id: 'item-2', user_id: CREATOR_PK, item_type: 'text', text: 'omg how does it work?', timestamp: '1770000000000000' },
      ],
    },
  };

  const { viewerId, threads } = mergeCapturedThreads([inboxPayload(), threadDetail]);

  assert.equal(viewerId, VIEWER_PK);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].items.length, 3);
  assert.deepEqual(threads[0].users, [{ pk: CREATOR_PK, username: 'daily_dani' }]);
});

test('extractCounterpartMessages returns only their messages, oldest first', () => {
  const { threads, viewerId } = mergeCapturedThreads([inboxPayload()]);
  const messages = extractCounterpartMessages(threads[0], viewerId);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].itemId, 'item-2');
  assert.equal(messages[0].username, 'daily_dani');
  assert.equal(messages[0].text, 'omg how does it work?');
  assert.equal(messages[0].respondedAt.toISOString(), new Date(1770000000000).toISOString());
});

test('extractCounterpartMessages skips group threads', () => {
  const payload = inboxPayload({
    users: [
      { pk: CREATOR_PK, username: 'daily_dani' },
      { pk: '222', username: 'someone_else' },
    ],
  });
  const { threads, viewerId } = mergeCapturedThreads([payload]);

  assert.deepEqual(extractCounterpartMessages(threads[0], viewerId), []);
});

test('extractCounterpartMessages falls back to cookie viewer id', () => {
  const payload = inboxPayload({ viewer_id: undefined });
  delete payload.viewer;
  const { threads, viewerId } = mergeCapturedThreads([payload]);

  assert.equal(viewerId, null);
  const messages = extractCounterpartMessages(threads[0], VIEWER_PK);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].itemId, 'item-2');
});

test('describeItem labels non-text items', () => {
  assert.equal(describeItem({ item_type: 'text', text: 'hello' }), 'hello');
  assert.equal(describeItem({ item_type: 'voice_media' }), '[voice message]');
  assert.equal(describeItem({ item_type: 'reel_share', reel_share: { text: 'nice story' } }), 'nice story');
  assert.equal(describeItem({ item_type: 'mystery_type' }), '[mystery_type]');
});

test('igTimestampToDate handles micro, milli, and second precision', () => {
  const expected = new Date(1770000000000).toISOString();
  assert.equal(igTimestampToDate('1770000000000000').toISOString(), expected);
  assert.equal(igTimestampToDate(1770000000000).toISOString(), expected);
  assert.equal(igTimestampToDate(1770000000).toISOString(), expected);
  assert.equal(igTimestampToDate('not-a-number'), null);
  assert.equal(igTimestampToDate(0), null);
});

test('buildLeadMap keeps the most recent send per handle', () => {
  const leads = buildLeadMap([
    { handle: '@Daily_Dani', campaign: 'old_campaign', sent_at: '2026-01-01T00:00:00Z', creator_id: 'c1' },
    { handle: 'daily_dani', campaign: 'ugc_creators', sent_at: '2026-06-01T00:00:00Z', creator_id: 'c1' },
    { handle: 'other_person', campaign: 'day_in_life_creators', sent_at: '2026-05-01T00:00:00Z', creator_id: 'c2' },
  ]);

  assert.equal(leads.size, 2);
  assert.equal(leads.get('daily_dani').campaign, 'ugc_creators');
  assert.equal(leads.get('other_person').creator_id, 'c2');
});

test('parseArgs reads accounts, thread cap, and flags', () => {
  const options = parseArgs(['--account', '@MH.Iris', '--account=mh_zoe', '--max-threads=5', '--inbox-pages=2', '--debug-capture']);
  assert.deepEqual(options.accounts, ['mh.iris', 'mh_zoe']);
  assert.equal(options.maxThreads, 5);
  assert.equal(options.inboxPages, 2);
  assert.equal(options.debugCapture, true);

  const fallback = parseArgs(['--max-threads=zero', '--inbox-pages=-1']);
  assert.equal(fallback.maxThreads, 25);
  assert.equal(fallback.inboxPages, 3);
});

test('parseArgs rejects flags with missing values', () => {
  assert.throws(() => parseArgs(['--account']), /Missing value for --account/);
  assert.throws(() => parseArgs(['--account', '--debug-capture']), /Missing value for --account/);
  assert.throws(() => parseArgs(['--max-threads']), /Missing value for --max-threads/);
});

test('mergeCapturedThreads skips threads without a thread_id', () => {
  const payload = {
    inbox: {
      threads: [{ thread_v2_id: 'only-v2-id', users: [{ pk: CREATOR_PK, username: 'x' }], items: [] }],
    },
  };
  assert.deepEqual(mergeCapturedThreads([payload]).threads, []);
});
