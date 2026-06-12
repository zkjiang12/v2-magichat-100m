import { collectCreatorEmails } from '../contacts.js';
import { scoreUgcCreator, ugcCreators } from './ugc-creators.js';

function scoreUgcCreatorWithEmail(scrapedProfile, config) {
  const baseReview = scoreUgcCreator(scrapedProfile, config);
  if (baseReview.list === 'reject') return baseReview;

  const emails = collectCreatorEmails({
    bio: scrapedProfile.creator.bio,
    publicEmail: scrapedProfile.creator.publicEmail,
  });
  if (emails.length === 0) {
    return {
      fitScore: 2,
      list: 'reject',
      reasoning: `Rule reject: no contactable email in bio or public business email. Base review: ${baseReview.reasoning}`,
    };
  }

  return {
    ...baseReview,
    reasoning: `${baseReview.reasoning} Contactable email: ${emails[0]}.`,
  };
}

export const ugcCreatorsEmail = {
  name: 'ugc_creators_email',
  description:
    'ugc_creators clone for pure cold-email outbound: same deterministic rules, but only accepts creators with a contactable email in their bio or public business email.',
  defaults: { ...ugcCreators.defaults },
  hardNoTerms: {
    accountTerms: [],
    categoryTerms: [],
  },
  scoring: {
    mode: 'rule',
    score: scoreUgcCreatorWithEmail,
  },
  accept: (review) => review.fitScore >= 3,
  goldFile: 'evals/gold/ugc_creators_email/accuracy.json',
  seedsFile: 'seeds/ugc_creators_email.txt',
  speedCostSeed: null,
};
