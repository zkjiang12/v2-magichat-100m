import pg from 'pg';

const { Pool } = pg;

export function createDashboardRecorder({ config }) {
  if (!config.databaseUrl) return null;

  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: numberEnv('DATABASE_POOL_MAX', 3),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ssl: shouldUseSsl(config.databaseUrl) ? { rejectUnauthorized: false } : false,
  });

  const campaign = config.campaign;
  const enqueueStatus = config.dashboardEnqueueStatus;

  return {
    async createScraperRun({ seedHandles, maxAccepted, followingLimit, qualificationWorkers, state }) {
      const result = await pool.query(
        `
          insert into scraper_runs (
            campaign,
            status,
            seed_handles,
            max_accepted,
            following_limit,
            qualification_workers,
            state,
            counters,
            started_at,
            updated_at
          )
          values ($1, 'running', $2, $3, $4, $5, $6, $7, now(), now())
          returning *
        `,
        [
          campaign,
          seedHandles,
          maxAccepted,
          followingLimit,
          qualificationWorkers,
          JSON.stringify(state),
          JSON.stringify(countersFromState(state)),
        ],
      );
      return result.rows[0];
    },

    async claimScraperRun({ runId, fallbackState }) {
      const result = await pool.query(
        `
          update scraper_runs
          set status = 'running',
              state = case when state = '{}'::jsonb then $2 else state end,
              counters = case when state = '{}'::jsonb then $3 else counters end,
              started_at = coalesce(started_at, now()),
              updated_at = now()
          where id = $1
          returning *
        `,
        [runId, JSON.stringify(fallbackState), JSON.stringify(countersFromState(fallbackState))],
      );
      return result.rows[0] || null;
    },

    async claimNextScraperRun() {
      const result = await pool.query(
        `
          update scraper_runs
          set status = 'running',
              started_at = coalesce(started_at, now()),
              updated_at = now()
          where id = (
            select id
            from scraper_runs
            where campaign = $1
              and status in ('requested', 'paused')
            order by created_at asc
            for update skip locked
            limit 1
          )
          returning *
        `,
        [campaign],
      );
      return result.rows[0] || null;
    },

    async saveScraperRunState({ runId, state, status = 'running' }) {
      await pool.query(
        `
          update scraper_runs
          set state = $2,
              counters = $3,
              status = case
                when status in ('pause_requested', 'stop_requested') then status
                else $4
              end,
              updated_at = now()
          where id = $1
        `,
        [runId, JSON.stringify(state), JSON.stringify(countersFromState(state)), status],
      );
    },

    async completeScraperRun({ runId, state, status }) {
      await pool.query(
        `
          update scraper_runs
          set state = $2,
              counters = $3,
              status = $4,
              completed_at = now(),
              updated_at = now()
          where id = $1
        `,
        [runId, JSON.stringify(state), JSON.stringify(countersFromState(state)), status],
      );
    },

    async failScraperRun({ runId, state, error }) {
      await pool.query(
        `
          update scraper_runs
          set state = $2,
              counters = $3,
              status = 'failed',
              error = $4,
              completed_at = now(),
              updated_at = now()
          where id = $1
        `,
        [runId, JSON.stringify(state), JSON.stringify(countersFromState(state)), error],
      );
    },

    async nextScraperCommand({ runId }) {
      const result = await pool.query(
        `
          select *
          from run_commands
          where run_type = 'scraper'
            and run_id = $1
            and status = 'pending'
          order by created_at asc
          limit 1
        `,
        [runId],
      );
      if (result.rows[0]) return result.rows[0];

      const runResult = await pool.query(
        `
          select status
          from scraper_runs
          where id = $1
        `,
        [runId],
      );
      const status = runResult.rows[0]?.status;
      if (status === 'stop_requested') {
        return { id: null, command: 'stop' };
      }
      if (status === 'pause_requested') {
        return { id: null, command: 'pause' };
      }
      return null;
    },

    async markCommandApplied({ commandId }) {
      if (!commandId) return;
      await pool.query(
        `
          update run_commands
          set status = 'applied',
              applied_at = now()
          where id = $1
        `,
        [commandId],
      );
    },

    async recordSeenMany(records) {
      for (const record of records) {
        const creator = await upsertCreator(pool, record);
        await upsertScrapeEvent(pool, {
          campaign,
          creatorId: creator.id,
          record,
          eventType: 'seen',
          eventAt: record.discoveredAt,
          externalKey: `${record.handle}:seen:${record.discoveredAt}`,
        });
      }
    },

    async recordEvaluated(record) {
      const creator = await upsertCreator(pool, record);
      await upsertEvaluation(pool, { creatorId: creator.id, record, campaign });
      await upsertScrapeEvent(pool, {
        campaign,
        creatorId: creator.id,
        record,
        eventType: 'processed',
        eventAt: record.scoredAt,
        externalKey: `${record.handle}:processed:${record.scoredAt}`,
      });
      await upsertScrapeEvent(pool, {
        campaign,
        creatorId: creator.id,
        record,
        eventType: record.status,
        eventAt: record.scoredAt,
        externalKey: `${record.handle}:${record.status}:${record.scoredAt}`,
      });

      if (record.status === 'accepted') {
        await upsertQueueItem(pool, {
          creatorId: creator.id,
          campaign,
          status: enqueueStatus,
        });
      }
    },

    async recordFailed(record) {
      const creator = await upsertCreator(pool, record);
      await upsertScrapeEvent(pool, {
        campaign,
        creatorId: creator.id,
        record,
        eventType: 'failed',
        eventAt: record.failedAt,
        externalKey: `${record.handle}:failed:${record.failedAt}`,
      });
    },

    async recordApifyRun(run) {
      await upsertCostEvent(pool, {
        campaign,
        provider: 'apify',
        purpose: run.purpose,
        amountUsd: numberOrZero(run.usageTotalUsd),
        externalRunId: run.runId,
        eventAt: run.finishedAt || run.startedAt || new Date().toISOString(),
        metadata: {
          actorId: run.actorId,
          status: run.status,
          input: run.input,
          defaultDatasetId: run.defaultDatasetId,
          chargedEventCounts: run.chargedEventCounts,
        },
      });
    },

    async recordOpenAiScore({ handle, scored }) {
      await upsertCostEvent(pool, {
        campaign,
        provider: 'openai',
        purpose: 'scoring',
        amountUsd: numberOrZero(scored.estimatedCostUsd),
        inputTokens: integerOrNull(scored.usage?.inputTokens),
        cachedInputTokens: integerOrNull(scored.usage?.cachedInputTokens),
        outputTokens: integerOrNull(scored.usage?.outputTokens),
        externalRunId: `${handle}:openai:${Date.now()}`,
        eventAt: new Date().toISOString(),
        metadata: {
          handle,
          model: scored.model,
        },
      });
    },

    async close() {
      await pool.end();
    },
  };
}

function countersFromState(state) {
  return {
    accepted: state.acceptedCount || 0,
    processed: state.processedCount || 0,
    failed: state.failedCount || 0,
    seen: Object.keys(state.seen || {}).length,
    queued: state.qualificationQueue?.length || 0,
    currentSeed: state.currentSeed || null,
  };
}

async function upsertCreator(pool, record) {
  const result = await pool.query(
    `
      insert into creators (
        handle,
        profile_url,
        display_name,
        followers_count,
        following_count,
        is_private,
        is_verified,
        source_seed,
        discovered_at,
        bio,
        emails,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
      on conflict (handle)
      do update set
        profile_url = coalesce(excluded.profile_url, creators.profile_url),
        display_name = coalesce(excluded.display_name, creators.display_name),
        followers_count = coalesce(excluded.followers_count, creators.followers_count),
        following_count = coalesce(excluded.following_count, creators.following_count),
        is_private = coalesce(excluded.is_private, creators.is_private),
        is_verified = coalesce(excluded.is_verified, creators.is_verified),
        source_seed = coalesce(excluded.source_seed, creators.source_seed),
        discovered_at = coalesce(creators.discovered_at, excluded.discovered_at),
        bio = coalesce(excluded.bio, creators.bio),
        emails = case
          when coalesce(array_length(excluded.emails, 1), 0) > 0 then excluded.emails
          else creators.emails
        end,
        updated_at = now()
      returning *
    `,
    [
      record.handle,
      record.profileUrl || `https://www.instagram.com/${record.handle}/`,
      record.name || null,
      integerOrNull(record.followersCount),
      integerOrNull(record.followingCount),
      booleanOrNull(record.isPrivate),
      booleanOrNull(record.isVerified),
      record.sourceSeed || null,
      timestampOrNull(record.discoveredAt),
      record.bio || null,
      Array.isArray(record.emails) ? record.emails : [],
    ],
  );
  return result.rows[0];
}

async function upsertEvaluation(pool, { creatorId, record, campaign }) {
  await pool.query(
    `
      insert into creator_evaluations (
        creator_id,
        campaign,
        fit_score,
        list,
        reasoning,
        review_path,
        raw_record,
        evaluated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      on conflict (creator_id, campaign)
      do update set
        fit_score = excluded.fit_score,
        list = excluded.list,
        reasoning = excluded.reasoning,
        review_path = excluded.review_path,
        raw_record = excluded.raw_record,
        evaluated_at = excluded.evaluated_at
    `,
    [
      creatorId,
      campaign,
      Number(record.fitScore),
      record.list || null,
      record.reasoning || null,
      record.reviewPath || null,
      JSON.stringify(record),
      timestampOrNull(record.scoredAt),
    ],
  );
}

async function upsertScrapeEvent(
  pool,
  { campaign, creatorId, record, eventType, eventAt, externalKey },
) {
  await pool.query(
    `
      insert into scrape_events (
        campaign,
        creator_id,
        handle,
        event_type,
        source_seed,
        event_at,
        metadata,
        external_key
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      on conflict (campaign, external_key)
      do update set
        creator_id = excluded.creator_id,
        handle = excluded.handle,
        event_at = excluded.event_at,
        metadata = excluded.metadata
    `,
    [
      campaign,
      creatorId,
      record.handle,
      eventType,
      record.sourceSeed || null,
      timestampOrNull(eventAt) || new Date(),
      JSON.stringify({
        status: record.status,
        fitScore: record.fitScore ?? null,
        list: record.list ?? null,
        reasoning: record.reasoning ?? null,
        error: record.error ?? null,
      }),
      externalKey,
    ],
  );
}

async function upsertQueueItem(pool, { creatorId, campaign, status }) {
  await pool.query(
    `
      insert into send_queue (creator_id, campaign, status)
      values ($1, $2, $3)
      on conflict (creator_id, campaign)
      do update set updated_at = now()
    `,
    [creatorId, campaign, status],
  );
}

async function upsertCostEvent(
  pool,
  {
    campaign,
    provider,
    purpose,
    amountUsd,
    inputTokens = null,
    cachedInputTokens = null,
    outputTokens = null,
    externalRunId,
    eventAt,
    metadata = {},
  },
) {
  await pool.query(
    `
      insert into cost_events (
        campaign,
        provider,
        purpose,
        amount_usd,
        input_tokens,
        cached_input_tokens,
        output_tokens,
        external_run_id,
        event_at,
        metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      on conflict (campaign, provider, purpose, external_run_id)
      do update set
        amount_usd = excluded.amount_usd,
        input_tokens = excluded.input_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        output_tokens = excluded.output_tokens,
        event_at = excluded.event_at,
        metadata = excluded.metadata
    `,
    [
      campaign,
      provider,
      purpose,
      amountUsd,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      externalRunId,
      timestampOrNull(eventAt) || new Date(),
      JSON.stringify(metadata),
    ],
  );
}

function shouldUseSsl(databaseUrl) {
  return !/localhost|127\.0\.0\.1/.test(databaseUrl);
}

function numberEnv(name, fallback) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function timestampOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
