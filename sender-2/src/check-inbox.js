import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

import { getConfig } from './config.js';
import { createPool } from './db.js';
import { loadAccountConfigs, mergeAccountConfig, normalizeUsername } from './accounts.js';

const INBOX_API_PATTERN = /\/api\/v1\/direct_v2\/inbox\//;
const THREAD_API_PATTERN = /\/api\/v1\/direct_v2\/threads\//;
const WEB_APP_ID = '936619743392459';

// --- pure helpers (unit-tested) ---

// IG timestamps arrive as microseconds on web payloads, but be tolerant of
// milliseconds/seconds since shapes drift.
export function igTimestampToDate(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  if (number >= 1e15) return new Date(Math.floor(number / 1000));
  if (number >= 1e12) return new Date(number);
  return new Date(number * 1000);
}

export function describeItem(item = {}) {
  if (item.text) return String(item.text);
  const type = String(item.item_type || 'unknown');
  if (type === 'reel_share' && item.reel_share?.text) return String(item.reel_share.text);
  if (type === 'link' && item.link?.text) return String(item.link.text);
  const labels = {
    like: '[liked a message]',
    media: '[photo/video]',
    media_share: '[shared a post]',
    clip: '[shared a reel]',
    voice_media: '[voice message]',
    animated_media: '[gif]',
    story_share: '[shared a story]',
    reel_share: '[replied to your story]',
    xma_media_share: '[shared a post]',
    placeholder: '[unavailable message]',
  };
  return labels[type] || `[${type}]`;
}

// Merge every captured inbox/thread payload into one map of threads keyed by
// thread id, combining item lists (thread detail payloads carry more history
// than the inbox list does).
export function mergeCapturedThreads(payloads = []) {
  const threads = new Map();
  let viewerId = null;

  for (const payload of payloads) {
    if (!payload || typeof payload !== 'object') continue;
    if (payload.viewer?.pk) viewerId = String(payload.viewer.pk);

    const candidates = [];
    if (Array.isArray(payload.inbox?.threads)) candidates.push(...payload.inbox.threads);
    if (payload.thread && typeof payload.thread === 'object') candidates.push(payload.thread);

    for (const thread of candidates) {
      // thread_id only: it is both the dedupe key in dm_responses and the
      // REST path segment, so a v2-id fallback would corrupt both.
      const threadId = String(thread.thread_id || '');
      if (!threadId) continue;
      if (thread.viewer_id) viewerId = viewerId || String(thread.viewer_id);

      const existing = threads.get(threadId) || {
        threadId,
        viewerId: thread.viewer_id ? String(thread.viewer_id) : null,
        users: [],
        items: new Map(),
      };
      if (!existing.viewerId && thread.viewer_id) existing.viewerId = String(thread.viewer_id);

      for (const user of thread.users || []) {
        if (user?.pk && !existing.users.some((u) => u.pk === String(user.pk))) {
          existing.users.push({ pk: String(user.pk), username: normalizeUsername(user.username) });
        }
      }

      const items = [
        ...(Array.isArray(thread.items) ? thread.items : []),
        ...(thread.last_permanent_item ? [thread.last_permanent_item] : []),
      ];
      for (const item of items) {
        if (item?.item_id) existing.items.set(String(item.item_id), item);
      }

      threads.set(threadId, existing);
    }
  }

  return {
    viewerId,
    threads: [...threads.values()].map((thread) => ({
      ...thread,
      items: [...thread.items.values()],
    })),
  };
}

// Messages authored by the (single) counterpart in a 1:1 thread. Group
// threads return [] — the CRM only tracks direct leads.
export function extractCounterpartMessages(thread, viewerId) {
  if (!thread || thread.users.length !== 1) return [];
  const counterpart = thread.users[0];
  const viewer = String(thread.viewerId || viewerId || '');

  return thread.items
    .filter((item) => {
      const author = String(item.user_id ?? '');
      if (!author || !item.item_id) return false;
      if (viewer && author === viewer) return false;
      return author === counterpart.pk;
    })
    .map((item) => ({
      itemId: String(item.item_id),
      username: counterpart.username,
      text: describeItem(item),
      respondedAt: igTimestampToDate(item.timestamp),
    }))
    .sort((a, b) => (a.respondedAt?.getTime() || 0) - (b.respondedAt?.getTime() || 0));
}

// Map of counterpart handle -> the most recent sent DM row for this account,
// so each response is attributed to the right creator and campaign.
export function buildLeadMap(rows = []) {
  const leads = new Map();
  for (const row of rows) {
    const handle = normalizeUsername(row.handle);
    if (!handle) continue;
    const existing = leads.get(handle);
    if (!existing || new Date(row.sent_at) > new Date(existing.sent_at)) {
      leads.set(handle, row);
    }
  }
  return leads;
}

export function findConfigFor(configs = [], username) {
  const normalized = normalizeUsername(username);
  return configs.find((config) => normalizeUsername(config.username) === normalized) ||
    configs.find((config) => normalizeUsername(config.name) === normalized) ||
    null;
}

export function parseArgs(argv = []) {
  const options = { accounts: [], maxThreads: 25, inboxPages: 3, debugCapture: false };
  const takeValue = (index, name) => {
    const value = argv[index];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${name}`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--account') options.accounts.push(normalizeUsername(takeValue((index += 1), arg)));
    else if (arg.startsWith('--account=')) options.accounts.push(normalizeUsername(arg.slice('--account='.length)));
    else if (arg === '--max-threads') options.maxThreads = Number(takeValue((index += 1), arg));
    else if (arg.startsWith('--max-threads=')) options.maxThreads = Number(arg.slice('--max-threads='.length));
    else if (arg === '--inbox-pages') options.inboxPages = Number(takeValue((index += 1), arg));
    else if (arg.startsWith('--inbox-pages=')) options.inboxPages = Number(arg.slice('--inbox-pages='.length));
    else if (arg === '--debug-capture') options.debugCapture = true;
  }
  if (!Number.isFinite(options.maxThreads) || options.maxThreads < 1) options.maxThreads = 25;
  if (!Number.isFinite(options.inboxPages) || options.inboxPages < 1) options.inboxPages = 3;
  return options;
}

// --- worker ---

export async function runInboxCheck({ pool, config, options }) {
  const accountConfigs = loadAccountConfigs({
    accountsJson: config.accountsJson,
    accountsPath: config.accountsPath,
    authDir: config.authDir,
  });

  const accountsResult = await pool.query(
    `
      select *
      from sender_accounts
      where status in ('active', 'paused')
      order by username asc
    `,
  );

  let accounts = accountsResult.rows
    .map((row) => mergeAccountConfig(row, findConfigFor(accountConfigs, row.username)));
  if (options.accounts.length > 0) {
    accounts = accounts.filter((account) => options.accounts.includes(account.username));
  }

  const skipped = accounts.filter((account) => !account.storageState);
  for (const account of skipped) {
    console.log(`@${account.username}: no storageState configured, skipping.`);
  }
  accounts = accounts.filter((account) => account.storageState);

  if (accounts.length === 0) {
    console.log('No checkable sender accounts found.');
    return [];
  }

  const browser = await chromium.launch({
    headless: config.playwrightHeadless,
    slowMo: config.playwrightSlowMoMs,
  });

  const summaries = [];
  try {
    for (const [index, account] of accounts.entries()) {
      try {
        const summary = await checkAccountInbox({ browser, pool, account, options });
        summaries.push(summary);
        console.log(
          `@${account.username}: ${summary.threadsSeen} threads seen, ` +
          `${summary.leadThreads} lead threads with replies, ${summary.inserted} new messages saved.`,
        );
      } catch (error) {
        summaries.push({ username: account.username, error: error.message });
        console.error(`@${account.username}: inbox check failed - ${error.message}`);
      }
      if (index < accounts.length - 1) await sleep(randomInt(3_000, 8_000));
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return summaries;
}

async function checkAccountInbox({ browser, pool, account, options }) {
  await assertReadableStorageState(account.storageState, account.username);

  const context = await browser.newContext({ storageState: account.storageState });
  const page = await context.newPage();
  const captured = [];

  page.on('response', async (response) => {
    const url = response.url();
    const isDirectApi = INBOX_API_PATTERN.test(url) || THREAD_API_PATTERN.test(url);
    if (options.debugCapture && /\/api\/|\/graphql/.test(url)) {
      console.log(`  [capture] ${response.status()} ${url.slice(0, 140)}`);
    }
    if (!isDirectApi || !response.ok()) return;
    const payload = await response.json().catch(() => null);
    if (payload) captured.push(payload);
  });

  try {
    await page.goto('https://www.instagram.com/direct/inbox/', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await dismissKnownDialogs(page);
    await page.waitForTimeout(3_000);

    // The web client itself talks GraphQL now, so the passive capture above is
    // just a bonus; the direct_v2 REST API still answers session-authenticated
    // requests and is the primary source.
    captured.push(...await fetchInboxPages(page, options.inboxPages));

    if (captured.length === 0) {
      await saveDebugScreenshot(page, account.username);
      throw new Error(
        'No direct_v2 inbox payload captured or fetched. Instagram may have changed its DM API; ' +
        'rerun with --debug-capture to list the endpoints the page calls.',
      );
    }

    const leadRows = await pool.query(
      `
        select c.id as creator_id, c.handle, sq.campaign, sq.sent_at
        from send_queue sq
        join creators c on c.id = sq.creator_id
        where sq.sender_account_id = $1
          and sq.sent_at is not null
      `,
      [account.id],
    );
    const leads = buildLeadMap(leadRows.rows);

    let merged = mergeCapturedThreads(captured);
    const viewerId = merged.viewerId || (await viewerIdFromCookies(context));

    const replyThreads = merged.threads.filter((thread) => {
      if (thread.users.length !== 1) return false;
      if (!leads.has(thread.users[0].username)) return false;
      return extractCounterpartMessages(thread, viewerId).length > 0;
    });

    // Pull fuller history for each replied thread than the inbox list snapshot
    // carries, then re-merge everything captured so far.
    const toOpen = replyThreads.slice(0, options.maxThreads);
    for (const thread of toOpen) {
      const payload = await fetchThreadViaApi(page, thread.threadId);
      if (payload) captured.push(payload);
      await page.waitForTimeout(randomInt(1_500, 4_000));
    }
    merged = mergeCapturedThreads(captured);

    let inserted = 0;
    let leadThreads = 0;
    for (const thread of merged.threads) {
      if (thread.users.length !== 1) continue;
      const lead = leads.get(thread.users[0].username);
      if (!lead) continue;
      const messages = extractCounterpartMessages(thread, viewerId);
      if (messages.length === 0) continue;
      leadThreads += 1;

      for (const message of messages) {
        const result = await pool.query(
          `
            insert into dm_responses (
              creator_id,
              sender_account_id,
              campaign,
              counterpart_username,
              ig_thread_id,
              ig_item_id,
              message_text,
              responded_at
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8)
            on conflict (ig_thread_id, ig_item_id) do nothing
          `,
          [
            lead.creator_id,
            account.id,
            lead.campaign,
            message.username,
            thread.threadId,
            message.itemId,
            message.text,
            message.respondedAt,
          ],
        );
        inserted += result.rowCount;
      }
    }

    return {
      username: account.username,
      threadsSeen: merged.threads.length,
      leadThreads,
      inserted,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function fetchInboxPages(page, maxPages) {
  const payloads = [];
  let cursor = null;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const params = new URLSearchParams({
      persistentBadging: 'true',
      folder: '',
      limit: '20',
      thread_message_limit: '10',
    });
    if (cursor) params.set('cursor', cursor);
    const payload = await fetchDirectApi(page, `https://www.instagram.com/api/v1/direct_v2/inbox/?${params}`);
    if (!payload) break;
    payloads.push(payload);
    cursor = payload.inbox?.oldest_cursor || null;
    if (!payload.inbox?.has_older || !cursor) break;
    await page.waitForTimeout(randomInt(800, 2_000));
  }

  return payloads;
}

async function fetchThreadViaApi(page, threadId) {
  return fetchDirectApi(page, `https://www.instagram.com/api/v1/direct_v2/threads/${threadId}/?limit=20`);
}

async function fetchDirectApi(page, url) {
  const response = await page.request.get(url, {
    headers: { 'x-ig-app-id': WEB_APP_ID, 'x-requested-with': 'XMLHttpRequest' },
  }).catch(() => null);
  if (!response || !response.ok()) return null;
  return response.json().catch(() => null);
}

async function viewerIdFromCookies(context) {
  const cookies = await context.cookies('https://www.instagram.com').catch(() => []);
  const cookie = cookies.find((entry) => entry.name === 'ds_user_id');
  return cookie ? String(cookie.value) : null;
}

async function dismissKnownDialogs(page) {
  const labels = [/^not now$/i, /^allow all cookies$/i, /^decline optional cookies$/i, /^continue$/i];
  for (const label of labels) {
    const button = page.getByRole('button', { name: label }).first();
    if (await button.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await button.click().catch(() => {});
    }
  }
}

async function assertReadableStorageState(storageState, username) {
  if (storageState && typeof storageState === 'object') return;
  const raw = await fs.readFile(storageState, 'utf8');
  if (!raw.trim()) throw new Error(`Storage state for @${username} is empty: ${storageState}`);
  JSON.parse(raw);
}

async function saveDebugScreenshot(page, username) {
  const dir = path.resolve('logs/screenshots');
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const file = path.join(dir, `inbox-${username}-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  console.error(`  Saved debug screenshot: ${file}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

async function main() {
  const config = getConfig();
  const options = parseArgs(process.argv.slice(2));
  const pool = createPool({ databaseUrl: config.databaseUrl });

  try {
    const summaries = await runInboxCheck({ pool, config, options });
    const totals = summaries.reduce(
      (acc, summary) => ({
        inserted: acc.inserted + (summary.inserted || 0),
        failed: acc.failed + (summary.error ? 1 : 0),
      }),
      { inserted: 0, failed: 0 },
    );
    console.log(`Inbox check complete: ${totals.inserted} new messages, ${totals.failed} account failures.`);
    if (totals.failed > 0) process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
