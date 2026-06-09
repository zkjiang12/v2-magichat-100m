import { withTransaction } from './db.js';

export function normalizeSenderRunCounters(counters = {}) {
  return {
    attempted: integerOrZero(counters.attempted),
    sent: integerOrZero(counters.sent),
    dry_run: integerOrZero(counters.dry_run),
    skipped: integerOrZero(counters.skipped),
    failed_retryable: integerOrZero(counters.failed_retryable),
    failed_final: integerOrZero(counters.failed_final),
  };
}

export function incrementSenderRunCounters(counters, outcome) {
  const next = normalizeSenderRunCounters(counters);
  next.attempted += 1;

  if (outcome === 'sent') next.sent += 1;
  if (outcome === 'dry_run') next.dry_run += 1;
  if (outcome === 'skipped') next.skipped += 1;
  if (outcome === 'failed_retryable') next.failed_retryable += 1;
  if (outcome === 'failed_final') next.failed_final += 1;

  return next;
}

export async function claimNextSenderRun(pool, { campaign }) {
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `
        update sender_runs
        set status = 'running',
            counters = coalesce(counters, '{}'::jsonb),
            error = null,
            started_at = coalesce(started_at, now()),
            updated_at = now()
        where id = (
          select id
          from sender_runs
          where campaign = $1
            and status = 'requested'
          order by created_at asc
          for update skip locked
          limit 1
        )
        returning *
      `,
      [campaign],
    );

    return result.rows[0] || null;
  });
}

export async function claimSenderRunById(pool, { campaign, runId }) {
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `
        update sender_runs
        set status = 'running',
            counters = coalesce(counters, '{}'::jsonb),
            error = null,
            started_at = coalesce(started_at, now()),
            updated_at = now()
        where id = (
          select id
          from sender_runs
          where campaign = $1
            and id = $2
            and status = 'requested'
          for update skip locked
          limit 1
        )
        returning *
      `,
      [campaign, runId],
    );

    return result.rows[0] || null;
  });
}

export async function saveSenderRunProgress(pool, { runId, counters }) {
  await pool.query(
    `
      update sender_runs
      set counters = $2,
          updated_at = now()
      where id = $1
    `,
    [runId, JSON.stringify(normalizeSenderRunCounters(counters))],
  );
}

export async function completeSenderRun(pool, { runId, counters, status }) {
  if (!['completed', 'stopped'].includes(status)) {
    throw new Error(`Invalid sender run completion status: ${status}`);
  }

  await pool.query(
    `
      update sender_runs
      set status = $2,
          counters = $3,
          completed_at = now(),
          updated_at = now()
      where id = $1
    `,
    [runId, status, JSON.stringify(normalizeSenderRunCounters(counters))],
  );
}

export async function pauseSenderRun(pool, { runId, counters }) {
  await pool.query(
    `
      update sender_runs
      set status = 'paused',
          counters = $2,
          updated_at = now()
      where id = $1
    `,
    [runId, JSON.stringify(normalizeSenderRunCounters(counters))],
  );
}

export async function failSenderRun(pool, { runId, counters, error }) {
  await pool.query(
    `
      update sender_runs
      set status = 'failed',
          counters = $2,
          error = $3,
          completed_at = now(),
          updated_at = now()
      where id = $1
    `,
    [runId, JSON.stringify(normalizeSenderRunCounters(counters)), error],
  );
}

export async function nextSenderCommand(pool, { runId }) {
  const commandResult = await pool.query(
    `
      select *
      from run_commands
      where run_type = 'sender'
        and run_id = $1
        and status = 'pending'
      order by created_at asc
      limit 1
    `,
    [runId],
  );
  if (commandResult.rows[0]) return commandResult.rows[0];

  const runResult = await pool.query(
    `
      select status
      from sender_runs
      where id = $1
    `,
    [runId],
  );

  const status = runResult.rows[0]?.status;
  if (status === 'stop_requested') return { id: null, command: 'stop' };
  if (status === 'pause_requested') return { id: null, command: 'pause' };
  return null;
}

export async function markSenderCommandApplied(pool, { commandId }) {
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
}

export async function markSenderCommandFailed(pool, { commandId, error }) {
  if (!commandId) return;
  await pool.query(
    `
      update run_commands
      set status = 'failed',
          error = $2,
          applied_at = now()
      where id = $1
    `,
    [commandId, error],
  );
}

export async function handleSenderCommand(pool, { runId, counters, command }) {
  if (!command) return 'continue';

  if (command.command === 'resume') {
    await markSenderCommandApplied(pool, { commandId: command.id });
    return 'continue';
  }

  if (command.command === 'pause') {
    await pauseSenderRun(pool, { runId, counters });
    await markSenderCommandApplied(pool, { commandId: command.id });
    return 'paused';
  }

  if (command.command === 'stop') {
    await completeSenderRun(pool, { runId, counters, status: 'stopped' });
    await markSenderCommandApplied(pool, { commandId: command.id });
    return 'stopped';
  }

  await markSenderCommandFailed(pool, {
    commandId: command.id,
    error: `Unknown sender command: ${command.command}`,
  });
  return 'continue';
}

function integerOrZero(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}
