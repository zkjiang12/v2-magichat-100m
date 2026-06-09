import { normalizeHandle } from './instagram.js';

export function validateAccuracyGold(rawEntries) {
  if (!Array.isArray(rawEntries)) {
    throw new Error('Accuracy gold file must be a JSON array');
  }

  const seen = new Set();
  return rawEntries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Gold row ${index + 1} must be an object`);
    }

    const handle = normalizeHandle(String(entry.handle || ''));
    if (!handle) {
      throw new Error(`Gold row ${index + 1} is missing handle`);
    }
    if (seen.has(handle)) {
      throw new Error(`Duplicate handle in gold file: ${handle}`);
    }
    seen.add(handle);

    const humanScore = Number(entry.humanScore);
    if (!Number.isInteger(humanScore) || humanScore < 1 || humanScore > 4) {
      throw new Error(`Gold row ${index + 1} has invalid humanScore; expected integer 1-4`);
    }

    return { handle, humanScore };
  });
}

export function buildAccuracyReport(rows) {
  const total = rows.length;
  const exactMatches = rows.filter((row) => row.match).length;
  const withinOne = rows.filter((row) => Math.abs(row.diff) <= 1).length;
  const absoluteDiffTotal = rows.reduce((sum, row) => sum + Math.abs(row.diff), 0);
  const majorMismatches = rows.filter((row) => Math.abs(row.diff) >= 2).length;

  return {
    summary: {
      total,
      exactMatches,
      exactAccuracy: total === 0 ? 0 : roundRatio(exactMatches / total),
      withinOne,
      withinOneAccuracy: total === 0 ? 0 : roundRatio(withinOne / total),
      averageAbsoluteDiff: total === 0 ? 0 : roundRatio(absoluteDiffTotal / total),
      majorMismatches,
    },
    rows,
    mismatches: rows
      .filter((row) => !row.match)
      .slice()
      .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.handle.localeCompare(b.handle)),
  };
}

export function buildAccuracyRow({ handle, humanScore, aiReview }) {
  const aiScore = Number(aiReview.fitScore);
  const diff = aiScore - humanScore;
  return {
    handle,
    humanScore,
    aiScore,
    diff,
    match: diff === 0,
    aiReasoning: aiReview.reasoning || '',
  };
}

export function buildSpeedCostReport({
  seed,
  profilesProcessed,
  qualifiedProfiles = 0,
  failedProfiles = 0,
  acceptedSamples = [],
  rejectedSamples = [],
  totalTimeMs,
  apifySummary,
  openaiSummary,
}) {
  const rawTotalTimeMinutes = totalTimeMs / 60000;
  const totalTimeMinutes = roundMetric(rawTotalTimeMinutes);
  const throughputPerMinute =
    rawTotalTimeMinutes === 0 ? 0 : roundMetric(profilesProcessed / rawTotalTimeMinutes);
  const apify = buildApifyBreakdown(apifySummary);
  const openai = {
    totalUsd: roundUsd(openaiSummary.totalUsd || 0),
    inputTokens: openaiSummary.inputTokens || 0,
    cachedInputTokens: openaiSummary.cachedInputTokens || 0,
    outputTokens: openaiSummary.outputTokens || 0,
  };

  return {
    seed,
    profilesProcessed,
    qualifiedProfiles,
    failedProfiles,
    qualificationPercent: profilesProcessed === 0
      ? 0
      : roundMetric((qualifiedProfiles / profilesProcessed) * 100),
    acceptedSamples: acceptedSamples.slice(0, 10),
    rejectedSamples: rejectedSamples.slice(0, 10),
    throughputPerMinute,
    totalTimeMinutes,
    totalCostUsd: roundUsd(apify.totalUsd + openai.totalUsd),
    costPer100ProfilesUsd: profilesProcessed === 0
      ? 0
      : roundUsd(((apify.totalUsd + openai.totalUsd) / profilesProcessed) * 100),
    costBreakdown: {
      apify,
      openai,
    },
  };
}

function buildApifyBreakdown(apifySummary) {
  const byPurpose = apifySummary?.byPurpose || {};
  return {
    totalUsd: roundUsd(apifySummary?.totalUsageUsd || 0),
    followingUsd: roundUsd(byPurpose.following?.usageTotalUsd || 0),
    profileUsd: roundUsd(byPurpose.profile?.usageTotalUsd || 0),
    postsUsd: roundUsd(byPurpose.posts?.usageTotalUsd || 0),
  };
}

function roundRatio(value) {
  return Number(value.toFixed(4));
}

function roundMetric(value) {
  return Number(value.toFixed(2));
}

function roundUsd(value) {
  return Number(value.toFixed(6));
}
