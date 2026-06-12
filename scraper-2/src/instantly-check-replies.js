#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import pg from 'pg';

import './config.js';
import { createInstantlyClient } from './instantly.js';
import { instantlyCampaignEnvKey, resolveCampaignMapping } from './instantly-sync.js';

const MAX_BODY_CHARS = 5000;

// Instantly /emails items vary in shape across email providers; pull out only
// what the CRM stores and normalize the lead email for attribution lookups.
export function normalizeReceivedEmail(item) {
  if (!item || !item.id) return null;
  const leadEmail = extractEmailAddress(item.lead) || extractEmailAddress(item.from_address_email);
  if (!leadEmail) return null;
  return {
    instantlyEmailId: String(item.id),
    threadId: item.thread_id ? String(item.thread_id) : null,
    leadEmail,
    fromAddress: typeof item.from_address_email === 'string' ? item.from_address_email : null,
    subject: typeof item.subject === 'string' ? item.subject : null,
    bodyText: extractBodyText(item),
    receivedAt: item.timestamp_email || item.timestamp_created || null,
  };
}

// Accepts a bare address or a display-name form like 'Jane <jane@x.com>'.
export function extractEmailAddress(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/[^\s<>"',;]+@[^\s<>"',;]+/);
  return match ? match[0].toLowerCase() : null;
}

export function extractBodyText(item) {
  const body = item?.body;
  if (typeof body === 'string') return cleanText(body);
  if (body && typeof body === 'object') {
    if (typeof body.text === 'string' && body.text.trim()) return cleanText(body.text);
    if (typeof body.html === 'string' && body.html.trim()) return cleanText(stripHtml(body.html));
  }
  if (typeof item?.content_preview === 'string') return cleanText(item.content_preview);
  return '';
}

function stripHtml(html) {
  return html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}

function cleanText(text) {
  const cleaned = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned.length > MAX_BODY_CHARS ? `${cleaned.slice(0, MAX_BODY_CHARS)}…` : cleaned;
}

// Counts from Instantly's campaign analytics, defaulting anything missing to
// zero so a partial payload can't write nulls into instantly_campaign_stats.
export function normalizeCampaignAnalytics(item) {
  if (!item) return null;
  const count = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  return {
    leadsCount: count(item.leads_count),
    contactedCount: count(item.contacted_count),
    emailsSentCount: count(item.emails_sent_count),
    bouncedCount: count(item.bounced_count),
    replyCount: count(item.reply_count),
  };
}

export async function runInstantlyReplyCheck({ campaign = null, log = console.log, client = null } = {}) {
  const apiKey = process.env.INSTANTLY_API_KEY;
  if (!client && !apiKey) throw new Error('INSTANTLY_API_KEY is required.');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');

  const { mapping, unmapped } = resolveCampaignMapping();
  if (unmapped.length > 0) {
    log(`[instantly] campaigns without an Instantly campaign id (skipped): ${unmapped.join(', ')}`);
  }
  const mappedCampaigns = campaign ? [campaign].filter((name) => mapping[name]) : Object.keys(mapping);
  if (mappedCampaigns.length === 0) {
    throw new Error(
      `No campaigns are mapped to Instantly. Set ${(campaign ? [campaign] : unmapped)
        .map(instantlyCampaignEnvKey)
        .join(' / ')} in the environment.`,
    );
  }

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 2,
    ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false },
  });

  const instantly = client || createInstantlyClient({ apiKey });
  const summary = {
    seen: 0,
    inserted: 0,
    updated: 0,
    unattributed: 0,
    malformed: 0,
    statsUpdated: 0,
    byCampaign: {},
  };

  try {
    for (const name of mappedCampaigns) {
      const instantlyCampaignId = mapping[name];
      const [emails, attribution] = await Promise.all([
        instantly.listEmails({ campaignId: instantlyCampaignId, emailType: 'received' }),
        loadAttributionMap(pool, instantlyCampaignId),
      ]);

      const campaignSummary = { seen: emails.length, inserted: 0, unattributed: 0 };
      for (const item of emails) {
        const reply = normalizeReceivedEmail(item);
        if (!reply) {
          summary.malformed += 1;
          continue;
        }
        summary.seen += 1;
        const lead = attribution.get(reply.leadEmail) || null;
        if (!lead) {
          summary.unattributed += 1;
          campaignSummary.unattributed += 1;
        }
        const result = await upsertReply({ pool, reply, instantlyCampaignId, lead });
        if (result === 'inserted') {
          summary.inserted += 1;
          campaignSummary.inserted += 1;
        } else if (result === 'updated') {
          summary.updated += 1;
        }
      }
      summary.byCampaign[name] = campaignSummary;
      log(
        `[instantly] ${name}: ${campaignSummary.seen} replies seen, ${campaignSummary.inserted} new` +
          (campaignSummary.unattributed ? `, ${campaignSummary.unattributed} unattributed` : ''),
      );

      // Analytics are a bonus on top of reply capture: a failure here (e.g.
      // endpoint hiccup) shouldn't lose the replies we just stored.
      try {
        const analytics = normalizeCampaignAnalytics(
          await instantly.getCampaignAnalytics({ campaignId: instantlyCampaignId }),
        );
        if (analytics) {
          await upsertCampaignStats({ pool, instantlyCampaignId, campaign: name, analytics });
          summary.statsUpdated += 1;
          log(
            `[instantly] ${name}: stats emails_sent=${analytics.emailsSentCount} ` +
              `contacted=${analytics.contactedCount} bounced=${analytics.bouncedCount}`,
          );
        } else {
          log(`[instantly] ${name}: no analytics returned, stats row left as-is`);
        }
      } catch (error) {
        log(`[instantly] ${name}: analytics fetch failed (${error.message}), stats row left as-is`);
      }
    }

    log(
      `[instantly] reply check complete: seen=${summary.seen} inserted=${summary.inserted} ` +
        `updated=${summary.updated} unattributed=${summary.unattributed} malformed=${summary.malformed} ` +
        `stats_updated=${summary.statsUpdated}/${mappedCampaigns.length}`,
    );
    return summary;
  } finally {
    await pool.end();
  }
}

async function upsertCampaignStats({ pool, instantlyCampaignId, campaign, analytics }) {
  await pool.query(
    `
      insert into instantly_campaign_stats (
        instantly_campaign_id, campaign, leads_count, contacted_count,
        emails_sent_count, bounced_count, reply_count, fetched_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, now())
      on conflict (instantly_campaign_id)
      do update set
        campaign = excluded.campaign,
        leads_count = excluded.leads_count,
        contacted_count = excluded.contacted_count,
        emails_sent_count = excluded.emails_sent_count,
        bounced_count = excluded.bounced_count,
        reply_count = excluded.reply_count,
        fetched_at = now()
    `,
    [
      instantlyCampaignId,
      campaign,
      analytics.leadsCount,
      analytics.contactedCount,
      analytics.emailsSentCount,
      analytics.bouncedCount,
      analytics.replyCount,
    ],
  );
}

// email -> { creatorId, campaign } for every lead pushed to this Instantly campaign.
async function loadAttributionMap(pool, instantlyCampaignId) {
  const result = await pool.query(
    `
      select lower(email) as email, creator_id, campaign
      from instantly_sync
      where instantly_campaign_id = $1 and status = 'pushed'
    `,
    [instantlyCampaignId],
  );
  return new Map(result.rows.map((row) => [row.email, { creatorId: row.creator_id, campaign: row.campaign }]));
}

async function upsertReply({ pool, reply, instantlyCampaignId, lead }) {
  // A reply can arrive before its lead row exists in instantly_sync, so on
  // conflict we only fill in attribution that was missing before. The WHERE on
  // the conflict action means already-attributed rows return no row at all,
  // and xmax = 0 distinguishes fresh inserts from attribution backfills.
  const result = await pool.query(
    `
      insert into email_responses (
        creator_id, campaign, instantly_campaign_id, lead_email, instantly_email_id,
        thread_id, subject, body_text, from_address, received_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      on conflict (instantly_email_id)
      do update set
        creator_id = excluded.creator_id,
        campaign = excluded.campaign
      where email_responses.creator_id is null and excluded.creator_id is not null
      returning (xmax = 0) as inserted
    `,
    [
      lead?.creatorId || null,
      lead?.campaign || null,
      instantlyCampaignId,
      reply.leadEmail,
      reply.instantlyEmailId,
      reply.threadId,
      reply.subject,
      reply.bodyText,
      reply.fromAddress,
      reply.receivedAt,
    ],
  );
  const row = result.rows[0];
  if (!row) return 'unchanged';
  return row.inserted ? 'inserted' : 'updated';
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

function flagValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`${name} requires a value`);
    process.exit(1);
  }
  return value;
}

if (isMain) {
  const args = process.argv.slice(2);
  const campaign = flagValue(args, '--campaign');

  runInstantlyReplyCheck({ campaign }).catch((error) => {
    console.error(`[instantly] reply check failed: ${error.message}`);
    process.exit(1);
  });
}
