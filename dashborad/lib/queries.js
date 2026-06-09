import { query } from './db';

export async function getDashboardData({ campaign, range = '24h' }) {
  const cfg = bucketConfig(range);
  const scrapeTotals = await queryScrapeTotals(campaign);
  const scrapeLastHour = await queryScrapeLastHour(campaign);
  const scrapeHourly = await queryScrapeHourly(campaign, cfg);
  const costTotals = await queryCostTotals(campaign);
  const costLastHour = await queryCostLastHour(campaign);
  const costHourly = await queryCostHourly(campaign, cfg);
  const sendQueueTotals = await querySendQueueTotals(campaign);
  const sendAttemptTotals = await querySendAttemptTotals(campaign);
  const sendAttemptLastHour = await querySendAttemptLastHour(campaign);
  const sendAttemptHourly = await querySendAttemptHourly(campaign, cfg);
  const freshness = await queryFreshness(campaign);
  const scraperRuns = await queryScraperRuns(campaign);
  const senderRuns = await querySenderRuns(campaign);
  const senderAccounts = await querySenderAccounts();
  const runObservability = await queryRunObservability(campaign);
  const acceptedCreators = await queryCreators(campaign);
  const recentEvents = await queryRecentEvents(campaign);

  return {
    scrapeTotals,
    scrapeLastHour,
    scrapeHourly,
    costTotals,
    costLastHour,
    costHourly,
    sendQueueTotals,
    sendAttemptTotals,
    sendAttemptLastHour,
    sendAttemptHourly,
    freshness,
    scraperRuns,
    senderRuns,
    senderAccounts,
    runObservability,
    acceptedCreators,
    recentEvents,
  };
}

export async function createScraperRun({
  campaign,
  seedHandles,
  maxAccepted,
  followingLimit,
  qualificationWorkers,
}) {
  const result = await query(
    `
      insert into scraper_runs (
        campaign,
        seed_handles,
        max_accepted,
        following_limit,
        qualification_workers
      )
      values ($1, $2, $3, $4, $5)
      returning id
    `,
    [campaign, seedHandles, maxAccepted, followingLimit, qualificationWorkers],
  );
  return result.rows[0];
}

export async function recordScraperCloudTrigger({ runId, operationName, target, error }) {
  await query(
    `
      update scraper_runs
      set worker_target = $2,
          cloud_operation_name = $3,
          cloud_triggered_at = case when $4::text is null then now() else cloud_triggered_at end,
          cloud_trigger_error = $4,
          updated_at = now()
      where id = $1
    `,
    [runId, target, operationName || null, error || null],
  );
}

export async function createSenderRun({ campaign, accountUsernames, maxSends }) {
  const result = await query(
    `
      insert into sender_runs (
        campaign,
        account_usernames,
        max_sends
      )
      values ($1, $2, $3)
      returning id
    `,
    [campaign, accountUsernames, maxSends],
  );
  return result.rows[0];
}

export async function recordSenderCloudTrigger({ runId, operationName, target, error }) {
  await query(
    `
      update sender_runs
      set worker_target = $2,
          cloud_operation_name = $3,
          cloud_triggered_at = case when $4::text is null then now() else cloud_triggered_at end,
          cloud_trigger_error = $4,
          updated_at = now()
      where id = $1
    `,
    [runId, target, operationName || null, error || null],
  );
}

export async function createRunCommand({ campaign, runType, runId, command }) {
  if (!['scraper', 'sender'].includes(runType)) {
    throw new Error('Invalid run type');
  }
  if (!['pause', 'resume', 'stop'].includes(command)) {
    throw new Error('Invalid run command');
  }
  if (!isUuid(runId)) {
    throw new Error('Invalid run id');
  }

  if (runType === 'scraper') {
    await query(
      `
        with commandable_run as (
          select id
          from scraper_runs
          where campaign = $1
            and id = $2
            and (
              ($3 = 'pause' and status = 'running')
              or ($3 = 'resume' and status = 'paused')
              or ($3 = 'stop' and status in ('requested', 'running', 'pause_requested', 'paused'))
            )
        ),
        inserted_command as (
          insert into run_commands (campaign, run_type, run_id, command)
          select $1, 'scraper', id, $3
          from commandable_run
          where not exists (
            select 1
            from run_commands
            where campaign = $1
              and run_type = 'scraper'
              and run_id = $2
              and command = $3
              and status = 'pending'
          )
          returning run_id, command
        )
        update scraper_runs
        set status = case
              when inserted_command.command = 'pause' then 'pause_requested'
              when inserted_command.command = 'resume' then 'requested'
              when inserted_command.command = 'stop' then 'stop_requested'
              else scraper_runs.status
            end,
            updated_at = now()
        from inserted_command
        where scraper_runs.id = inserted_command.run_id
      `,
      [campaign, runId, command],
    );
  }

  if (runType === 'sender') {
    await query(
      `
        with commandable_run as (
          select id
          from sender_runs
          where campaign = $1
            and id = $2
            and (
              ($3 = 'pause' and status = 'running')
              or ($3 = 'resume' and status = 'paused')
              or ($3 = 'stop' and status in ('requested', 'running', 'pause_requested', 'paused'))
            )
        ),
        inserted_command as (
          insert into run_commands (campaign, run_type, run_id, command)
          select $1, 'sender', id, $3
          from commandable_run
          where not exists (
            select 1
            from run_commands
            where campaign = $1
              and run_type = 'sender'
              and run_id = $2
              and command = $3
              and status = 'pending'
          )
          returning run_id, command
        )
        update sender_runs
        set status = case
              when inserted_command.command = 'pause' then 'pause_requested'
              when inserted_command.command = 'resume' then 'requested'
              when inserted_command.command = 'stop' then 'stop_requested'
              else sender_runs.status
            end,
            updated_at = now()
        from inserted_command
        where sender_runs.id = inserted_command.run_id
      `,
      [campaign, runId, command],
    );
  }
}

export async function getCreatorDetail({ handle, campaign }) {
  const creatorResult = await query(
    `
      select
        c.*,
        ce.fit_score,
        ce.list,
        ce.reasoning,
        ce.raw_record,
        ce.evaluated_at,
        sq.status as queue_status,
        sq.message,
        sq.sent_at,
        sq.last_error,
        cn.note
      from creators c
      left join creator_evaluations ce
        on ce.creator_id = c.id
        and ce.campaign = $2
      left join send_queue sq
        on sq.creator_id = c.id
        and sq.campaign = $2
      left join campaign_notes cn
        on cn.creator_id = c.id
        and cn.campaign = $2
      where c.handle = $1
      limit 1
    `,
    [handle, campaign],
  );

  const creator = creatorResult.rows[0] || null;
  if (!creator) return null;

  const [attempts, events] = await Promise.all([
    query(
      `
        select
          sa.status,
          sa.provider,
          sa.worker_id,
          sa.message,
          sa.error,
          sa.provider_response,
          sa.created_at,
          sender.username as sender_username
        from send_attempts sa
        join send_queue sq on sq.id = sa.send_queue_id
        left join sender_accounts sender on sender.id = sa.sender_account_id
        where sq.creator_id = $1
          and sq.campaign = $2
        order by sa.created_at desc
      `,
      [creator.id, campaign],
    ),
    query(
      `
        select event_type, source_seed, event_at, metadata
        from scrape_events
        where creator_id = $1
          and campaign = $2
        order by event_at desc
      `,
      [creator.id, campaign],
    ),
  ]);

  return {
    creator,
    attempts: attempts.rows,
    events: events.rows,
  };
}

export async function saveCreatorNote({ handle, campaign, note }) {
  await query(
    `
      insert into campaign_notes (creator_id, campaign, note, updated_at)
      select id, $2, $3, now()
      from creators
      where handle = $1
      on conflict (creator_id, campaign)
      do update set note = excluded.note, updated_at = now()
    `,
    [handle, campaign, note],
  );
}

async function queryScrapeTotals(campaign) {
  const result = await query(
    `
      select
        count(*) filter (where event_type = 'seen')::int as seen,
        count(*) filter (where event_type = 'processed')::int as processed,
        count(*) filter (where event_type = 'accepted')::int as accepted,
        count(*) filter (where event_type = 'rejected')::int as rejected,
        count(*) filter (where event_type = 'failed')::int as failed
      from scrape_events
      where campaign = $1
    `,
    [campaign],
  );
  return normalizeCounts(result.rows[0]);
}

async function queryScrapeLastHour(campaign) {
  const result = await query(
    `
      select
        count(*) filter (where event_type = 'seen')::int as seen,
        count(*) filter (where event_type = 'processed')::int as processed,
        count(*) filter (where event_type = 'accepted')::int as accepted,
        count(*) filter (where event_type = 'rejected')::int as rejected,
        count(*) filter (where event_type = 'failed')::int as failed
      from scrape_events
      where campaign = $1
        and event_at >= now() - interval '1 hour'
    `,
    [campaign],
  );
  return normalizeCounts(result.rows[0]);
}

function bucketConfig(range) {
  if (range === '7d') {
    return { trunc: 'day', step: "interval '1 day'", lookback: "interval '6 days'" };
  }
  if (range === '30d') {
    return { trunc: 'day', step: "interval '1 day'", lookback: "interval '29 days'" };
  }
  return { trunc: 'hour', step: "interval '1 hour'", lookback: "interval '23 hours'" };
}

async function queryScrapeHourly(campaign, cfg = bucketConfig('24h')) {
  const result = await query(
    `
      with buckets as (
        select generate_series(
          date_trunc('${cfg.trunc}', now()) - ${cfg.lookback},
          date_trunc('${cfg.trunc}', now()),
          ${cfg.step}
        ) as hour
      )
      select
        b.hour,
        count(se.*) filter (where se.event_type = 'seen')::int as seen,
        count(se.*) filter (where se.event_type = 'processed')::int as processed,
        count(se.*) filter (where se.event_type = 'accepted')::int as accepted,
        count(se.*) filter (where se.event_type = 'rejected')::int as rejected,
        count(se.*) filter (where se.event_type = 'failed')::int as failed
      from buckets b
      left join scrape_events se
        on date_trunc('${cfg.trunc}', se.event_at) = b.hour
        and se.campaign = $1
      group by b.hour
      order by b.hour
    `,
    [campaign],
  );
  return result.rows.map((row) => ({
    hour: row.hour,
    seen: Number(row.seen || 0),
    processed: Number(row.processed || 0),
    accepted: Number(row.accepted || 0),
    rejected: Number(row.rejected || 0),
    failed: Number(row.failed || 0),
  }));
}

async function queryCostTotals(campaign) {
  return queryCost(campaign, false);
}

async function queryCostLastHour(campaign) {
  return queryCost(campaign, true);
}

async function queryCost(campaign, lastHour) {
  const result = await query(
    `
      select
        coalesce(sum(amount_usd) filter (where provider = 'apify'), 0)::float as apify_usd,
        coalesce(sum(amount_usd) filter (where provider = 'openai'), 0)::float as openai_usd,
        coalesce(sum(amount_usd) filter (where provider in ('apify', 'openai')), 0)::float as total_usd,
        coalesce(sum(profiles_processed) filter (where provider = 'combined'), 0)::int as profiles_processed,
        coalesce(sum(accepted_creators) filter (where provider = 'combined'), 0)::int as accepted_creators
      from cost_events
      where campaign = $1
        and ($2::boolean = false or event_at >= now() - interval '1 hour')
    `,
    [campaign, lastHour],
  );
  const row = result.rows[0] || {};
  return {
    apifyUsd: Number(row.apify_usd || 0),
    openaiUsd: Number(row.openai_usd || 0),
    totalUsd: Number(row.total_usd || 0),
    profilesProcessed: Number(row.profiles_processed || 0),
    acceptedCreators: Number(row.accepted_creators || 0),
  };
}

async function queryCostHourly(campaign, cfg = bucketConfig('24h')) {
  const result = await query(
    `
      with buckets as (
        select generate_series(
          date_trunc('${cfg.trunc}', now()) - ${cfg.lookback},
          date_trunc('${cfg.trunc}', now()),
          ${cfg.step}
        ) as hour
      )
      select
        b.hour,
        coalesce(sum(ce.amount_usd) filter (where ce.provider = 'apify'), 0)::float as apify_usd,
        coalesce(sum(ce.amount_usd) filter (where ce.provider = 'openai'), 0)::float as openai_usd
      from buckets b
      left join cost_events ce
        on date_trunc('${cfg.trunc}', ce.event_at) = b.hour
        and ce.campaign = $1
      group by b.hour
      order by b.hour
    `,
    [campaign],
  );
  return result.rows.map((row) => ({
    hour: row.hour,
    apifyUsd: Number(row.apify_usd || 0),
    openaiUsd: Number(row.openai_usd || 0),
  }));
}

async function querySendQueueTotals(campaign) {
  const result = await query(
    `
      select status, count(*)::int as count
      from send_queue
      where campaign = $1
      group by status
    `,
    [campaign],
  );
  return rowsToCounts(result.rows);
}

async function querySendAttemptTotals(campaign) {
  const result = await query(
    `
      select sa.status, count(*)::int as count
      from send_attempts sa
      join send_queue sq on sq.id = sa.send_queue_id
      where sq.campaign = $1
      group by sa.status
    `,
    [campaign],
  );
  return rowsToCounts(result.rows);
}

async function querySendAttemptLastHour(campaign) {
  const result = await query(
    `
      select sa.status, count(*)::int as count
      from send_attempts sa
      join send_queue sq on sq.id = sa.send_queue_id
      where sq.campaign = $1
        and sa.created_at >= now() - interval '1 hour'
      group by sa.status
    `,
    [campaign],
  );
  return rowsToCounts(result.rows);
}

async function querySendAttemptHourly(campaign, cfg = bucketConfig('24h')) {
  const result = await query(
    `
      with buckets as (
        select generate_series(
          date_trunc('${cfg.trunc}', now()) - ${cfg.lookback},
          date_trunc('${cfg.trunc}', now()),
          ${cfg.step}
        ) as hour
      )
      select
        b.hour,
        count(sa.*) filter (where sa.status = 'sent')::int as sent,
        count(sa.*) filter (where sa.status in ('failed_retryable', 'failed_final'))::int as failed,
        count(sa.*) filter (where sa.status = 'skipped')::int as skipped,
        count(sa.*) filter (where sa.status = 'dry_run')::int as dry_run
      from buckets b
      left join send_attempts sa
        on date_trunc('${cfg.trunc}', sa.created_at) = b.hour
      left join send_queue sq
        on sq.id = sa.send_queue_id
        and sq.campaign = $1
      where sa.id is null or sq.campaign = $1
      group by b.hour
      order by b.hour
    `,
    [campaign],
  );
  return result.rows.map((row) => ({
    hour: row.hour,
    sent: Number(row.sent || 0),
    failed: Number(row.failed || 0),
    skipped: Number(row.skipped || 0),
    dry_run: Number(row.dry_run || 0),
  }));
}

async function queryFreshness(campaign) {
  const result = await query(
    `
      select
        (select max(event_at) from scrape_events where campaign = $1) as last_scrape_event_at,
        (select max(event_at) from scrape_events where campaign = $1 and event_type = 'accepted') as last_accepted_at,
        (
          select max(sa.created_at)
          from send_attempts sa
          join send_queue sq on sq.id = sa.send_queue_id
          where sq.campaign = $1
        ) as last_send_attempt_at,
        (
          select count(*)::int
          from send_queue
          where campaign = $1
            and status = 'claimed'
            and claimed_at < now() - interval '15 minutes'
        ) as stuck_claimed_sends,
        (
          select count(*)::int
          from send_queue
          where campaign = $1
            and status = 'failed_retryable'
        ) as retryable_failures
    `,
    [campaign],
  );
  return result.rows[0] || {};
}

async function queryScraperRuns(campaign) {
  const result = await query(
    `
      select
        id,
        status,
        seed_handles,
        max_accepted,
        following_limit,
        qualification_workers,
        counters,
        worker_target,
        cloud_operation_name,
        cloud_triggered_at,
        cloud_trigger_error,
        state ->> 'updatedAt' as state_updated_at,
        state ->> 'currentSeed' as current_seed,
        coalesce(jsonb_array_length(state -> 'qualificationQueue'), 0)::int as queued_candidates,
        coalesce(jsonb_array_length(state -> 'frontier'), 0)::int as frontier_size,
        extract(epoch from (now() - created_at))::int as age_seconds,
        extract(epoch from (now() - updated_at))::int as seconds_since_update,
        (
          select array_agg(rc.command order by rc.created_at asc)
          from run_commands rc
          where rc.run_type = 'scraper'
            and rc.run_id = scraper_runs.id
            and rc.status = 'pending'
        ) as pending_commands,
        error,
        started_at,
        completed_at,
        created_at,
        updated_at
      from scraper_runs
      where campaign = $1
      order by created_at desc
      limit 10
    `,
    [campaign],
  );
  return result.rows;
}

async function querySenderRuns(campaign) {
  const result = await query(
    `
      select
        id,
        status,
        account_usernames,
        max_sends,
        counters,
        worker_target,
        cloud_operation_name,
        cloud_triggered_at,
        cloud_trigger_error,
        extract(epoch from (now() - sender_runs.created_at))::int as age_seconds,
        extract(epoch from (now() - sender_runs.updated_at))::int as seconds_since_update,
        (
          select max(sa.created_at)
          from send_attempts sa
          where sa.sender_run_id = sender_runs.id
        ) as last_attempt_at,
        (
          select count(*)::int
          from send_attempts sa
          where sa.sender_run_id = sender_runs.id
        ) as attempt_count,
        (
          select json_agg(
            json_build_object(
              'status', sa.status,
              'handle', c.handle,
              'provider', sa.provider,
              'error', sa.error,
              'created_at', sa.created_at
            )
            order by sa.created_at desc
          )
          from (
            select *
            from send_attempts
            where sender_run_id = sender_runs.id
            order by created_at desc
            limit 5
          ) sa
          join send_queue sq on sq.id = sa.send_queue_id
          left join creators c on c.id = sq.creator_id
        ) as recent_attempts,
        (
          select array_agg(rc.command order by rc.created_at asc)
          from run_commands rc
          where rc.run_type = 'sender'
            and rc.run_id = sender_runs.id
            and rc.status = 'pending'
        ) as pending_commands,
        error,
        started_at,
        completed_at,
        created_at,
        updated_at
      from sender_runs
      where campaign = $1
      order by created_at desc
      limit 10
    `,
    [campaign],
  );
  return result.rows;
}

async function queryRunObservability(campaign) {
  const result = await query(
    `
      select
        (select count(*)::int from scraper_runs where campaign = $1 and status = 'requested') as scraper_waiting,
        (select count(*)::int from sender_runs where campaign = $1 and status = 'requested') as sender_waiting,
        (
          select count(*)::int
          from scraper_runs
          where campaign = $1
            and status in ('running', 'pause_requested', 'stop_requested')
            and updated_at < now() - interval '5 minutes'
        ) as scraper_stale,
        (
          select count(*)::int
          from sender_runs
          where campaign = $1
            and status in ('running', 'pause_requested', 'stop_requested')
            and updated_at < now() - interval '5 minutes'
        ) as sender_stale,
        (
          select count(*)::int
          from run_commands
          where campaign = $1
            and status = 'pending'
        ) as pending_commands,
        (
          select max(updated_at)
          from scraper_runs
          where campaign = $1
        ) as last_scraper_run_update_at,
        (
          select max(updated_at)
          from sender_runs
          where campaign = $1
        ) as last_sender_run_update_at
    `,
    [campaign],
  );
  return result.rows[0] || {};
}

async function querySenderAccounts() {
  const result = await query(
    `
      select username, status, daily_send_limit, sends_today, last_sent_at, cooldown_until
      from sender_accounts
      order by username asc
    `,
  );
  return result.rows;
}

async function queryCreators(campaign) {
  const result = await query(
    `
      select
        c.handle,
        c.profile_url,
        c.display_name,
        c.followers_count,
        c.source_seed,
        ce.fit_score,
        ce.list,
        ce.reasoning,
        ce.evaluated_at,
        sq.status as queue_status,
        sq.sent_at,
        cn.note
      from creator_evaluations ce
      join creators c on c.id = ce.creator_id
      left join send_queue sq
        on sq.creator_id = c.id
        and sq.campaign = ce.campaign
      left join campaign_notes cn
        on cn.creator_id = c.id
        and cn.campaign = ce.campaign
      where ce.campaign = $1
        and ce.fit_score between 1 and 4
      order by ce.evaluated_at desc nulls last, ce.created_at desc
    `,
    [campaign],
  );
  return result.rows;
}

async function queryRecentEvents(campaign) {
  const result = await query(
    `
      select
        se.event_type,
        se.handle,
        se.source_seed,
        se.event_at,
        se.metadata,
        ce.fit_score
      from scrape_events se
      left join creators c on c.handle = se.handle
      left join creator_evaluations ce
        on ce.creator_id = c.id
        and ce.campaign = se.campaign
      where se.campaign = $1
      order by se.event_at desc
      limit 30
    `,
    [campaign],
  );
  return result.rows;
}

function normalizeCounts(row = {}) {
  return {
    seen: Number(row.seen || 0),
    processed: Number(row.processed || 0),
    accepted: Number(row.accepted || 0),
    rejected: Number(row.rejected || 0),
    failed: Number(row.failed || 0),
  };
}

function rowsToCounts(rows) {
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count || 0)]));
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || ''),
  );
}
