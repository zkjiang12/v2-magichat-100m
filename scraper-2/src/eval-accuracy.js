#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { getConfig } from './config.js';
import { buildAccuracyReport, buildAccuracyRow, validateAccuracyGold } from './eval-metrics.js';
import { scrapeInstagramProfile } from './instagram.js';
import { buildScrapeHardNoReview } from './qualification.js';
import { scoreCreator } from './scorer.js';

const CONCURRENCY = 15;

async function main() {
  const config = getConfig();
  const goldPath = config.campaignDefinition.goldFile;
  const outputDir = path.join('data/eval-runs/accuracy', config.campaign);

  if (process.argv.slice(2).length > 0) {
    throw new Error(`eval:accuracy does not accept arguments; edit ${goldPath}`);
  }

  const gold = await readJsonFile(path.resolve(goldPath));
  const entries = validateAccuracyGold(gold);

  if (entries.length === 0) {
    const report = buildAccuracyReport([]);
    const savedPath = await saveReport(report, outputDir);
    console.log(`Accuracy eval has no rows. Add handles to ${goldPath}.`);
    console.log(`Saved: ${savedPath}`);
    return;
  }

  const rows = await runWithConcurrency({
    items: entries,
    concurrency: CONCURRENCY,
    worker: (entry, index) => evaluateEntry({
      entry,
      index,
      total: entries.length,
      config,
    }),
  });

  const report = buildAccuracyReport(rows);
  const savedPath = await saveReport(report, outputDir);

  console.log('\n=== Accuracy Eval Summary ===');
  printSummary(report.summary);
  printScoreComparison(report.rows);
  console.log(`Saved: ${savedPath}`);
}

async function evaluateEntry({ entry, index, total, config }) {
  console.log(`[${index + 1}/${total}] Live scraping @${entry.handle}`);
  const scrapedProfile = await scrapeInstagramProfile({ handle: entry.handle, config });
  const aiReview = await scoreScrapedProfile({ scrapedProfile, config });

  return buildAccuracyRow({
    handle: entry.handle,
    humanScore: entry.humanScore,
    aiReview,
  });
}

async function scoreScrapedProfile({ scrapedProfile, config }) {
  const hardNoReview = buildScrapeHardNoReview({ scrapedProfile, config });
  return hardNoReview || scoreCreator({ scrapedProfile, config });
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

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function saveReport(report, outputDir) {
  const resolvedDir = path.resolve(outputDir);
  await fs.mkdir(resolvedDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(resolvedDir, `${timestamp}.json`);
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return outputPath;
}

function printScoreComparison(rows) {
  console.log('\n=== Scores + Explanation ===');
  for (const row of rows) {
    console.log(`${row.humanScore} ${row.aiScore} (@${row.handle})`);
    console.log(`  explanation: ${row.aiReasoning}`);
  }
}

function printSummary(summary) {
  console.log(`total: ${summary.total}`);
  console.log(`exact matches: ${summary.exactMatches}/${summary.total} (${formatPercent(summary.exactAccuracy)})`);
  console.log(`within one: ${summary.withinOne}/${summary.total} (${formatPercent(summary.withinOneAccuracy)})`);
  console.log(`average absolute diff: ${summary.averageAbsoluteDiff}`);
  console.log(`major mismatches: ${summary.majorMismatches}`);
}

function formatPercent(ratio) {
  return `${Number((ratio * 100).toFixed(2))}%`;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
