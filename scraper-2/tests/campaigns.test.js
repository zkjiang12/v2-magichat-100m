import assert from 'node:assert/strict';
import test from 'node:test';

import { detectHardNoAccount } from '../src/account-filter.js';
import { dayInLifeCreators } from '../src/campaigns/day-in-life-creators.js';
import {
  getCampaignDefinition,
  listCampaignNames,
  validateCampaignDefinition,
} from '../src/campaigns/index.js';
import { ugcCreators } from '../src/campaigns/ugc-creators.js';
import { getConfig } from '../src/config.js';
import { isKnownOutsideFollowerRange } from '../src/qualification.js';
import { buildScoreSchema } from '../src/scorer.js';

// Verbatim copies of the pre-campaign literals from scorer.js and account-filter.js.
// These tests prove the extraction into campaigns/day-in-life-creators.js changed nothing.
const ORIGINAL_SCORE_SCHEMA = {
  name: 'magichat_creator_score',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      fitScore: { type: 'integer', minimum: 1, maximum: 4 },
      list: {
        type: 'string',
        enum: ['target_now', 'good_not_now_non_us', 'business_day_in_life', 'reject'],
      },
      reasoning: { type: 'string' },
    },
    required: [
      'fitScore',
      'list',
      'reasoning',
    ],
  },
  strict: true,
};

const ORIGINAL_SYSTEM_PROMPT = [
  'Score Instagram creators for MagicHat, a consumer AI wearable hat with a POV camera for life capture, memory, and useful personal insights.',
  'Use only the supplied scraped packet. Do not invent details. When evidence is mixed, prefer score 3 if there are clear positive lifestyle, personal growth, travel, storytelling, craft, fitness, food, or aesthetic signals and no hard exclude.',
  '',
  'Fit:',
  '- Good: real-world life content, tasteful day-in-life, personal storytelling, creator-led stories, personal milestones, events, general lifestyle, cooking, gym/fitness, running, hiking/outdoors, travel, cleaning/organizing, studying, grinding, aspirational/motivational content, making/craft/DIY, barbers, photography/events, sports, aesthetic lifestyle, food, pets, useful routines, trust-building content.',
  '- Lifestyle content around productivity, studying, routines, health, fitness, exercise, cooking, nutrition, cleaning, organizing, home, personal growth, self-improvement, learning, discipline, confidence, and daily habits is a core positive category. Score it 3 or 4 when the creator is legitimate, the content is creator-led, and no hard exclude applies.',
  '- Personal stories, events, milestones, and general lifestyle content are usually positive signals when they are creator-led, tasteful, and show real life or an aspirational personal journey. Do not penalize them for not being explicitly educational or routine-focused.',
  '- Adventure travel, cultural exploration, documentary-style storytelling, and high-quality aspirational life stories are strong positives. For large, verified creators, this can be a 4 even when the content is not personal day-in-life or routine content.',
  '- Entertainment, stunt/challenge, cinematic travel/vlog, artist process, creator-led event, and visual storytelling content can qualify when tasteful, aspirational, and creator-led. These are directly relevant to POV life capture when they show experiences, places, making, movement, or personal perspective. Do not penalize content just because it is not educational, advice-driven, or a literal routine.',
  '- Brand ads, sponsorships, product integrations, and creator partnerships are not negative by themselves. Treat them as neutral or positive when the creator association is tasteful, polished, and not built around scams, vulgarity, sex, gambling, drama, or low-trust products.',
  '- If creator association is positive, tasteful, aspirational, useful, beautiful, interesting, or culturally compelling, score 3 or 4 even if the content is not literal day-in-life, routine, or advice content.',
  '- For very large accounts, a low percentage engagement rate is not a reject reason by itself when absolute views, likes, or audience size are still meaningful and the content fit is strong.',
  '- Do not reject because of vague caution or abstract reputational concerns. Reject only for the explicit hard excludes below, very weak fit, low-trust/scammy behavior, or low reach.',
  '- Bad: vulgar, childish, brainrot, clickbait, mean-spirited, low-trust, scammy, overly sexualized, status-driven, drama-heavy, problem-heavy, or irrelevant to a POV wearable.',
  '- Tasteful parties/events/nightlife can qualify when not sexually explicit, not vulgar, and not drama-driven.',
  '',
  'Hard excludes, score 1:',
  '- Business advice, startups, founder grind, VC, Silicon Valley commentary, career growth, 9-5 advice, side hustles, sales, investing, real estate wealth, money/status-maxing, unless it is primarily tasteful day-in-life footage; then use business_day_in_life.',
  '- Do not penalize creators for monetizing a good-fit domain, promoting their own services/products, or having calls to action when the core content is useful, tasteful, aspirational, or lifestyle-oriented. Fitness coaches, food creators, barbers, artists, travel creators, educators, and makers can qualify even if they sell coaching, courses, products, or services.',
  '- Dating, relationships, sex, gossip, cheating, interpersonal conflict, drama, or sexually suggestive material.',
  '- Death, murder, violent crime, gore, trauma-heavy stories, depression, mental health crisis, tragedy, or other heavy/problem content.',
  '- Politics, partisan commentary, culture-war commentary, or public-policy/current-events punditry.',
  '- Companies, brands, organizations, media pages, aggregators, repost accounts, venues, event pages, product pages, shops, stores, teams, or non-individual pages.',
  '- Celebrities, professional athletes, actors, musicians, singers, rappers, DJs, bands, comedians, public figures, sports team members, or entertainment personalities.',
  '- Median recent views below 10K.',
  '',
  'Scores:',
  '4 = undoubtedly good for MagicHat: tasteful/useful/aspirational/interesting, with large audience or strong engagement.',
  '3 = generally useful, tasteful, aesthetic, beautiful, cinematic, creator-led, interesting, or positive; MagicHat would consider outreach.',
  '2 = not clearly damaging but mostly off-target, weak, not tasteful/useful/interesting, low-trust, or lacking creator-led real-life signals.',
  '1 = terrible or hard-excluded brand fit.',
  '',
  'Routing:',
  '- fitScore 1 or 2 -> list reject.',
  '- fitScore 3 or 4 and business/career/money project that is primarily tasteful day-in-life footage -> business_day_in_life.',
  '- fitScore 3 or 4 and appears non-US -> good_not_now_non_us.',
  '- fitScore 3 or 4 and US-based or US location plausible/unknown -> target_now.',
  '',
  'Reasoning must be concise and grounded in specific supplied signals: bio, follower/following count, engagement rate, captions, accessibility captions, timestamps, or post metrics.',
].join('\n');

const ORIGINAL_BUSINESS_OR_EVENT_TERMS = [
  'agency',
  'apparel',
  'bar',
  'brand',
  'boutique',
  'cafe',
  'club',
  'collective',
  'company',
  'conference',
  'festival',
  'gallery',
  'hotel',
  'market',
  'media',
  'official',
  'organization',
  'podcast',
  'restaurant',
  'shop',
  'store',
  'studio',
  'team',
  'venue',
];

const ORIGINAL_BUSINESS_CATEGORY_TERMS = [
  'business',
  'company',
  'event',
  'media',
  'organization',
  'product',
  'restaurant',
  'shopping',
  'store',
];

const ugcStubConfig = {
  instagramFollowerThreshold: 1000,
  instagramFollowerMax: 50000,
  instagramFollowingPrefilter: true,
  campaignDefinition: ugcCreators,
};

const dayInLifeStubConfig = {
  instagramFollowerThreshold: 10000,
  instagramFollowerMax: null,
  instagramFollowingPrefilter: true,
  campaignDefinition: dayInLifeCreators,
};

function stubProfile({ handle = 'someone', name = null, bio = null, followersCount = 20000 } = {}) {
  return {
    handle,
    creator: { name, bio, followersCount },
  };
}

test('campaign registry returns known definitions and rejects unknown names', () => {
  assert.equal(getCampaignDefinition('day_in_life_creators'), dayInLifeCreators);
  assert.equal(getCampaignDefinition('ugc_creators'), ugcCreators);
  assert.deepEqual(listCampaignNames(), ['day_in_life_creators', 'ugc_creators']);
  assert.throws(() => getCampaignDefinition('nope'), /Unknown campaign: nope/);
});

test('day_in_life_creators definition matches the pre-campaign literals exactly', () => {
  assert.equal(dayInLifeCreators.scoring.mode, 'openai');
  assert.equal(dayInLifeCreators.scoring.systemPrompt, ORIGINAL_SYSTEM_PROMPT);
  assert.deepEqual(dayInLifeCreators.scoring.listValues, ORIGINAL_SCORE_SCHEMA.schema.properties.list.enum);
  assert.deepEqual(dayInLifeCreators.hardNoTerms.accountTerms, ORIGINAL_BUSINESS_OR_EVENT_TERMS);
  assert.deepEqual(dayInLifeCreators.hardNoTerms.categoryTerms, ORIGINAL_BUSINESS_CATEGORY_TERMS);
  assert.deepEqual(dayInLifeCreators.defaults, {
    followerThreshold: 10000,
    medianViewsThreshold: 10000,
    requireVerified: true,
    followerMax: null,
    profilePrefilter: true,
    contentPrefilter: true,
    scrapePosts: true,
  });
  assert.equal(dayInLifeCreators.accept({ fitScore: 3 }), true);
  assert.equal(dayInLifeCreators.accept({ fitScore: 2 }), false);
});

test('buildScoreSchema reproduces the original OpenAI schema for day_in_life listValues', () => {
  assert.deepEqual(buildScoreSchema(dayInLifeCreators.scoring.listValues), ORIGINAL_SCORE_SCHEMA);
});

test('all registered campaign definitions pass shape validation', () => {
  for (const name of listCampaignNames()) {
    validateCampaignDefinition(getCampaignDefinition(name));
  }
});

test('validateCampaignDefinition rejects broken definitions', () => {
  const broken = {
    ...dayInLifeCreators,
    scoring: { ...dayInLifeCreators.scoring, listValues: ['target_now'] },
  };
  assert.throws(() => validateCampaignDefinition(broken), /listValues must include reject/);

  const brokenRule = { ...ugcCreators, scoring: { mode: 'rule' } };
  assert.throws(() => validateCampaignDefinition(brokenRule), /scoring\.score must be a function/);
});

test('ugc rule scorer accepts with 4 when "ugc" appears in bio or username', () => {
  const fromBio = ugcCreators.scoring.score(
    stubProfile({ bio: 'UGC creator | collabs welcome' }),
    ugcStubConfig,
  );
  assert.deepEqual([fromBio.fitScore, fromBio.list], [4, 'target_now']);

  const fromHandle = ugcCreators.scoring.score(
    stubProfile({ handle: 'ugcwithjess', bio: 'just vibes' }),
    ugcStubConfig,
  );
  assert.deepEqual([fromHandle.fitScore, fromHandle.list], [4, 'target_now']);
});

test('ugc rule scorer accepts with 3 on other UGC terms', () => {
  const review = ugcCreators.scoring.score(
    stubProfile({ bio: 'content creator, brand partnerships: dm me' }),
    ugcStubConfig,
  );
  assert.deepEqual([review.fitScore, review.list], [3, 'target_now']);
  assert.match(review.reasoning, /creator|partnership/);
});

test('ugc rule scorer rejects with 2 when no UGC terms match', () => {
  const review = ugcCreators.scoring.score(
    stubProfile({ bio: 'coffee & travel' }),
    ugcStubConfig,
  );
  assert.deepEqual([review.fitScore, review.list], [2, 'reject']);
});

test('ugc rule scorer rejects with 2 outside the follower range or when followers unknown', () => {
  const tooSmall = ugcCreators.scoring.score(
    stubProfile({ bio: 'UGC creator', followersCount: 500 }),
    ugcStubConfig,
  );
  assert.deepEqual([tooSmall.fitScore, tooSmall.list], [2, 'reject']);

  const tooBig = ugcCreators.scoring.score(
    stubProfile({ bio: 'UGC creator', followersCount: 80000 }),
    ugcStubConfig,
  );
  assert.deepEqual([tooBig.fitScore, tooBig.list], [2, 'reject']);

  const unknown = ugcCreators.scoring.score(
    stubProfile({ bio: 'UGC creator', followersCount: null }),
    ugcStubConfig,
  );
  assert.deepEqual([unknown.fitScore, unknown.list], [2, 'reject']);
});

test('detectHardNoAccount uses campaign terms', () => {
  const candidate = { handle: 'jess', name: 'Jess', bio: 'brand partnerships open' };
  assert.equal(detectHardNoAccount(candidate, dayInLifeCreators.hardNoTerms).hardNo, true);
  assert.equal(detectHardNoAccount(candidate, ugcCreators.hardNoTerms).hardNo, false);

  const businessCategory = { handle: 'venuepage', businessCategoryName: 'Media/news company' };
  assert.equal(detectHardNoAccount(businessCategory, dayInLifeCreators.hardNoTerms).hardNo, true);
});

test('isKnownOutsideFollowerRange filters both below min and above max', () => {
  assert.equal(
    isKnownOutsideFollowerRange({ candidate: { followersCount: 500 }, config: ugcStubConfig }),
    true,
  );
  assert.equal(
    isKnownOutsideFollowerRange({ candidate: { followersCount: 80000 }, config: ugcStubConfig }),
    true,
  );
  assert.equal(
    isKnownOutsideFollowerRange({ candidate: { followersCount: 20000 }, config: ugcStubConfig }),
    false,
  );
  assert.equal(
    isKnownOutsideFollowerRange({ candidate: { followersCount: 80000 }, config: dayInLifeStubConfig }),
    false,
  );
  assert.equal(
    isKnownOutsideFollowerRange({ candidate: { followersCount: null }, config: ugcStubConfig }),
    false,
  );
});

test('getConfig applies campaign defaults with env overrides taking precedence', () => {
  const savedEnv = { ...process.env };
  try {
    process.env.APIFY_TOKEN = 'test_token';
    process.env.OPENAI_API_KEY = 'test_key';
    for (const key of [
      'OUTBOUND_CAMPAIGN',
      'INSTAGRAM_FOLLOWER_THRESHOLD',
      'INSTAGRAM_FOLLOWER_MAX',
      'INSTAGRAM_MEDIAN_VIEWS_THRESHOLD',
      'INSTAGRAM_REQUIRE_VERIFIED',
      'INSTAGRAM_PROFILE_PREFILTER',
      'INSTAGRAM_CONTENT_PREFILTER',
      'INSTAGRAM_SCRAPE_POSTS',
    ]) {
      delete process.env[key];
    }

    const dayInLifeConfig = getConfig();
    assert.equal(dayInLifeConfig.campaign, 'day_in_life_creators');
    assert.equal(dayInLifeConfig.instagramFollowerThreshold, 10000);
    assert.equal(dayInLifeConfig.instagramFollowerMax, null);
    assert.equal(dayInLifeConfig.instagramMedianViewsThreshold, 10000);
    assert.equal(dayInLifeConfig.instagramRequireVerified, true);
    assert.equal(dayInLifeConfig.instagramScrapePosts, true);
    assert.equal(dayInLifeConfig.campaignDefinition, dayInLifeCreators);

    process.env.OUTBOUND_CAMPAIGN = 'ugc_creators';
    const ugcConfig = getConfig();
    assert.equal(ugcConfig.instagramFollowerThreshold, 1000);
    assert.equal(ugcConfig.instagramFollowerMax, 50000);
    assert.equal(ugcConfig.instagramMedianViewsThreshold, 0);
    assert.equal(ugcConfig.instagramRequireVerified, false);
    assert.equal(ugcConfig.instagramProfilePrefilter, false);
    assert.equal(ugcConfig.instagramContentPrefilter, false);
    assert.equal(ugcConfig.instagramScrapePosts, false);
    assert.equal(ugcConfig.campaignDefinition, ugcCreators);

    process.env.INSTAGRAM_FOLLOWER_THRESHOLD = '5000';
    process.env.INSTAGRAM_FOLLOWER_MAX = '90000';
    const overriddenConfig = getConfig();
    assert.equal(overriddenConfig.instagramFollowerThreshold, 5000);
    assert.equal(overriddenConfig.instagramFollowerMax, 90000);

    process.env.OUTBOUND_CAMPAIGN = 'not_a_campaign';
    assert.throws(() => getConfig(), /Unknown campaign: not_a_campaign/);
  } finally {
    process.env = savedEnv;
  }
});
