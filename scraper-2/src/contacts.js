const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

// Matches like "logo@2x.png" are filenames, not contactable addresses.
const IGNORED_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'mov', 'heic']);

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
  const match = trimmed.match(/^[a-z0-9._%+-]+@[a-z0-9.-]+\.([a-z]{2,})$/);
  if (!match) return null;
  if (IGNORED_TLDS.has(match[1])) return null;
  return trimmed;
}
