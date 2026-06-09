alter table send_queue drop constraint if exists send_queue_status_check;

alter table send_queue
  add constraint send_queue_status_check
  check (
    status in (
      'ready_for_review',
      'queued',
      'claimed',
      'dry_run',
      'sent',
      'failed_retryable',
      'failed_final',
      'skipped'
    )
  );

create index if not exists send_queue_dry_run_idx
  on send_queue (campaign, status, queued_at);
