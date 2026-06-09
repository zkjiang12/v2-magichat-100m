import fs from 'node:fs/promises';

import { normalizeHandle } from './instagram.js';

export async function parseHandles(args) {
  const fileIndex = args.findIndex((arg) => arg === '--file' || arg === '-f');
  const handles = [];

  if (fileIndex !== -1) {
    const filePath = args[fileIndex + 1];
    if (!filePath) throw new Error('Missing file path after --file');
    const raw = await fs.readFile(filePath, 'utf8');
    handles.push(...raw.split(/[\s,]+/).filter(Boolean));
  }

  handles.push(
    ...args
      .filter((arg, index) => fileIndex === -1 || (index !== fileIndex && index !== fileIndex + 1))
      .flatMap((arg) => arg.split(','))
      .filter(Boolean),
  );

  return [...new Set(handles.map(normalizeHandle).filter(Boolean))];
}

export function splitIntoBatches(items, batchCount) {
  const batches = Array.from({ length: batchCount }, () => []);
  items.forEach((item, index) => {
    batches[index % batchCount].push(item);
  });
  return batches.filter((batch) => batch.length > 0);
}
