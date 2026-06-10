#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import pg from 'pg';

import { getConfig } from './config.js';
import { collectCreatorEmails } from './contacts.js';
import { fetchApifyDatasetItems, runApifyActor } from './instagram.js';

const DEFAULT_MIN_FIT_SCORE = 3;
const DEFAULT_RESCRAPE_BATCH_SIZE = 50;

export async function backfillFromLocalFiles({ pool, dataDir, log = console.log }) {
  let fileNames = [];
  try {
    fileNames = (await fs.readdir(dataDir)).filter((name) => name.endsWith('.json'));
  } catch (error) {
    log(`[backfill] no local evaluation dir at ${dataDir} (${error.code}); skipping file phase.`);
    return { files: 0, updated: 0, withEmail: 0 };
  }

  // Keep only the newest evaluation per handle.
  const latestByHandle = new Map();
  for (const fileName of fileNames) {
    let record;
    try {
      record = JSON.parse(await fs.readFile(path.join(dataDir, fileName), 'utf8'));
    } catch {
      continue;
    }
    const handle = record?.handle;
    const creator = record?.scrapedProfile?.creator;
    if (!handle || !creator) continue;
    const existing = latestByHandle.get(handle);
    if (!existing || String(record.createdAt) > String(existing.createdAt)) {
      latestByHandle.set(handle, {
        createdAt: record.createdAt,
        bio: creator.bio || null,
        publicEmail: creator.publicEmail || null,
      });
    }
  }

  let updated = 0;
  let withEmail = 0;
  for (const [handle, info] of latestByHandle) {
    const emails = collectCreatorEmails({ bio: info.bio, publicEmail: info.publicEmail });
    if (!info.bio && emails.length === 0) continue;
    const result = await pool.query(
      `
        update creators
        set bio = coalesce(creators.bio, $2),
            emails = (
              select coalesce(array_agg(distinct e), '{}'::text[])
              from unnest(creators.emails || $3::text[]) as t(e)
            ),
            updated_at = now()
        where handle = $1
      `,
      [handle, info.bio, emails],
    );
    if (result.rowCount > 0) {
      updated += 1;
      if (emails.length > 0) withEmail += 1;
    }
  }

  log(
    `[backfill] local files: ${fileNames.length} files, ${latestByHandle.size} unique handles, ${updated} creators updated, ${withEmail} had an email.`,
  );
  return { files: fileNames.length, updated, withEmail };
}

export async function rescrapeMissingProfiles({
  pool,
  config,
  minFitScore,
  batchSize = DEFAULT_RESCRAPE_BATCH_SIZE,
  rescrapeLimit = null,
  log = console.log,
}) {
  const candidates = await pool.query(
    `
      select distinct c.id, c.handle
      from creators c
      join creator_evaluations ce on ce.creator_id = c.id
      where ce.fit_score >= $1
        and coalesce(array_length(c.emails, 1), 0) = 0
        and c.contact_scraped_at is null
      order by c.handle
      ${rescrapeLimit ? 'limit $2' : ''}
    `,
    rescrapeLimit ? [minFitScore, rescrapeLimit] : [minFitScore],
  );

  log(`[backfill] re-scraping ${candidates.rows.length} qualified creators with no known email.`);

  let scraped = 0;
  let foundEmail = 0;
  for (let start = 0; start < candidates.rows.length; start += batchSize) {
    const batch = candidates.rows.slice(start, start + batchSize);
    const usernames = batch.map((row) => row.handle);

    const run = await runApifyActor({
      actorId: config.apifyInstagramProfileActorId,
      token: config.apifyToken,
      maxTotalChargeUsd: config.apifyMaxRunUsd,
      runPurpose: 'contact-backfill',
      runCostTracker: config.apifyRunCostTracker || null,
      waitForFinishSecs: 600,
      input: { usernames, resultsLimit: 1 },
    });
    const items = await fetchApifyDatasetItems({
      datasetId: run.defaultDatasetId,
      token: config.apifyToken,
      limit: batch.length + 10,
    });

    const itemsByUsername = new Map();
    for (const item of items) {
      const username = (item.username || item.userName || '').toLowerCase();
      if (username) itemsByUsername.set(username, item);
    }

    for (const row of batch) {
      const item = itemsByUsername.get(row.handle.toLowerCase());
      const bio = item?.biography || item?.bio || null;
      const publicEmail = item?.publicEmail || item?.businessEmail || item?.public_email || null;
      const emails = collectCreatorEmails({ bio, publicEmail });
      await pool.query(
        `
          update creators
          set bio = coalesce($2, creators.bio),
              emails = (
                select coalesce(array_agg(distinct e), '{}'::text[])
                from unnest(creators.emails || $3::text[]) as t(e)
              ),
              contact_scraped_at = now(),
              updated_at = now()
          where id = $1
        `,
        [row.id, bio, emails],
      );
      scraped += 1;
      if (emails.length > 0) foundEmail += 1;
    }

    log(
      `[backfill] batch ${Math.floor(start / batchSize) + 1}: scraped ${scraped}/${candidates.rows.length}, emails found so far: ${foundEmail}`,
    );
  }

  return { candidates: candidates.rows.length, scraped, foundEmail };
}

export async function reportEmailCoverage({ pool, minFitScore, log = console.log }) {
  const coverage = await pool.query(
    `
      select
        ce.campaign,
        count(distinct c.id) as qualified_creators,
        count(distinct c.id) filter (where coalesce(array_length(c.emails, 1), 0) > 0) as with_email
      from creator_evaluations ce
      join creators c on c.id = ce.creator_id
      where ce.fit_score >= $1
      group by ce.campaign
      order by ce.campaign
    `,
    [minFitScore],
  );

  log(`[backfill] email coverage for fit_score >= ${minFitScore}:`);
  for (const row of coverage.rows) {
    const percent = row.qualified_creators > 0
      ? Math.round((row.with_email / row.qualified_creators) * 100)
      : 0;
    log(
      `[backfill]   ${row.campaign}: ${row.with_email}/${row.qualified_creators} creators with email (${percent}%)`,
    );
  }
  return coverage.rows;
}

async function main() {
  const args = process.argv.slice(2);
  const reportOnly = args.includes('--report-only');
  const rescrape = args.includes('--rescrape');
  const dataDirIndex = args.indexOf('--data-dir');
  const dataDir = dataDirIndex !== -1 ? args[dataDirIndex + 1] : path.resolve('data/evaluations');
  const rescrapeLimitIndex = args.indexOf('--rescrape-limit');
  const rescrapeLimit = rescrapeLimitIndex !== -1 ? Number(args[rescrapeLimitIndex + 1]) : null;
  const minFitScore = Number(process.env.INSTANTLY_MIN_FIT_SCORE || DEFAULT_MIN_FIT_SCORE);

  if (rescrapeLimit !== null && (!Number.isFinite(rescrapeLimit) || rescrapeLimit < 1)) {
    throw new Error('--rescrape-limit must be a positive number');
  }

  const config = getConfig();
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required.');

  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 3,
    ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false },
  });

  try {
    if (!reportOnly) {
      await backfillFromLocalFiles({ pool, dataDir });
      if (rescrape) {
        await rescrapeMissingProfiles({ pool, config, minFitScore, rescrapeLimit });
      }
    }
    await reportEmailCoverage({ pool, minFitScore });
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    console.error(`[backfill] failed: ${error.message}`);
    process.exit(1);
  });
}
