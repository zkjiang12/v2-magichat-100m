import Link from 'next/link';
import { notFound } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { resolveCampaign } from '../../../lib/campaigns';
import { getCreatorDetail, requeueCreatorSend, saveCreatorNote } from '../../../lib/queries';
import Nav from '../../components/Nav';
import PendingButton from '../../components/PendingButton';

export const dynamic = 'force-dynamic';

export default async function CreatorDetailPage({ params, searchParams }) {
  const campaign = resolveCampaign(searchParams?.campaign);
  const handle = String(params.handle || '').replace(/^@/, '');
  const detail = await getCreatorDetail({ handle, campaign });
  if (!detail) notFound();

  const { creator, attempts, events } = detail;

  async function saveNote(formData) {
    'use server';
    await saveCreatorNote({
      handle,
      campaign,
      note: String(formData.get('note') || ''),
    });
    revalidatePath(`/creators/${handle}`);
    revalidatePath('/');
  }

  async function requeueSend() {
    'use server';
    await requeueCreatorSend({ handle, campaign });
    revalidatePath(`/creators/${handle}`);
    revalidatePath('/');
  }

  const canRequeue = ['failed_retryable', 'failed_final', 'skipped', 'dry_run'].includes(creator.queue_status);

  return (
    <>
      <Nav
        title={`@${creator.handle}`}
        subtitle={campaign}
        campaign={campaign}
        showCampaignTabs={false}
      />
      <main>
        <Link href={`/?campaign=${campaign}`}>← Back to dashboard</Link>

        <section className="split detail-split">
          <section className="panel">
            <h2>Creator</h2>
            <StatRows
              rows={[
                ['Display name', creator.display_name || ''],
                ['Followers', formatNumber(creator.followers_count)],
                ['Following', formatNumber(creator.following_count)],
                ['Verified', creator.is_verified === null ? '' : String(Boolean(creator.is_verified))],
                ['Private', creator.is_private === null ? '' : String(Boolean(creator.is_private))],
                ['Fit score', creator.fit_score ? `${creator.fit_score}/4` : ''],
                ['List', creator.list || ''],
                ['Queue', creator.queue_status || ''],
              ]}
            />
          </section>

          <section className="panel">
            <h2>Note</h2>
            <form action={saveNote} className="run-form">
              <textarea name="note" defaultValue={creator.note || ''} />
              <PendingButton pendingText="Saving…">Save note</PendingButton>
            </form>
            {canRequeue ? (
              <form action={requeueSend} className="run-form">
                <PendingButton className="secondary-button" pendingText="Requeuing…">
                  Requeue DM (currently {creator.queue_status})
                </PendingButton>
              </form>
            ) : null}
          </section>
        </section>

        <section className="band">
          <div className="band-header">
            <h2>Reasoning</h2>
          </div>
          <div className="run-list">
            <p>{creator.reasoning || 'No reasoning recorded.'}</p>
          </div>
        </section>

        <section className="split detail-split">
          <section className="panel">
            <h2>Send Attempts</h2>
            <div className="run-list">
              {attempts.length === 0 ? (
                <p className="muted-copy">No send attempts yet.</p>
              ) : attempts.map((attempt) => (
                <div className="run-row" key={`${attempt.created_at}-${attempt.status}`}>
                  <div>
                    <strong>{attempt.status}</strong>
                    <small>{attempt.provider} | {formatDate(attempt.created_at)}</small>
                    {attempt.sender_username ? <small>sender @{attempt.sender_username}</small> : null}
                    {attempt.error ? <small className="run-error">{attempt.error}</small> : null}
                    {attempt.message ? <small>{attempt.message}</small> : null}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <h2>Scrape Events</h2>
            <div className="run-list">
              {events.length === 0 ? (
                <p className="muted-copy">No scrape events yet.</p>
              ) : events.map((event) => (
                <div className="run-row" key={`${event.event_at}-${event.event_type}`}>
                  <div>
                    <strong>{event.event_type}</strong>
                    <small>{formatDate(event.event_at)}</small>
                    {event.source_seed ? <small>from @{event.source_seed}</small> : null}
                  </div>
                </div>
              ))}
            </div>
          </section>
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
