#!/usr/bin/env node

import { getConfig } from './config.js';
import { normalizeHandle, scrapeInstagramProfile } from './instagram.js';
import { parseHandles } from './handles.js';
import { buildScrapeHardNoReview } from './qualification.js';
import { scoreCreator } from './scorer.js';
import { saveEvaluationRecord } from './storage.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  console.log('Starting MagicHat Instagram batch evaluator...');

  const handles = await parseHandles(args);
  if (handles.length === 0) {
    throw new Error('Usage: npm run review -- @handle1 @handle2 OR npm run review -- --file handles.txt');
  }

  const config = getConfig();
  const results = [];

  for (const [index, rawHandle] of handles.entries()) {
    const handle = normalizeHandle(rawHandle);
    console.log(`\n[${index + 1}/${handles.length}] Scraping @${handle}`);
    const scrapedProfile = await scrapeInstagramProfile({ handle, config });

    const hardNoReview = buildScrapeHardNoReview({ scrapedProfile, config });
    const aiReview = hardNoReview
      ? logHardNoReview({ hardNoReview, handle, index, total: handles.length })
      : await scoreCreatorWithLog({
          scrapedProfile,
          config,
          handle,
          index,
          total: handles.length,
        });

    const record = {
      createdAt: new Date().toISOString(),
      handle,
      scrapedProfile,
      aiReview,
    };

    const saved = await saveEvaluationRecord(record);
    results.push({ handle, aiReview, scrapedProfile, saved });

    console.log(`@${handle}: ${aiReview.fitScore}/4 [${aiReview.list}]`);
    console.log(aiReview.reasoning);
    console.log(`Saved: ${saved.reviewPath}`);
  }

  console.log('\n=== Batch Results ===');
  for (const result of results) {
    console.log(
      `@${result.handle}: ${result.aiReview.fitScore}/4 [${result.aiReview.list}] - ${result.aiReview.reasoning}`,
    );
  }
  console.log('\nAppend-only log: data/evaluations.jsonl');
}

function logHardNoReview({ hardNoReview, handle, index, total }) {
  console.log(`[${index + 1}/${total}] Hard no @${handle}; skipped OpenAI`);
  return hardNoReview;
}

async function scoreCreatorWithLog({ scrapedProfile, config, handle, index, total }) {
  console.log(`[${index + 1}/${total}] Scoring @${handle}`);
  return scoreCreator({ scrapedProfile, config });
}

function printHelp() {
  console.log(`Usage:
  npm run review -- @handle1 @handle2
  npm run review -- --file handles.txt

Options:
  --file <path>    Handles file, one handle per line
`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
