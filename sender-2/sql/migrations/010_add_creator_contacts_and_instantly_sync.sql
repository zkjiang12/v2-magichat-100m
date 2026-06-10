-- Contact info captured from Instagram profiles (bio text + business contact email),
-- plus per-campaign tracking of leads pushed to Instantly.ai.

alter table creators
  add column if not exists bio text,
  add column if not exists emails text[] not null default '{}'::text[],
  add column if not exists contact_scraped_at timestamptz;

create table if not exists instantly_sync (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creators(id) on delete cascade,
  campaign text not null,
  email text not null,
  instantly_campaign_id text not null,
  instantly_lead_id text,
  status text not null check (status in ('pushed', 'skipped', 'failed')),
  error text,
  pushed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (creator_id, campaign, email)
);

create index if not exists instantly_sync_campaign_status_idx
  on instantly_sync (campaign, status, created_at desc);

create index if not exists creators_has_email_idx
  on creators ((coalesce(array_length(emails, 1), 0) > 0));

alter table instantly_sync enable row level security;
