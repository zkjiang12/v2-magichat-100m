alter table send_attempts
  add column if not exists sender_run_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'send_attempts_sender_run_id_fkey'
  ) then
    alter table send_attempts
      add constraint send_attempts_sender_run_id_fkey
      foreign key (sender_run_id) references sender_runs(id) on delete set null;
  end if;
end $$;

create index if not exists send_attempts_sender_run_id_idx
  on send_attempts (sender_run_id, created_at);
