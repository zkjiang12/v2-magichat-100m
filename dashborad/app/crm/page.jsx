import { Suspense } from 'react';
import Link from 'next/link';

import {
  LEAD_STATUSES,
  getCrmCampaignStats,
  getCrmLeads,
  getUnattributedReplyCount,
} from '../../lib/crm';
import { LeadStatusButtons, NoteForm } from '../components/CrmControls';
import Nav from '../components/Nav';
import { BandSkeleton } from '../components/Skeletons';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'CRM — MagicHat',
};

const UNIBOX_URL = 'https://app.instantly.ai/app/unibox';

const STATUS_LABELS = {
  needs_reply: 'needs reply',
  interested: 'interested',
  closed: 'closed',
  churned: 'churned',
};

export default function CrmPage({ searchParams }) {
  const campaignFilter = String(searchParams?.campaign || 'all');
  const statusFilter = LEAD_STATUSES.includes(searchParams?.status) ? searchParams.status : 'all';
  const minScore = clampScore(searchParams?.minScore);

  return (
    <>
      <Nav title="CRM — Instantly replies" subtitle="email replies across campaigns" showCampaignTabs={false} />
      <main>
        <Suspense fallback={<BandSkeleton height={420} />}>
          <CrmContent
            campaignFilter={campaignFilter}
            statusFilter={statusFilter}
            minScore={minScore}
          />
        </Suspense>
      </main>
    </>
  );
}

async function CrmContent({ campaignFilter, statusFilter, minScore }) {
  const [allLeads, campaignStats, unattributed] = await Promise.all([
    getCrmLeads(),
    getCrmCampaignStats(),
    getUnattributedReplyCount(),
  ]);

  const scoped = allLeads.filter((lead) =>
    (campaignFilter === 'all' || lead.campaign === campaignFilter) &&
    (minScore === 0 || Number(lead.fit_score || 0) >= minScore));

  const statusCounts = Object.fromEntries(LEAD_STATUSES.map((status) => [
    status,
    scoped.filter((lead) => lead.lead_status === status).length,
  ]));

  const leads = statusFilter === 'all'
    ? scoped
    : scoped.filter((lead) => lead.lead_status === statusFilter);

  const params = { campaign: campaignFilter, status: statusFilter, minScore };

  return (
    <>
      <section className="crm-campaign-grid">
        {campaignStats.map((stat) => {
          const active = campaignFilter === stat.campaign;
          return (
            <Link
              key={stat.campaign}
              href={crmHref({ ...params, campaign: active ? 'all' : stat.campaign })}
              className={`panel crm-campaign-card${active ? ' active' : ''}`}
            >
              <h2>{stat.campaign}</h2>
              <p className="crm-bignum">
                {stat.responders}
                <span> / {stat.contacted} emailed</span>
              </p>
              <div className="crm-bar">
                <div style={{ width: `${Math.min(100, Math.round(stat.replyRate * 100))}%` }} />
              </div>
              <p className="muted-copy">
                {(stat.replyRate * 100).toFixed(1)}% reply rate
                {' · '}{stat.interested} interested · {stat.closed} closed · {stat.churned} churned
              </p>
            </Link>
          );
        })}
      </section>

      <section className="band">
        <div className="band-header">
          <h2>Leads ({leads.length} shown)</h2>
          <div className="range-tabs">
            <a href={UNIBOX_URL} target="_blank" rel="noreferrer" className="range-tab">Open Unibox</a>
            <Link
              href={crmHref({ ...params, status: 'all' })}
              className={`range-tab${statusFilter === 'all' ? ' active' : ''}`}
            >
              all ({scoped.length})
            </Link>
            {LEAD_STATUSES.map((status) => (
              <Link
                key={status}
                href={crmHref({ ...params, status })}
                className={`range-tab${statusFilter === status ? ' active' : ''}`}
              >
                {STATUS_LABELS[status]} ({statusCounts[status]})
              </Link>
            ))}
          </div>
        </div>

        <form method="get" action="/crm" className="crm-filters">
          <input type="hidden" name="campaign" value={campaignFilter} />
          <input type="hidden" name="status" value={statusFilter} />
          <label>
            <span>Min score</span>
            <select name="minScore" defaultValue={String(minScore)}>
              <option value="0">any</option>
              <option value="2">2+</option>
              <option value="3">3+</option>
              <option value="4">4 only</option>
            </select>
          </label>
          <button type="submit" className="secondary-button">Apply</button>
          {(campaignFilter !== 'all' || statusFilter !== 'all' || minScore > 0) ? (
            <Link href="/crm" className="muted-copy">clear filters</Link>
          ) : null}
        </form>

        {unattributed > 0 ? (
          <p className="muted-copy">
            {unattributed} repl{unattributed === 1 ? 'y' : 'ies'} couldn&apos;t be matched to a pushed
            lead yet (kept in <code>email_responses</code>; matching is retried on every check run).
          </p>
        ) : null}

        {leads.length === 0 ? (
          <p className="empty-state">
            No replies recorded yet. Run <code>npm run instantly:replies</code> in scraper-2 to pull
            replies from your Instantly campaigns.
          </p>
        ) : (
          <div className="crm-lead-list">
            {leads.map((lead) => (
              <LeadRow key={`${lead.handle}-${lead.campaign}`} lead={lead} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function LeadRow({ lead }) {
  const messages = Array.isArray(lead.messages) ? lead.messages : [];
  const latest = messages[0];

  return (
    <details className="crm-lead">
      <summary>
        <span className="crm-lead-who">
          <Link href={`/creators/${lead.handle}?campaign=${lead.campaign}`}>@{lead.handle}</Link>
          <small>{lead.campaign}</small>
        </span>
        {lead.fit_score ? (
          <span className={`score-pill score-${lead.fit_score}`}>{lead.fit_score}</span>
        ) : (
          <span className="score-pill">-</span>
        )}
        <span className="crm-lead-preview">{latest ? (latest.subject || latest.text) : ''}</span>
        <span className="crm-lead-account">{lead.lead_email || ''}</span>
        <span className={`crm-status ${lead.lead_status}`}>{STATUS_LABELS[lead.lead_status]}</span>
        <span className="crm-lead-when">{formatRelative(lead.last_responded_at)}</span>
      </summary>

      <div className="crm-lead-detail">
        <div>
          <h3>Their replies</h3>
          <ul className="crm-messages">
            {messages.map((message, index) => (
              <li key={index}>
                {message.subject ? <small>{message.subject}</small> : null}
                <p>{message.text}</p>
                <small>{formatDate(message.responded_at)}</small>
              </li>
            ))}
          </ul>
          <p className="crm-outbound">
            <small>
              {lead.pushed_at ? `pushed to Instantly ${formatDate(lead.pushed_at)} · ` : ''}
              reply from{' '}
              <a
                href={`${UNIBOX_URL}?search=${encodeURIComponent(lead.lead_email || '')}`}
                target="_blank"
                rel="noreferrer"
              >
                {lead.lead_email}
              </a>
              {' '}- answer in Unibox
            </small>
          </p>
        </div>

        <div>
          {lead.reasoning ? (
            <p className="reasoning">
              <small>score {lead.fit_score}/4:</small> {lead.reasoning}
            </p>
          ) : null}

          <LeadStatusButtons
            handle={lead.handle}
            campaign={lead.campaign}
            currentStatus={lead.lead_status}
            statuses={LEAD_STATUSES}
            labels={STATUS_LABELS}
          />

          <NoteForm handle={lead.handle} campaign={lead.campaign} note={lead.note} />
        </div>
      </div>
    </details>
  );
}

function crmHref({ campaign, status, minScore }) {
  const params = new URLSearchParams();
  if (campaign && campaign !== 'all') params.set('campaign', campaign);
  if (status && status !== 'all') params.set('status', status);
  if (minScore) params.set('minScore', String(minScore));
  const qs = params.toString();
  return qs ? `/crm?${qs}` : '/crm';
}

function clampScore(value) {
  const number = Number.parseInt(String(value || '0'), 10);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(number, 4);
}

function formatDate(value) {
  if (!value) return 'unknown time';
  return new Date(value).toLocaleString();
}

function formatRelative(value) {
  if (!value) return '';
  const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
