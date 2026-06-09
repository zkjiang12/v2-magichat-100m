export function renderMessage(template, creator = {}) {
  return String(template || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => {
    if (key === 'name') return displayNameForCreator(creator);
    return creator[key] ?? creator[toSnakeCase(key)] ?? '';
  });
}

function displayNameForCreator(creator) {
  const displayName = creator.display_name || creator.displayName || creator.name;
  if (displayName) return firstWord(displayName);
  return creator.handle ? `@${creator.handle}` : 'there';
}

function firstWord(value) {
  return String(value).trim().split(/\s+/)[0] || 'there';
}

function toSnakeCase(value) {
  return String(value).replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
