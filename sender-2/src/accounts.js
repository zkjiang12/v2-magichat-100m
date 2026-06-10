import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

export const DEFAULT_EXCLUDED_USERNAMES = ['try_magic_hat'];

export async function loadAccounts(configPath) {
  const resolvedPath = path.resolve(configPath);
  const parsed = JSON.parse(await fs.readFile(resolvedPath, 'utf8'));

  if (!Array.isArray(parsed)) {
    throw new Error('Accounts config must be a JSON array');
  }

  const baseDir = path.dirname(resolvedPath);
  const accounts = [];
  for (const [index, account] of parsed.entries()) {
    accounts.push(await normalizeAccount(account, index, baseDir));
  }
  return accounts;
}

const ACCOUNT_LOCK_STALE_MINUTES = 10;

const ELIGIBLE_ACCOUNT_WHERE = `
      where status = 'active'
        and (cooldown_until is null or cooldown_until <= now())
        and username <> all($1::text[])
        and ($2::text[] = '{}'::text[] or username = any($2::text[]))
        and ($3::text is null or campaign is null or campaign = $3::text)
        and daily_send_limit > case
          when last_sent_at is null then sends_today
          when last_sent_at::date = current_date then sends_today
          else 0
        end
`;

export async function selectSenderAccount(pool, {
  allowedUsernames = [],
  excludedUsernames = DEFAULT_EXCLUDED_USERNAMES,
  accountConfigs = [],
  campaign = null,
} = {}) {
  const normalizedAllowed = normalizeUsernameList(allowedUsernames);
  const normalizedExcluded = normalizeUsernameList(excludedUsernames);

  const result = await pool.query(
    `
      select
        *,
        case
          when last_sent_at is null then sends_today
          when last_sent_at::date = current_date then sends_today
          else 0
        end as effective_sends_today
      from sender_accounts
      ${ELIGIBLE_ACCOUNT_WHERE}
        and (
          locked_by is null
          or locked_at is null
          or locked_at < now() - interval '${ACCOUNT_LOCK_STALE_MINUTES} minutes'
        )
      order by
        case when $3::text is not null and campaign = $3::text then 0 else 1 end asc,
        case when last_sent_at is null then 0 else 1 end asc,
        effective_sends_today asc,
        last_sent_at asc nulls first,
        username asc
      limit 1
    `,
    [normalizedExcluded, normalizedAllowed, campaign || null],
  );

  const account = result.rows[0] || null;
  if (!account) return null;

  return mergeAccountConfig(account, findAccountConfig(accountConfigs, account.username));
}

// Every eligible account with capacity left today, locked ones included
// (callers decide whether a held lock matters).
export async function listEligibleSenderAccounts(pool, {
  allowedUsernames = [],
  excludedUsernames = DEFAULT_EXCLUDED_USERNAMES,
  campaign = null,
} = {}) {
  const result = await pool.query(
    `
      select
        *,
        case
          when last_sent_at is null then sends_today
          when last_sent_at::date = current_date then sends_today
          else 0
        end as effective_sends_today,
        (locked_by is not null and locked_at > now() - interval '${ACCOUNT_LOCK_STALE_MINUTES} minutes') as is_locked
      from sender_accounts
      ${ELIGIBLE_ACCOUNT_WHERE}
      order by
        case when $3::text is not null and campaign = $3::text then 0 else 1 end asc,
        case when last_sent_at is null then 0 else 1 end asc,
        effective_sends_today asc,
        last_sent_at asc nulls first,
        username asc
    `,
    [
      normalizeUsernameList(excludedUsernames),
      normalizeUsernameList(allowedUsernames),
      campaign || null,
    ],
  );
  return result.rows;
}

// Atomically take an account for one worker lane. Stale locks (crashed
// workers) are claimable after ACCOUNT_LOCK_STALE_MINUTES.
export async function lockSenderAccount(pool, { accountId, workerId }) {
  const result = await pool.query(
    `
      update sender_accounts
      set locked_by = $2,
          locked_at = now(),
          updated_at = now()
      where id = $1
        and (
          locked_by is null
          or locked_by = $2
          or locked_at is null
          or locked_at < now() - interval '${ACCOUNT_LOCK_STALE_MINUTES} minutes'
        )
      returning id
    `,
    [accountId, workerId],
  );
  return result.rowCount > 0;
}

export async function refreshSenderAccountLock(pool, { accountId, workerId }) {
  await pool.query(
    `
      update sender_accounts
      set locked_at = now()
      where id = $1 and locked_by = $2
    `,
    [accountId, workerId],
  );
}

export async function unlockSenderAccount(pool, { accountId, workerId }) {
  await pool.query(
    `
      update sender_accounts
      set locked_by = null,
          locked_at = null,
          updated_at = now()
      where id = $1 and locked_by = $2
    `,
    [accountId, workerId],
  );
}

export function loadAccountConfigs({ accountsJson = null, accountsPath = null, authDir = null } = {}) {
  const fromJson = accountsJson ? loadAccountConfigJson(accountsJson) : [];
  if (fromJson.length > 0) return fromJson;

  const fromConfig = accountsPath ? loadAccountConfigFile(accountsPath) : [];
  if (fromConfig.length > 0) return fromConfig;
  return authDir ? discoverAuthDir(authDir) : [];
}

export function normalizeUsernameList(usernames = []) {
  if (!Array.isArray(usernames)) return [];
  return usernames
    .map((username) => normalizeUsername(username))
    .filter(Boolean);
}

export function normalizeUsername(username) {
  return String(username || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
}

export function mergeAccountConfig(account, config = null) {
  const metadata = account.metadata && typeof account.metadata === 'object' ? account.metadata : {};
  const storageState = config?.storageState ||
    metadata.storageState ||
    metadata.storage_state ||
    metadata.storageStateData ||
    metadata.storage_state_data ||
    null;

  return {
    ...account,
    username: normalizeUsername(account.username),
    storageState: normalizeStorageStateValue(storageState),
    message: config?.message || metadata.message || null,
    minDelayMs: numberFrom(config?.minDelayMs ?? config?.minDelay ?? metadata.minDelayMs ?? metadata.minDelay),
    maxDelayMs: numberFrom(config?.maxDelayMs ?? config?.maxDelay ?? metadata.maxDelayMs ?? metadata.maxDelay),
  };
}

async function normalizeAccount(account, index, baseDir) {
  const name = String(account.name || `account-${index + 1}`).trim();
  if (!account.storageState) throw new Error(`${name} is missing storageState`);
  const storageState = path.resolve(baseDir, account.storageState);
  const senderHandle =
    normalizeHandle(account.senderHandle || account.username) ||
    (await inferInstagramHandleFromStorageState(storageState)) ||
    name;

  return {
    ...account,
    name,
    senderHandle,
    storageState,
    message: account.message || null,
    limit: numberOrDefault(account.limit, 25),
    minDelay: numberOrDefault(account.minDelay, 45),
    maxDelay: numberOrDefault(account.maxDelay, 120),
    stopAfterFailures: numberOrDefault(account.stopAfterFailures, 5),
    headless: account.headless !== false,
  };
}

async function inferInstagramHandleFromStorageState(storageState) {
  try {
    const state = JSON.parse(await fs.readFile(storageState, 'utf8'));
    for (const origin of state.origins || []) {
      for (const item of origin.localStorage || []) {
        if (item.name !== 'one_tap_storage_version') continue;
        const parsed = JSON.parse(item.value);
        const username = Object.values(parsed)[0]?.username;
        const normalized = normalizeHandle(username);
        if (normalized) return normalized;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeHandle(value) {
  return String(value || '').trim().replace(/^@/, '');
}

function numberOrDefault(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return number;
}

function loadAccountConfigFile(accountsPath) {
  const resolvedPath = path.resolve(accountsPath);
  if (!fsSync.existsSync(resolvedPath)) {
    throw new Error(`Sender accounts file not found: ${resolvedPath}`);
  }

  const raw = fsSync.readFileSync(resolvedPath, 'utf8').trim();
  if (!raw) return [];

  const parsed = JSON.parse(raw);
  const records = Array.isArray(parsed) ? parsed : Object.values(parsed).flat();
  return records
    .filter((record) => record && typeof record === 'object')
    .map((record) => normalizeAccountConfig(record, path.dirname(resolvedPath)))
    .filter((record) => record.username || record.name);
}

function loadAccountConfigJson(accountsJson) {
  const raw = String(accountsJson || '').trim();
  if (!raw) return [];

  const parsed = JSON.parse(raw);
  const records = Array.isArray(parsed) ? parsed : Object.values(parsed).flat();
  return records
    .filter((record) => record && typeof record === 'object')
    .map((record) => normalizeAccountConfig(record, process.cwd()))
    .filter((record) => record.username || record.name);
}

function discoverAuthDir(authDir) {
  const resolvedDir = path.resolve(authDir);
  if (!fsSync.existsSync(resolvedDir)) return [];

  return fsSync.readdirSync(resolvedDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const storageState = path.join(resolvedDir, name);
      const username = path.basename(name, '.json');
      return {
        name: username,
        username: normalizeUsername(username),
        storageState,
      };
    });
}

function normalizeAccountConfig(record, baseDir) {
  const storageState = record.storageState ||
    record.storage_state ||
    record.storageStateData ||
    record.storage_state_data ||
    record.authPath ||
    record.auth_path;
  return {
    name: record.name || record.account || null,
    username: normalizeUsername(record.username || record.handle || record.senderHandle || record.name),
    storageState: normalizeStorageStateValue(storageState, baseDir),
    message: record.message || null,
    minDelayMs: numberFrom(record.minDelayMs ?? record.minDelay),
    maxDelayMs: numberFrom(record.maxDelayMs ?? record.maxDelay),
  };
}

export function findAccountConfig(configs, username) {
  const normalized = normalizeUsername(username);
  return configs.find((config) => normalizeUsername(config.username) === normalized) ||
    configs.find((config) => normalizeUsername(config.name) === normalized) ||
    null;
}

function normalizeStorageStateValue(value, baseDir = null) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  const stringValue = String(value);
  if (path.isAbsolute(stringValue)) return stringValue;
  return path.resolve(baseDir || '.', stringValue);
}

function numberFrom(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
