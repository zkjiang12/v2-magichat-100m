'use client';

import Link from 'next/link';

import { useNav } from './NavProvider';

export default function TabLink({ href, active, children }) {
  const { navigate } = useNav();
  return (
    <Link
      href={href}
      prefetch={false}
      className={`range-tab${active ? ' active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => {
        // keep cmd/ctrl-click (new tab) working
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </Link>
  );
}
