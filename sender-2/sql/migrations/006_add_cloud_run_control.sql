create table if not exists scraper_runs (
  id uuid primary key default gen_random_uuid(),
  campaign text not null default 'day_in_life_creators',
  status text not null default 'requested' check (
    status in ('requested', 'running', 'pause_requested', 'paused', 'stop_requested', 'stopped', 'completed', 'failed')
  ),
  seed_handles text[] not null default '{}'::text[],
  max_accepted integer not null default 1000,
  following_limit integer,
  qualification_workers integer not null default 32,
  state jsonb not null default '{}'::jsonb,
  counters jsonb not null default '{}'::jsonb,
  error text,
  requested_by text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sender_runs (
  id uuid primary key default gen_random_uuid(),
  campaign text not null default 'day_in_life_creators',
  status text not null default 'requested' check (
    status in ('requested', 'running', 'pause_requested', 'paused', 'stop_requested', 'stopped', 'completed', 'failed')
  ),
  account_usernames text[] not null default '{}'::text[],
  max_sends integer,
  config jsonb not null default '{}'::jsonb,
  counters jsonb not null default '{}'::jsonb,
  error text,
  requested_by text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists run_commands (
  id uuid primary key default gen_random_uuid(),
  campaign text not null default 'day_in_life_creators',
  run_type text not null check (run_type in ('scraper', 'sender')),
  run_id uuid not null,
  command text not null check (command in ('pause', 'resume', 'stop')),
  status text not null default 'pending' check (status in ('pending', 'applied', 'failed')),
  payload jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  applied_at timestamptz
);

create index if not exists scraper_runs_campaign_status_idx
  on scraper_runs (campaign, status, created_at desc);

create index if not exists sender_runs_campaign_status_idx
  on sender_runs (campaign, status, created_at desc);

create index if not exists run_commands_pending_idx
  on run_commands (run_type, run_id, status, created_at);

alter table scraper_runs enable row level security;
alter table sender_runs enable row level security;
alter table run_commands enable row level security;
