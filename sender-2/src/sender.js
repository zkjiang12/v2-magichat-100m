#!/usr/bin/env node

import {
  listEligibleSenderAccounts,
  lockSenderAccount,
  refreshSenderAccountLock,
  unlockSenderAccount,
} from './accounts.js';
import { getCampaignMessageTemplate } from './campaigns.js';
import { getConfig } from './config.js';
import { createPool } from './db.js';
import { renderMessage } from './message-template.js';
import {
  claimNextQueueItem,
  countClaimableQueueItems,
  markQueueDryRun,
  markQueueFailed,
  markQueueSkipped,
  markQueueSent,
  recordSendAttempt,
  releaseQueueItem,
  reclaimStuckQueueItems,
  skipCrossCampaignDuplicates,
} from './queue.js';
import { createProvider } from './providers/index.js';
import {
  claimNextSenderRun,
  claimSenderRunById,
  completeSenderRun,
  createDrainSenderRun,
  failSenderRun,
  handleSenderCommand,
  incrementSenderRunCounters,
  nextSenderCommand,
  normalizeSenderRunCounters,
  PAUSE_REASON_NO_CAPACITY,
  pauseSenderRun,
  resumeCapacityPausedSenderRuns,
  saveSenderRunProgress,
  unclaimSenderRun,
} from './sender-runs.js';

let stopRequested = false;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = getConfig();
  const pool = createPool({ databaseUrl: config.databaseUrl });
  const provider = createProvider(config.provider, { pool, config });
  installShutdownHandlers();

  if (args.drain) {
    try {
      await runDrainWorker({ pool, provider, config });
    } finally {
      await provider.close?.();
      await pool.end();
    }
    return;
  }

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
    if (provider.name !== 'dry-run') {
      const eligible = await listEligibleSenderAccounts(pool, {
        excludedUsernames: config.excludedSenderUsernames,
        campaign: config.campaign,
      });
      if (eligible.length === 0) {
        console.log(`All accounts are at their daily limit; sleeping ${config.pollIntervalMs}ms.`);
        await sleep(config.pollIntervalMs);
        continue;
      }
    }

    let claimedAny = false;
    let outOfCapacity = false;

    for (let index = 0; index < config.batchSize; index += 1) {
      if (!shouldContinue({ sentOrAttempted, maxSends: config.maxSends })) break;

      const queueItem = await claimNextQueueItem(pool, {
        workerId: config.workerId,
        campaign: config.campaign,
      });

      if (!queueItem) break;
      claimedAny = true;
      const outcome = await processQueueItem({ pool, queueItem, provider, config });
      if (outcome === 'no_capacity') {
        outOfCapacity = true;
        break;
      }
      sentOrAttempted += 1;
    }

    if (!claimedAny || outOfCapacity) {
      if (!outOfCapacity) console.log(`No queued items found; sleeping ${config.pollIntervalMs}ms.`);
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

      const result = await processSenderRun({ pool, run, provider, config });
      if (once) return;
      if (result === 'unclaimed') {
        // The run went back to 'requested' because accounts are busy; sleep
        // instead of immediately re-claiming it in a hot loop.
        await sleep(config.pollIntervalMs);
      }
    }
  } finally {
    await pool.end();
  }
}

async function processSenderRun({ pool, run, provider, config }) {
  let counters = normalizeSenderRunCounters(run.counters);
  const maxSends = run.max_sends ?? config.maxSends;
  const campaign = run.campaign || config.campaign;

  console.log(
    `[run ${run.id}] claimed sender run; provider=${provider.name}; maxSends=${maxSends ?? 'unlimited'}`,
  );

  try {
    // Dry-run has no real accounts, so capacity/lanes don't apply.
    if (provider.name === 'dry-run') {
      await runSequentialSenderRun({ pool, run, provider, config, counters, maxSends });
      return;
    }

    while (!stopRequested && shouldContinue({ sentOrAttempted: counters.attempted, maxSends })) {
      const command = await nextSenderCommand(pool, { runId: run.id });
      const commandResult = await handleSenderCommand(pool, { runId: run.id, counters, command });
      if (commandResult !== 'continue') {
        console.log(`[run ${run.id}] ${commandResult}.`);
        return;
      }

      const eligible = await listEligibleSenderAccounts(pool, {
        allowedUsernames: run.account_usernames || [],
        excludedUsernames: config.excludedSenderUsernames,
        campaign,
      });

      if (eligible.length === 0) {
        await pauseSenderRun(pool, { runId: run.id, counters, reason: PAUSE_REASON_NO_CAPACITY });
        console.log(`[run ${run.id}] paused; every eligible account is at its daily send limit.`);
        return;
      }

      const lockedAccounts = [];
      for (const account of eligible) {
        if (lockedAccounts.length >= config.maxParallelAccounts) break;
        if (account.is_locked) continue;
        if (await lockSenderAccount(pool, { accountId: account.id, workerId: config.workerId })) {
          lockedAccounts.push(account);
        }
      }

      if (lockedAccounts.length === 0) {
        // Capacity exists but other workers hold every account; let a later
        // tick retry instead of spinning here. Callers must NOT immediately
        // re-claim (the run is 'requested' again) or they will hot-loop.
        await unclaimSenderRun(pool, { runId: run.id, counters });
        console.log(`[run ${run.id}] re-queued; eligible accounts are busy with another worker.`);
        return 'unclaimed';
      }

      const shared = {
        counters,
        reserved: counters.attempted,
        command: null,
        drained: false,
      };

      console.log(
        `[run ${run.id}] sending on ${lockedAccounts.length} account lane(s): ${lockedAccounts.map((a) => `@${a.username}`).join(', ')}`,
      );

      // allSettled so one lane's crash doesn't release accounts that other
      // lanes are still actively driving.
      const laneResults = await Promise.allSettled(
        lockedAccounts.map((account) =>
          runAccountLane({ pool, provider, config, run, account, shared, maxSends })),
      );
      for (const account of lockedAccounts) {
        await unlockSenderAccount(pool, { accountId: account.id, workerId: config.workerId })
          .catch(() => {});
      }
      const laneFailure = laneResults.find((result) => result.status === 'rejected');
      if (laneFailure) throw laneFailure.reason;

      counters = shared.counters;

      if (shared.command) {
        const result = await handleSenderCommand(pool, {
          runId: run.id,
          counters,
          command: shared.command,
        });
        if (result !== 'continue') {
          console.log(`[run ${run.id}] ${result}.`);
          return;
        }
      }

      if (shared.drained) {
        await completeSenderRun(pool, { runId: run.id, counters, status: 'completed' });
        console.log(`[run ${run.id}] completed; no queued items left.`);
        return;
      }
      // Otherwise some lanes exhausted their account's capacity: loop to
      // re-list accounts and continue on whatever capacity remains.
    }

    const finalStatus = stopRequested ? 'stopped' : 'completed';
    await completeSenderRun(pool, { runId: run.id, counters, status: finalStatus });
    console.log(`[run ${run.id}] ${finalStatus}; attempted=${counters.attempted}.`);
  } catch (error) {
    await failSenderRun(pool, { runId: run.id, counters, error: error.stack || error.message });
    throw error;
  }
}

// One lane = one locked account sending sequentially with its own pacing.
// Lanes share counters and stop signals through `shared`.
async function runAccountLane({ pool, provider, config, run, account, shared, maxSends }) {
  const capacityLeft = Math.max(
    0,
    Number(account.daily_send_limit) - Number(account.effective_sends_today || 0),
  );
  let laneSent = 0;

  while (!stopRequested && !shared.command && !shared.drained && laneSent < capacityLeft) {
    if (maxSends !== null && shared.reserved >= maxSends) return;
    shared.reserved += 1;

    const queueItem = await claimNextQueueItem(pool, {
      workerId: `${config.workerId}:${run.id}:${account.username}`,
      campaign: run.campaign || config.campaign,
    });

    if (!queueItem) {
      shared.reserved -= 1;
      shared.drained = true;
      return;
    }

    const outcome = await processQueueItem({
      pool,
      queueItem,
      provider,
      config,
      senderAccount: account,
      senderRunId: run.id,
      senderRun: run,
    });

    if (outcome === 'no_capacity') {
      shared.reserved -= 1;
      return;
    }

    if (outcome === 'sent') laneSent += 1;
    shared.counters = incrementSenderRunCounters(shared.counters, outcome);
    await saveSenderRunProgress(pool, { runId: run.id, counters: shared.counters });
    await refreshSenderAccountLock(pool, { accountId: account.id, workerId: config.workerId })
      .catch(() => {});

    if (!shared.command) {
      const command = await nextSenderCommand(pool, { runId: run.id });
      if (command) shared.command = command;
    }
  }
}

// The pre-lanes behavior, kept for the dry-run provider.
async function runSequentialSenderRun({ pool, run, provider, config, counters, maxSends }) {
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
      campaign: run.campaign || config.campaign,
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
}

// One tick of the scheduled worker: clean up, resume capacity-paused runs,
// work through requested runs, then keep draining the queue on an auto run
// while accounts still have capacity. Exits when there is nothing to do.
async function runDrainWorker({ pool, provider, config }) {
  const campaign = config.campaign;

  if (config.drainJitterMs > 0) {
    const jitterMs = randomInt(0, config.drainJitterMs);
    console.log(`Drain: sleeping ${jitterMs}ms jitter before starting.`);
    await sleep(jitterMs);
  }

  const reclaimed = await reclaimStuckQueueItems(pool, {
    campaign,
    maxAgeMinutes: config.reclaimAfterMinutes,
  });
  if (reclaimed > 0) console.log(`Drain: reclaimed ${reclaimed} stale claimed item(s).`);

  const deduped = await skipCrossCampaignDuplicates(pool, { campaign });
  if (deduped > 0) {
    console.log(`Drain: skipped ${deduped} item(s) already messaged in another campaign.`);
  }

  const resumed = await resumeCapacityPausedSenderRuns(pool, { campaign });
  if (resumed > 0) console.log(`Drain: resumed ${resumed} capacity-paused run(s).`);

  while (!stopRequested) {
    const run = await claimNextSenderRun(pool, { campaign });
    if (!run) break;
    const result = await processSenderRun({ pool, run, provider, config });
    if (result === 'unclaimed') {
      // Accounts are busy with another worker; this tick is done.
      console.log('Drain: accounts busy with another worker; exiting until next tick.');
      return;
    }
  }
  if (stopRequested) return;

  const pending = await countClaimableQueueItems(pool, { campaign });
  if (pending === 0) {
    console.log('Drain: no claimable queue items; exiting.');
    return;
  }

  const eligible = await listEligibleSenderAccounts(pool, {
    excludedUsernames: config.excludedSenderUsernames,
    campaign,
  });
  if (eligible.filter((account) => !account.is_locked).length === 0) {
    console.log(`Drain: ${pending} item(s) queued but no account capacity available; exiting until next tick.`);
    return;
  }

  const autoRun = await createDrainSenderRun(pool, { campaign });
  console.log(`Drain: created auto run ${autoRun.id} to drain ${pending} queued item(s).`);
  const claimed = await claimSenderRunById(pool, { campaign, runId: autoRun.id });
  if (claimed) {
    await processSenderRun({ pool, run: claimed, provider, config });
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
  const campaignTemplate = await getCampaignMessageTemplate(pool, queueItem.campaign);
  const accountMessage = senderAccount?.message ||
    senderAccount?.metadata?.message ||
    provider.account?.message ||
    null;
  const messageTemplate = textOrNull(senderRun?.message_template) ||
    accountMessage ||
    campaignTemplate ||
    config.messageTemplate;
  const message = renderMessage(messageTemplate, creator);

  try {
    const providerResponse = await provider.sendMessage({
      account: senderAccount || provider.account || null,
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
    if (error.code === 'NO_CAPACITY') {
      // Not a real failure: nothing was attempted. Put the item back
      // untouched so the run loop can pause instead of churning.
      await releaseQueueItem(pool, { queueItem });
      console.log(`RELEASED @${creator.handle}: ${error.message}`);
      return 'no_capacity';
    }

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

function textOrNull(value) {
  const text = String(value || '').trim();
  return text ? text : null;
}

function shouldContinue({ sentOrAttempted, maxSends }) {
  return maxSends === null || sentOrAttempted < maxSends;
}

function parseArgs(argv) {
  const args = {
    claimRun: false,
    drain: false,
    once: false,
    runId: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--claim-run') {
      args.claimRun = true;
    } else if (arg === '--drain') {
      args.drain = true;
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

function randomInt(min, max) {
  const low = Math.ceil(Number(min) || 0);
  const high = Math.floor(Number(max) || low);
  if (high <= low) return low;
  return low + Math.floor(Math.random() * (high - low + 1));
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
