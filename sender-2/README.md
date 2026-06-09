# MagicHat Sender 2

The dashboard-triggered production path is a bounded sender run:

```text
dashboard creates sender_runs row -> Cloud Run starts this exact run id -> sender exits
```

Run a specific sender run:

```bash
npm run sender:run -- --run-id <sender_run_id> --once
```

The dashboard Cloud Run trigger defaults to `SENDER_PROVIDER=dry-run`. To enable live sending, set both:

```text
SENDER_CLOUD_RUN_PROVIDER=instagram-playwright
SENDER_LIVE_SENDS_ENABLED=true
```

Live mode uses Playwright storage state from `sender_accounts.metadata.storageState` or from `SENDER_ACCOUNTS_PATH`. The `try_magic_hat` account is excluded by default.

Required environment:

```text
DATABASE_URL
OUTBOUND_CAMPAIGN=day_in_life_creators
OUTBOUND_MESSAGE_TEMPLATE
SENDER_PROVIDER=dry-run
SENDER_LIVE_SENDS_ENABLED=false
SENDER_EXCLUDED_USERNAMES=try_magic_hat
SENDER_PLAYWRIGHT_HEADLESS=true
SENDER_SEND_MIN_DELAY_MS=45000
SENDER_SEND_MAX_DELAY_MS=120000
```

Apply the sender cloud metadata migration:

```bash
psql "$DATABASE_URL" -f sql/migrations/009_add_sender_cloud_trigger_metadata.sql
```

Fallback/admin polling is still available:

```bash
npm run sender:run -- --once
```
