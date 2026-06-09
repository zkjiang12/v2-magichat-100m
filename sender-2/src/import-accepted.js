#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

import { getConfig } from './config.js';
import { createPool } from './db.js';
import { upsertAcceptedCreator } from './queue.js';

async function main() {
  const config = getConfig();
  const statePath = path.resolve(config.scraperStatePath);
  const accepted = await readAcceptedRecords(statePath);
  const pool = createPool({ databaseUrl: config.databaseUrl });

  let imported = 0;
  try {
    for (const record of accepted) {
      await upsertAcceptedCreator(pool, {
        record,
        campaign: config.campaign,
        enqueueStatus: config.importEnqueueStatus,
      });
      imported += 1;
    }
  } finally {
    await pool.end();
  }

  console.log(
    `Imported ${imported}/${accepted.length} accepted creators into campaign ${config.campaign}.`,
  );
}

export async function readAcceptedRecords(statePath) {
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  return Object.values(state.seen || {})
    .filter((record) => record.status === 'accepted')
    .filter((record) => record.handle && Number(record.fitScore) >= 3)
    .sort((a, b) => timestampValue(a.scoredAt) - timestampValue(b.scoredAt));
}

function timestampValue(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
