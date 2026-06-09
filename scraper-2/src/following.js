import {
  fetchApifyDatasetItems,
  normalizeHandle,
  runApifyActor,
} from './instagram.js';

export async function scrapeFollowingCandidates({ handle, config }) {
  const normalizedHandle = normalizeHandle(handle);
  const run = await runApifyActor({
    actorId: config.apifyInstagramFollowingActorId,
    token: config.apifyToken,
    waitForFinishSecs: 900,
    maxTotalChargeUsd: config.apifyMaxRunUsd,
    runPurpose: 'following',
    runCostTracker: config.apifyRunCostTracker,
    input: buildFollowingInput({
      handle: normalizedHandle,
      mode: config.instagramFollowingMode,
      limit: config.instagramFollowingLimit,
    }),
  });

  const items = await fetchApifyDatasetItems({
    datasetId: run.defaultDatasetId,
    token: config.apifyToken,
    limit: config.instagramFollowingLimit + 10,
  });

  const candidates = items
    .map((item) => normalizeFollowingItem(item))
    .filter((candidate) => candidate.handle);

  return {
    candidates,
    rawCount: items.length,
    requestedLimit: config.instagramFollowingLimit,
    observedTypes: [...new Set(items.map((item) => item.type).filter(Boolean))],
  };
}

function buildFollowingInput({ handle, mode, limit }) {
  const dataToScrape = mode.toLowerCase() === 'following' ? 'Followings' : 'Followers';

  return {
    Account: [handle],
    dataToScrape,
    resultsLimit: limit,
  };
}

function normalizeFollowingItem(item) {
  const handle = normalizeCandidateHandle(
    item.username ||
      item.userName ||
      item.handle ||
      item.ownerUsername ||
      item.profileUsername ||
      item.instagramUsername ||
      item.profileName,
  );

  return {
    handle,
    name: item.fullName || item.full_name || item.name || item.displayName || null,
    followersCount: numberOrNull(
      item.followersCount ||
        item.followerCount ||
        item.followers ||
        item.edge_followed_by?.count,
    ),
    followingCount: numberOrNull(
      item.followingCount ||
        item.followsCount ||
        item.following ||
        item.edge_follow?.count,
    ),
    isPrivate: booleanOrNull(
      item.isPrivate ?? item.private ?? item.is_private ?? item.profileIsPrivate,
    ),
    isVerified: booleanOrNull(item.isVerified ?? item.verified ?? item.is_verified),
    profileUrl:
      item.profileUrl ||
      item.url ||
      item.inputUrl ||
      (handle ? `https://www.instagram.com/${handle}/` : null),
    raw: item,
  };
}

function normalizeCandidateHandle(value) {
  if (!value || typeof value !== 'string') return null;
  const normalized = normalizeHandle(value);
  return normalized || null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}
