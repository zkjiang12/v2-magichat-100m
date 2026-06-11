'use client';

import { usePathname } from 'next/navigation';

import { CAMPAIGNS } from '../../lib/campaigns';
import TabLink from './TabLink';

export default function Nav({ title, subtitle, campaign, range = '24h', showCampaignTabs = true }) {
  const pathname = usePathname();
  const onCrm = pathname.startsWith('/crm');
  const campaignQuery = campaign ? `?campaign=${campaign}` : '';

  return (
    <header className="topbar">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      <div className="topbar-nav">
        <nav className="range-tabs" aria-label="Pages">
          <TabLink href={`/${campaignQuery}`} active={!onCrm}>
            Dashboard
          </TabLink>
          <TabLink href={`/crm${campaignQuery}`} active={onCrm}>
            CRM
          </TabLink>
        </nav>
        {showCampaignTabs ? (
          <div className="range-tabs" role="tablist" aria-label="Campaign">
            {CAMPAIGNS.map((value) => {
              const params = new URLSearchParams({ campaign: value });
              if (range && range !== '24h') params.set('range', range);
              return (
                <TabLink key={value} href={`${pathname}?${params.toString()}`} active={value === campaign}>
                  {value}
                </TabLink>
              );
            })}
          </div>
        ) : null}
      </div>
    </header>
  );
}
