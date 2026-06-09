# MagicHat Dashboard

The dashboard is the normal production trigger for scraper and sender runs.

```text
dashboard button -> Postgres run row -> Cloud Run Job with exact run id
```

Postgres is the source of truth for business progress and counters. Google Cloud Run is the source of truth for whether the worker execution started, is running, succeeded, or failed.

## Required Env

```text
DATABASE_URL=postgresql://...
OUTBOUND_CAMPAIGN=day_in_life_creators
DATABASE_POOL_MAX=2
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

## Scraper Cloud Run

```text
SCRAPER_CLOUD_RUN_PROJECT_ID=...
SCRAPER_CLOUD_RUN_REGION=...
SCRAPER_CLOUD_RUN_JOB_NAME=...
```

The dashboard triggers:

```bash
npm run crawl -- --run-id <scraper_run_id>
```

## Sender Cloud Run

```text
SENDER_CLOUD_RUN_PROJECT_ID=...
SENDER_CLOUD_RUN_REGION=...
SENDER_CLOUD_RUN_JOB_NAME=...
```

The dashboard triggers the sender Cloud Run job:

```bash
npm run sender:run -- --run-id <sender_run_id> --once
```

By default, the dashboard passes `SENDER_PROVIDER=dry-run`. To run live Playwright sends from dashboard-triggered Cloud Run jobs, configure:

```text
SENDER_CLOUD_RUN_PROVIDER=instagram-playwright
SENDER_LIVE_SENDS_ENABLED=true
```

Apply the sender cloud metadata migration before deploying:

```bash
psql "$DATABASE_URL" -f ../sender-2/sql/migrations/009_add_sender_cloud_trigger_metadata.sql
```
