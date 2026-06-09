import fs from 'node:fs';

import { getCampaignDefinition } from './campaigns/index.js';

loadLocalEnv();

export function getConfig() {
  const campaign = process.env.OUTBOUND_CAMPAIGN || 'day_in_life_creators';
  const campaignDefinition = getCampaignDefinition(campaign);
  const campaignDefaults = campaignDefinition.defaults;

  const config = {
    apifyToken: process.env.APIFY_TOKEN,
    openaiApiKey: process.env.OPENAI_API_KEY,
    apifyInstagramProfileActorId:
      process.env.APIFY_INSTAGRAM_PROFILE_ACTOR_ID || 'apify/instagram-profile-scraper',
    apifyInstagramPostsActorId:
      process.env.APIFY_INSTAGRAM_POSTS_ACTOR_ID ||
      process.env.APIFY_INSTAGRAM_ACTOR_ID ||
      'apify/instagram-scraper',
    apifyMaxRunUsd:
      process.env.APIFY_MAX_RUN_USD === undefined || process.env.APIFY_MAX_RUN_USD === ''
        ? null
        : Number(process.env.APIFY_MAX_RUN_USD),
    apifyInstagramFollowingActorId:
      process.env.APIFY_INSTAGRAM_FOLLOWING_ACTOR_ID ||
      'scraping_solutions/instagram-scraper-followers-following',
    instagramFollowingMode: process.env.INSTAGRAM_FOLLOWING_MODE || 'following',
    instagramFollowingLimit: Number(process.env.INSTAGRAM_FOLLOWING_LIMIT || 1000),
    instagramFollowerThreshold: Number(
      process.env.INSTAGRAM_FOLLOWER_THRESHOLD || campaignDefaults.followerThreshold,
    ),
    instagramFollowerMax: process.env.INSTAGRAM_FOLLOWER_MAX
      ? Number(process.env.INSTAGRAM_FOLLOWER_MAX)
      : campaignDefaults.followerMax ?? null,
    instagramMedianViewsThreshold: Number(
      process.env.INSTAGRAM_MEDIAN_VIEWS_THRESHOLD || campaignDefaults.medianViewsThreshold,
    ),
    instagramRequireVerified: parseBoolean(
      process.env.INSTAGRAM_REQUIRE_VERIFIED ?? String(campaignDefaults.requireVerified),
    ),
    instagramProfilePrefilter: parseBoolean(
      process.env.INSTAGRAM_PROFILE_PREFILTER ?? String(campaignDefaults.profilePrefilter),
    ),
    instagramContentPrefilter: parseBoolean(
      process.env.INSTAGRAM_CONTENT_PREFILTER ?? String(campaignDefaults.contentPrefilter),
    ),
    instagramScrapePosts: parseBoolean(
      process.env.INSTAGRAM_SCRAPE_POSTS ?? String(campaignDefaults.scrapePosts),
    ),
    instagramFollowingPrefilter: parseBoolean(process.env.INSTAGRAM_FOLLOWING_PREFILTER ?? 'true'),
    instagramResultsLimit: Number(process.env.INSTAGRAM_RESULTS_LIMIT || 3),
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    openaiPostLimit: Number(process.env.OPENAI_POST_LIMIT || 3),
    openaiMaxTextChars: Number(process.env.OPENAI_MAX_TEXT_CHARS || 320),
    databaseUrl: process.env.DATABASE_URL || null,
    campaign,
    campaignDefinition,
    dashboardEnqueueStatus: process.env.DASHBOARD_ENQUEUE_STATUS || 'queued',
  };

  const missing = [];
  if (!config.apifyToken || config.apifyToken.startsWith('replace_with_')) {
    missing.push('APIFY_TOKEN');
  }
  if (!config.openaiApiKey || config.openaiApiKey.startsWith('replace_with_')) {
    missing.push('OPENAI_API_KEY');
  }
  if (!Number.isFinite(config.instagramResultsLimit) || config.instagramResultsLimit < 1) {
    missing.push('INSTAGRAM_RESULTS_LIMIT must be a positive number');
  }
  if (
    config.apifyMaxRunUsd !== null &&
    (!Number.isFinite(config.apifyMaxRunUsd) || config.apifyMaxRunUsd <= 0)
  ) {
    missing.push('APIFY_MAX_RUN_USD must be a positive number when set');
  }
  if (!Number.isFinite(config.instagramFollowingLimit) || config.instagramFollowingLimit < 1) {
    missing.push('INSTAGRAM_FOLLOWING_LIMIT must be a positive number');
  }
  if (!Number.isFinite(config.instagramFollowerThreshold) || config.instagramFollowerThreshold < 0) {
    missing.push('INSTAGRAM_FOLLOWER_THRESHOLD must be zero or a positive number');
  }
  if (
    !Number.isFinite(config.instagramMedianViewsThreshold) ||
    config.instagramMedianViewsThreshold < 0
  ) {
    missing.push('INSTAGRAM_MEDIAN_VIEWS_THRESHOLD must be zero or a positive number');
  }
  if (
    config.instagramFollowerMax !== null &&
    (!Number.isFinite(config.instagramFollowerMax) || config.instagramFollowerMax <= 0)
  ) {
    missing.push('INSTAGRAM_FOLLOWER_MAX must be a positive number when set');
  }
  if (!Number.isFinite(config.openaiPostLimit) || config.openaiPostLimit < 1) {
    missing.push('OPENAI_POST_LIMIT must be a positive number');
  }
  if (!Number.isFinite(config.openaiMaxTextChars) || config.openaiMaxTextChars < 50) {
    missing.push('OPENAI_MAX_TEXT_CHARS must be at least 50');
  }
  if (!['ready_for_review', 'queued'].includes(config.dashboardEnqueueStatus)) {
    missing.push('DASHBOARD_ENQUEUE_STATUS must be ready_for_review or queued');
  }

  if (missing.length > 0) {
    throw new Error(`Missing or invalid environment values: ${missing.join(', ')}`);
  }

  return config;
}

function loadLocalEnv() {
  if (!fs.existsSync('.env')) return;
  const raw = fs.readFileSync('.env', 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value.replace(/^["']|["']$/g, '');
    }
  }
}

function parseBoolean(value) {
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}
