#!/usr/bin/env node

import { getConfig } from './config.js';
import { createPool } from './db.js';
import { renderMessage } from './message-template.js';
import {
  claimNextQueueItem,
  markQueueDryRun,
  markQueueFailed,
  markQueueSkipped,
  markQueueSent,
  recordSendAttempt,
} from './queue.js';
import { createProvider } from './providers/index.js';
import {
  claimNextSenderRun,
  claimSenderRunById,
  completeSenderRun,
  failSenderRun,
  handleSenderCommand,
  incrementSenderRunCounters,
  nextSenderCommand,
  normalizeSenderRunCounters,
  saveSenderRunProgress,
} from './sender-runs.js';

let stopRequested = false;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = getConfig();
  const pool = createPool({ databaseUrl: config.databaseUrl });
  const provider = createProvider(config.provider, { pool, config });
  installShutdownHandlers();

  if (args.claimRun) {
    try {
      await runDashboardSenderRuns({
        pool,
        provider,
        config,
        once: args.once,
        runId: args.runId,
      });
    } finally {
      await provider.close?.();
    }
    return;
  }

  console.log(
    [
      `Starting sender worker ${config.workerId}`,
      `provider=${provider.name}`,
      `campaign=${config.campaign}`,
      `batchSize=${config.batchSize}`,
      `maxSends=${config.maxSends ?? 'unlimited'}`,
    ].join('; '),
  );

  try {
    await runDirectQueueWorker({ pool, provider, config });
  } finally {
    await provider.close?.();
    await pool.end();
  }
}

async function runDirectQueueWorker({ pool, provider, config }) {
  let sentOrAttempted = 0;
  while (!stopRequested && shouldContinue({ sentOrAttempted, maxSends: config.maxSends })) {
    let claimedAny = false;

    for (let index = 0; index < config.batchSize; index += 1) {
      if (!shouldContinue({ sentOrAttempted, maxSends: config.maxSends })) break;

      const queueItem = await claimNextQueueItem(pool, {
        workerId: config.workerId,
        campaign: config.campaign,
      });

      if (!queueItem) break;
      claimedAny = true;
      sentOrAttempted += 1;
      await processQueueItem({ pool, queueItem, provider, config });
    }

    if (!claimedAny) {
      console.log(`No queued items found; sleeping ${config.pollIntervalMs}ms.`);
      await sleep(config.pollIntervalMs);
    }
  }
  console.log(`Sender stopped after ${sentOrAttempted} claimed item(s).`);
}

async function runDashboardSenderRuns({ pool, provider, config, once = false, runId = null }) {
  console.log(
    [
      `Starting sender run worker ${config.workerId}`,
      `provider=${provider.name}`,
      `campaign=${config.campaign}`,
      `pollIntervalMs=${config.pollIntervalMs}`,
      `once=${once}`,
      runId ? `runId=${runId}` : null,
    ].filter(Boolean).join('; '),
  );

  try {
    if (runId) {
      const run = await claimSenderRunById(pool, { campaign: config.campaign, runId });
      if (!run) {
        console.log(`No requested sender_runs row found for runId=${runId}; exiting.`);
        return;
      }

      await processSenderRun({ pool, run, provider, config });
      return;
    }

    while (!stopRequested) {
      const run = await claimNextSenderRun(pool, { campaign: config.campaign });
      if (!run) {
        if (once) {
          console.log('No requested sender_runs found; exiting one-shot worker.');
          return;
        }
        console.log(`No requested sender_runs found; sleeping ${config.pollIntervalMs}ms.`);
        await sleep(config.pollIntervalMs);
        continue;
      }

      await processSenderRun({ pool, run, provider, config });
      if (once) return;
    }
  } finally {
    await pool.end();
  }
}

async function processSenderRun({ pool, run, provider, config }) {
  let counters = normalizeSenderRunCounters(run.counters);
  const maxSends = run.max_sends ?? config.maxSends;

  console.log(
    `[run ${run.id}] claimed sender run; provider=${provider.name}; maxSends=${maxSends ?? 'unlimited'}`,
  );

  try {
    while (!stopRequested && shouldContinue({ sentOrAttempted: counters.attempted, maxSends })) {
      const commandBefore = await nextSenderCommand(pool, { runId: run.id });
      const commandBeforeResult = await handleSenderCommand(pool, {
        runId: run.id,
        counters,
        command: commandBefore,
      });
      if (commandBeforeResult !== 'continue') {
        console.log(`[run ${run.id}] ${commandBeforeResult}.`);
        return;
      }

      const queueItem = await claimNextQueueItem(pool, {
        workerId: `${config.workerId}:${run.id}`,
        campaign: config.campaign,
      });

      if (!queueItem) {
        await completeSenderRun(pool, { runId: run.id, counters, status: 'completed' });
        console.log(`[run ${run.id}] completed; no queued items left.`);
        return;
      }

      const outcome = await processQueueItem({
        pool,
        queueItem,
        provider,
        config,
        senderRunId: run.id,
        senderRun: run,
      });
      counters = incrementSenderRunCounters(counters, outcome);
      await saveSenderRunProgress(pool, { runId: run.id, counters });

      const commandAfter = await nextSenderCommand(pool, { runId: run.id });
      const commandAfterResult = await handleSenderCommand(pool, {
        runId: run.id,
        counters,
        command: commandAfter,
      });
      if (commandAfterResult !== 'continue') {
        console.log(`[run ${run.id}] ${commandAfterResult}.`);
        return;
      }
    }

    const finalStatus = stopRequested ? 'stopped' : 'completed';
    await completeSenderRun(pool, { runId: run.id, counters, status: finalStatus });
    console.log(`[run ${run.id}] ${finalStatus}; attempted=${counters.attempted}.`);
  } catch (error) {
    await failSenderRun(pool, { runId: run.id, counters, error: error.stack || error.message });
    throw error;
  }
}

export async function processQueueItem({
  pool,
  queueItem,
  provider,
  config,
  senderAccount = null,
  senderRunId = null,
  senderRun = null,
}) {
  const creator = queueItemToCreator(queueItem);
  const messageTemplate = provider.account?.message || config.messageTemplate;
  const message = renderMessage(messageTemplate, creator);

  try {
    const providerResponse = await provider.sendMessage({
      account: provider.account || null,
      creator,
      message,
      queueItem,
      senderRun,
    });

    const resolvedSenderAccount = senderAccount || providerResponse.senderAccount || null;
    const attemptStatus = provider.name === 'dry-run' ? 'dry_run' : 'sent';
    await recordSendAttempt(pool, {
      queueItem,
      workerId: config.workerId,
      provider: provider.name,
      status: providerResponse.skipped ? 'skipped' : attemptStatus,
      message,
      senderAccountId: resolvedSenderAccount?.id || null,
      senderRunId,
      providerResponse,
    });

    if (providerResponse.skipped) {
      await markQueueSkipped(pool, {
        queueItem,
        senderAccountId: resolvedSenderAccount?.id || null,
        senderHandle: resolvedSenderAccount?.username || provider.account?.senderHandle || null,
        message,
        reason: providerResponse.reason || 'provider skipped send',
      });
      console.log(`SKIPPED @${creator.handle}: ${providerResponse.reason || 'provider skipped send'}`);
      return 'skipped';
    }

    if (provider.name !== 'dry-run' || config.markDryRunAsSent) {
      await markQueueSent(pool, {
        queueItem,
        senderAccountId: resolvedSenderAccount?.id || null,
        senderHandle: resolvedSenderAccount?.username || provider.account?.senderHandle || null,
        message,
      });
      console.log(`SENT @${creator.handle}`);
      return 'sent';
    }

    await markQueueDryRun(pool, { queueItem, message });
    console.log(`DRY RUN @${creator.handle}: ${message}`);
    return 'dry_run';
  } catch (error) {
    const screenshot = await provider.screenshot?.(creator.handle).catch(() => null);
    const status = await markQueueFailed(pool, {
      queueItem,
      error: error.message,
      retryAfter: new Date(Date.now() + 30 * 60 * 1000),
    });

    await recordSendAttempt(pool, {
      queueItem,
      workerId: config.workerId,
      provider: provider.name,
      status,
      message,
      senderAccountId: senderAccount?.id || null,
      senderRunId,
      error: error.message,
      providerResponse: screenshot ? { screenshot } : {},
    });

    console.error(`FAILED @${creator.handle}: ${error.message}`);
    return status;
  }
}

function queueItemToCreator(queueItem) {
  return {
    id: queueItem.creator_id,
    handle: queueItem.handle,
    profile_url: queueItem.profile_url,
    display_name: queueItem.display_name,
    followers_count: queueItem.followers_count,
    source_seed: queueItem.source_seed,
  };
}

function shouldContinue({ sentOrAttempted, maxSends }) {
  return maxSends === null || sentOrAttempted < maxSends;
}

function parseArgs(argv) {
  const args = {
    claimRun: false,
    once: false,
    runId: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--claim-run') {
      args.claimRun = true;
    } else if (arg === '--once') {
      args.once = true;
    } else if (arg === '--run-id') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--run-id requires a run id');
      args.runId = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installShutdownHandlers() {
  process.once('SIGINT', () => {
    stopRequested = true;
    console.log('SIGINT received; stopping after current item.');
  });
  process.once('SIGTERM', () => {
    stopRequested = true;
    console.log('SIGTERM received; stopping after current item.');
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
