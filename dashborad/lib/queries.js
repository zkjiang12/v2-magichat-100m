import { cache } from 'react';

import { query } from './db';

// Section-scoped fetchers so the page streams each band as soon as its data
// is ready. Queries within a section run in parallel; `cache()` dedupes the
// queries shared across sections within a single render pass.

export async function getOverviewData({ campaign, range = '24h' }) {
  const cfg = bucketConfig(range);
  const [
    scrapeTotals,
    scrapeHourly,
    costTotals,
    costHourly,
    sendQueueTotals,
    sendAttemptTotals,
    sendAttemptHourly,
  ] = await Promise.all([
    queryScrapeTotals(campaign),
    queryScrapeHourly(campaign, cfg),
    queryCostTotals(campaign),
    queryCostHourly(campaign, cfg),
    querySendQueueTotals(campaign),
    querySendAttemptTotals(campaign),
    querySendAttemptHourly(campaign, cfg),
  ]);

  return {
    scrapeTotals,
    scrapeHourly,
    costTotals,
    costHourly,
    sendQueueTotals,
    sendAttemptTotals,
    sendAttemptHourly,
  };
}

export async function getRunsData({ campaign }) {
  const [
    scraperRuns,
    senderRuns,
    recentEvents,
    sendQueueTotals,
    senderAccounts,
    campaignSettings,
  ] = await Promise.all([
    queryScraperRuns(campaign),
    querySenderRuns(campaign),
    queryRecentEvents(campaign),
    querySendQueueTotals(campaign),
    querySenderAccounts(),
    queryCampaignSettings(campaign),
  ]);

  return {
    scraperRuns,
    senderRuns,
    recentEvents,
    sendQueueTotals,
    senderAccounts,
    campaignSettings,
  };
}

export async function getAccountsData({ campaign }) {
  const [senderAccounts, instantlyTotals] = await Promise.all([
    querySenderAccounts(),
    queryInstantlyTotals(campaign),
  ]);
  return { senderAccounts, instantlyTotals };
}

export async function getCreatorsData({ campaign }) {
  const [acceptedCreators, creatorTotals] = await Promise.all([
    queryCreators(campaign),
    queryCreatorTotals(campaign),
  ]);
  return { acceptedCreators, creatorTotals };
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

export async function extendScraperRun({ campaign, runId, addAccepted }) {
  if (!isUuid(runId)) throw new Error('Invalid run id');
  const amount = Number(addAccepted);
  if (!Number.isInteger(amount) || amount < 1) throw new Error('Invalid extend amount');

  const result = await query(
    `
      update scraper_runs
      set max_accepted = max_accepted + $3,
          status = 'requested',
          error = null,
          completed_at = null,
          updated_at = now()
      where id = $1
        and campaign = $2
        and status in ('completed', 'stopped', 'failed')
      returning id
    `,
    [runId, campaign, amount],
  );
  return result.rows[0] || null;
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

export async function createSenderRun({ campaign, accountUsernames, maxSends, messageTemplate = null }) {
  const result = await query(
    `
      insert into sender_runs (
        campaign,
        account_usernames,
        max_sends,
        message_template
      )
      values ($1, $2, $3, $4)
      returning id
    `,
    [campaign, accountUsernames, maxSends, messageTemplate],
  );
  return result.rows[0];
}

export async function updateSenderAccountSettings({ username, status, campaign, dailySendLimit }) {
  await query(
    `
      update sender_accounts
      set status = coalesce($2, status),
          campaign = $3,
          daily_send_limit = coalesce($4, daily_send_limit),
          updated_at = now()
      where username = $1
    `,
    [username, status, campaign, dailySendLimit],
  );
}

export async function getSenderAccountDetail({ username }) {
  const accountResult = await query(
    `
      select
        a.id,
        a.username,
        a.status,
        a.campaign,
        a.daily_send_limit,
        a.last_sent_at,
        a.cooldown_until,
        a.created_at,
        coalesce(s.sends_today, 0) as sends_today,
        coalesce(s.total_sent, 0) as total_sent,
        coalesce(s.total_failed, 0) as total_failed,
        coalesce(s.total_attempts, 0) as total_attempts
      from sender_accounts a
      left join lateral (
        select
          count(*) filter (where sa.status = 'sent' and sa.created_at::date = current_date)::int as sends_today,
          count(*) filter (where sa.status = 'sent')::int as total_sent,
          count(*) filter (where sa.status in ('failed_retryable', 'failed_final'))::int as total_failed,
          count(*)::int as total_attempts
        from send_attempts sa
        where sa.sender_account_id = a.id
      ) s on true
      where a.username = $1
      limit 1
    `,
    [username],
  );

  const account = accountResult.rows[0] || null;
  if (!account) return null;

  const attemptsResult = await query(
    `
      select
        sa.status,
        sa.provider,
        sa.message,
        sa.error,
        sa.created_at,
        sa.sender_run_id,
        sq.campaign,
        coalesce(c.handle, sq.recipient_handle) as recipient_handle,
        c.profile_url
      from send_attempts sa
      join send_queue sq on sq.id = sa.send_queue_id
      left join creators c on c.id = sq.creator_id
      where sa.sender_account_id = $1
      order by sa.created_at desc
      limit 200
    `,
    [account.id],
  );

  return { account, attempts: attemptsResult.rows };
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

const REQUEUE_SET_CLAUSE = `
      set status = 'queued',
          attempt_count = 0,
          retry_after = null,
          last_error = null,
          claimed_by = null,
          claimed_at = null,
          updated_at = now()
`;

// Requeue the failures attempted by one specific run. Never touches sent rows.
export async function requeueRunFailures({ runId, campaign }) {
  if (!isUuid(runId)) throw new Error('Invalid run id');
  const result = await query(
    `
      update send_queue sq
      ${REQUEUE_SET_CLAUSE}
      where sq.campaign = $2
        and sq.status in ('failed_retryable', 'failed_final')
        and exists (
          select 1
          from send_attempts sa
          where sa.send_queue_id = sq.id
            and sa.sender_run_id = $1
        )
      returning sq.id
    `,
    [runId, campaign],
  );
  return result.rowCount;
}

export async function requeueCampaignFailures({ campaign }) {
  const result = await query(
    `
      update send_queue sq
      ${REQUEUE_SET_CLAUSE}
      where sq.campaign = $1
        and sq.status in ('failed_retryable', 'failed_final')
      returning sq.id
    `,
    [campaign],
  );
  return result.rowCount;
}

// Per-creator requeue; also revives skipped and dry_run rows since that's a
// deliberate human override. Sent rows stay untouchable.
export async function requeueCreatorSend({ handle, campaign }) {
  const result = await query(
    `
      update send_queue sq
      ${REQUEUE_SET_CLAUSE}
      from creators c
      where c.id = sq.creator_id
        and c.handle = $1
        and sq.campaign = $2
        and sq.status in ('failed_retryable', 'failed_final', 'skipped', 'dry_run')
      returning sq.id
    `,
    [handle, campaign],
  );
  return result.rowCount;
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
      ),
      ev as (
        -- range-bound before bucketing so the (campaign, event_at) index is
        -- used instead of date_trunc-scanning every event for the campaign
        select date_trunc('${cfg.trunc}', event_at) as hour, event_type
        from scrape_events
        where campaign = $1
          and event_at >= date_trunc('${cfg.trunc}', now()) - ${cfg.lookback}
      )
      select
        b.hour,
        count(ev.*) filter (where ev.event_type = 'seen')::int as seen,
        count(ev.*) filter (where ev.event_type = 'processed')::int as processed,
        count(ev.*) filter (where ev.event_type = 'accepted')::int as accepted,
        count(ev.*) filter (where ev.event_type = 'rejected')::int as rejected,
        count(ev.*) filter (where ev.event_type = 'failed')::int as failed
      from buckets b
      left join ev on ev.hour = b.hour
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
    `,
    [campaign],
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
      ),
      ev as (
        select date_trunc('${cfg.trunc}', event_at) as hour, provider, amount_usd
        from cost_events
        where campaign = $1
          and event_at >= date_trunc('${cfg.trunc}', now()) - ${cfg.lookback}
      )
      select
        b.hour,
        coalesce(sum(ev.amount_usd) filter (where ev.provider = 'apify'), 0)::float as apify_usd,
        coalesce(sum(ev.amount_usd) filter (where ev.provider = 'openai'), 0)::float as openai_usd
      from buckets b
      left join ev on ev.hour = b.hour
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

const querySendQueueTotals = cache(async (campaign) => {
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
});

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

async function querySendAttemptHourly(campaign, cfg = bucketConfig('24h')) {
  const result = await query(
    `
      with buckets as (
        select generate_series(
          date_trunc('${cfg.trunc}', now()) - ${cfg.lookback},
          date_trunc('${cfg.trunc}', now()),
          ${cfg.step}
        ) as hour
      ),
      ev as (
        select date_trunc('${cfg.trunc}', sa.created_at) as hour, sa.status
        from send_attempts sa
        join send_queue sq on sq.id = sa.send_queue_id
        where sq.campaign = $1
          and sa.created_at >= date_trunc('${cfg.trunc}', now()) - ${cfg.lookback}
      )
      select
        b.hour,
        count(ev.*) filter (where ev.status = 'sent')::int as sent,
        count(ev.*) filter (where ev.status in ('failed_retryable', 'failed_final'))::int as failed,
        count(ev.*) filter (where ev.status = 'skipped')::int as skipped,
        count(ev.*) filter (where ev.status = 'dry_run')::int as dry_run
      from buckets b
      left join ev on ev.hour = b.hour
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
        pause_reason,
        requested_by,
        account_usernames,
        max_sends,
        message_template,
        counters,
        (
          select count(distinct sq.id)::int
          from send_attempts sa
          join send_queue sq on sq.id = sa.send_queue_id
          where sa.sender_run_id = sender_runs.id
            and sq.status in ('failed_retryable', 'failed_final')
        ) as failed_remaining,
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

const querySenderAccounts = cache(async () => {
  const result = await query(
    `
      select
        a.username,
        a.status,
        a.campaign,
        a.daily_send_limit,
        a.last_sent_at,
        a.cooldown_until,
        coalesce(s.sends_today, 0) as sends_today,
        coalesce(s.total_sent, 0) as total_sent
      from sender_accounts a
      left join lateral (
        select
          count(*) filter (where sa.status = 'sent' and sa.created_at::date = current_date)::int as sends_today,
          count(*) filter (where sa.status = 'sent')::int as total_sent
        from send_attempts sa
        where sa.sender_account_id = a.id
      ) s on true
      order by a.username asc
    `,
  );
  return result.rows;
});

async function queryCampaignSettings(campaign) {
  const result = await query(
    `
      select name, message_template
      from campaigns
      where name = $1
    `,
    [campaign],
  );
  return result.rows[0] || { name: campaign, message_template: null };
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
        c.emails,
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
      limit 400
    `,
    [campaign],
  );
  return result.rows;
}

// Campaign-wide column totals for the kanban. queryCreators caps the rows it
// returns (display only), so counting those rows undercounts — totals must
// come from the full table. Joins are 1:1 via the (creator_id, campaign)
// unique constraints on both creator_evaluations and send_queue.
async function queryCreatorTotals(campaign) {
  const result = await query(
    `
      select
        count(*) filter (where ce.fit_score between 1 and 4)::int as scored,
        count(*) filter (where ce.fit_score between 3 and 4)::int as qualified,
        count(*) filter (
          where ce.fit_score between 1 and 4
            and (sq.status = 'sent' or sq.sent_at is not null)
        )::int as messaged
      from creator_evaluations ce
      left join send_queue sq
        on sq.creator_id = ce.creator_id
        and sq.campaign = ce.campaign
      where ce.campaign = $1
    `,
    [campaign],
  );
  const row = result.rows[0] || {};
  return {
    scored: Number(row.scored || 0),
    qualified: Number(row.qualified || 0),
    messaged: Number(row.messaged || 0),
  };
}

async function queryInstantlyTotals(campaign) {
  try {
    const result = await query(
      `
        select
          (
            select count(distinct c.id)::int
            from creator_evaluations ce
            join creators c on c.id = ce.creator_id
            where ce.campaign = $1 and ce.fit_score >= 3
          ) as qualified,
          (
            select count(distinct c.id)::int
            from creator_evaluations ce
            join creators c on c.id = ce.creator_id
            where ce.campaign = $1
              and ce.fit_score >= 3
              and coalesce(array_length(c.emails, 1), 0) > 0
          ) as with_email,
          (select count(*)::int from instantly_sync where campaign = $1 and status = 'pushed') as pushed,
          (select count(*)::int from instantly_sync where campaign = $1 and status = 'skipped') as skipped,
          (select count(*)::int from instantly_sync where campaign = $1 and status = 'failed') as failed,
          (select max(pushed_at) from instantly_sync where campaign = $1) as last_pushed_at
      `,
      [campaign],
    );
    return result.rows[0] || null;
  } catch (error) {
    // instantly_sync migration not applied yet (or query failed); hide the
    // panel instead of breaking the page, but leave a trace in server logs.
    console.warn(`[dashboard] instantly totals unavailable: ${error.message}`);
    return null;
  }
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
