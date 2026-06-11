'use client';

import { useFormStatus } from 'react-dom';

export default function PendingButton({ children, pendingText = 'Working…', className, ...props }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} {...props}>
      {pending ? pendingText : children}
    </button>
  );
}
