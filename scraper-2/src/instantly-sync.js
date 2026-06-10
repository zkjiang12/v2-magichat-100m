#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import pg from 'pg';

import './config.js';
import { listCampaignNames } from './campaigns/index.js';
import { createInstantlyClient, isDuplicateLeadError } from './instantly.js';

const DEFAULT_MIN_FIT_SCORE = 3;
const LEAD_PUSH_DELAY_MS = 150;

export function instantlyCampaignEnvKey(campaign) {
  return `INSTANTLY_CAMPAIGN_ID_${campaign.toUpperCase()}`;
}

export function resolveCampaignMapping({ env = process.env, campaigns = listCampaignNames() } = {}) {
  const mapping = {};
  const unmapped = [];
  for (const campaign of campaigns) {
    const id = env[instantlyCampaignEnvKey(campaign)];
    if (id) {
      mapping[campaign] = id;
    } else {
      unmapped.push(campaign);
    }
  }
  return { mapping, unmapped };
}

export async function runInstantlySync({
  live = false,
  limit = null,
  campaign = null,
  log = console.log,
} = {}) {
  const apiKey = process.env.INSTANTLY_API_KEY;
  if (!apiKey) throw new Error('INSTANTLY_API_KEY is required.');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');

  const minFitScore = Number(process.env.INSTANTLY_MIN_FIT_SCORE || DEFAULT_MIN_FIT_SCORE);
  if (!Number.isFinite(minFitScore)) throw new Error('INSTANTLY_MIN_FIT_SCORE must be a number.');

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

  try {
    const pending = await pool.query(
      `
        select
          ce.campaign,
          ce.fit_score,
          c.id as creator_id,
          c.handle,
          c.display_name,
          c.followers_count,
          c.bio,
          e.email
        from creator_evaluations ce
        join creators c on c.id = ce.creator_id
        cross join lateral unnest(c.emails) as e(email)
        where ce.fit_score >= $1
          and ce.campaign = any($2)
          and not exists (
            select 1
            from instantly_sync s
            where s.creator_id = c.id
              and s.campaign = ce.campaign
              and s.email = e.email
              and s.status in ('pushed', 'skipped')
          )
        order by ce.fit_score desc, c.followers_count desc nulls last
        ${limit ? 'limit $3' : ''}
      `,
      limit ? [minFitScore, mappedCampaigns, limit] : [minFitScore, mappedCampaigns],
    );

    const summary = {
      scanned: pending.rows.length,
      pushed: 0,
      skipped: 0,
      failed: 0,
      byCampaign: {},
    };
    for (const row of pending.rows) {
      summary.byCampaign[row.campaign] = (summary.byCampaign[row.campaign] || 0) + 1;
    }

    if (!live) {
      log(`[instantly] DRY RUN: ${summary.scanned} leads would be pushed (min fit ${minFitScore}).`);
      for (const [name, count] of Object.entries(summary.byCampaign)) {
        log(`[instantly]   ${name} -> ${mapping[name]}: ${count} leads`);
      }
      for (const row of pending.rows.slice(0, 10)) {
        log(
          `[instantly]   sample @${row.handle} <${row.email}> fit=${row.fit_score} campaign=${row.campaign}`,
        );
      }
      return summary;
    }

    const client = createInstantlyClient({ apiKey });
    for (const row of pending.rows) {
      const result = await pushLead({ client, pool, row, instantlyCampaignId: mapping[row.campaign], log });
      summary[result] += 1;
      await sleep(LEAD_PUSH_DELAY_MS);
    }

    log(
      `[instantly] sync complete: pushed=${summary.pushed} skipped=${summary.skipped} failed=${summary.failed} (scanned=${summary.scanned})`,
    );
    return summary;
  } finally {
    await pool.end();
  }
}

async function pushLead({ client, pool, row, instantlyCampaignId, log }) {
  const { firstName, lastName } = splitName(row.display_name);
  let status = 'pushed';
  let leadId = null;
  let errorMessage = null;

  try {
    const lead = await client.createLead({
      campaign: instantlyCampaignId,
      email: row.email,
      first_name: firstName,
      last_name: lastName,
      skip_if_in_campaign: true,
      custom_variables: {
        username: row.handle,
        name: row.display_name || row.handle,
        follower_count: row.followers_count ?? '',
        fit_score: row.fit_score,
        bio: row.bio || '',
        profile_url: `https://www.instagram.com/${row.handle}/`,
        source_campaign: row.campaign,
      },
    });
    leadId = lead?.id || null;
  } catch (error) {
    if (isDuplicateLeadError(error)) {
      status = 'skipped';
      errorMessage = 'duplicate lead in campaign';
    } else {
      status = 'failed';
      errorMessage = error.message?.slice(0, 500) || 'unknown error';
      log(`[instantly] FAILED @${row.handle} <${row.email}>: ${errorMessage}`);
    }
  }

  await pool.query(
    `
      insert into instantly_sync (
        creator_id, campaign, email, instantly_campaign_id, instantly_lead_id, status, error, pushed_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, case when $6 = 'pushed' then now() else null end)
      on conflict (creator_id, campaign, email)
      do update set
        instantly_campaign_id = excluded.instantly_campaign_id,
        instantly_lead_id = excluded.instantly_lead_id,
        status = excluded.status,
        error = excluded.error,
        pushed_at = coalesce(excluded.pushed_at, instantly_sync.pushed_at),
        updated_at = now()
    `,
    [row.creator_id, row.campaign, row.email, instantlyCampaignId, leadId, status, errorMessage],
  );

  return status;
}

export function splitName(displayName) {
  const cleaned = (displayName || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return { firstName: '', lastName: '' };
  const parts = cleaned.split(' ');
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex !== -1 ? Number(args[limitIndex + 1]) : null;
  const campaignIndex = args.indexOf('--campaign');
  const campaign = campaignIndex !== -1 ? args[campaignIndex + 1] : null;

  if (limit !== null && (!Number.isFinite(limit) || limit < 1)) {
    console.error('--limit must be a positive number');
    process.exit(1);
  }

  runInstantlySync({ live, limit, campaign })
    .then(() => {
      if (!live) console.log('[instantly] re-run with --live to push leads.');
    })
    .catch((error) => {
      console.error(`[instantly] sync failed: ${error.message}`);
      process.exit(1);
    });
}
