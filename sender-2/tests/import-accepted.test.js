import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readAcceptedRecords } from '../src/import-accepted.js';

test('reads accepted creator records from scraper state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sender-import-'));
  const statePath = path.join(dir, 'state.json');

  await fs.writeFile(
    statePath,
    JSON.stringify({
      seen: {
        accepted2: {
          handle: 'accepted2',
          status: 'accepted',
          fitScore: 4,
          scoredAt: '2026-06-07T02:00:00.000Z',
        },
        rejected: {
          handle: 'rejected',
          status: 'rejected',
          fitScore: 2,
          scoredAt: '2026-06-07T01:00:00.000Z',
        },
        accepted1: {
          handle: 'accepted1',
          status: 'accepted',
          fitScore: 3,
          scoredAt: '2026-06-07T01:00:00.000Z',
        },
      },
    }),
  );

  const records = await readAcceptedRecords(statePath);
  assert.deepEqual(
    records.map((record) => record.handle),
    ['accepted1', 'accepted2'],
  );
});
