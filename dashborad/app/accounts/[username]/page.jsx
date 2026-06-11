import Link from 'next/link';
import { notFound } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { CAMPAIGNS, resolveCampaign } from '../../../lib/campaigns';
import { getSenderAccountDetail, updateSenderAccountSettings } from '../../../lib/queries';
import Nav from '../../components/Nav';
import PendingButton from '../../components/PendingButton';

export const dynamic = 'force-dynamic';

export default async function SenderAccountPage({ params, searchParams }) {
  const campaign = resolveCampaign(searchParams?.campaign);
  const username = String(params.username || '').replace(/^@/, '').toLowerCase();
  const detail = await getSenderAccountDetail({ username });
  if (!detail) notFound();

  const { account, attempts } = detail;

  async function updateAccount(formData) {
    'use server';
    const selectedCampaign = String(formData.get('campaign') || '');
    const selectedStatus = String(formData.get('status') || '');
    const limitValue = Number.parseInt(String(formData.get('dailySendLimit') || ''), 10);
    await updateSenderAccountSettings({
      username,
      status: ['active', 'paused', 'blocked'].includes(selectedStatus) ? selectedStatus : null,
      campaign: CAMPAIGNS.includes(selectedCampaign) ? selectedCampaign : null,
      dailySendLimit: Number.isFinite(limitValue) && limitValue >= 0 ? Math.min(limitValue, 500) : null,
    });
    revalidatePath(`/accounts/${username}`);
    revalidatePath('/');
  }

  return (
    <>
      <Nav
        title={`@${account.username}`}
        subtitle={`sender account | ${account.status}`}
        campaign={campaign}
        showCampaignTabs={false}
      />
      <main>
        <Link href={`/?campaign=${campaign}`}>← Back to dashboard</Link>

        <section className="split detail-split">
          <section className="panel">
            <h2>Stats</h2>
            <StatRows
              rows={[
                ['Status', account.status],
                ['Campaign', account.campaign || 'any campaign'],
                ['Sends today', `${account.sends_today}/${account.daily_send_limit}`],
                ['Total sent', formatNumber(account.total_sent)],
                ['Total failed', formatNumber(account.total_failed)],
                ['Total attempts', formatNumber(account.total_attempts)],
                ['Last sent', account.last_sent_at ? formatDate(account.last_sent_at) : 'never'],
                ['Cooldown until', account.cooldown_until ? formatDate(account.cooldown_until) : ''],
                ['Added', formatDate(account.created_at)],
              ]}
            />
          </section>

          <section className="panel">
            <h2>Settings</h2>
            <form action={updateAccount} className="run-form">
              <label>
                <span>Status</span>
                <select name="status" defaultValue={account.status}>
                  <option value="active">active</option>
                  <option value="paused">paused</option>
                  <option value="blocked">blocked</option>
                </select>
              </label>
              <label>
                <span>Daily send limit</span>
                <input
                  name="dailySendLimit"
                  type="number"
                  min="0"
                  max="500"
                  defaultValue={account.daily_send_limit}
                />
              </label>
              <label>
                <span>Campaign</span>
                <select name="campaign" defaultValue={account.campaign || ''}>
                  <option value="">any campaign</option>
                  {CAMPAIGNS.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </label>
              <PendingButton pendingText="Saving…">Save</PendingButton>
            </form>
          </section>
        </section>

        <section className="band">
          <div className="band-header">
            <h2>DM History</h2>
            <span className="muted-copy">{attempts.length === 200 ? 'last 200 attempts' : `${attempts.length} attempts`}</span>
          </div>
          {attempts.length === 0 ? (
            <p className="muted-copy">No send attempts from this account yet.</p>
          ) : (
            <table className="accounts-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Recipient</th>
                  <th>Status</th>
                  <th>Campaign</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((attempt, index) => (
                  <tr key={`${attempt.created_at}-${index}`}>
                    <td>{formatDate(attempt.created_at)}</td>
                    <td>
                      {attempt.recipient_handle ? (
                        <>
                          <Link href={`/creators/${attempt.recipient_handle}?campaign=${attempt.campaign || campaign}`}>
                            @{attempt.recipient_handle}
                          </Link>
                          {' '}
                          <a
                            href={attempt.profile_url || `https://instagram.com/${attempt.recipient_handle}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            IG
                          </a>
                        </>
                      ) : (
                        'unknown'
                      )}
                    </td>
                    <td>
                      {attempt.status}
                      {attempt.error ? <div className="run-error">{attempt.error}</div> : null}
                    </td>
                    <td>{attempt.campaign || ''}</td>
                    <td className="dm-message-cell">{attempt.message || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </>
  );
}

function StatRows({ rows }) {
  return (
    <dl className="stat-rows">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function formatNumber(value) {
  if (value === null || value === undefined || value === '') return '';
  return new Intl.NumberFormat('en-US').format(Number(value));
}

function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString();
}
