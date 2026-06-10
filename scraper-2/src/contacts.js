const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

// Matches like "logo@2x.png" are filenames, not contactable addresses.
const IGNORED_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'mov', 'heic']);

// Bios often contain cross-platform mentions like "insta@first.last" or
// "yt@handle.name" that are structurally valid emails but never contactable.
const PLATFORM_MENTION_LOCALS = new Set([
  'ig', 'insta', 'instagram', 'yt', 'youtube', 'tiktok', 'tt',
  'snap', 'snapchat', 'twitter', 'x', 'fb', 'facebook',
]);

const MAX_EMAIL_LENGTH = 254;

export function extractEmailsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(EMAIL_PATTERN) || [];
  const emails = [];
  for (const match of matches) {
    const normalized = normalizeEmail(match);
    if (normalized && !emails.includes(normalized)) emails.push(normalized);
  }
  return emails;
}

export function collectCreatorEmails({ bio, publicEmail } = {}) {
  const emails = [];
  for (const email of [...extractEmailsFromText(publicEmail), ...extractEmailsFromText(bio)]) {
    if (!emails.includes(email)) emails.push(email);
  }
  return emails;
}

export function normalizeEmail(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  if (trimmed.length > MAX_EMAIL_LENGTH) return null;
  const match = trimmed.match(/^([a-z0-9._%+-]+)@([a-z0-9.-]+)\.([a-z]{2,})$/);
  if (!match) return null;
  const [, local, domainBody, tld] = match;
  if (IGNORED_TLDS.has(tld)) return null;
  if (PLATFORM_MENTION_LOCALS.has(local)) return null;
  if (local.endsWith('.') || local.includes('..')) return null;
  const labels = `${domainBody}.${tld}`.split('.');
  if (labels.some((label) => !label || label.startsWith('-') || label.endsWith('-'))) return null;
  return trimmed;
}
