insert into sender_accounts (username, status, daily_send_limit, metadata)
values ('try_magic_hat', 'paused', 0, '{"reason":"Removed from active sender pool"}'::jsonb)
on conflict (username)
do update set
  status = 'paused',
  daily_send_limit = 0,
  metadata = sender_accounts.metadata || '{"reason":"Removed from active sender pool"}'::jsonb,
  updated_at = now();
