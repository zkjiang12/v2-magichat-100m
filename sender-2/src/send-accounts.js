#!/usr/bin/env node

import { getConfig } from './config.js';
import { createPool } from './db.js';
import { loadAccounts } from './accounts.js';
import { claimNextQueueItem, upsertSenderAccount } from './queue.js';
import { processQueueItem } from './sender.js';
import { createInstagramPlaywrightProvider } from './providers/instagram-playwright.js';
import {
  claimNextSenderRun,
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
  if (!args.send) {
    throw new Error('Live Playwright sending requires --send. Use npm run send:accounts -- --send ...');
  }
  if (process.env.SENDER_LIVE_SEND !== 'true') {
    throw new Error('Live Playwright sending requires SENDER_LIVE_SEND=true in addition to --send.');
  }

  const config = getConfig();
  const accounts = await loadAccounts(args.config);
  const pool = createPool({ databaseUrl: config.databaseUrl });
  installShutdownHandlers();

  try {
    if (args.claimRun) {
      await runDashboardSenderRuns({ pool, config, accounts, args });
    } else {
      const selectedAccounts = selectAccountsForRun({
        accounts,
        accountUsernames: [],
        accountLimit: args.accounts,
        excludeHandles: args.excludeHandles,
      });

      console.log(
        `Starting ${selectedAccounts.length} Playwright sender account(s); concurrency=${args.concurrency}; maxPerAccount=${args.maxPerAccount}; excluded=${[...args.excludeHandles].join(',') || 'none'}`,
      );
      await runAccountQueue({ pool, config, accounts: selectedAccounts, args });
    }
  } finally {
    await pool.end();
  }
}

async function runDashboardSenderRuns({ pool, config, accounts, args }) {
  console.log(
    [
      `Starting live sender run worker ${config.workerId}`,
      `campaign=${config.campaign}`,
      `pollIntervalMs=${config.pollIntervalMs}`,
      `excluded=${[...args.excludeHandles].join(',') || 'none'}`,
    ].join('; '),
  );

  while (!stopRequested) {
    const run = await claimNextSenderRun(pool, { campaign: config.campaign });
    if (!run) {
      console.log(`No requested sender_runs found; sleeping ${config.pollIntervalMs}ms.`);
      await sleep(config.pollIntervalMs);
      continue;
    }

    const selectedAccounts = selectAccountsForRun({
      accounts,
      accountUsernames: run.account_usernames || [],
      accountLimit: run.account_usernames?.length || args.accounts,
      excludeHandles: args.excludeHandles,
    });

    if (selectedAccounts.length === 0) {
      await failSenderRun(pool, {
        runId: run.id,
        counters: run.counters,
        error: 'No runnable sender accounts matched this sender run.',
      });
      continue;
    }

    await runSenderRun({ pool, config, run, accounts: selectedAccounts, args });
  }
}

async function runAccountQueue({ pool, config, accounts, args }) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(args.concurrency, accounts.length) }, async () => {
    while (!stopRequested && nextIndex < accounts.length) {
      const account = accounts[nextIndex];
      nextIndex += 1;
      await runAccount({ pool, config, account, args });
    }
  });

  await Promise.all(workers);
}

async function runSenderRun({ pool, config, run, accounts, args }) {
  let counters = normalizeSenderRunCounters(run.counters);
  const maxSends = run.max_sends ?? config.maxSends;
  const accountMaxPerAccount = Math.max(1, maxSends ?? args.maxPerAccount);
  const runArgs = {
    ...args,
    maxPerAccount: accountMaxPerAccount,
    senderRunId: run.id,
    runMaxSends: maxSends,
  };

  console.log(
    `[run ${run.id}] claimed live sender run; accounts=${accounts.map((account) => account.senderHandle).join(', ')}; maxSends=${maxSends ?? 'unlimited'}`,
  );

  try {
    for (const account of accounts) {
      if (stopRequested || !shouldContinueRun(counters, maxSends)) break;

      const commandBefore = await nextSenderCommand(pool, { runId: run.id });
      const commandBeforeResult = await handleSenderCommand(pool, {
        runId: run.id,
        counters,
        command: commandBefore,
      });
      if (commandBeforeResult !== 'continue') return;

      counters = await runAccount({
        pool,
        config,
        account,
        args: { ...runArgs, counters },
      });
    }

    if (['paused', 'stopped'].includes((await readSenderRunStatus(pool, run.id)) || '')) return;

    const finalStatus = stopRequested ? 'stopped' : 'completed';
    await completeSenderRun(pool, { runId: run.id, counters, status: finalStatus });
    console.log(`[run ${run.id}] ${finalStatus}; attempted=${counters.attempted}.`);
  } catch (error) {
    await failSenderRun(pool, { runId: run.id, counters, error: error.stack || error.message });
    throw error;
  }
}

async function runAccount({ pool, config, account, args }) {
  const senderAccount = await upsertSenderAccount(pool, {
    username: account.senderHandle,
    dailySendLimit: account.limit,
    metadata: {
      label: account.name,
      storageState: account.storageState,
      minDelay: account.minDelay,
      maxDelay: account.maxDelay,
    },
  });

  const provider = await createInstagramPlaywrightProvider({
    account,
    headless: args.headless,
    logsDir: args.logsDir,
  });

  const maxSends = Math.min(account.limit, args.maxPerAccount);
  let sentOrAttempted = 0;
  let consecutiveFailures = 0;
  let runCounters = args.senderRunId ? normalizeSenderRunCounters(args.counters) : null;

  try {
    while (
      !stopRequested &&
      sentOrAttempted < maxSends &&
      (!args.senderRunId || shouldContinueRun(runCounters, args.runMaxSends))
    ) {
      if (args.senderRunId) {
        const commandBefore = await nextSenderCommand(pool, { runId: args.senderRunId });
        const commandBeforeResult = await handleSenderCommand(pool, {
          runId: args.senderRunId,
          counters: runCounters,
          command: commandBefore,
        });
        if (commandBeforeResult !== 'continue') return runCounters;
      }

      const queueItem = await claimNextQueueItem(pool, {
        workerId: `${config.workerId}:${account.name}`,
        campaign: config.campaign,
      });

      if (!queueItem) {
        console.log(`[${account.name}] no queued items left.`);
        return runCounters;
      }

      const outcome = await processQueueItem({
        pool,
        queueItem,
        provider,
        config,
        senderAccount,
        senderRunId: args.senderRunId || null,
      });

      sentOrAttempted += 1;
      if (args.senderRunId) {
        runCounters = incrementSenderRunCounters(runCounters, outcome);
        await saveSenderRunProgress(pool, { runId: args.senderRunId, counters: runCounters });

        const commandAfter = await nextSenderCommand(pool, { runId: args.senderRunId });
        const commandAfterResult = await handleSenderCommand(pool, {
          runId: args.senderRunId,
          counters: runCounters,
          command: commandAfter,
        });
        if (commandAfterResult !== 'continue') return runCounters;
      }

      if (outcome === 'failed_retryable' || outcome === 'failed_final') {
        consecutiveFailures += 1;
      } else {
        consecutiveFailures = 0;
      }

      if (account.stopAfterFailures > 0 && consecutiveFailures >= account.stopAfterFailures) {
        console.log(`[${account.name}] stopping after ${consecutiveFailures} consecutive failure(s).`);
        return runCounters;
      }

      if (sentOrAttempted < maxSends) {
        const delay = randomDelay(account.minDelay, account.maxDelay);
        console.log(`[${account.name}] waiting ${delay}s before next send.`);
        if (args.senderRunId) {
          const sleepResult = await sleepWithSenderCommandChecks(pool, {
            runId: args.senderRunId,
            counters: runCounters,
            delayMs: delay * 1000,
          });
          if (sleepResult !== 'continue') return runCounters;
        } else {
          await sleep(delay * 1000);
        }
      }
    }
  } finally {
    await provider.close();
    console.log(`[${account.name}] stopped after ${sentOrAttempted} claimed item(s).`);
  }

  return runCounters;
}

function parseArgs(argv) {
  const args = {
    send: false,
    claimRun: false,
    config: process.env.SENDER_ACCOUNTS_CONFIG_PATH || '../../v1/sender-1/accounts-all.json',
    concurrency: 1,
    accounts: 1,
    maxPerAccount: 1,
    headless: false,
    logsDir: 'logs',
    excludeHandles: new Set(['try_magic_hat']),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === '--send') {
      args.send = true;
    } else if (arg === '--claim-run') {
      args.claimRun = true;
    } else if (arg === '--config') {
      if (!value || value.startsWith('--')) throw new Error('Missing value for --config');
      args.config = value;
      index += 1;
    } else if (arg === '--concurrency') {
      args.concurrency = parsePositiveInteger(value, '--concurrency');
      index += 1;
    } else if (arg === '--accounts') {
      args.accounts = parsePositiveInteger(value, '--accounts');
      index += 1;
    } else if (arg === '--max-per-account') {
      args.maxPerAccount = parsePositiveInteger(value, '--max-per-account');
      index += 1;
    } else if (arg === '--headless') {
      args.headless = true;
    } else if (arg === '--logs-dir') {
      if (!value || value.startsWith('--')) throw new Error('Missing value for --logs-dir');
      args.logsDir = value;
      index += 1;
    } else if (arg === '--exclude-handle') {
      if (!value || value.startsWith('--')) throw new Error('Missing value for --exclude-handle');
      args.excludeHandles.add(value.replace(/^@/, ''));
      index += 1;
    } else if (arg === '--include-try-magic-hat') {
      args.excludeHandles.delete('try_magic_hat');
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function selectAccountsForRun({ accounts, accountUsernames, accountLimit, excludeHandles }) {
  const requested = new Set((accountUsernames || []).map(normalizeHandle).filter(Boolean));
  return accounts
    .filter((account) => !excludeHandles.has(account.senderHandle))
    .filter((account) => requested.size === 0 || requested.has(account.senderHandle))
    .slice(0, accountLimit);
}

function normalizeHandle(value) {
  return String(value || '').trim().replace(/^@/, '');
}

function shouldContinueRun(counters, maxSends) {
  return maxSends === null || normalizeSenderRunCounters(counters).attempted < maxSends;
}

async function readSenderRunStatus(pool, runId) {
  const result = await pool.query('select status from sender_runs where id = $1', [runId]);
  return result.rows[0]?.status || null;
}

async function sleepWithSenderCommandChecks(pool, { runId, counters, delayMs }) {
  const deadline = Date.now() + delayMs;
  while (!stopRequested && Date.now() < deadline) {
    const command = await nextSenderCommand(pool, { runId });
    const commandResult = await handleSenderCommand(pool, { runId, counters, command });
    if (commandResult !== 'continue') return commandResult;
    await sleep(Math.min(5000, Math.max(0, deadline - Date.now())));
  }
  return 'continue';
}

function parsePositiveInteger(value, name) {
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
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
