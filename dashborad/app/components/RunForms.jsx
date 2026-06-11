'use client';

import { useEffect, useRef } from 'react';
import { useFormState } from 'react-dom';

import { startScraperRunAction, startSenderRunAction } from '../actions';
import PendingButton from './PendingButton';

const INITIAL_STATE = { ok: null, message: null, error: null, at: 0 };

export function FormNotice({ state }) {
  if (!state || state.ok === null) return null;
  if (!state.ok) return <p className="form-error">{state.error}</p>;
  return (
    <p key={state.at} className="form-success fade-out">
      ✓ {state.message || 'Done'}
    </p>
  );
}

function useResetOnSuccess(state) {
  const formRef = useRef(null);
  useEffect(() => {
    if (state.ok && formRef.current) formRef.current.reset();
  }, [state.ok, state.at]);
  return formRef;
}

export function ScraperRunForm({ campaign }) {
  const [state, formAction] = useFormState(startScraperRunAction, INITIAL_STATE);
  const formRef = useResetOnSuccess(state);

  return (
    <form ref={formRef} action={formAction} className="run-form">
      <input type="hidden" name="campaign" value={campaign} />
      <label>
        <span>Seed handles</span>
        <input name="seedHandles" placeholder="yestheory, drewbinsky" />
      </label>
      <div className="form-grid">
        {[
          ['maxAccepted', 'Max accepted', '1000'],
          ['followingLimit', 'Following limit', '2000'],
          ['qualificationWorkers', 'Workers', '32'],
        ].map(([name, label, placeholder]) => (
          <label key={name}>
            <span>{label}</span>
            <input name={name} placeholder={placeholder} />
          </label>
        ))}
      </div>
      <FormNotice state={state} />
      <div className="form-actions">
        <PendingButton pendingText="Creating…">Create run</PendingButton>
      </div>
    </form>
  );
}

export function SenderRunForm({ campaign, eligibleAccounts, campaignTemplate }) {
  const [state, formAction] = useFormState(startSenderRunAction, INITIAL_STATE);
  const formRef = useResetOnSuccess(state);

  return (
    <form ref={formRef} action={formAction} className="run-form">
      <input type="hidden" name="campaign" value={campaign} />
      <div>
        <span>Send from</span>
        <p className="field-hint">None checked = any eligible account for {campaign}.</p>
        {eligibleAccounts.length === 0 ? (
          <p className="muted-copy">
            No sender accounts are assigned to this campaign yet. Assign them in Sender Accounts below.
          </p>
        ) : (
          <div className="account-picker">
            {eligibleAccounts.map((account) => (
              <label key={account.username} className="account-checkbox">
                <input type="checkbox" name="accountUsernames" value={account.username} />
                <span className="account-handle">@{account.username}</span>
                <span className="account-pill">{account.campaign ? account.campaign : 'shared'}</span>
                {account.status !== 'active' ? (
                  <span className="account-pill warn">{account.status}</span>
                ) : null}
                <span className="account-usage">
                  {account.sends_today || 0}/{account.daily_send_limit} today
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
      <label>
        <span>Message for this run (blank = campaign template)</span>
        <textarea name="messageTemplate" rows={3} defaultValue={campaignTemplate} placeholder="Hey {name}, ..." />
      </label>
      <div className="form-grid">
        <label className="narrow-field">
          <span>Max sends</span>
          <input name="maxSends" placeholder="25" />
        </label>
      </div>
      <FormNotice state={state} />
      <div className="form-actions">
        <PendingButton pendingText="Creating…">Create run</PendingButton>
      </div>
    </form>
  );
}
