import { fetchApifyRun } from './instagram.js';

export function createApifyCostTracker({ settleMs = 10000, onRecordedRun = null } = {}) {
  const runs = [];

  return {
    runs,
    async recordRun({ actorId, purpose, input, run, token }) {
      const entry = {
        purpose,
        actorId,
        runId: run.id,
        status: run.status,
        input: summarizeInput(input),
        startedAt: run.startedAt || null,
        finishedAt: run.finishedAt || null,
        defaultDatasetId: run.defaultDatasetId || null,
        usageTotalUsd: numberOrZero(run.usageTotalUsd),
        usageUsd: run.usageUsd || {},
        chargedEventCounts: run.chargedEventCounts || {},
      };
      Object.defineProperty(entry, '_token', {
        value: token,
        enumerable: false,
      });
      runs.push(entry);
      if (onRecordedRun) await onRecordedRun(entry);
    },
    async settle() {
      if (settleMs > 0 && runs.length > 0) await sleep(settleMs);

      await Promise.all(
        runs.map(async (entry) => {
          try {
            const run = await fetchApifyRun({ runId: entry.runId, token: entry._token });
            entry.status = run.status || entry.status;
            entry.startedAt = run.startedAt || entry.startedAt;
            entry.finishedAt = run.finishedAt || entry.finishedAt;
            entry.defaultDatasetId = run.defaultDatasetId || entry.defaultDatasetId;
            entry.usageTotalUsd = numberOrZero(run.usageTotalUsd ?? entry.usageTotalUsd);
            entry.usageUsd = run.usageUsd || entry.usageUsd || {};
            entry.chargedEventCounts = run.chargedEventCounts || entry.chargedEventCounts || {};
          } catch (error) {
            entry.settleError = error.message;
            console.warn(`[cost] Could not refresh Apify run ${entry.runId}: ${error.message}`);
          }
        }),
      );
    },
    summary() {
      const byPurpose = {};
      for (const run of runs) {
        if (!byPurpose[run.purpose]) {
          byPurpose[run.purpose] = {
            runs: 0,
            usageTotalUsd: 0,
            chargedEventCounts: {},
          };
        }

        byPurpose[run.purpose].runs += 1;
        byPurpose[run.purpose].usageTotalUsd += run.usageTotalUsd;
        for (const [eventName, count] of Object.entries(run.chargedEventCounts)) {
          byPurpose[run.purpose].chargedEventCounts[eventName] =
            (byPurpose[run.purpose].chargedEventCounts[eventName] || 0) + count;
        }
      }

      return {
        totalRuns: runs.length,
        totalUsageUsd: roundUsd(runs.reduce((sum, run) => sum + run.usageTotalUsd, 0)),
        byPurpose: Object.fromEntries(
          Object.entries(byPurpose).map(([purpose, value]) => [
            purpose,
            {
              ...value,
              usageTotalUsd: roundUsd(value.usageTotalUsd),
            },
          ]),
        ),
      };
    },
  };
}

function summarizeInput(input) {
  return {
    usernames: input.usernames?.length ?? null,
    accountCount: input.Account?.length ?? null,
    directUrls: input.directUrls?.length ?? null,
    dataToScrape: input.dataToScrape ?? null,
    resultsType: input.resultsType ?? null,
    resultsLimit: input.resultsLimit ?? null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function roundUsd(value) {
  return Number(value.toFixed(6));
}
