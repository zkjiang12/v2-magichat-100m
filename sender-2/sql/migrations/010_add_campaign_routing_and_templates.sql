-- Campaign-scoped sender accounts and per-campaign/per-run message templates.

alter table sender_accounts
  add column if not exists campaign text;

alter table sender_runs
  add column if not exists message_template text;

create table if not exists campaigns (
  name text primary key,
  message_template text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table campaigns enable row level security;

insert into campaigns (name)
values ('day_in_life_creators'), ('ugc_creators')
on conflict (name) do nothing;
