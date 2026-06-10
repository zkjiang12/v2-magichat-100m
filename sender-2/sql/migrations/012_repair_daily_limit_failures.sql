-- One-time repair: requeue creators that were marked failed purely because
-- every sender account had hit its daily limit (the old run loop churned
-- through the queue burning attempts instead of pausing). Restores their
-- full retry budget. Never touches sent/skipped rows.

update send_queue
set status = 'queued',
    attempt_count = 0,
    retry_after = null,
    last_error = null,
    claimed_by = null,
    claimed_at = null,
    updated_at = now()
where status in ('failed_retryable', 'failed_final')
  and last_error like 'No eligible sender account%';
