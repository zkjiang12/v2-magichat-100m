const BUSINESS_OR_EVENT_TERMS = [
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

const BUSINESS_CATEGORY_TERMS = [
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

export function detectHardNoAccount(candidate) {
  const text = [
    candidate.handle,
    candidate.name,
    candidate.bio,
    candidate.businessCategoryName,
    candidate.categoryName,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const categoryText = [
    candidate.businessCategoryName,
    candidate.categoryName,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (BUSINESS_CATEGORY_TERMS.some((term) => categoryText.includes(term))) {
    return {
      hardNo: true,
      reason: `business/event category: ${categoryText}`,
    };
  }

  const matchedTerm = BUSINESS_OR_EVENT_TERMS.find((term) => containsWord(text, term));
  if (matchedTerm) {
    return {
      hardNo: true,
      reason: `business/event/page signal: ${matchedTerm}`,
    };
  }

  return { hardNo: false, reason: null };
}

function containsWord(text, word) {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}([^a-z0-9]|$)`).test(text);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
