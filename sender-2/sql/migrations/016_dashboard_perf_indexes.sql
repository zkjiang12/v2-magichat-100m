-- Dashboard chart/feed queries filter by campaign + time range; the existing
-- scrape_events index has event_type in the middle so range scans can't use it.
-- NOTE: `concurrently` cannot run inside a transaction block. Apply with:
--   psql "$DATABASE_URL" -f sql/migrations/016_dashboard_perf_indexes.sql

create index concurrently if not exists scrape_events_campaign_at_idx
  on scrape_events (campaign, event_at desc);

create index concurrently if not exists send_attempts_created_at_idx
  on send_attempts (created_at);

create index concurrently if not exists send_queue_campaign_status_idx
  on send_queue (campaign, status);
