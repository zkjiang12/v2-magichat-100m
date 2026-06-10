import fs from 'node:fs';
import path from 'node:path';

loadLocalEnv();

export function getConfig() {
  const config = {
    databaseUrl: process.env.DATABASE_URL,
    provider: process.env.SENDER_PROVIDER || 'dry-run',
    liveSendsEnabled: booleanEnv('SENDER_LIVE_SENDS_ENABLED', false),
    workerId: process.env.SENDER_WORKER_ID || `sender-${process.pid}`,
    batchSize: numberEnv('SENDER_BATCH_SIZE', 1),
    pollIntervalMs: numberEnv('SENDER_POLL_INTERVAL_MS', 5000),
    maxSends: nullableNumberEnv('SENDER_MAX_SENDS'),
    markDryRunAsSent: booleanEnv('SENDER_MARK_DRY_RUN_AS_SENT', false),
    accountsPath: process.env.SENDER_ACCOUNTS_PATH || null,
    accountsJson: process.env.SENDER_ACCOUNTS_JSON || null,
    authDir: process.env.SENDER_AUTH_DIR || null,
    excludedSenderUsernames: listEnv('SENDER_EXCLUDED_USERNAMES', ['try_magic_hat']),
    playwrightHeadless: booleanEnv('SENDER_PLAYWRIGHT_HEADLESS', true),
    playwrightSlowMoMs: numberEnv('SENDER_PLAYWRIGHT_SLOW_MO_MS', 0),
    sendMinDelayMs: numberEnv('SENDER_SEND_MIN_DELAY_MS', 45_000),
    sendMaxDelayMs: numberEnv('SENDER_SEND_MAX_DELAY_MS', 120_000),
    screenshotDir: process.env.SENDER_SCREENSHOT_DIR || 'logs/screenshots',
    campaign: process.env.OUTBOUND_CAMPAIGN || 'day_in_life_creators',
    messageTemplate:
      process.env.OUTBOUND_MESSAGE_TEMPLATE ||
      'Hey {name}, loved your day-in-the-life content. Would be interested in chatting about MagicHat?',
    scraperStatePath: process.env.SCRAPER_STATE_PATH || '../scraper-2/data/frontier-crawl-state.json',
    importEnqueueStatus: process.env.IMPORT_ENQUEUE_STATUS || 'queued',
  };

  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!['ready_for_review', 'queued'].includes(config.importEnqueueStatus)) {
    missing.push('IMPORT_ENQUEUE_STATUS must be ready_for_review or queued');
  }
  if (config.batchSize < 1) missing.push('SENDER_BATCH_SIZE must be >= 1');
  if (config.pollIntervalMs < 250) missing.push('SENDER_POLL_INTERVAL_MS must be >= 250');
  if (config.sendMinDelayMs < 0) missing.push('SENDER_SEND_MIN_DELAY_MS must be >= 0');
  if (config.sendMaxDelayMs < config.sendMinDelayMs) {
    missing.push('SENDER_SEND_MAX_DELAY_MS must be >= SENDER_SEND_MIN_DELAY_MS');
  }

  if (missing.length > 0) {
    throw new Error(`Missing or invalid environment values: ${missing.join(', ')}`);
  }

  return config;
}

export function loadLocalEnv() {
  const envPath = path.resolve('.env');
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value.replace(/^["']|["']$/g, '');
    }
  }
}

function numberEnv(name, fallback) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function nullableNumberEnv(name) {
  if (process.env[name] === undefined || process.env[name] === '') return null;
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function booleanEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean`);
}

function listEnv(name, fallback = []) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
