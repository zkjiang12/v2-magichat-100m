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

## Inbox checking (CRM responses)

Reads each sender account's DM inbox (read-only, using the same saved sessions as
the sender) and records replies from creators we DM'd into `dm_responses`. The
`/crm` dashboard page is built on this table.

```bash
npm run check-inbox                          # all active/paused accounts
npm run check-inbox -- --account some_acct   # one account (use this to test)
npm run check-inbox -- --inbox-pages=5       # paginate deeper than the default 60 threads
npm run check-inbox -- --debug-capture       # log every API endpoint the page calls
```

How it works: it opens `instagram.com/direct/inbox/` with the account's saved
session, then queries Instagram's `direct_v2` inbox API through that page
session (3 pages of 20 threads by default), keeps 1:1 threads whose
counterpart matches a creator with a sent DM from that account, pulls those
threads' recent history, and inserts the counterpart's messages (deduped by IG
thread+item id, so reruns are safe). Group threads, message requests, and
people we never DM'd are ignored.

Apply the CRM migration first:

```bash
psql "$DATABASE_URL" -f sql/migrations/013_add_dm_responses_and_lead_statuses.sql
```
