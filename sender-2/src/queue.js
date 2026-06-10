import { withTransaction } from './db.js';

export async function upsertAcceptedCreator(pool, { record, campaign, enqueueStatus }) {
  return withTransaction(pool, async (client) => {
    const creator = await upsertCreator(client, record);
    await upsertEvaluation(client, { creatorId: creator.id, record, campaign });
    const queueItem = await upsertQueueItem(client, {
      creatorId: creator.id,
      recipientHandle: record.handle,
      campaign,
      status: enqueueStatus,
    });

    return { creator, queueItem };
  });
}

export async function upsertSenderAccount(pool, { username, dailySendLimit = 25, metadata = {} }) {
  const result = await pool.query(
    `
      insert into sender_accounts (
        username,
        daily_send_limit,
        metadata,
        updated_at
      )
      values ($1, $2, $3, now())
      on conflict (username)
      do update set
        daily_send_limit = excluded.daily_send_limit,
        metadata = sender_accounts.metadata || excluded.metadata,
        updated_at = now()
      returning *
    `,
    [username, dailySendLimit, JSON.stringify(metadata)],
  );

  return result.rows[0];
}

export async function claimNextQueueItem(pool, { workerId, campaign }) {
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `
        with next_item as (
          select sq.id
          from send_queue sq
          join creators c on c.id = sq.creator_id
          where sq.campaign = $1
            and (
              sq.status = 'queued'
              or (sq.status = 'failed_retryable' and (sq.retry_after is null or sq.retry_after <= now()))
            )
            and sq.attempt_count < sq.max_attempts
            and not exists (
              select 1
              from send_queue dup
              where dup.creator_id = sq.creator_id
                and dup.id <> sq.id
                and dup.status in ('sent', 'claimed')
            )
          order by sq.priority asc, sq.queued_at asc
          for update skip locked
          limit 1
        )
        update send_queue sq
        set status = 'claimed',
            claimed_by = $2,
            claimed_at = now(),
            attempt_count = sq.attempt_count + 1,
            updated_at = now()
        from next_item
        where sq.id = next_item.id
        returning sq.*
      `,
      [campaign, workerId],
    );

    if (result.rowCount === 0) return null;
    return hydrateQueueItem(client, result.rows[0]);
  });
}

// Put a claimed item back untouched (e.g. capacity ran out before we tried
// to send). Refunds the attempt that claiming charged.
export async function releaseQueueItem(pool, { queueItem }) {
  await pool.query(
    `
      update send_queue
      set status = 'queued',
          claimed_by = null,
          claimed_at = null,
          attempt_count = greatest(attempt_count - 1, 0),
          updated_at = now()
      where id = $1
        and status = 'claimed'
    `,
    [queueItem.id],
  );
}

// Claims older than maxAgeMinutes belong to dead workers. The send may or
// may not have gone out before the crash, so the attempt stays charged and
// the item goes to failed_retryable (immediately eligible); the provider's
// already-in-thread check stops an actual double DM. Items out of attempts
// land in failed_final, recoverable from the dashboard.
export async function reclaimStuckQueueItems(pool, { campaign, maxAgeMinutes = 20 }) {
  const result = await pool.query(
    `
      update send_queue
      set status = case
            when attempt_count >= max_attempts then 'failed_final'
            else 'failed_retryable'
          end,
          last_error = 'reclaimed: claim went stale (worker likely crashed mid-send)',
          retry_after = now(),
          claimed_by = null,
          claimed_at = null,
          updated_at = now()
      where campaign = $1
        and status = 'claimed'
        and claimed_at < now() - make_interval(mins => $2::int)
      returning id
    `,
    [campaign, maxAgeMinutes],
  );
  return result.rowCount;
}

// How many items a worker could claim right now (mirrors the claim query).
export async function countClaimableQueueItems(pool, { campaign }) {
  const result = await pool.query(
    `
      select count(*)::int as count
      from send_queue sq
      where sq.campaign = $1
        and (
          sq.status = 'queued'
          or (sq.status = 'failed_retryable' and (sq.retry_after is null or sq.retry_after <= now()))
        )
        and sq.attempt_count < sq.max_attempts
        and not exists (
          select 1
          from send_queue dup
          where dup.creator_id = sq.creator_id
            and dup.id <> sq.id
            and dup.status in ('sent', 'claimed')
        )
    `,
    [campaign],
  );
  return Number(result.rows[0]?.count || 0);
}

// One DM per person ever: anyone already sent in another campaign gets this
// campaign's pending row marked skipped, with the reason visible.
export async function skipCrossCampaignDuplicates(pool, { campaign }) {
  const result = await pool.query(
    `
      update send_queue sq
      set status = 'skipped',
          last_error = 'already messaged in campaign ' || dup.campaign,
          claimed_by = null,
          claimed_at = null,
          updated_at = now()
      from send_queue dup
      where sq.campaign = $1
        and sq.status in ('queued', 'failed_retryable')
        and dup.creator_id = sq.creator_id
        and dup.id <> sq.id
        and dup.status = 'sent'
      returning sq.id
    `,
    [campaign],
  );
  return result.rowCount;
}

export async function recordSendAttempt(
  pool,
  {
    queueItem,
    senderAccountId = null,
    senderRunId = null,
    workerId,
    provider,
    status,
    message,
    error = null,
    providerResponse = {},
  },
) {
  await pool.query(
    `
      insert into send_attempts (
        send_queue_id,
        sender_account_id,
        sender_run_id,
        worker_id,
        provider,
        status,
        message,
        error,
        provider_response
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      queueItem.id,
      senderAccountId,
      senderRunId,
      workerId,
      provider,
      status,
      message,
      error,
      JSON.stringify(providerResponse),
    ],
  );
}

export async function markQueueSent(
  pool,
  { queueItem, senderAccountId = null, senderHandle = null, message },
) {
  await withTransaction(pool, async (client) => {
    await client.query(
      `
        update send_queue
        set status = 'sent',
            sender_account_id = $2,
            sender_handle = $3,
            recipient_handle = coalesce(recipient_handle, $4),
            message = $5,
            sent_at = now(),
            last_error = null,
            updated_at = now()
        where id = $1
      `,
      [queueItem.id, senderAccountId, senderHandle, queueItem.handle || null, message],
    );

    if (senderAccountId) {
      await client.query(
        `
          update sender_accounts
          set sends_today = case
                when last_sent_at is null or last_sent_at::date = current_date then sends_today + 1
                else 1
              end,
              last_sent_at = now(),
              updated_at = now()
          where id = $1
        `,
        [senderAccountId],
      );
    }
  });
}

export async function markQueueDryRun(pool, { queueItem, message }) {
  await pool.query(
    `
      update send_queue
      set status = 'dry_run',
          recipient_handle = coalesce(recipient_handle, $2),
          message = $3,
          claimed_by = null,
          claimed_at = null,
          attempt_count = greatest(attempt_count - 1, 0),
          last_error = null,
          retry_after = null,
          updated_at = now()
      where id = $1
    `,
    [queueItem.id, queueItem.handle || null, message],
  );
}

export async function markQueueSkipped(
  pool,
  { queueItem, senderAccountId = null, senderHandle = null, message, reason },
) {
  await pool.query(
    `
      update send_queue
      set status = 'skipped',
          sender_account_id = $2,
          sender_handle = $3,
          recipient_handle = coalesce(recipient_handle, $4),
          message = $5,
          last_error = $6,
          claimed_by = null,
          claimed_at = null,
          updated_at = now()
      where id = $1
    `,
    [queueItem.id, senderAccountId, senderHandle, queueItem.handle || null, message, reason],
  );
}

export async function markQueueFailed(pool, { queueItem, error, retryAfter = null }) {
  const finalStatus =
    queueItem.attempt_count >= queueItem.max_attempts ? 'failed_final' : 'failed_retryable';

  await pool.query(
    `
      update send_queue
      set status = $2,
          last_error = $3,
          retry_after = $4,
          updated_at = now()
      where id = $1
    `,
    [queueItem.id, finalStatus, error, retryAfter],
  );

  return finalStatus;
}

async function hydrateQueueItem(client, queueItem) {
  const result = await client.query(
    `
      select
        sq.*,
        c.handle,
        c.profile_url,
        c.display_name,
        c.followers_count,
        c.source_seed
      from send_queue sq
      join creators c on c.id = sq.creator_id
      where sq.id = $1
    `,
    [queueItem.id],
  );
  return result.rows[0] || queueItem;
}

async function upsertCreator(client, record) {
  const result = await client.query(
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
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
      on conflict (handle)
      do update set
        profile_url = excluded.profile_url,
        display_name = excluded.display_name,
        followers_count = excluded.followers_count,
        following_count = excluded.following_count,
        is_private = excluded.is_private,
        is_verified = excluded.is_verified,
        source_seed = excluded.source_seed,
        updated_at = now()
      returning *
    `,
    [
      record.handle,
      record.profileUrl || record.profile_url || `https://www.instagram.com/${record.handle}/`,
      record.name || record.displayName || record.display_name || null,
      record.followersCount ?? record.followers_count ?? null,
      record.followingCount ?? record.following_count ?? null,
      record.isPrivate ?? record.is_private ?? null,
      record.isVerified ?? record.is_verified ?? null,
      record.sourceSeed || record.source_seed || null,
      record.discoveredAt || record.createdAt || new Date().toISOString(),
    ],
  );

  return result.rows[0];
}

async function upsertEvaluation(client, { creatorId, record, campaign }) {
  const review = record.aiReview || record.review || {};
  await client.query(
    `
      insert into creator_evaluations (
        creator_id,
        campaign,
        fit_score,
        list,
        reasoning,
        raw_record,
        evaluated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7)
      on conflict (creator_id, campaign)
      do update set
        fit_score = excluded.fit_score,
        list = excluded.list,
        reasoning = excluded.reasoning,
        raw_record = excluded.raw_record,
        evaluated_at = excluded.evaluated_at
    `,
    [
      creatorId,
      campaign,
      review.fitScore || record.fitScore || null,
      review.list || record.list || null,
      review.reasoning || record.reasoning || null,
      JSON.stringify(record),
      record.createdAt || record.scoredAt || new Date().toISOString(),
    ],
  );
}

async function upsertQueueItem(client, { creatorId, recipientHandle, campaign, status }) {
  const result = await client.query(
    `
      insert into send_queue (
        creator_id,
        campaign,
        recipient_handle,
        status,
        queued_at,
        updated_at
      )
      values ($1, $2, $3, $4, now(), now())
      on conflict (creator_id, campaign)
      do update set
        recipient_handle = coalesce(send_queue.recipient_handle, excluded.recipient_handle),
        status = case
          when send_queue.status in ('sent', 'skipped') then send_queue.status
          else excluded.status
        end,
        updated_at = now()
      returning *
    `,
    [creatorId, campaign, recipientHandle, status],
  );
  return result.rows[0];
}
