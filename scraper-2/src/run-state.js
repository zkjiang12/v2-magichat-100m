// Pure helpers for scraper run state now that the campaign-wide seen-set lives
// in the campaign_seen table instead of scraper_runs.state.

// The seen map stays in memory for fast dedup, but it is campaign-wide and can
// be rebuilt from campaign_seen, so it is stripped before persisting the blob.
export function serializeRunStateForStorage(state) {
  if (!state || typeof state !== 'object') return JSON.stringify(state);
  const { seen, ...rest } = state;
  return JSON.stringify(rest);
}

// Build the in-memory seen map from campaign_seen rows plus any legacy seen map
// still stored in the run's state blob. Table status wins: every status change
// is written to campaign_seen before the blob save, so the table is always at
// least as fresh as the blob.
export function mergeCampaignSeen({ blobSeen = {}, tableRows = [], runId }) {
  const seen = {};

  for (const [handle, record] of Object.entries(blobSeen)) {
    seen[handle] = { ...record };
  }

  for (const row of tableRows) {
    const existing = seen[row.handle] || { handle: row.handle };
    seen[row.handle] = {
      ...existing,
      handle: row.handle,
      status: row.status,
      sourceSeed: existing.sourceSeed ?? row.source_seed ?? null,
      runId: row.run_id || null,
      fromOtherRun: Boolean(row.run_id && runId && row.run_id !== runId),
    };
  }

  return seen;
}

// Statuses a claiming run requeues for its own handles: 'queued' covers the
// crash window between the table insert and the state blob save; 'cap_skipped'
// covers accept-worthy candidates that lost the accepted-cap race, so extending
// a run recovers them instead of losing them.
const OWN_REQUEUE_STATUSES = new Set(['queued', 'cap_skipped']);

// Handles this run owns that should be in the qualification queue but are not.
// Other runs' queued handles stay with their owning run.
export function collectMissingQueuedHandles({ seen = {}, qualificationQueue = [], runId }) {
  const queued = new Set(qualificationQueue);
  const missing = [];
  for (const [handle, record] of Object.entries(seen)) {
    if (record.fromOtherRun) continue;
    if (!OWN_REQUEUE_STATUSES.has(record.status)) continue;
    if (queued.has(handle)) continue;
    missing.push(handle);
  }
  return missing;
}

// Records discovered/processed by this run, excluding hydrated rows that belong
// to other runs of the same campaign. Keeps run counters meaning "this run".
export function ownSeenRecords(seen = {}) {
  return Object.values(seen).filter((record) => !record.fromOtherRun);
}
