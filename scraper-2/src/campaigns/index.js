import { dayInLifeCreators } from './day-in-life-creators.js';
import { ugcCreatorsEmail } from './ugc-creators-email.js';
import { ugcCreators } from './ugc-creators.js';

const CAMPAIGN_DEFINITIONS = new Map(
  [dayInLifeCreators, ugcCreators, ugcCreatorsEmail].map((definition) => [definition.name, definition]),
);

for (const definition of CAMPAIGN_DEFINITIONS.values()) {
  validateCampaignDefinition(definition);
}

export function getCampaignDefinition(name) {
  const definition = CAMPAIGN_DEFINITIONS.get(name);
  if (!definition) {
    throw new Error(
      `Unknown campaign: ${name}. Known campaigns: ${listCampaignNames().join(', ')}`,
    );
  }
  return definition;
}

export function listCampaignNames() {
  return [...CAMPAIGN_DEFINITIONS.keys()];
}

export function validateCampaignDefinition(definition) {
  const issues = [];
  if (!definition || typeof definition !== 'object') {
    throw new Error('Campaign definition must be an object');
  }

  if (!definition.name || typeof definition.name !== 'string') {
    issues.push('name must be a non-empty string');
  }

  const defaults = definition.defaults || {};
  for (const key of ['followerThreshold', 'medianViewsThreshold']) {
    if (!Number.isFinite(defaults[key]) || defaults[key] < 0) {
      issues.push(`defaults.${key} must be zero or a positive number`);
    }
  }
  if (defaults.followerMax !== null && (!Number.isFinite(defaults.followerMax) || defaults.followerMax <= 0)) {
    issues.push('defaults.followerMax must be null or a positive number');
  }
  for (const key of ['requireVerified', 'profilePrefilter', 'contentPrefilter', 'scrapePosts']) {
    if (typeof defaults[key] !== 'boolean') {
      issues.push(`defaults.${key} must be a boolean`);
    }
  }

  const hardNoTerms = definition.hardNoTerms || {};
  for (const key of ['accountTerms', 'categoryTerms']) {
    const terms = hardNoTerms[key];
    if (!Array.isArray(terms) || terms.some((term) => typeof term !== 'string' || term !== term.toLowerCase())) {
      issues.push(`hardNoTerms.${key} must be an array of lowercase strings`);
    }
  }

  const scoring = definition.scoring || {};
  if (scoring.mode === 'openai') {
    if (!scoring.systemPrompt || typeof scoring.systemPrompt !== 'string') {
      issues.push('scoring.systemPrompt must be a non-empty string for openai mode');
    }
    if (!Array.isArray(scoring.listValues) || scoring.listValues.length === 0) {
      issues.push('scoring.listValues must be a non-empty array for openai mode');
    } else if (!scoring.listValues.includes('reject')) {
      issues.push('scoring.listValues must include reject');
    }
  } else if (scoring.mode === 'rule') {
    if (typeof scoring.score !== 'function') {
      issues.push('scoring.score must be a function for rule mode');
    }
  } else {
    issues.push('scoring.mode must be openai or rule');
  }

  if (typeof definition.accept !== 'function') {
    issues.push('accept must be a function');
  }
  for (const key of ['goldFile', 'seedsFile']) {
    if (!definition[key] || typeof definition[key] !== 'string') {
      issues.push(`${key} must be a non-empty string`);
    }
  }

  if (issues.length > 0) {
    throw new Error(
      `Invalid campaign definition${definition.name ? ` ${definition.name}` : ''}: ${issues.join('; ')}`,
    );
  }

  return definition;
}
