import { fetchJsonWithRetry } from './retry.js';

const SCORE_SCHEMA = {
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

const SYSTEM_PROMPT = [
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

export const DEFAULT_OPENAI_PRICING = {
  inputUsdPer1MTokens: 0.4,
  cachedInputUsdPer1MTokens: 0.1,
  outputUsdPer1MTokens: 1.6,
};

export async function scoreCreator({ scrapedProfile, config }) {
  const result = await scoreCreatorDetailed({ scrapedProfile, config });
  return result.review;
}

export async function scoreCreatorDetailed({ scrapedProfile, config }) {
  const { body: completion = {} } = await fetchJsonWithRetry({
    url: 'https://api.openai.com/v1/chat/completions',
    label: 'OpenAI scoring',
    options: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.openaiModel,
        temperature: 0.1,
        response_format: {
          type: 'json_schema',
          json_schema: SCORE_SCHEMA,
        },
        messages: [
          {
            role: 'system',
            content: SYSTEM_PROMPT,
          },
          {
            role: 'user',
            content: JSON.stringify(buildScoringPacket({ scrapedProfile, config })),
          },
        ],
      }),
    },
  });

  const review = JSON.parse(completion.choices[0].message.content);
  const usage = normalizeOpenAiUsage(completion.usage || {});
  const estimatedCostUsd = estimateOpenAiCost({
    usage,
    pricing: DEFAULT_OPENAI_PRICING,
  });

  return {
    review,
    usage,
    model: completion.model || config.openaiModel,
    estimatedCostUsd,
  };
}

export function estimateOpenAiCost({ usage, pricing = DEFAULT_OPENAI_PRICING }) {
  const cachedInputTokens = Math.min(usage.cachedInputTokens || 0, usage.inputTokens || 0);
  const uncachedInputTokens = Math.max(0, (usage.inputTokens || 0) - cachedInputTokens);
  return roundUsd(
    (uncachedInputTokens / 1_000_000) * pricing.inputUsdPer1MTokens +
      (cachedInputTokens / 1_000_000) * pricing.cachedInputUsdPer1MTokens +
      ((usage.outputTokens || 0) / 1_000_000) * pricing.outputUsdPer1MTokens,
  );
}

function normalizeOpenAiUsage(usage) {
  const inputTokens = numberOrZero(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = numberOrZero(usage.completion_tokens ?? usage.output_tokens);
  const cachedInputTokens = numberOrZero(
    usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      usage.input_token_details?.cached_tokens,
  );

  return {
    inputTokens,
    cachedInputTokens: Math.min(cachedInputTokens, inputTokens),
    outputTokens,
  };
}

function buildScoringPacket({ scrapedProfile, config }) {
  const maxTextChars = config.openaiMaxTextChars;

  return stripEmpty({
    handle: scrapedProfile.handle,
    profileUrl: scrapedProfile.profileUrl,
    scrapedAt: scrapedProfile.scrapedAt,
    creator: stripEmpty({
      name: truncateText(scrapedProfile.creator.name, maxTextChars),
      bio: truncateText(scrapedProfile.creator.bio, maxTextChars),
      followersCount: scrapedProfile.creator.followersCount,
      followingCount: scrapedProfile.creator.followingCount,
      averageEngagementRate: scrapedProfile.creator.averageEngagementRate,
      postMetricStandardDeviation: scrapedProfile.creator.postMetricStandardDeviation,
      postsCount: scrapedProfile.creator.postsCount,
      isVerified: scrapedProfile.creator.isVerified,
      businessCategoryName: scrapedProfile.creator.businessCategoryName,
      categoryName: scrapedProfile.creator.categoryName,
    }),
    recentPosts: scrapedProfile.recentPosts
      .slice(0, config.openaiPostLimit)
      .map((post) => compactPost({ post, config })),
    scrapeWarnings: scrapedProfile.scrapeWarnings?.slice(0, 5),
  });
}

function compactPost({ post, config }) {
  return stripEmpty({
    caption: truncateText(post.caption, config.openaiMaxTextChars),
    accessibilityCaption: truncateText(post.accessibilityCaption, config.openaiMaxTextChars),
    timestamp: post.timestamp,
    views: post.views,
    likes: post.likes,
    comments: post.comments,
  });
}

function truncateText(value, maxChars) {
  if (typeof value !== 'string') return value;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function stripEmpty(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;

  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => {
      if (entryValue === null || entryValue === undefined || entryValue === '') return false;
      if (Array.isArray(entryValue) && entryValue.length === 0) return false;
      return true;
    }),
  );
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundUsd(value) {
  return Number(value.toFixed(6));
}
