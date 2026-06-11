'use client';

import { createContext, useCallback, useContext, useTransition } from 'react';
import { useRouter } from 'next/navigation';

// Navigations run inside a transition so the current page stays visible
// (dimmed, with a progress bar) instead of freezing while the server renders.
const NavContext = createContext({ pending: false, navigate: () => {} });

export function NavProvider({ children }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const navigate = useCallback(
    (href) => {
      startTransition(() => router.push(href));
    },
    [router],
  );

  return (
    <NavContext.Provider value={{ pending, navigate }}>
      <div className={`nav-progress${pending ? ' is-active' : ''}`} aria-hidden="true" />
      <div className="app-shell" data-nav-pending={pending ? '' : undefined}>
        {children}
      </div>
    </NavContext.Provider>
  );
}

export function useNav() {
  return useContext(NavContext);
}
