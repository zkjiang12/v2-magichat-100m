'use client';

import { useFormState } from 'react-dom';

import { updateSenderAccountAction } from '../actions';
import PendingButton from './PendingButton';

const INITIAL_STATE = { ok: null, message: null, error: null, at: 0 };

export default function AccountManageForm({ account, campaigns }) {
  const [state, formAction] = useFormState(updateSenderAccountAction, INITIAL_STATE);
  return (
    <form action={formAction} className="account-assign-form">
      <input type="hidden" name="username" value={account.username} />
      <select name="status" defaultValue={account.status}>
        <option value="active">active</option>
        <option value="paused">paused</option>
        <option value="blocked">blocked</option>
      </select>
      <input
        name="dailySendLimit"
        type="number"
        min="0"
        max="500"
        defaultValue={account.daily_send_limit}
        title="Daily send limit"
        className="account-limit-input"
      />
      <select name="campaign" defaultValue={account.campaign || ''}>
        <option value="">any campaign</option>
        {campaigns.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <PendingButton className="secondary-button" pendingText="saving…">
        Save
      </PendingButton>
      {state.ok ? (
        <small key={state.at} className="form-success fade-out">
          ✓ saved
        </small>
      ) : null}
      {state.ok === false ? <small className="form-error">{state.error}</small> : null}
    </form>
  );
}
