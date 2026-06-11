'use client';

import TabLink from './TabLink';

export function RangeTabs({ current, campaign, options }) {
  return (
    <div className="range-tabs" role="tablist" aria-label="Chart range">
      {options.map((option) => {
        const href = `/?campaign=${campaign}${option.value === '24h' ? '' : `&range=${option.value}`}`;
        return (
          <TabLink key={option.value} href={href} active={option.value === current}>
            {option.label}
          </TabLink>
        );
      })}
    </div>
  );
}
