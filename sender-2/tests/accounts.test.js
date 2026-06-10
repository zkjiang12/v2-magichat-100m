import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadAccountConfigs,
  mergeAccountConfig,
  normalizeUsernameList,
  selectSenderAccount,
} from '../src/accounts.js';

test('normalizeUsernameList strips at signs and empties', () => {
  assert.deepEqual(normalizeUsernameList(['@try_magic_hat', '', ' Zikang_Jiang ']), [
    'try_magic_hat',
    'zikang_jiang',
  ]);
});

test('selectSenderAccount excludes blocked accounts and respects allowed usernames', async () => {
  const pool = {
    async query(sql, params) {
      assert.match(sql, /username <> all/);
      assert.deepEqual(params, [['try_magic_hat'], ['zikang_jiang'], null]);
      return {
        rows: [{
          id: 'account-1',
          username: 'zikang_jiang',
          daily_send_limit: 5,
          sends_today: 1,
          effective_sends_today: 1,
          metadata: { storageState: '/tmp/account-1.json' },
        }],
      };
    },
  };

  const account = await selectSenderAccount(pool, {
    allowedUsernames: ['@zikang_jiang'],
    excludedUsernames: ['try_magic_hat'],
  });

  assert.equal(account.id, 'account-1');
  assert.equal(account.username, 'zikang_jiang');
  assert.equal(account.storageState, '/tmp/account-1.json');
});

test('selectSenderAccount filters and prefers accounts by campaign', async () => {
  const pool = {
    async query(sql, params) {
      assert.match(sql, /campaign is null or campaign = \$3::text/);
      assert.match(sql, /case when \$3::text is not null and campaign = \$3::text then 0 else 1 end asc/);
      assert.deepEqual(params, [['try_magic_hat'], [], 'ugc_creators']);
      return {
        rows: [{
          id: 'account-2',
          username: 'ugc_burner',
          campaign: 'ugc_creators',
          daily_send_limit: 25,
          sends_today: 0,
          effective_sends_today: 0,
          metadata: {},
        }],
      };
    },
  };

  const account = await selectSenderAccount(pool, { campaign: 'ugc_creators' });

  assert.equal(account.username, 'ugc_burner');
  assert.equal(account.campaign, 'ugc_creators');
});

test('loadAccountConfigs resolves storageState relative to config file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sender-accounts-'));
  const configPath = path.join(dir, 'accounts.json');
  fs.mkdirSync(path.join(dir, '.auth'));
  fs.writeFileSync(
    configPath,
    JSON.stringify([{ username: 'Account_One', storageState: '.auth/account-1.json' }]),
  );

  const configs = loadAccountConfigs({ accountsPath: configPath });

  assert.equal(configs.length, 1);
  assert.equal(configs[0].username, 'account_one');
  assert.equal(configs[0].storageState, path.join(dir, '.auth/account-1.json'));
});

test('loadAccountConfigs parses inline storage state JSON', () => {
  const configs = loadAccountConfigs({
    accountsJson: JSON.stringify([{
      username: 'Zikang_Jiang',
      storageStateData: { cookies: [], origins: [] },
    }]),
  });

  assert.equal(configs.length, 1);
  assert.equal(configs[0].username, 'zikang_jiang');
  assert.deepEqual(configs[0].storageState, { cookies: [], origins: [] });
});

test('mergeAccountConfig lets explicit account config override metadata storageState', () => {
  const merged = mergeAccountConfig(
    {
      id: 'account-1',
      username: 'Example',
      metadata: { storageState: '/tmp/from-db.json', minDelay: 10 },
    },
    { storageState: '/tmp/from-config.json', maxDelayMs: 20 },
  );

  assert.equal(merged.username, 'example');
  assert.equal(merged.storageState, '/tmp/from-config.json');
  assert.equal(merged.minDelayMs, 10);
  assert.equal(merged.maxDelayMs, 20);
});
