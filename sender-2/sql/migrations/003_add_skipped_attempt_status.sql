alter table send_attempts drop constraint if exists send_attempts_status_check;

alter table send_attempts
  add constraint send_attempts_status_check
  check (
    status in (
      'dry_run',
      'sent',
      'skipped',
      'failed_retryable',
      'failed_final'
    )
  );
