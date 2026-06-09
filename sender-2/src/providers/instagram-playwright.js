import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { loadAccountConfigs, selectSenderAccount } from '../accounts.js';

export function createInstagramPlaywrightProvider({ pool, config }) {
  if (!pool) throw new Error('Instagram Playwright provider requires a database pool.');
  if (!config?.liveSendsEnabled) {
    throw new Error(
      'Refusing to enable live Instagram sender. Set SENDER_PROVIDER=instagram-playwright and SENDER_LIVE_SENDS_ENABLED=true explicitly.',
    );
  }

  const accountConfigs = loadAccountConfigs({
    accountsJson: config.accountsJson,
    accountsPath: config.accountsPath,
    authDir: config.authDir,
  });

  return new InstagramPlaywrightProvider({ pool, config, accountConfigs });
}

class InstagramPlaywrightProvider {
  name = 'instagram-playwright';

  constructor({ pool, config, accountConfigs }) {
    this.pool = pool;
    this.config = config;
    this.accountConfigs = accountConfigs;
    this.browser = null;
    this.sessions = new Map();
    this.lastScreenshot = null;
  }

  async sendMessage({ creator, message, senderRun = null }) {
    const account = await selectSenderAccount(this.pool, {
      allowedUsernames: senderRun?.account_usernames || [],
      excludedUsernames: this.config.excludedSenderUsernames,
      accountConfigs: this.accountConfigs,
    });

    if (!account) {
      throw new Error('No eligible sender account is under its daily limit.');
    }

    if (!account.storageState) {
      throw new Error(`Sender account @${account.username} has no storageState configured.`);
    }

    await assertReadableStorageState(account.storageState, `storage state for @${account.username}`);

    const session = await this.getSession(account);
    const page = session.page;
    const username = normalizeUsername(creator.handle);

    await openConversation(page, username);

    if (await hasExistingMessage(page, message)) {
      return {
        skipped: true,
        reason: 'Exact message already visible in thread.',
        provider: this.name,
        senderAccount: accountSummary(account),
      };
    }

    await typeAndSend(page, message);
    if (!(await hasExistingMessage(page, message))) {
      throw new Error('Message was submitted, but the sent text was not visible afterward.');
    }

    await delayAfterSend(account, this.config);

    return {
      skipped: false,
      provider: this.name,
      username,
      senderAccount: accountSummary(account),
      sentAt: new Date().toISOString(),
    };
  }

  async screenshot(username) {
    const activeSession = [...this.sessions.values()].find((session) => session.page);
    if (!activeSession) return this.lastScreenshot;

    await fs.mkdir(path.resolve(this.config.screenshotDir), { recursive: true });
    const screenshotPath = path.resolve(
      this.config.screenshotDir,
      `failed-${safeFilename(username)}-${Date.now()}.png`,
    );
    await activeSession.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);
    this.lastScreenshot = screenshotPath;
    return screenshotPath;
  }

  async close() {
    for (const session of this.sessions.values()) {
      await session.context?.close().catch(() => {});
    }
    this.sessions.clear();
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }

  async getSession(account) {
    const key = account.username;
    const existing = this.sessions.get(key);
    if (existing) return existing;

    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: this.config.playwrightHeadless,
        slowMo: this.config.playwrightSlowMoMs,
      });
    }

    const context = await this.browser.newContext({ storageState: account.storageState });
    const page = await context.newPage();
    const session = { account, context, page };
    this.sessions.set(key, session);
    return session;
  }
}

async function openConversation(page, username) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await page.goto(`https://www.instagram.com/${username}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await dismissKnownDialogs(page);
    await page.waitForTimeout(2_000);

    const clickedMessage = await clickFirstVisible(page, [
      page.locator("main div[role='button']").filter({ hasText: /^Message$/ }).first(),
      page.getByRole('button', { name: /^message$/i }).first(),
      page.getByRole('link', { name: /^message$/i }).first(),
      page.locator("div[role='button']").filter({ hasText: /^Message$/ }).first(),
    ]);

    if (!clickedMessage) {
      await page.goto(`https://www.instagram.com/direct/t/${username}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
    }

    await dismissKnownDialogs(page, { includeClose: false });

    try {
      await waitForComposer(page, { timeoutMs: 30_000 });
      return;
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      console.log(`DM composer did not open for @${username}; retrying (${attempt + 1}/${maxAttempts}).`);
    }
  }

  throw new Error('Could not find DM composer. Instagram UI may have changed, or this profile cannot be messaged.');
}

async function typeAndSend(page, message) {
  const composer = await waitForComposer(page);
  await composer.click();
  await composer.fill(message).catch(async () => {
    await composer.pressSequentially(message, { delay: 15 });
  });

  const sendButton = page.getByRole('button', { name: /^send$/i }).last();
  if (await sendButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await sendButton.click();
    await page.waitForTimeout(1_500);
    return;
  }

  await composer.press('Enter');
  await page.waitForTimeout(1_500);
}

async function waitForComposer(page, { timeoutMs = 45_000 } = {}) {
  const selectors = [
    "[role='textbox'][contenteditable='true'][aria-label='Message']",
    "div[contenteditable='true'][role='textbox']",
    "[role='textbox'][contenteditable='true']",
    "input[placeholder*='Message']",
    "textarea[placeholder*='Message']",
    "[aria-label='Message'][contenteditable='true']",
    "[contenteditable='true']",
  ];

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = await firstVisible(page.locator(selector));
      if (locator) return locator;
    }
    await page.waitForTimeout(500);
  }

  throw new Error('Could not find DM composer. Instagram UI may have changed, or this profile cannot be messaged.');
}

async function firstVisible(locator) {
  const count = await locator.count().catch(() => 0);

  for (let index = count - 1; index >= 0; index -= 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible({ timeout: 100 }).catch(() => false)) {
      return candidate;
    }
  }

  return null;
}

async function dismissKnownDialogs(page, { includeClose = false } = {}) {
  const labels = [/^not now$/i, /^allow all cookies$/i, /^decline optional cookies$/i, /^continue$/i];
  if (includeClose) labels.push(/^close$/i);

  for (const label of labels) {
    const button = page.getByRole('button', { name: label }).first();
    if (await button.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await button.click().catch(() => {});
    }
  }
}

async function clickFirstVisible(page, locators) {
  const deadline = Date.now() + 12_000;

  while (Date.now() < deadline) {
    for (const locator of locators) {
      if (await locator.isVisible({ timeout: 500 }).catch(() => false)) {
        await locator.click();
        return true;
      }
    }
    await page.waitForTimeout(500);
  }

  return false;
}

async function hasExistingMessage(page, message) {
  const normalizedMessage = normalizeText(message);
  if (!normalizedMessage) return false;

  const visibleText = await page.locator('body').evaluate((body) => body.innerText || '').catch(() => '');
  return normalizeText(visibleText).includes(normalizedMessage);
}

async function assertReadableStorageState(storageState, label) {
  if (storageState && typeof storageState === 'object') return;
  const raw = await fs.readFile(storageState, 'utf8');
  if (!raw.trim()) throw new Error(`Configured ${label} is empty: ${storageState}`);
  JSON.parse(raw);
}

async function delayAfterSend(account, config) {
  const minDelayMs = account.minDelayMs ?? config.sendMinDelayMs;
  const maxDelayMs = account.maxDelayMs ?? config.sendMaxDelayMs;
  const delayMs = randomInt(minDelayMs, maxDelayMs);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function randomInt(min, max) {
  const low = Math.ceil(Number(min) || 0);
  const high = Math.floor(Number(max) || low);
  if (high <= low) return low;
  return low + Math.floor(Math.random() * (high - low + 1));
}

function accountSummary(account) {
  return {
    id: account.id,
    username: account.username,
    dailySendLimit: account.daily_send_limit,
    sendsToday: Number(account.effective_sends_today ?? account.sends_today ?? 0),
  };
}

function normalizeUsername(username) {
  return String(username || '')
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .split(/[/?#]/)[0];
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeFilename(value) {
  return String(value || 'unknown').replace(/[^a-z0-9_.-]+/gi, '_');
}
