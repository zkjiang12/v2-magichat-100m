'use client';

import { useFormState } from 'react-dom';

import {
  commandRunAction,
  extendRunAction,
  requeueAllFailuresAction,
  retryRunFailuresAction,
  startScraperRunAction,
  startSenderRunAction,
} from '../actions';
import PendingButton from './PendingButton';

const INITIAL_STATE = { ok: null, message: null, error: null, at: 0 };

const COMMAND_PENDING_LABELS = {
  pause: 'pausing…',
  resume: 'resuming…',
  stop: 'stopping…',
};

function InlineError({ state }) {
  if (!state || state.ok !== false) return null;
  return <small className="form-error">{state.error}</small>;
}

export function CommandButton({ campaign, runType, runId, command }) {
  const [state, formAction] = useFormState(commandRunAction, INITIAL_STATE);
  return (
    <form action={formAction}>
      <input type="hidden" name="campaign" value={campaign} />
      <input type="hidden" name="runType" value={runType} />
      <input type="hidden" name="runId" value={runId} />
      <input type="hidden" name="command" value={command} />
      <PendingButton className="secondary-button" pendingText={COMMAND_PENDING_LABELS[command] || 'working…'}>
        {command}
      </PendingButton>
      <InlineError state={state} />
    </form>
  );
}

export function ExtendRunForm({ campaign, runId }) {
  const [state, formAction] = useFormState(extendRunAction, INITIAL_STATE);
  return (
    <form action={formAction}>
      <input type="hidden" name="campaign" value={campaign} />
      <input type="hidden" name="runId" value={runId} />
      <input name="addAccepted" placeholder="+500" style={{ width: '64px' }} />
      <PendingButton className="secondary-button" pendingText="extending…">
        extend
      </PendingButton>
      <InlineError state={state} />
    </form>
  );
}

export function RetryFailedButton({ campaign, runId, count }) {
  const [state, formAction] = useFormState(retryRunFailuresAction, INITIAL_STATE);
  return (
    <form action={formAction}>
      <input type="hidden" name="campaign" value={campaign} />
      <input type="hidden" name="runId" value={runId} />
      <PendingButton className="secondary-button" pendingText="requeuing…">
        retry {count} failed
      </PendingButton>
      <InlineError state={state} />
    </form>
  );
}

export function RequeueAllButton({ campaign, count }) {
  const [state, formAction] = useFormState(requeueAllFailuresAction, INITIAL_STATE);
  return (
    <form action={formAction} className="run-tab-action">
      <input type="hidden" name="campaign" value={campaign} />
      <PendingButton className="secondary-button" pendingText="requeuing…">
        Requeue all {count} failed
      </PendingButton>
      <InlineError state={state} />
    </form>
  );
}

// Re-launches a finished run with its original settings, no retyping.
export function RunAgainButton({ kind, campaign, settings }) {
  const action = kind === 'scraper' ? startScraperRunAction : startSenderRunAction;
  const [state, formAction] = useFormState(action, INITIAL_STATE);
  return (
    <form action={formAction}>
      <input type="hidden" name="campaign" value={campaign} />
      {kind === 'scraper' ? (
        <>
          <input type="hidden" name="seedHandles" value={settings.seedHandles} />
          <input type="hidden" name="maxAccepted" value={settings.maxAccepted ?? ''} />
          <input type="hidden" name="followingLimit" value={settings.followingLimit ?? ''} />
          <input type="hidden" name="qualificationWorkers" value={settings.qualificationWorkers ?? ''} />
        </>
      ) : (
        <>
          {(settings.accountUsernames || []).map((username) => (
            <input key={username} type="hidden" name="accountUsernames" value={username} />
          ))}
          <input type="hidden" name="maxSends" value={settings.maxSends ?? ''} />
          <input type="hidden" name="messageTemplate" value={settings.messageTemplate ?? ''} />
        </>
      )}
      <PendingButton className="secondary-button" pendingText="creating…">
        run again
      </PendingButton>
      <InlineError state={state} />
    </form>
  );
}
