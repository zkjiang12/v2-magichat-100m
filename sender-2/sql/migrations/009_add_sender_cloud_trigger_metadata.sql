alter table sender_runs
  add column if not exists worker_target text,
  add column if not exists cloud_operation_name text,
  add column if not exists cloud_triggered_at timestamptz,
  add column if not exists cloud_trigger_error text;
