import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAccuracyReport,
  buildAccuracyRow,
  buildSpeedCostReport,
  validateAccuracyGold,
} from '../src/eval-metrics.js';
import { normalizeHandle } from '../src/instagram.js';
import {
  HttpError,
  isRetryableStatus,
  retryDelayMs,
  withRetry,
} from '../src/retry.js';
import { estimateOpenAiCost } from '../src/scorer.js';

test('normalizes handles', () => {
  assert.equal(normalizeHandle('@Creator.One'), 'Creator.One');
  assert.equal(normalizeHandle('https://www.instagram.com/yestheory/?hl=en'), 'yestheory');
});

test('validates accuracy gold rows', () => {
  assert.deepEqual(
    validateAccuracyGold([
      { handle: '@creator1', humanScore: 4 },
      { handle: 'https://www.instagram.com/creator2/', humanScore: '1' },
    ]),
    [
      { handle: 'creator1', humanScore: 4 },
      { handle: 'creator2', humanScore: 1 },
    ],
  );

  assert.throws(
    () => validateAccuracyGold([{ handle: '@creator1', humanScore: 5 }]),
    /invalid humanScore/,
  );
  assert.throws(
    () => validateAccuracyGold([
      { handle: '@creator1', humanScore: 4 },
      { handle: 'creator1', humanScore: 3 },
    ]),
    /Duplicate handle/,
  );
});

test('builds accuracy comparison metrics', () => {
  const rows = [
    buildAccuracyRow({
      handle: 'exact',
      humanScore: 4,
      aiReview: { fitScore: 4, reasoning: 'same' },
    }),
    buildAccuracyRow({
      handle: 'offbyone',
      humanScore: 4,
      aiReview: { fitScore: 3, reasoning: 'close' },
    }),
    buildAccuracyRow({
      handle: 'major',
      humanScore: 3,
      aiReview: { fitScore: 1, reasoning: 'far' },
    }),
  ];

  const report = buildAccuracyReport(rows);
  assert.deepEqual(report.summary, {
    total: 3,
    exactMatches: 1,
    exactAccuracy: 0.3333,
    withinOne: 2,
    withinOneAccuracy: 0.6667,
    averageAbsoluteDiff: 1,
    majorMismatches: 1,
  });
  assert.equal(report.mismatches[0].handle, 'major');
});

test('estimates OpenAI token cost with cached input', () => {
  assert.equal(
    estimateOpenAiCost({
      usage: {
        inputTokens: 1_000_000,
        cachedInputTokens: 100_000,
        outputTokens: 500_000,
      },
    }),
    1.17,
  );
});

test('builds minimal speed-cost report', () => {
  const report = buildSpeedCostReport({
    seed: 'yestheory',
    profilesProcessed: 500,
    qualifiedProfiles: 25,
    failedProfiles: 2,
    acceptedSamples: [
      {
        username: 'accepted1',
        score: 4,
        reasoning: 'great fit',
      },
    ],
    rejectedSamples: [
      {
        username: 'rejected1',
        score: 1,
        reasoning: 'bad fit',
      },
    ],
    totalTimeMs: 11.82 * 60_000,
    apifySummary: {
      totalUsageUsd: 10.91,
      byPurpose: {
        following: { usageTotalUsd: 1.3 },
        profile: { usageTotalUsd: 0.96 },
        posts: { usageTotalUsd: 8.65 },
      },
    },
    openaiSummary: {
      totalUsd: 1.57,
      inputTokens: 123456,
      cachedInputTokens: 0,
      outputTokens: 23456,
    },
  });

  assert.deepEqual(report, {
    seed: 'yestheory',
    profilesProcessed: 500,
    qualifiedProfiles: 25,
    failedProfiles: 2,
    qualificationPercent: 5,
    acceptedSamples: [
      {
        username: 'accepted1',
        score: 4,
        reasoning: 'great fit',
      },
    ],
    rejectedSamples: [
      {
        username: 'rejected1',
        score: 1,
        reasoning: 'bad fit',
      },
    ],
    throughputPerMinute: 42.3,
    totalTimeMinutes: 11.82,
    totalCostUsd: 12.48,
    costPer100ProfilesUsd: 2.496,
    costBreakdown: {
      apify: {
        totalUsd: 10.91,
        followingUsd: 1.3,
        profileUsd: 0.96,
        postsUsd: 8.65,
      },
      openai: {
        totalUsd: 1.57,
        inputTokens: 123456,
        cachedInputTokens: 0,
        outputTokens: 23456,
      },
    },
  });
});

test('classifies retryable HTTP statuses', () => {
  assert.equal(isRetryableStatus(408), true);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(504), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(404), false);
});

test('retries transient errors with exponential backoff', async () => {
  const delays = [];
  let calls = 0;

  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) {
        throw new HttpError({
          label: 'test request',
          status: 429,
          body: { error: 'rate limited' },
        });
      }
      return 'ok';
    },
    {
      retries: 2,
      baseDelayMs: 10,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      onRetry: null,
    },
  );

  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(retryDelayMs({ attempt: 3, baseDelayMs: 10, maxDelayMs: 25 }), 25);
});

test('does not retry non-transient HTTP errors', async () => {
  let calls = 0;

  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw new HttpError({
            label: 'test request',
            status: 401,
            body: { error: 'bad token' },
          });
        },
        {
          retries: 2,
          sleep: async () => {},
          onRetry: null,
        },
      ),
    /test request failed: 401/,
  );

  assert.equal(calls, 1);
});
