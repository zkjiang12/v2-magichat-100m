#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright';
import { createPool } from './db.js';
import { upsertSenderAccount } from './queue.js';
import { normalizeUsername } from './accounts.js';
import { loadLocalEnv } from './config.js';

loadLocalEnv();

const LOGIN_URL = 'https://www.instagram.com/accounts/login/';
const HOME_URL = 'https://www.instagram.com/';
const LOGIN_POLL_MS = 2000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const DEFAULTS = {
  limit: 25,
  minDelay: 45,
  maxDelay: 120,
  stopAfterFailures: 5,
  headless: true,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = path.resolve(args.config);
  const authDir = path.resolve(path.dirname(configPath), args.authDir);
  await fs.mkdir(authDir, { recursive: true });

  const pool = process.env.DATABASE_URL
    ? createPool({ databaseUrl: process.env.DATABASE_URL })
    : null;
  if (!pool) {
    console.log('DATABASE_URL not set; will update the accounts config only (DB row is created on first send anyway).');
  }

  console.log(`Accounts config: ${configPath}`);
  console.log(`Auth dir: ${authDir}`);
  console.log('A browser window is opening. Log into the Instagram account you want to add.');
  console.log('Close the browser window (or Ctrl+C) when you are done adding accounts.\n');

  const browser = await chromium.launch({ headless: false });
  let browserClosed = false;
  browser.on('disconnected', () => {
    browserClosed = true;
  });

  try {
    while (!browserClosed) {
      const added = await captureOneAccount({ browser, configPath, authDir, pool });
      if (!added) break;
      console.log('\nReady for the next account — log in again, or close the browser to finish.\n');
    }
  } finally {
    if (!browserClosed) await browser.close().catch(() => {});
    if (pool) await pool.end();
  }
}

async function captureOneAccount({ browser, configPath, authDir, pool }) {
  let context;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    const loggedIn = await waitForLogin(context);
    if (!loggedIn) return false;
    console.log('Login detected; looking up username...');

    const username = await resolveUsername(page);
    const storageStatePath = path.join(authDir, `${username}.json`);
    await context.storageState({ path: storageStatePath });
    console.log(`✓ Saved session to ${storageStatePath}`);

    await upsertAccountConfig({ configPath, username, storageStatePath });
    console.log(`✓ Updated accounts config entry for @${username}`);

    if (pool) {
      await upsertSenderAccount(pool, {
        username,
        dailySendLimit: DEFAULTS.limit,
        metadata: {
          label: username,
          storageState: storageStatePath,
          minDelay: DEFAULTS.minDelay,
          maxDelay: DEFAULTS.maxDelay,
        },
      });
      console.log(`✓ Upserted sender_accounts row for @${username}`);
    }

    return true;
  } catch (error) {
    if (isBrowserGone(error)) return false;
    throw error;
  } finally {
    await context?.close().catch(() => {});
  }
}

async function waitForLogin(context) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const cookies = await context.cookies('https://www.instagram.com');
    const names = new Set(cookies.map((cookie) => cookie.name));
    if (names.has('sessionid') && names.has('ds_user_id')) return true;
    await sleep(LOGIN_POLL_MS);
  }
  return false;
}

// Reads the logged-in handle straight from the home feed's DOM — the nav profile-picture
// link and the embedded page JSON both carry it. No Instagram API call (which fails on
// interstitials and trips "useragent mismatch"), so this works right after any login.
async function resolveUsername(page) {
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = await page
      .evaluate(() => {
        const link = [...document.querySelectorAll('img[alt$="profile picture" i]')]
          .map((img) => img.closest('a')?.getAttribute('href'))
          .find((href) => /^\/[a-z0-9._]+\/$/i.test(href || ''));
        if (link) return link.replace(/\//g, '');

        const match = document.documentElement.innerHTML.match(/"username":"([a-z0-9._]+)"/i);
        return match?.[1] || null;
      })
      .catch(() => null);

    const normalized = normalizeUsername(candidate);
    if (normalized) return normalized;
    await sleep(2000);
  }

  // Detection should normally succeed; fall back to asking only if the DOM shape changed.
  console.log('Could not read the username from the page automatically.');
  const typed = await promptForUsername();
  const normalized = normalizeUsername(typed);
  if (!normalized) throw new Error('No username provided; skipping this account.');
  return normalized;
}

async function promptForUsername() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question('Type the Instagram username you just logged into (or press Enter to skip): ')).trim();
  } finally {
    rl.close();
  }
}

function isBrowserGone(error) {
  const message = String(error?.message || '');
  return message.includes('Target page, context or browser has been closed') ||
    message.includes('Target closed') ||
    message.includes('browser has been closed');
}

async function upsertAccountConfig({ configPath, username, storageStatePath }) {
  let accounts = [];
  try {
    accounts = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (!Array.isArray(accounts)) throw new Error(`Accounts config must be a JSON array: ${configPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const relativeStorageState = path.relative(path.dirname(configPath), storageStatePath);
  const entry = {
    name: username,
    senderHandle: username,
    storageState: relativeStorageState,
    limit: DEFAULTS.limit,
    minDelay: DEFAULTS.minDelay,
    maxDelay: DEFAULTS.maxDelay,
    stopAfterFailures: DEFAULTS.stopAfterFailures,
    headless: DEFAULTS.headless,
  };

  const existingIndex = accounts.findIndex((account) => {
    const handle = normalizeUsername(account.senderHandle || account.username || account.name);
    return handle === username;
  });

  if (existingIndex >= 0) {
    accounts[existingIndex] = { ...accounts[existingIndex], storageState: relativeStorageState };
  } else {
    accounts.push(entry);
  }

  await fs.writeFile(configPath, `${JSON.stringify(accounts, null, 2)}\n`);
}

function parseArgs(argv) {
  const args = {
    config: process.env.SENDER_ACCOUNTS_CONFIG_PATH || '../../v1/sender-1/accounts-all.json',
    authDir: '.auth',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === '--config') {
      if (!value || value.startsWith('--')) throw new Error('Missing value for --config');
      args.config = value;
      index += 1;
    } else if (arg === '--auth-dir') {
      if (!value || value.startsWith('--')) throw new Error('Missing value for --auth-dir');
      args.authDir = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
