import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractBodyText,
  extractEmailAddress,
  normalizeCampaignAnalytics,
  normalizeReceivedEmail,
} from '../src/instantly-check-replies.js';
import { createInstantlyClient } from '../src/instantly.js';

test('extractEmailAddress handles bare addresses, display names, and junk', () => {
  assert.equal(extractEmailAddress('jane@example.com'), 'jane@example.com');
  assert.equal(extractEmailAddress('Jane Doe <Jane@Example.com>'), 'jane@example.com');
  assert.equal(extractEmailAddress('"Doe, Jane" <jane@example.com>'), 'jane@example.com');
  assert.equal(extractEmailAddress('no email here'), null);
  assert.equal(extractEmailAddress(null), null);
  assert.equal(extractEmailAddress(42), null);
});

test('extractBodyText prefers text, falls back to stripped html, then preview', () => {
  assert.equal(extractBodyText({ body: 'plain string body' }), 'plain string body');
  assert.equal(extractBodyText({ body: { text: 'hi there', html: '<p>ignored</p>' } }), 'hi there');
  assert.equal(
    extractBodyText({ body: { html: '<div>Hey!<br>Sounds&nbsp;good &amp; fun</div><style>p{}</style>' } }),
    'Hey!\nSounds good & fun',
  );
  assert.equal(extractBodyText({ content_preview: 'preview only' }), 'preview only');
  assert.equal(extractBodyText({}), '');
});

test('extractBodyText caps very long bodies', () => {
  const text = extractBodyText({ body: 'x'.repeat(9000) });
  assert.equal(text.length, 5001);
  assert.ok(text.endsWith('…'));
});

test('normalizeReceivedEmail maps an Instantly email item to a reply row', () => {
  const reply = normalizeReceivedEmail({
    id: 'em-1',
    thread_id: 'th-1',
    lead: 'Lead@Creator.com',
    from_address_email: 'Lead Name <lead@creator.com>',
    subject: 'Re: collab',
    body: { text: 'sounds interesting' },
    timestamp_email: '2026-06-10T12:00:00Z',
  });
  assert.deepEqual(reply, {
    instantlyEmailId: 'em-1',
    threadId: 'th-1',
    leadEmail: 'lead@creator.com',
    fromAddress: 'Lead Name <lead@creator.com>',
    subject: 'Re: collab',
    bodyText: 'sounds interesting',
    receivedAt: '2026-06-10T12:00:00Z',
  });
});

test('normalizeReceivedEmail falls back to from_address_email and rejects junk', () => {
  const reply = normalizeReceivedEmail({
    id: 'em-2',
    from_address_email: 'Other <other@creator.com>',
    timestamp_created: '2026-06-09T08:00:00Z',
  });
  assert.equal(reply.leadEmail, 'other@creator.com');
  assert.equal(reply.receivedAt, '2026-06-09T08:00:00Z');

  assert.equal(normalizeReceivedEmail(null), null);
  assert.equal(normalizeReceivedEmail({ lead: 'a@b.com' }), null); // no id
  assert.equal(normalizeReceivedEmail({ id: 'em-3' }), null); // no usable email
});

test('listEmails paginates with the campaign and email_type filters', async () => {
  const requests = [];
  const pages = [
    { items: [{ id: 'a' }, { id: 'b' }], next_starting_after: 'cursor-1' },
    { items: [{ id: 'c' }], next_starting_after: null },
  ];
  const fetchImpl = async (url) => {
    requests.push(url);
    return { ok: true, status: 200, json: async () => pages[requests.length - 1] };
  };

  const client = createInstantlyClient({ apiKey: 'test-key', fetchImpl });
  const emails = await client.listEmails({ campaignId: 'camp-1' });

  assert.deepEqual(emails.map((email) => email.id), ['a', 'b', 'c']);
  assert.equal(requests.length, 2);
  const first = new URL(requests[0]);
  assert.equal(first.searchParams.get('campaign_id'), 'camp-1');
  assert.equal(first.searchParams.get('email_type'), 'received');
  assert.equal(first.searchParams.get('starting_after'), null);
  const second = new URL(requests[1]);
  assert.equal(second.searchParams.get('starting_after'), 'cursor-1');
});

test('listEmails stops on a repeated cursor instead of looping forever', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: `item-${calls}` }], next_starting_after: 'same-cursor' }),
    };
  };

  const client = createInstantlyClient({ apiKey: 'test-key', fetchImpl });
  const emails = await client.listEmails({ campaignId: 'camp-1' });

  assert.equal(calls, 2);
  assert.equal(emails.length, 2);
});

test('normalizeCampaignAnalytics defaults missing counts to zero', () => {
  assert.equal(normalizeCampaignAnalytics(null), null);
  assert.deepEqual(
    normalizeCampaignAnalytics({
      campaign_id: 'camp-1',
      leads_count: 555,
      contacted_count: 540,
      emails_sent_count: 1080,
      bounced_count: 12,
      reply_count: 31,
    }),
    { leadsCount: 555, contactedCount: 540, emailsSentCount: 1080, bouncedCount: 12, replyCount: 31 },
  );
  assert.deepEqual(
    normalizeCampaignAnalytics({ campaign_id: 'camp-1', emails_sent_count: '7', bounced_count: null }),
    { leadsCount: 0, contactedCount: 0, emailsSentCount: 7, bouncedCount: 0, replyCount: 0 },
  );
});

test('getCampaignAnalytics queries by id and picks the matching row', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => [
        { campaign_id: 'other', emails_sent_count: 1 },
        { campaign_id: 'camp-1', emails_sent_count: 42 },
      ],
    };
  };

  const client = createInstantlyClient({ apiKey: 'test-key', fetchImpl });
  const analytics = await client.getCampaignAnalytics({ campaignId: 'camp-1' });

  assert.equal(analytics.emails_sent_count, 42);
  const url = new URL(requests[0]);
  assert.ok(url.pathname.endsWith('/campaigns/analytics'));
  assert.equal(url.searchParams.get('id'), 'camp-1');
});
