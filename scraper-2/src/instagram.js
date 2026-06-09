import {
  buildContentHardNoReview,
  buildProfileHardNoReview,
} from './qualification.js';
import { fetchJsonWithRetry } from './retry.js';

export function normalizeHandle(input) {
  return input
    .trim()
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/^@/, '')
    .split(/[/?#]/)[0]
    .trim();
}

export function profileUrlFor(handle) {
  return `https://www.instagram.com/${normalizeHandle(handle)}/`;
}

export async function scrapeInstagramProfile({ handle, config }) {
  const normalizedHandle = normalizeHandle(handle);
  const profileRun = await runApifyActor({
    actorId: config.apifyInstagramProfileActorId,
    token: config.apifyToken,
    maxTotalChargeUsd: config.apifyMaxRunUsd,
    runPurpose: 'profile',
    runCostTracker: config.apifyRunCostTracker,
    input: {
      usernames: [normalizedHandle],
      resultsLimit: 1,
    },
  });

  const profileItems = await fetchApifyDatasetItems({
    datasetId: profileRun.defaultDatasetId,
    token: config.apifyToken,
    limit: 5,
  });

  const profileOnly = normalizeInstagramItems({
    handle: normalizedHandle,
    profileSource: {
      actorId: config.apifyInstagramProfileActorId,
      actorRunId: profileRun.id,
      datasetId: profileRun.defaultDatasetId,
      rawItemCount: profileItems.length,
    },
    postsSource: null,
    profileItems,
    postItems: [],
  });

  const profileHardNoReview = config.instagramProfilePrefilter
    ? buildProfileHardNoReview({ scrapedProfile: profileOnly, config })
    : null;
  if (profileHardNoReview) {
    return {
      ...normalizeInstagramItems({
        handle: normalizedHandle,
        profileSource: profileOnly.sources.profile,
        postsSource: null,
        profileItems,
        postItems: [],
        skipped: {
          posts: 'profile prefilter rejected this account before recent posts were scraped',
        },
      }),
      prefilterReview: profileHardNoReview,
    };
  }

  const postsInput = {
    directUrls: [profileUrlFor(normalizedHandle)],
    resultsType: 'posts',
    resultsLimit: config.instagramResultsLimit,
  };

  const postsRun = await runApifyActor({
    actorId: config.apifyInstagramPostsActorId,
    token: config.apifyToken,
    maxTotalChargeUsd: config.apifyMaxRunUsd,
    runPurpose: 'posts',
    runCostTracker: config.apifyRunCostTracker,
    input: postsInput,
  });

  const postItems = await fetchApifyDatasetItems({
    datasetId: postsRun.defaultDatasetId,
    token: config.apifyToken,
    limit: config.instagramResultsLimit + 5,
  });

  const postsOnly = normalizeInstagramItems({
    handle: normalizedHandle,
    profileSource: {
      actorId: config.apifyInstagramProfileActorId,
      actorRunId: profileRun.id,
      datasetId: profileRun.defaultDatasetId,
      rawItemCount: profileItems.length,
    },
    postsSource: {
      actorId: config.apifyInstagramPostsActorId,
      actorRunId: postsRun.id,
      datasetId: postsRun.defaultDatasetId,
      rawItemCount: postItems.length,
    },
    profileItems,
    postItems,
  });

  const contentHardNoReview = config.instagramContentPrefilter
    ? buildContentHardNoReview({ scrapedProfile: postsOnly, config })
    : null;
  if (contentHardNoReview) {
    return {
      ...normalizeInstagramItems({
        handle: normalizedHandle,
        profileSource: postsOnly.sources.profile,
        postsSource: postsOnly.sources.posts,
        profileItems,
        postItems,
      }),
      prefilterReview: contentHardNoReview,
    };
  }

  return postsOnly;
}

export async function runApifyActor({
  actorId,
  token,
  input,
  waitForFinishSecs = 180,
  maxTotalChargeUsd = null,
  runPurpose = null,
  runCostTracker = null,
}) {
  const actorPath = actorId.replace('/', '~');
  const url = new URL(`https://api.apify.com/v2/acts/${actorPath}/runs`);
  url.searchParams.set('token', token);
  url.searchParams.set('waitForFinish', String(waitForFinishSecs));
  if (maxTotalChargeUsd !== null && maxTotalChargeUsd !== undefined) {
    url.searchParams.set('maxTotalChargeUsd', String(maxTotalChargeUsd));
  }

  const { body } = await fetchJsonWithRetry({
    url,
    label: `Apify ${runPurpose || actorId} run`,
    options: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  });

  if (!body.data?.defaultDatasetId) {
    throw new Error(`Apify actor did not return a dataset id: ${JSON.stringify(body)}`);
  }
  if (body.data.status && !['SUCCEEDED', 'READY', 'RUNNING'].includes(body.data.status)) {
    throw new Error(`Apify actor finished with status ${body.data.status}`);
  }

  if (body.data.status === 'RUNNING') {
    throw new Error(
      `Apify actor is still running after ${waitForFinishSecs} seconds. Try again or lower the relevant result limit.`,
    );
  }

  if (runCostTracker) {
    await runCostTracker.recordRun({
      actorId,
      purpose: runPurpose || actorId,
      input,
      run: body.data,
      token,
    });
  }

  return body.data;
}

export async function fetchApifyRun({ runId, token }) {
  const url = new URL(`https://api.apify.com/v2/actor-runs/${runId}`);
  url.searchParams.set('token', token);

  const { body } = await fetchJsonWithRetry({
    url,
    label: 'Apify run fetch',
  });
  return body.data;
}

export async function fetchApifyDatasetItems({ datasetId, token, limit }) {
  const url = new URL(`https://api.apify.com/v2/datasets/${datasetId}/items`);
  url.searchParams.set('token', token);
  url.searchParams.set('clean', 'true');
  url.searchParams.set('limit', String(limit));

  const { body } = await fetchJsonWithRetry({
    url,
    label: 'Apify dataset fetch',
  });
  return Array.isArray(body) ? body : [];
}

function normalizeInstagramItems({
  handle,
  profileSource,
  postsSource,
  profileItems,
  postItems,
  skipped = {},
}) {
  const profileCandidate =
    profileItems.find((item) => item.username || item.userName || item.ownerUsername) || {};

  const posts = postItems
    .filter((item) => item.url || item.shortCode || item.caption)
    .map((item) => ({
      url: item.url || item.inputUrl || null,
      caption: item.caption || item.description || '',
      timestamp: item.timestamp || item.takenAt || item.takenAtIso || null,
      likesCount: numberOrNull(item.likesCount),
      commentsCount: numberOrNull(item.commentsCount),
      videoViewCount: numberOrNull(item.videoViewCount || item.videoPlayCount),
      accessibilityCaption:
        item.accessibilityCaption ||
        item.accessibility_caption ||
        item.accessibility ||
        item.alt ||
        item.altText ||
        null,
    }))
    .sort((a, b) => timestampValue(b.timestamp) - timestampValue(a.timestamp))
    .map((post) => ({
      caption: post.caption,
      timestamp: post.timestamp,
      views: post.videoViewCount,
      likes: post.likesCount,
      comments: post.commentsCount,
      accessibilityCaption: post.accessibilityCaption,
    }));

  const profile = {
    username: profileCandidate.username || profileCandidate.userName || handle,
    fullName:
      profileCandidate.fullName ||
      profileCandidate.full_name ||
      profileCandidate.ownerFullName ||
      null,
    biography:
      profileCandidate.biography ||
      profileCandidate.bio ||
      profileCandidate.description ||
      profileCandidate.ownerBiography ||
      null,
    followersCount: numberOrNull(
      profileCandidate.followersCount ||
        profileCandidate.followers ||
        profileCandidate.followedByCount ||
        profileCandidate.ownerFollowersCount,
    ),
    followsCount: numberOrNull(
      profileCandidate.followsCount ||
        profileCandidate.followingCount ||
        profileCandidate.following,
    ),
    postsCount: numberOrNull(
      profileCandidate.postsCount || profileCandidate.posts || profileCandidate.mediaCount,
    ),
    isVerified: booleanOrNull(
      profileCandidate.verified ?? profileCandidate.isVerified,
    ),
    isPrivate: booleanOrNull(profileCandidate.private ?? profileCandidate.isPrivate),
    externalUrl:
      profileCandidate.externalUrl ||
      profileCandidate.external_url ||
      profileCandidate.website ||
      null,
    businessCategoryName:
      profileCandidate.businessCategoryName ||
      profileCandidate.businessCategory ||
      profileCandidate.categoryName ||
      null,
  };

  const averageEngagement = calculateAverageEngagement(posts, profile.followersCount);
  const postMetricStandardDeviation = calculatePostMetricStandardDeviation(posts);

  return {
    handle,
    profileUrl: `https://www.instagram.com/${handle}/`,
    scrapedAt: new Date().toISOString(),
    sources: {
      profile: profileSource,
      posts: postsSource,
    },
    scrapeSkipped: {
      posts: skipped.posts || null,
    },
    creator: {
      name: profile.fullName,
      bio: profile.biography,
      followersCount: profile.followersCount,
      followingCount: profile.followsCount,
      averageEngagementRate: averageEngagement.averageEngagementRate,
      postMetricStandardDeviation,
      postsCount: profile.postsCount,
      isVerified: profile.isVerified,
      businessCategoryName: profile.businessCategoryName,
      categoryName: profile.businessCategoryName,
    },
    recentPosts: posts,
    scrapeWarnings: buildScrapeWarnings({
      profile,
      posts,
      profileItemCount: profileItems.length,
      postItemCount: postItems.length,
      skipped,
    }),
  };
}

function calculateAverageEngagement(posts, followersCount) {
  const totals = posts
    .map((post) => sumNumbers(post.likes, post.comments))
    .filter((value) => value !== null);
  if (totals.length === 0) {
    return {
      postsAnalyzed: posts.length,
      averageLikesPlusComments: null,
      averageEngagementRate: null,
    };
  }

  return {
    postsAnalyzed: totals.length,
    averageLikesPlusComments: Math.round(average(totals)),
    averageEngagementRate:
      followersCount && followersCount > 0
        ? Number((average(totals) / followersCount).toFixed(4))
        : null,
  };
}

function calculatePostMetricStandardDeviation(posts) {
  return {
    views: standardDeviation(posts.map((post) => post.views)),
    likes: standardDeviation(posts.map((post) => post.likes)),
    comments: standardDeviation(posts.map((post) => post.comments)),
  };
}

function buildScrapeWarnings({
  profile,
  posts,
  profileItemCount,
  postItemCount,
  skipped,
}) {
  const warnings = [];
  if (skipped.posts) warnings.push(`Skipped posts scrape: ${skipped.posts}.`);
  if (profileItemCount === 0) warnings.push('Profile scraper returned no dataset items.');
  if (!skipped.posts && postItemCount === 0) warnings.push('Posts scraper returned no dataset items.');
  if (!profile.biography) warnings.push('No profile bio captured.');
  if (!profile.followersCount) warnings.push('No follower count captured.');
  if (!skipped.posts && posts.length === 0) warnings.push('No recent posts captured.');
  if (posts.length > 0 && !posts.some((post) => post.caption)) {
    warnings.push('No recent post captions captured.');
  }
  return warnings;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sumNumbers(...values) {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (numbers.length === 0) return null;
  return numbers.reduce((sum, value) => sum + value, 0);
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values) {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (numbers.length === 0) return null;
  const avg = average(numbers);
  const variance = average(numbers.map((value) => (value - avg) ** 2));
  return Math.round(Math.sqrt(variance));
}

function timestampValue(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function booleanOrNull(value) {
  if (value === undefined || value === null) return null;
  return Boolean(value);
}
