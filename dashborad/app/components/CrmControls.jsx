'use client';

import { useFormState, useFormStatus } from 'react-dom';

import { saveNoteAction, setLeadStatusAction } from '../actions';
import PendingButton from './PendingButton';

const INITIAL_STATE = { ok: null, message: null, error: null, at: 0 };

function StatusButton({ status, label, active }) {
  const { pending, data } = useFormStatus();
  const isThisOne = pending && data && data.get('status') === status;
  return (
    <button
      type="submit"
      name="status"
      value={status}
      className={`secondary-button${active ? ' active' : ''}`}
      disabled={pending}
    >
      {isThisOne ? '…' : label}
    </button>
  );
}

export function LeadStatusButtons({ handle, campaign, currentStatus, statuses, labels }) {
  const [state, formAction] = useFormState(setLeadStatusAction, INITIAL_STATE);
  return (
    <form action={formAction} className="crm-status-buttons">
      <input type="hidden" name="handle" value={handle} />
      <input type="hidden" name="campaign" value={campaign} />
      {statuses.map((status) => (
        <StatusButton key={status} status={status} label={labels[status]} active={currentStatus === status} />
      ))}
      {state.ok === false ? <small className="form-error">{state.error}</small> : null}
    </form>
  );
}

export function NoteForm({ handle, campaign, note, placeholder = 'Add a note...' }) {
  const [state, formAction] = useFormState(saveNoteAction, INITIAL_STATE);
  return (
    <form action={formAction} className="run-form">
      <input type="hidden" name="handle" value={handle} />
      <input type="hidden" name="campaign" value={campaign} />
      <textarea name="note" defaultValue={note || ''} placeholder={placeholder} />
      <PendingButton pendingText="Saving…">Save note</PendingButton>
      {state.ok ? (
        <small key={state.at} className="form-success fade-out">
          ✓ {state.message || 'saved'}
        </small>
      ) : null}
      {state.ok === false ? <small className="form-error">{state.error}</small> : null}
    </form>
  );
}
