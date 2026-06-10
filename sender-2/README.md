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

## Campaign routing and message templates

Applied in `sql/migrations/010_add_campaign_routing_and_templates.sql`:

- `sender_accounts.campaign` — assign an account to one campaign and it only sends for that campaign. Accounts with `campaign = null` are shared and can be picked by any campaign (campaign-dedicated accounts are preferred over shared ones).
- `campaigns.message_template` — per-campaign default message, editable from the dashboard.
- `sender_runs.message_template` — optional per-run override, set when creating a run from the dashboard.

Message resolution order: run template -> per-account `metadata.message` -> campaign template -> `OUTBOUND_MESSAGE_TEMPLATE`.

Fallback/admin polling is still available:

```bash
npm run sender:run -- --once
```
