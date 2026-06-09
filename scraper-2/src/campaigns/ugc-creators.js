import { containsAnyTerm } from '../account-filter.js';

const UGC_TERMS = [
  'ugc',
  'creator',
  'influencer',
  'brand partnership',
  'brand partnerships',
  'collab',
  'collabs',
  'collaboration',
  'collaborations',
];

function scoreUgcCreator(scrapedProfile, config) {
  const followersCount = scrapedProfile.creator.followersCount;
  const minFollowers = config.instagramFollowerThreshold;
  const maxFollowers = config.instagramFollowerMax;

  if (!Number.isFinite(followersCount)) {
    return {
      fitScore: 2,
      list: 'reject',
      reasoning: 'Rule reject: follower count is unknown, cannot confirm the required follower range.',
    };
  }

  if (followersCount <= minFollowers) {
    return {
      fitScore: 2,
      list: 'reject',
      reasoning: `Rule reject: follower count ${followersCount} is not above the ${minFollowers} minimum.`,
    };
  }

  if (maxFollowers !== null && followersCount >= maxFollowers) {
    return {
      fitScore: 2,
      list: 'reject',
      reasoning: `Rule reject: follower count ${followersCount} is not below the ${maxFollowers} maximum.`,
    };
  }

  const text = [scrapedProfile.handle, scrapedProfile.creator.name, scrapedProfile.creator.bio]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  // "ugc" is distinctive enough to substring-match, which also catches
  // concatenated handles like "ugcwithjess"; other terms need word boundaries.
  if (text.includes('ugc')) {
    return {
      fitScore: 4,
      list: 'target_now',
      reasoning: `Rule accept: bio/username mentions "ugc" and follower count ${followersCount} is within ${minFollowers}-${maxFollowers}.`,
    };
  }

  const matchedTerm = containsAnyTerm(text, UGC_TERMS);
  if (!matchedTerm) {
    return {
      fitScore: 2,
      list: 'reject',
      reasoning: `Rule reject: bio and username contain none of the UGC terms (${UGC_TERMS.join(', ')}).`,
    };
  }

  return {
    fitScore: 3,
    list: 'target_now',
    reasoning: `Rule accept: bio/username matches UGC term "${matchedTerm}" and follower count ${followersCount} is within ${minFollowers}-${maxFollowers}.`,
  };
}

export const ugcCreators = {
  name: 'ugc_creators',
  description:
    'Small/mid UGC creators selected by deterministic rules; no posts scrape and no OpenAI scoring.',
  defaults: {
    followerThreshold: 1000,
    medianViewsThreshold: 0,
    requireVerified: false,
    followerMax: 50000,
    profilePrefilter: false,
    contentPrefilter: false,
    scrapePosts: false,
  },
  hardNoTerms: {
    accountTerms: [],
    categoryTerms: [],
  },
  scoring: {
    mode: 'rule',
    score: scoreUgcCreator,
  },
  accept: (review) => review.fitScore >= 3,
  goldFile: 'evals/gold/ugc_creators/accuracy.json',
  seedsFile: 'seeds/ugc_creators.txt',
  speedCostSeed: null,
};
