export function detectHardNoAccount(candidate, { accountTerms, categoryTerms }) {
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

  if (categoryTerms.some((term) => categoryText.includes(term))) {
    return {
      hardNo: true,
      reason: `business/event category: ${categoryText}`,
    };
  }

  const matchedTerm = containsAnyTerm(text, accountTerms);
  if (matchedTerm) {
    return {
      hardNo: true,
      reason: `business/event/page signal: ${matchedTerm}`,
    };
  }

  return { hardNo: false, reason: null };
}

export function containsAnyTerm(text, terms) {
  return terms.find((term) => containsWord(text, term)) || null;
}

export function containsWord(text, word) {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}([^a-z0-9]|$)`).test(text);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
