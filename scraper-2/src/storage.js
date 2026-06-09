import fs from 'node:fs/promises';
import path from 'node:path';

export async function saveEvaluationRecord(record) {
  const reviewsDir = path.resolve('data/evaluations');
  await fs.mkdir(reviewsDir, { recursive: true });

  const timestamp = record.createdAt.replace(/[:.]/g, '-');
  const reviewPath = path.join(reviewsDir, `${record.handle}-${timestamp}.json`);
  await fs.writeFile(reviewPath, `${JSON.stringify(record, null, 2)}\n`);

  const jsonlPath = path.resolve('data/evaluations.jsonl');
  await fs.mkdir(path.dirname(jsonlPath), { recursive: true });
  await fs.appendFile(jsonlPath, `${JSON.stringify(summarizeForJsonl(record))}\n`);

  return { reviewPath, jsonlPath };
}

function summarizeForJsonl(record) {
  return {
    createdAt: record.createdAt,
    handle: record.handle,
    profileUrl: record.scrapedProfile.profileUrl,
    aiFitScore: record.aiReview.fitScore,
    list: record.aiReview.list,
    aiReasoning: record.aiReview.reasoning,
    creator: record.scrapedProfile.creator,
  };
}
