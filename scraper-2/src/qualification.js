import { detectHardNoAccount } from './account-filter.js';
import { collectCreatorEmails } from './contacts.js';

export function buildScrapeHardNoReview({ scrapedProfile, config }) {
  return (
    scrapedProfile.prefilterReview ||
    buildProfileHardNoReview({ scrapedProfile, config }) ||
    buildContentHardNoReview({ scrapedProfile, config })
  );
}

export function buildProfileHardNoReview({ scrapedProfile, config }) {
  const followersCount = scrapedProfile.creator.followersCount;
  if (
    followersCount === null ||
    followersCount === undefined ||
    followersCount <= config.instagramFollowerThreshold
  ) {
    return {
      fitScore: 1,
      list: 'reject',
      reasoning: `Hard no: follower count is ${followersCount ?? 'unknown'}, not above the ${config.instagramFollowerThreshold} minimum.`,
    };
  }

  const accountHardNo = detectHardNoAccount(
    {
      handle: scrapedProfile.handle,
      name: scrapedProfile.creator.name,
      bio: scrapedProfile.creator.bio,
      businessCategoryName: scrapedProfile.creator.businessCategoryName,
      categoryName: scrapedProfile.creator.categoryName,
    },
    config.campaignDefinition.hardNoTerms,
  );
  if (accountHardNo.hardNo) {
    return {
      fitScore: 1,
      list: 'reject',
      reasoning: `Hard no: ${accountHardNo.reason}. Businesses, event pages, venues, shops, brands, and non-creator pages do not qualify.`,
    };
  }

  if (config.instagramRequireEmail) {
    const emails = collectCreatorEmails({
      bio: scrapedProfile.creator.bio,
      publicEmail: scrapedProfile.creator.publicEmail,
    });
    if (emails.length === 0) {
      return {
        fitScore: 1,
        list: 'reject',
        reasoning: 'Hard no: no contactable email in bio or public email field, and this campaign requires one.',
      };
    }
  }

  return null;
}

export function buildContentHardNoReview({ scrapedProfile, config }) {
  const medianViews = median(
    scrapedProfile.recentPosts
      .map((post) => post.views)
      .filter((value) => Number.isFinite(value)),
  );

  if (medianViews === null || medianViews >= config.instagramMedianViewsThreshold) {
    return null;
  }

  return {
    fitScore: 1,
    list: 'reject',
    reasoning: `Hard no: median recent post views are ${medianViews}, below the ${config.instagramMedianViewsThreshold} minimum.`,
  };
}

export function annotateFollowingCandidateForPrefilter({ candidate, config }) {
  if (!config.instagramFollowingPrefilter) return candidate;

  const accountHardNo = detectHardNoAccount(
    {
      handle: candidate.handle,
      name: candidate.name,
    },
    config.campaignDefinition.hardNoTerms,
  );
  if (!accountHardNo.hardNo) return candidate;

  return {
    ...candidate,
    hardNo: true,
    hardNoReason: accountHardNo.reason,
  };
}

// Cheap-prefilter classification for a following-list candidate that has been
// annotated by annotateFollowingCandidateForPrefilter. Returns the seen status
// the candidate should be recorded with.
export function classifyDiscoveredCandidate({ candidate, config }) {
  if (candidate.isPrivate === true) return 'filtered_private';
  if (config.instagramRequireVerified && candidate.isVerified !== true) return 'filtered_unverified';
  if (isKnownOutsideFollowerRange({ candidate, config })) return 'filtered_followers';
  if (candidate.hardNo === true) return 'filtered_hard_no';
  return 'queued';
}

export function isKnownOutsideFollowerRange({ candidate, config }) {
  if (!config.instagramFollowingPrefilter || !Number.isFinite(candidate.followersCount)) {
    return false;
  }
  if (candidate.followersCount <= config.instagramFollowerThreshold) return true;
  return (
    config.instagramFollowerMax !== null &&
    candidate.followersCount >= config.instagramFollowerMax
  );
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}
