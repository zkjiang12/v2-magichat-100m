#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import pg from 'pg';

import './config.js';
import { getCampaignDefinition, listCampaignNames } from './campaigns/index.js';
import { createInstantlyClient, isDuplicateLeadError } from './instantly.js';

const DEFAULT_MIN_FIT_SCORE = 3;
const LEAD_PUSH_DELAY_MS = 150;
const MAX_PUSH_ATTEMPTS = 3;

export function instantlyCampaignEnvKey(campaign) {
  return `INSTANTLY_CAMPAIGN_ID_${campaign.toUpperCase()}`;
}

// Routing lists a campaign's accept() rule admits, derived by probing the
// campaign definition so the sync can't drift from the scraper's accept gate
// (day_in_life_us accepts only US-evidence lists; a score-only sync would
// push no_us_evidence creators into a US cold-email campaign). Returns null
// when the campaign accepts every list (or is rule-scored with no lists) —
// i.e. no SQL restriction needed.
export function instantlyAcceptedLists(campaign) {
  const definition = getCampaignDefinition(campaign);
  const listValues = definition.scoring?.listValues;
  if (!Array.isArray(listValues)) return null;
  const allowed = listValues.filter((list) => definition.accept({ fitScore: 4, list }));
  return allowed.length === listValues.length ? null : allowed;
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
  if (live && !apiKey) throw new Error('INSTANTLY_API_KEY is required for --live.');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');

  const minFitScoreRaw = process.env.INSTANTLY_MIN_FIT_SCORE;
  const minFitScore =
    minFitScoreRaw === undefined || minFitScoreRaw === '' ? DEFAULT_MIN_FIT_SCORE : Number(minFitScoreRaw);
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
    // Excludes leads already pushed/skipped, and failed leads that exhausted
    // their retry budget (so a permanently-bad email can't starve the queue).
    const params = [minFitScore, MAX_PUSH_ATTEMPTS];
    const campaignConditions = [];
    const unrestricted = [];
    for (const name of mappedCampaigns) {
      const lists = instantlyAcceptedLists(name);
      if (lists) {
        params.push(name, lists);
        campaignConditions.push(
          `(ce.campaign = $${params.length - 1} and ce.list = any($${params.length}))`,
        );
        log(`[instantly] ${name}: restricted to accepted lists (${lists.join(', ')})`);
      } else {
        unrestricted.push(name);
      }
    }
    if (unrestricted.length > 0) {
      params.push(unrestricted);
      campaignConditions.push(`ce.campaign = any($${params.length})`);
    }
    let limitClause = '';
    if (limit) {
      params.push(limit);
      limitClause = `limit $${params.length}`;
    }
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
          and (${campaignConditions.join(' or ')})
          and not exists (
            select 1
            from instantly_sync s
            where s.creator_id = c.id
              and s.campaign = ce.campaign
              and s.email = e.email
              and (s.status in ('pushed', 'skipped') or s.attempts >= $2)
          )
        order by ce.fit_score desc, c.followers_count desc nulls last
        ${limitClause}
      `,
      params,
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
    if (!leadId) {
      // skip_if_in_campaign matches return 200 without a lead id.
      status = 'skipped';
      errorMessage = 'no lead id in response (already in campaign)';
    }
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
        attempts = instantly_sync.attempts + 1,
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
  const live = args.includes('--live');
  const limitRaw = flagValue(args, '--limit');
  const limit = limitRaw === null ? null : Number(limitRaw);
  const campaign = flagValue(args, '--campaign');

  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    console.error('--limit must be a positive integer');
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
