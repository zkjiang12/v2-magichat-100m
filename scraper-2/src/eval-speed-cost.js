#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { createApifyCostTracker } from './apify-cost-tracker.js';
import { getConfig } from './config.js';
import { buildSpeedCostReport } from './eval-metrics.js';
import { scrapeFollowingCandidates } from './following.js';
import { normalizeHandle, scrapeInstagramProfile } from './instagram.js';
import {
  annotateFollowingCandidateForPrefilter,
  buildScrapeHardNoReview,
  isKnownOutsideFollowerRange,
} from './qualification.js';
import { scoreCreatorDetailed } from './scorer.js';

const LIMIT = 250;
const FOLLOWING_LIMIT = 2000;
const CONCURRENCY = 64;
const APIFY_COST_SETTLE_MS = 10000;

async function main() {
  if (process.argv.slice(2).length > 0) {
    throw new Error('eval:speed-cost does not accept arguments');
  }

  const config = getConfig();
  if (!config.campaignDefinition.speedCostSeed) {
    throw new Error(
      `Campaign ${config.campaign} has no speedCostSeed configured; set one in its campaign definition to run eval:speed-cost.`,
    );
  }
  const seed = normalizeHandle(config.campaignDefinition.speedCostSeed);
  config.instagramFollowingLimit = FOLLOWING_LIMIT;

  const costTracker = createApifyCostTracker({ settleMs: APIFY_COST_SETTLE_MS });
  config.apifyRunCostTracker = costTracker;

  console.log(
    [
      `Speed-cost eval seed=@${seed}`,
      `limit=${LIMIT}`,
      `followingLimit=${FOLLOWING_LIMIT}`,
      `concurrency=${CONCURRENCY}`,
    ].join(' '),
  );

  const startedAt = Date.now();
  const discovery = await scrapeFollowingCandidates({ handle: seed, config });
  const filterResult = filterCandidates({
    candidates: discovery.candidates,
    config,
    limit: LIMIT,
  });

  console.log(
    [
      `Discovered raw=${discovery.rawCount}`,
      `normalized=${discovery.candidates.length}`,
      `queuedForProcessing=${filterResult.queued.length}`,
    ].join(' '),
  );

  const processed = await runWithConcurrency({
    items: filterResult.queued,
    concurrency: CONCURRENCY,
    worker: (candidate, index) =>
      processCandidate({
        candidate,
        index,
        total: filterResult.queued.length,
        config,
      }),
  });

  await costTracker.settle();

  const totalTimeMs = Date.now() - startedAt;
  const report = buildSpeedCostReport({
    seed,
    profilesProcessed: filterResult.queued.length,
    qualifiedProfiles: processed.filter((result) => result.qualified).length,
    failedProfiles: processed.filter((result) => result.failed).length,
    acceptedSamples: sampleReviews({
      processed,
      predicate: (result) => !result.failed && result.qualified,
    }),
    rejectedSamples: sampleReviews({
      processed,
      predicate: (result) => !result.failed && !result.qualified,
    }),
    totalTimeMs,
    apifySummary: costTracker.summary(),
    openaiSummary: openaiUsageSummary,
  });

  const savedPath = await saveReport({ seed, report, campaign: config.campaign });

  console.log('\n=== Speed-Cost Eval ===');
  console.log(JSON.stringify(report, null, 2));
  console.log(`Saved: ${savedPath}`);
}

const openaiUsageSummary = {
  totalUsd: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
};

async function processCandidate({ candidate, index, total, config }) {
  try {
    console.log(`[${index + 1}/${total}] Scraping @${candidate.handle}`);
    const scrapedProfile = await scrapeInstagramProfile({ handle: candidate.handle, config });
    const hardNoReview = buildScrapeHardNoReview({ scrapedProfile, config });

    if (hardNoReview) {
      console.log(`[${index + 1}/${total}] Hard no @${candidate.handle}`);
      return buildProcessedResult({
        handle: candidate.handle,
        review: hardNoReview,
        config,
      });
    }

    console.log(`[${index + 1}/${total}] Scoring @${candidate.handle}`);
    const scored = await scoreCreatorDetailed({ scrapedProfile, config });
    addOpenAiUsage(scored);
    console.log(`[${index + 1}/${total}] @${candidate.handle}: ${scored.review.fitScore}/4`);
    return buildProcessedResult({
      handle: candidate.handle,
      review: scored.review,
      config,
    });
  } catch (error) {
    console.error(`[${index + 1}/${total}] Failed @${candidate.handle}: ${error.message}`);
    return {
      handle: candidate.handle,
      fitScore: 1,
      list: 'failed',
      reasoning: `Failed during speed-cost eval: ${error.message}`,
      qualified: false,
      failed: true,
    };
  }
}

function buildProcessedResult({ handle, review, config }) {
  return {
    handle,
    fitScore: review.fitScore,
    list: review.list,
    reasoning: review.reasoning,
    qualified: config.campaignDefinition.accept(review),
    failed: false,
  };
}

function sampleReviews({ processed, predicate, limit = 10 }) {
  return processed
    .filter(predicate)
    .slice(0, limit)
    .map((result) => ({
      username: result.handle,
      score: result.fitScore,
      reasoning: result.reasoning,
    }));
}

function addOpenAiUsage(scored) {
  openaiUsageSummary.totalUsd += scored.estimatedCostUsd || 0;
  openaiUsageSummary.inputTokens += scored.usage?.inputTokens || 0;
  openaiUsageSummary.cachedInputTokens += scored.usage?.cachedInputTokens || 0;
  openaiUsageSummary.outputTokens += scored.usage?.outputTokens || 0;
}

function filterCandidates({ candidates, config, limit }) {
  const seen = new Set();
  const queued = [];

  for (const candidate of candidates) {
    const handle = normalizeHandle(candidate.handle || '');
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);

    const prefilteredCandidate = annotateFollowingCandidateForPrefilter({
      candidate: { ...candidate, handle },
      config,
    });

    if (prefilteredCandidate.isPrivate === true) continue;
    if (config.instagramRequireVerified && prefilteredCandidate.isVerified !== true) continue;
    if (isKnownOutsideFollowerRange({ candidate: prefilteredCandidate, config })) continue;
    if (prefilteredCandidate.hardNo === true) continue;

    queued.push(prefilteredCandidate);
    if (queued.length >= limit) break;
  }

  return { queued };
}

async function runWithConcurrency({ items, concurrency, worker }) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  async function runNext() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runNext()));
  return results;
}

async function saveReport({ seed, report, campaign }) {
  const outputDir = path.resolve('data/eval-runs/speed-cost', campaign);
  await fs.mkdir(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(outputDir, `${seed}-${timestamp}.json`);
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return outputPath;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
