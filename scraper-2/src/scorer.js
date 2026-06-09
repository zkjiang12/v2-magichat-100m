import { fetchJsonWithRetry } from './retry.js';

export function buildScoreSchema(listValues) {
  return {
    name: 'magichat_creator_score',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fitScore: { type: 'integer', minimum: 1, maximum: 4 },
        list: {
          type: 'string',
          enum: listValues,
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
}

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
  const scoring = config.campaignDefinition.scoring;
  if (scoring.mode === 'rule') {
    return {
      review: scoring.score(scrapedProfile, config),
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      model: 'rule',
      estimatedCostUsd: 0,
    };
  }

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
          json_schema: buildScoreSchema(scoring.listValues),
        },
        messages: [
          {
            role: 'system',
            content: scoring.systemPrompt,
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
