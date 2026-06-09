#!/usr/bin/env node

import { createApifyCostTracker } from './apify-cost-tracker.js';
import { getConfig } from './config.js';
import { createDashboardRecorder } from './dashboard-db.js';
import { scrapeFollowingCandidates } from './following.js';
import { parseHandles } from './handles.js';
import {
  normalizeHandle,
  scrapeInstagramProfile,
} from './instagram.js';
import {
  annotateFollowingCandidateForPrefilter,
  buildScrapeHardNoReview,
  isKnownOutsideFollowerRange,
} from './qualification.js';
import { scoreCreatorDetailed } from './scorer.js';
import { saveEvaluationRecord } from './storage.js';

const DEFAULT_QUALIFICATION_WORKERS = 32;
const DEFAULT_MAX_ACCEPTED = 1000;
const STATS_INTERVAL_MS = 30000;

let stopRequested = false;
let activeQualifications = 0;
let requestedFinalStatus = 'stopped';

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const config = getConfig();
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required. scraper-2 now uses Postgres as its source of truth.');
  }

  const seedHandles = await parseHandles(options.handleArgs);
  if (!options.claimNext && !options.runId && seedHandles.length === 0) {
    throw new Error('Usage: npm run crawl -- --run-id <uuid> OR npm run crawl -- --file seeds/day_in_life_creators.txt OR npm run crawl -- @seed1 @seed2');
  }

  if (options.followingLimit !== null) config.instagramFollowingLimit = options.followingLimit;
  const dashboardRecorder = createDashboardRecorder({ config });
  config.dashboardRecorder = dashboardRecorder;
  config.apifyRunCostTracker = createApifyCostTracker({
    settleMs: 0,
    onRecordedRun: async (run) => {
      await dashboardRecorder?.recordApifyRun(run);
    },
  });

  const runContext = await loadOrCreatePostgresRun({
    recorder: dashboardRecorder,
    campaign: config.campaign,
    runId: options.runId,
    claimNext: options.claimNext,
    seedHandles,
    maxAccepted: options.maxAccepted,
    followingLimit: options.followingLimit,
    qualificationWorkers: options.qualificationWorkers,
  });
  if (runContext.noWork) {
    console.log('No requested or paused scraper_runs rows to claim; exiting without work.');
    await dashboardRecorder.close();
    return;
  }

  const { state, runId } = runContext;
  options.maxAccepted = runContext.maxAccepted;
  if (runContext.followingLimit !== null && runContext.followingLimit !== undefined) {
    config.instagramFollowingLimit = runContext.followingLimit;
  }
  options.qualificationWorkers = runContext.qualificationWorkers;
  const saveState = createPostgresStateSaver({ recorder: dashboardRecorder, runId });
  let statsTimer = null;
  try {
    await saveState(state);
    installShutdownHandlers({ state, saveState, recorder: dashboardRecorder, runId });

    console.log(
      [
        `Starting frontier crawl with ${options.qualificationWorkers} qualification workers`,
        `runId=${runId}`,
        `campaign=${config.campaign}`,
        `followingLimit=${config.instagramFollowingLimit}`,
        `maxAccepted=${options.maxAccepted}`,
      ].join('; '),
    );
    printProgress({ state, label: 'initial' });

    statsTimer = setInterval(() => {
      printProgress({ state, label: 'heartbeat' });
    }, STATS_INTERVAL_MS);

    try {
      if (state.qualificationQueue.length > 0) {
        await drainCarryoverQueue({
          runId,
          state,
          saveState,
          config,
          maxAccepted: options.maxAccepted,
          qualificationWorkers: options.qualificationWorkers,
        });
      }

      while (!stopRequested && state.acceptedCount < options.maxAccepted) {
        await applyPendingRunCommand({ recorder: dashboardRecorder, runId, state, saveState });
        if (stopRequested) break;

        const seed = selectNextSeed(state);
        if (!seed) {
          console.log('No frontier seeds remain.');
          break;
        }

        await expandSeed({
          seed,
          runId,
          state,
          saveState,
          config,
          maxAccepted: options.maxAccepted,
          qualificationWorkers: options.qualificationWorkers,
        });
      }
    } finally {
      clearInterval(statsTimer);
      statsTimer = null;
    }

    await saveState(state);
    await dashboardRecorder.completeScraperRun({
      runId,
      state,
      status: stopRequested ? requestedFinalStatus : 'completed',
    });
    printProgress({ state, label: 'final' });
    console.log('Frontier crawl finished or paused.');
  } catch (error) {
    if (statsTimer) clearInterval(statsTimer);
    await markRunFailedBestEffort({ recorder: dashboardRecorder, runId, state, saveState, error });
    throw error;
  } finally {
    await dashboardRecorder.close();
  }
}

async function drainCarryoverQueue({ runId, state, saveState, config, maxAccepted, qualificationWorkers }) {
  const carryoverSeed = {
    handle: state.currentSeed || 'carryover',
    depth: 0,
    priorityScore: 4,
  };
  console.log(
    `[carryover] qualifying ${state.qualificationQueue.length} migrated queued candidates with ${qualificationWorkers} workers`,
  );
  await drainQualificationQueue({
    runId,
    state,
    saveState,
    config,
    maxAccepted,
    sourceSeed: carryoverSeed,
    workerCount: qualificationWorkers,
  });
}

async function expandSeed({ seed, runId, state, saveState, config, maxAccepted, qualificationWorkers }) {
  seed.startedAt = seed.startedAt || new Date().toISOString();
  state.currentSeed = seed.handle;
  await saveState(state);

  if (!seed.discovery) {
    seed.status = 'discovering';
    await saveState(state);

    console.log(
      `[seed depth=${seed.depth} priority=${seed.priorityScore}] discovering followings for @${seed.handle}`,
    );

    let discovery;
    try {
      discovery = await scrapeFollowingCandidates({ handle: seed.handle, config });
    } catch (error) {
      seed.status = 'failed';
      seed.failedAt = new Date().toISOString();
      seed.error = error.message;
      state.currentSeed = null;
      await saveState(state);
      console.error(`[seed @${seed.handle}] discovery failed: ${error.message}`);
      return;
    }

    seed.status = 'qualifying';
    seed.discovery = {
      discoveredAt: new Date().toISOString(),
      requestedLimit: discovery.requestedLimit,
      rawCount: discovery.rawCount,
      candidateCount: discovery.candidates.length,
      observedTypes: discovery.observedTypes,
    };

    const filterStats = await enqueueDiscoveredCandidates({
      state,
      sourceSeed: seed,
      candidates: discovery.candidates,
      config,
    });
    seed.filterStats = filterStats;
    await saveState(state);

    console.log(
      [
        `[seed @${seed.handle}] discovered=${discovery.candidates.length}`,
        `raw=${discovery.rawCount}`,
        `queued=${filterStats.queued}`,
        `private=${filterStats.private}`,
        `unverified=${filterStats.unverified}`,
        `followers=${filterStats.followers}`,
        `hard_no=${filterStats.hardNo}`,
        `duplicate=${filterStats.duplicate}`,
      ].join(' '),
    );
    if (discovery.rawCount >= discovery.requestedLimit) {
      console.log(`[seed @${seed.handle}] hit following limit ${discovery.requestedLimit}; may have more followings beyond fetched set`);
    }
  } else {
    seed.status = 'qualifying';
    console.log(
      `[seed @${seed.handle}] resuming qualification queue; queued=${state.qualificationQueue.length}`,
    );
    await saveState(state);
  }

  await drainQualificationQueue({
    runId,
    state,
    saveState,
    config,
    maxAccepted,
    sourceSeed: seed,
    workerCount: qualificationWorkers,
  });

  seed.status = stopRequested ? 'paused' : 'done';
  seed.completedAt = new Date().toISOString();
  state.currentSeed = null;
  await saveState(state);
}

async function enqueueDiscoveredCandidates({ state, sourceSeed, candidates, config }) {
  const stats = {
    queued: 0,
    private: 0,
    unverified: 0,
    followers: 0,
    hardNo: 0,
    duplicate: 0,
    invalid: 0,
  };
  const seenRecords = [];

  for (const candidate of candidates) {
    const handle = normalizeHandle(candidate.handle || '');
    if (!handle) {
      stats.invalid += 1;
      continue;
    }

    if (state.seen[handle]) {
      stats.duplicate += 1;
      continue;
    }

    const prefilteredCandidate = annotateFollowingCandidateForPrefilter({ candidate, config });

    if (prefilteredCandidate.isPrivate === true) {
      state.seen[handle] = buildSeenRecord({
        handle,
        status: 'filtered_private',
        sourceSeed,
        candidate: prefilteredCandidate,
      });
      seenRecords.push(state.seen[handle]);
      stats.private += 1;
      continue;
    }

    if (config.instagramRequireVerified && prefilteredCandidate.isVerified !== true) {
      state.seen[handle] = buildSeenRecord({
        handle,
        status: 'filtered_unverified',
        sourceSeed,
        candidate: prefilteredCandidate,
      });
      seenRecords.push(state.seen[handle]);
      stats.unverified += 1;
      continue;
    }

    if (isKnownOutsideFollowerRange({ candidate: prefilteredCandidate, config })) {
      state.seen[handle] = buildSeenRecord({
        handle,
        status: 'filtered_followers',
        sourceSeed,
        candidate: prefilteredCandidate,
      });
      seenRecords.push(state.seen[handle]);
      stats.followers += 1;
      continue;
    }

    if (prefilteredCandidate.hardNo === true) {
      state.seen[handle] = buildSeenRecord({
        handle,
        status: 'filtered_hard_no',
        sourceSeed,
        candidate: prefilteredCandidate,
      });
      seenRecords.push(state.seen[handle]);
      stats.hardNo += 1;
      continue;
    }

    state.seen[handle] = buildSeenRecord({
      handle,
      status: 'queued',
      sourceSeed,
      candidate: prefilteredCandidate,
    });
    seenRecords.push(state.seen[handle]);
    state.qualificationQueue.push(handle);
    stats.queued += 1;
  }

  if (seenRecords.length > 0) {
    await config.dashboardRecorder?.recordSeenMany(seenRecords);
  }

  return stats;
}

async function drainQualificationQueue({ runId, state, saveState, config, maxAccepted, sourceSeed, workerCount }) {
  console.log(
    `[seed @${sourceSeed.handle}] qualifying ${state.qualificationQueue.length} queued candidates with ${workerCount} workers`,
  );

  await Promise.all(
    Array.from({ length: workerCount }, (_, index) =>
      runQualificationWorker({
        workerId: index + 1,
        runId,
        state,
        saveState,
        config,
        maxAccepted,
        sourceSeed,
      }),
    ),
  );
}

async function runQualificationWorker({ workerId, runId, state, saveState, config, maxAccepted, sourceSeed }) {
  while (!stopRequested) {
    await applyPendingRunCommand({
      recorder: config.dashboardRecorder,
      runId,
      state,
      saveState,
    });
    if (stopRequested) return;

    if (state.acceptedCount >= maxAccepted) return;

    const handle = dequeueQualificationCandidate(state);
    if (!handle) return;

    if (state.acceptedCount >= maxAccepted) {
      state.qualificationQueue.unshift(handle);
      return;
    }

    const record = state.seen[handle];
    record.status = 'processing';
    record.processingStartedAt = new Date().toISOString();
    record.workerId = workerId;
    activeQualifications += 1;
    console.log(`[worker ${workerId}] qualifying @${handle} from seed @${sourceSeed.handle}`);
    await saveState(state);

    try {
      await qualifyCandidate({ handle, state, saveState, config, sourceSeed, maxAccepted });
    } finally {
      activeQualifications -= 1;
    }
  }
}

function dequeueQualificationCandidate(state) {
  while (state.qualificationQueue.length > 0) {
    const handle = state.qualificationQueue.shift();
    if (state.seen[handle]?.status === 'queued') return handle;
  }
  return null;
}

async function qualifyCandidate({ handle, state, saveState, config, sourceSeed, maxAccepted }) {
  try {
    const scrapedProfile = await scrapeInstagramProfile({ handle, config });
    const hardNoReview = buildScrapeHardNoReview({ scrapedProfile, config });
    if (hardNoReview) {
      const saved = await saveEvaluation({ handle, scrapedProfile, aiReview: hardNoReview });
      await markScored({ state, handle, aiReview: hardNoReview, saved, config, maxAccepted });
      console.log(`[seed @${sourceSeed.handle}] HARD NO @${handle}: ${hardNoReview.reasoning}`);
      await saveState(state);
      return;
    }

    const scored = await scoreCreatorDetailed({ scrapedProfile, config });
    if (config.campaignDefinition.scoring.mode === 'openai') {
      await config.dashboardRecorder?.recordOpenAiScore({ handle, scored });
    }
    const aiReview = scored.review;
    const saved = await saveEvaluation({ handle, scrapedProfile, aiReview });
    const accepted = await markScored({ state, handle, aiReview, saved, config, maxAccepted });

    if (accepted) {
      addFrontierSeed({
        state,
        handle,
        parentSeed: sourceSeed,
        fitScore: aiReview.fitScore,
      });
      console.log(
        `[seed @${sourceSeed.handle}] ACCEPT @${handle}: ${aiReview.fitScore}/4 [${aiReview.list}] accepted=${state.acceptedCount} processed=${state.processedCount}`,
      );
    } else {
      console.log(
        `[seed @${sourceSeed.handle}] reject @${handle}: ${aiReview.fitScore}/4 [${aiReview.list}] accepted=${state.acceptedCount} processed=${state.processedCount}`,
      );
    }

    await saveState(state);
  } catch (error) {
    const record = state.seen[handle] || { handle };
    state.seen[handle] = {
      ...record,
      status: 'failed',
      failedAt: new Date().toISOString(),
      error: error.message,
    };
    await config.dashboardRecorder?.recordFailed(state.seen[handle]);
    state.failedCount += 1;
    console.error(`[seed @${sourceSeed.handle}] @${handle} failed: ${error.message}`);
    await saveState(state);
  }
}

async function saveEvaluation({ handle, scrapedProfile, aiReview }) {
  return saveEvaluationRecord({
    createdAt: new Date().toISOString(),
    handle,
    scrapedProfile,
    aiReview,
  });
}

async function markScored({ state, handle, aiReview, saved, config, maxAccepted }) {
  const record = state.seen[handle] || { handle };
  const wouldAccept = config.campaignDefinition.accept(aiReview);
  const accepted = wouldAccept && state.acceptedCount < maxAccepted;
  state.seen[handle] = {
    ...record,
    status: accepted ? 'accepted' : 'rejected',
    scoredAt: new Date().toISOString(),
    fitScore: aiReview.fitScore,
    list: aiReview.list,
    reasoning: wouldAccept && !accepted
      ? `Accepted-cap reached before this worker finished. Original review: ${aiReview.reasoning}`
      : aiReview.reasoning,
    reviewPath: saved.reviewPath,
    skippedByAcceptedCap: wouldAccept && !accepted,
  };
  state.processedCount += 1;
  if (accepted) state.acceptedCount += 1;
  await config.dashboardRecorder?.recordEvaluated(state.seen[handle]);
  return accepted;
}

async function applyPendingRunCommand({ recorder, runId, state, saveState }) {
  const command = await recorder.nextScraperCommand({ runId });
  if (!command) return;

  if (command.command === 'stop') {
    stopRequested = true;
    requestedFinalStatus = 'stopped';
    await saveState(state);
    await recorder.markCommandApplied({ commandId: command.id });
    console.log(`[run ${runId}] stop requested from dashboard`);
    return;
  }

  if (command.command === 'pause') {
    stopRequested = true;
    requestedFinalStatus = 'paused';
    await saveState(state);
    await recorder.markCommandApplied({ commandId: command.id });
    console.log(`[run ${runId}] pause requested from dashboard`);
    return;
  }

  await recorder.markCommandApplied({ commandId: command.id });
}

function addFrontierSeed({ state, handle, parentSeed, fitScore }) {
  if (state.frontier.some((seed) => seed.handle === handle)) return;

  state.frontier.push({
    handle,
    depth: parentSeed.depth + 1,
    priorityScore: fitScore,
    parentSeed: parentSeed.handle,
    status: 'pending',
    discoveredAt: new Date().toISOString(),
    originalSeed: false,
  });
}

function selectNextSeed(state) {
  const pending = state.frontier.filter((seed) => seed.status === 'pending' || seed.status === 'paused');
  if (pending.length === 0) return null;

  pending.sort(
    (a, b) =>
      a.depth - b.depth ||
      Number(b.originalSeed) - Number(a.originalSeed) ||
      b.priorityScore - a.priorityScore ||
      a.order - b.order ||
      timestampValue(a.discoveredAt) - timestampValue(b.discoveredAt),
  );
  return pending[0];
}

async function loadOrCreatePostgresRun({
  recorder,
  campaign,
  runId,
  claimNext,
  seedHandles,
  maxAccepted,
  followingLimit,
  qualificationWorkers,
}) {
  if (runId) {
    const fallbackState = createInitialFrontierState({ seedHandles, maxAccepted });
    const run = await recorder.claimScraperRun({ runId, fallbackState });
    if (!run) throw new Error(`scraper_runs row not found: ${runId}`);
    assertRunCampaignMatches({ run, campaign });

    const runState = Object.keys(run.state || {}).length > 0 ? run.state : fallbackState;
    return {
      runId: run.id,
      maxAccepted: run.max_accepted || maxAccepted,
      followingLimit: run.following_limit ?? followingLimit,
      qualificationWorkers: run.qualification_workers || qualificationWorkers,
      state: normalizeFrontierState(runState, { maxAccepted: run.max_accepted || maxAccepted }),
    };
  }

  if (claimNext) {
    const run = await recorder.claimNextScraperRun();
    if (!run) return { noWork: true };
    assertRunCampaignMatches({ run, campaign });
    const runSeedHandles = run.seed_handles || [];
    const maxAcceptedForRun = run.max_accepted || maxAccepted;
    const fallbackState = createInitialFrontierState({
      seedHandles: runSeedHandles,
      maxAccepted: maxAcceptedForRun,
    });
    const runState = Object.keys(run.state || {}).length > 0 ? run.state : fallbackState;
    return {
      runId: run.id,
      maxAccepted: maxAcceptedForRun,
      followingLimit: run.following_limit ?? followingLimit,
      qualificationWorkers: run.qualification_workers || qualificationWorkers,
      state: normalizeFrontierState(runState, { maxAccepted: maxAcceptedForRun }),
    };
  }

  const state = createInitialFrontierState({ seedHandles, maxAccepted });
  const run = await recorder.createScraperRun({
    seedHandles,
    maxAccepted,
    followingLimit,
    qualificationWorkers,
    state,
  });
  return { runId: run.id, state, maxAccepted, followingLimit, qualificationWorkers };
}

function assertRunCampaignMatches({ run, campaign }) {
  if (run.campaign && run.campaign !== campaign) {
    throw new Error(
      `scraper_runs row ${run.id} belongs to campaign ${run.campaign}, but this worker is configured for ${campaign}. Set OUTBOUND_CAMPAIGN=${run.campaign} to process it.`,
    );
  }
}

async function markRunFailedBestEffort({ recorder, runId, state, saveState, error }) {
  try {
    await saveState(state);
  } catch (saveError) {
    console.warn(`[run ${runId}] failed to save state before marking failed: ${saveError.message}`);
  }

  try {
    await recorder.failScraperRun({ runId, state, error: error.stack || error.message });
  } catch (failError) {
    console.warn(`[run ${runId}] failed to mark scraper run failed: ${failError.message}`);
  }
}

function createInitialFrontierState({ seedHandles, maxAccepted }) {
  const uniqueSeeds = [...new Set(seedHandles.map(normalizeHandle).filter(Boolean))];
  const frontier = uniqueSeeds.map((handle, index) => ({
    handle,
    depth: 0,
    priorityScore: 4,
    parentSeed: null,
    status: 'pending',
    discoveredAt: new Date().toISOString(),
    originalSeed: true,
    order: index,
  }));

  const seen = {};
  for (const seed of frontier) {
    seen[seed.handle] = {
      handle: seed.handle,
      status: 'seed',
      source: 'initial_seed',
      discoveredAt: seed.discoveredAt,
      depth: 0,
      profileUrl: `https://www.instagram.com/${seed.handle}/`,
    };
  }

  return {
    version: 1,
    mode: 'frontier',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    maxAccepted,
    acceptedCount: 0,
    processedCount: 0,
    failedCount: 0,
    currentSeed: null,
    qualificationQueue: [],
    frontier,
    seen,
  };
}

function normalizeFrontierState(state, { maxAccepted }) {
  const normalized = {
    version: state.version || 1,
    mode: 'frontier',
    createdAt: state.createdAt || new Date().toISOString(),
    updatedAt: state.updatedAt || new Date().toISOString(),
    maxAccepted: state.maxAccepted || maxAccepted,
    acceptedCount: state.acceptedCount || countStatus(state, 'accepted'),
    processedCount: state.processedCount || countStatus(state, 'accepted') + countStatus(state, 'rejected'),
    failedCount: state.failedCount || countStatus(state, 'failed'),
    currentSeed: state.currentSeed || null,
    qualificationQueue: state.qualificationQueue || [],
    frontier: state.frontier || [],
    seen: state.seen || {},
  };

  for (const seed of normalized.frontier) {
    if (seed.status === 'discovering') seed.status = 'pending';
    if (seed.status === 'qualifying' || seed.status === 'paused') seed.status = 'pending';
    seed.priorityScore = seed.priorityScore || 3;
    seed.order = seed.order ?? 0;
  }

  requeueInterruptedProcessing(normalized);
  return normalized;
}

function requeueInterruptedProcessing(state) {
  for (const [handle, record] of Object.entries(state.seen)) {
    if (record.status !== 'processing') continue;
    record.status = 'queued';
    record.requeuedAt = new Date().toISOString();
    if (!state.qualificationQueue.includes(handle)) state.qualificationQueue.unshift(handle);
  }
}

function buildSeenRecord({ handle, status, sourceSeed, candidate }) {
  return {
    handle,
    status,
    sourceSeed: sourceSeed.handle,
    sourceDepth: sourceSeed.depth,
    discoveredAt: new Date().toISOString(),
    followersCount: candidate.followersCount ?? null,
    followingCount: candidate.followingCount ?? null,
    isPrivate: candidate.isPrivate ?? null,
    isVerified: candidate.isVerified ?? null,
    hardNoReason: candidate.hardNoReason ?? null,
    name: candidate.name ?? null,
    profileUrl: candidate.profileUrl ?? `https://www.instagram.com/${handle}/`,
  };
}

function createPostgresStateSaver({ recorder, runId }) {
  let saveChain = Promise.resolve();

  return async function saveState(state) {
    state.updatedAt = new Date().toISOString();
    saveChain = saveChain.then(async () => {
      await recorder.saveScraperRunState({ runId, state });
    });
    return saveChain;
  };
}

function printProgress({ state, label }) {
  const counts = countStatuses(state);
  const frontierCounts = countFrontierStatuses(state);
  console.log(
    [
      `\n=== Frontier ${label} ===`,
      `accepted=${state.acceptedCount} processed=${state.processedCount} failed=${state.failedCount} seen=${Object.keys(state.seen).length} currentSeed=${state.currentSeed || 'none'}`,
      `queue=${state.qualificationQueue.length} activeQualifications=${activeQualifications}`,
      `statuses: accepted=${counts.accepted || 0} rejected=${counts.rejected || 0} queued=${counts.queued || 0} processing=${counts.processing || 0} failed=${counts.failed || 0}`,
      `filtered: private=${counts.filtered_private || 0} unverified=${counts.filtered_unverified || 0} followers=${counts.filtered_followers || 0} hard_no=${counts.filtered_hard_no || 0}`,
      `frontier: pending=${frontierCounts.pending || 0} discovering=${frontierCounts.discovering || 0} qualifying=${frontierCounts.qualifying || 0} done=${frontierCounts.done || 0} failed=${frontierCounts.failed || 0}`,
      '===================\n',
    ].join('\n'),
  );
}

function countStatuses(state) {
  const counts = {};
  for (const record of Object.values(state.seen)) {
    counts[record.status] = (counts[record.status] || 0) + 1;
  }
  return counts;
}

function countFrontierStatuses(state) {
  const counts = {};
  for (const seed of state.frontier) {
    counts[seed.status] = (counts[seed.status] || 0) + 1;
  }
  return counts;
}

function countStatus(state, status) {
  return Object.values(state.seen || {}).filter((record) => record.status === status).length;
}

function timestampValue(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function installShutdownHandlers({ state, saveState, recorder, runId }) {
  async function requestStop(signal) {
    if (stopRequested) {
      console.error(`${signal} received again; exiting immediately.`);
      process.exit(1);
    }

    stopRequested = true;
    console.log(`${signal} received; saving frontier state and letting active API calls finish...`);
    await saveState(state);
    await recorder.completeScraperRun({ runId, state, status: 'stopped' });
    printProgress({ state, label: 'stopping' });
  }

  process.once('SIGINT', () => {
    requestStop('SIGINT').catch((error) => {
      console.error(`Failed to save state during SIGINT: ${error.message}`);
      process.exit(1);
    });
  });

  process.once('SIGTERM', () => {
    requestStop('SIGTERM').catch((error) => {
      console.error(`Failed to save state during SIGTERM: ${error.message}`);
      process.exit(1);
    });
  });
}

function parseOptions(args) {
  const handleArgs = [];
  let qualificationWorkers = DEFAULT_QUALIFICATION_WORKERS;
  let maxAccepted = DEFAULT_MAX_ACCEPTED;
  let followingLimit = null;
  let runId = null;
  let claimNext = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--qualification-workers') {
      qualificationWorkers = parsePositiveInteger(args[index + 1], '--qualification-workers');
      index += 1;
    } else if (arg === '--max-accepted' || arg === '--accepted-limit') {
      maxAccepted = parsePositiveInteger(args[index + 1], arg);
      index += 1;
    } else if (arg === '--following-limit') {
      followingLimit = parsePositiveInteger(args[index + 1], '--following-limit');
      index += 1;
    } else if (arg === '--run-id') {
      runId = args[index + 1];
      if (!runId || runId.startsWith('--')) throw new Error('--run-id requires a run id');
      index += 1;
    } else if (arg === '--claim-next') {
      claimNext = true;
    } else if (arg === '--state') {
      throw new Error('--state is no longer supported. scraper-2 uses Postgres scraper_runs state.');
    } else {
      handleArgs.push(arg);
    }
  }

  return {
    qualificationWorkers,
    maxAccepted,
    followingLimit,
    runId,
    claimNext,
    help,
    handleArgs,
  };
}

function parsePositiveInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  npm run crawl -- --file seeds/day_in_life_creators.txt
  npm run crawl -- --file seeds/day_in_life_creators.txt --following-limit 2000 --qualification-workers 20

Options:
  --file <path>                  Seed handles file, one handle per line
  --qualification-workers <n>    Deep profile/post/OpenAI workers, default ${DEFAULT_QUALIFICATION_WORKERS}
  --following-limit <n>          Followings fetched per seed, defaults to env/config
  --max-accepted <n>             Stop after this many accepted profiles, default ${DEFAULT_MAX_ACCEPTED}
  --run-id <uuid>                Claim/resume a dashboard-created scraper_runs row
  --claim-next                   Claim the oldest requested/paused scraper_runs row
`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
