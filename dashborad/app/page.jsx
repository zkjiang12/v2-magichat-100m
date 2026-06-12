import Link from 'next/link';
import { revalidatePath } from 'next/cache';

import HourlyBarChartBody from './HourlyBarChartBody';
import IgHandle, { EmailNote } from './IgHandle';

import { CAMPAIGNS, resolveCampaign } from '../lib/campaigns';
import {
  getCloudRunOperationStatus,
  triggerScraperCloudRunJob,
  triggerSenderCloudRunJob,
} from '../lib/cloud-run';
import {
  createRunCommand,
  createScraperRun,
  createSenderRun,
  extendScraperRun,
  getDashboardData,
  recordScraperCloudTrigger,
  recordSenderCloudTrigger,
  requeueCampaignFailures,
  requeueRunFailures,
  updateSenderAccountSettings,
} from '../lib/queries';

export const dynamic = 'force-dynamic';

const STALE_RUN_SECONDS = 5 * 60;
const RANGE_OPTIONS = [
  { value: '24h', label: '24h', bucket: 'hour' },
  { value: '7d', label: '7d', bucket: 'day' },
  { value: '30d', label: '30d', bucket: 'day' },
];

export default async function DashboardPage({ searchParams }) {
  const campaign = resolveCampaign(searchParams?.campaign);
  const rangeParam = searchParams?.range;
  const rangeOption = RANGE_OPTIONS.find((opt) => opt.value === rangeParam) || RANGE_OPTIONS[0];
  const range = rangeOption.value;
  const bucketKind = rangeOption.bucket;
  let data;
  let error = null;

  try {
    data = await getDashboardData({ campaign, range });
    data = await attachCloudStatuses(data);
  } catch (caught) {
    error = caught;
  }

  if (error) {
    return (
      <Shell campaign={campaign}>
        <section className="empty-state">
          <h2>Dashboard is not connected yet</h2>
          <p>{error.message}</p>
          <p>Set `DATABASE_URL` and run the dashboard/control migrations.</p>
        </section>
      </Shell>
    );
  }

  const scrapeTotals = data.scrapeTotals;
  const scrapeLastHour = data.scrapeLastHour;
  const queue = data.sendQueueTotals;
  const sendTotals = data.sendAttemptTotals;
  const sendHour = data.sendAttemptLastHour;
  const costTotals = withCostRates(data.costTotals, scrapeTotals);
  const costHour = withCostRates(data.costLastHour, scrapeLastHour);

  async function startScraperRun(formData) {
    'use server';
    const seedHandles = parseHandles(String(formData.get('seedHandles') || ''));
    if (seedHandles.length === 0) return;

    const run = await createScraperRun({
      campaign,
      seedHandles,
      maxAccepted: positiveInt(formData.get('maxAccepted'), 1000),
      followingLimit: Math.max(50, boundedPositiveInt(formData.get('followingLimit'), 2000, 2000)),
      qualificationWorkers: boundedPositiveInt(formData.get('qualificationWorkers'), 32, 32),
    });

    try {
      const trigger = await triggerScraperCloudRunJob({ runId: run.id, campaign });
      if (trigger) {
        await recordScraperCloudTrigger({
          runId: run.id,
          operationName: trigger.name,
          target: trigger.target,
        });
      }
    } catch (caught) {
      await recordScraperCloudTrigger({
        runId: run.id,
        target: 'cloud_run_job',
        error: caught.message,
      });
      throw caught;
    }

    revalidatePath('/');
  }

  async function startSenderRun(formData) {
    'use server';
    const accountUsernames = [...new Set(
      formData.getAll('accountUsernames')
        .map((value) => String(value).trim().replace(/^@/, '').toLowerCase())
        .filter(Boolean),
    )];
    const messageTemplate = String(formData.get('messageTemplate') || '').trim();
    const run = await createSenderRun({
      campaign,
      accountUsernames,
      maxSends: boundedPositiveInt(formData.get('maxSends'), 25, 100),
      messageTemplate: messageTemplate || null,
    });

    try {
      const trigger = await triggerSenderCloudRunJob({ runId: run.id, campaign });
      if (trigger) {
        await recordSenderCloudTrigger({
          runId: run.id,
          operationName: trigger.name,
          target: trigger.target,
        });
      }
    } catch (caught) {
      await recordSenderCloudTrigger({
        runId: run.id,
        target: 'cloud_run_job',
        error: caught.message,
      });
      throw caught;
    }

    revalidatePath('/');
  }

  async function updateSenderAccount(formData) {
    'use server';
    const username = String(formData.get('username') || '').trim();
    if (!username) return;
    const selectedCampaign = String(formData.get('campaign') || '');
    const selectedStatus = String(formData.get('status') || '');
    const limitValue = Number.parseInt(String(formData.get('dailySendLimit') || ''), 10);
    await updateSenderAccountSettings({
      username,
      status: ['active', 'paused', 'blocked'].includes(selectedStatus) ? selectedStatus : null,
      campaign: CAMPAIGNS.includes(selectedCampaign) ? selectedCampaign : null,
      dailySendLimit: Number.isFinite(limitValue) && limitValue >= 0 ? Math.min(limitValue, 500) : null,
    });
    revalidatePath('/');
  }

  async function commandRun(formData) {
    'use server';
    await createRunCommand({
      campaign,
      runType: String(formData.get('runType')),
      runId: String(formData.get('runId')),
      command: String(formData.get('command')),
    });
    revalidatePath('/');
  }

  async function retryRunFailures(formData) {
    'use server';
    await requeueRunFailures({
      runId: String(formData.get('runId') || ''),
      campaign,
    });
    revalidatePath('/');
  }

  async function requeueAllFailures() {
    'use server';
    await requeueCampaignFailures({ campaign });
    revalidatePath('/');
  }

  async function extendRun(formData) {
    'use server';
    const runId = String(formData.get('runId'));
    const addAccepted = positiveInt(formData.get('addAccepted'), 500);

    const extended = await extendScraperRun({ campaign, runId, addAccepted });
    if (!extended) return;

    try {
      const trigger = await triggerScraperCloudRunJob({ runId, campaign });
      if (trigger) {
        await recordScraperCloudTrigger({
          runId,
          operationName: trigger.name,
          target: trigger.target,
        });
      }
    } catch (caught) {
      await recordScraperCloudTrigger({
        runId,
        target: 'cloud_run_job',
        error: caught.message,
      });
      throw caught;
    }

    revalidatePath('/');
  }

  return (
    <Shell campaign={campaign} range={range}>
      <section className="band overview-band">
        <div className="band-header overview-header">
          <RangeTabs current={range} campaign={campaign} />
        </div>
        <div className="overview-grid">
          <Donut
            centerLabel="Seen"
            total={scrapeTotals.seen}
            segments={[
              { key: 'accepted', label: 'Accepted', value: scrapeTotals.accepted, color: 'var(--green)' },
              { key: 'rejected', label: 'Rejected', value: scrapeTotals.rejected, color: 'var(--red)' },
              {
                key: 'pending',
                label: 'Pending',
                value: pendingValue(scrapeTotals.seen, scrapeTotals.accepted, scrapeTotals.rejected),
                color: '#3f3f46',
              },
            ]}
          />
          <Donut
            centerLabel="DMs"
            total={sendDmTotal(queue, sendTotals)}
            segments={[
              { key: 'sent', label: 'Sent DMs', value: queue.sent || sendTotals.sent || 0, color: 'var(--green)' },
              {
                key: 'failed',
                label: 'Failed Sends',
                value: (queue.failed_retryable || 0) + (queue.failed_final || 0),
                color: 'var(--red)',
              },
              {
                key: 'queued',
                label: 'Queued Sends',
                value: queuedPending(queue, sendTotals),
                color: '#3f3f46',
              },
            ]}
          />
        </div>
        <div className="split chart-split">
          <HourlyBarChart
            title="Scraping"
          unit="profiles"
          bucketKind={bucketKind}
          data={data.scrapeHourly}
          segments={[
            { key: 'accepted', label: 'Accepted', color: 'var(--green)' },
            { key: 'rejected', label: 'Rejected', color: 'var(--red)' },
            { key: 'pending', label: 'Pending', color: '#3f3f46' },
          ]}
          derive={(row) => ({
            accepted: row.accepted,
            rejected: row.rejected,
            pending: Math.max(0, (row.seen || 0) - (row.accepted || 0) - (row.rejected || 0)),
          })}
          formatValue={(value) => formatNumber(value)}
          totals={[
            ['Seen', scrapeTotals.seen],
            ['Processed', scrapeTotals.processed],
            ['Accepted', scrapeTotals.accepted],
            ['Rejected', scrapeTotals.rejected],
            ['Failed', scrapeTotals.failed],
            ['Acceptance rate', percent(scrapeTotals.accepted, scrapeTotals.processed)],
          ]}
        />
        <HourlyBarChart
          title="Cost"
          unit="USD"
          bucketKind={bucketKind}
          data={data.costHourly}
          segments={[
            { key: 'apifyUsd', label: 'Apify', color: 'var(--blue)' },
            { key: 'openaiUsd', label: 'OpenAI', color: 'var(--green)' },
          ]}
          derive={(row) => ({
            apifyUsd: row.apifyUsd,
            openaiUsd: row.openaiUsd,
          })}
          formatValue={(value) => `$${Number(value || 0).toFixed(2)}`}
          totals={[
            ['Apify', usd(costTotals.apifyUsd)],
            ['OpenAI', usd(costTotals.openaiUsd)],
            ['Total', usd(costTotals.totalUsd)],
            ['Cost/processed', usd(costTotals.costPerProcessed)],
            ['Cost/accepted', usd(costTotals.costPerAccepted)],
          ]}
        />
        <HourlyBarChart
          title="Sending"
          unit="attempts"
          bucketKind={bucketKind}
          data={data.sendAttemptHourly}
          segments={[
            { key: 'sent', label: 'Sent', color: 'var(--green)' },
            { key: 'failed', label: 'Failed', color: 'var(--red)' },
            { key: 'skipped', label: 'Skipped', color: '#3f3f46' },
          ]}
          derive={(row) => ({
            sent: row.sent,
            failed: row.failed,
            skipped: row.skipped,
          })}
          formatValue={(value) => formatNumber(value)}
          totals={[
            ['Queued', queue.queued || 0],
            ['Claimed', queue.claimed || 0],
            ['Dry run', queue.dry_run || sendTotals.dry_run || 0],
            ['Sent', queue.sent || sendTotals.sent || 0],
            ['Failed retryable', queue.failed_retryable || 0],
            ['Failed final', queue.failed_final || 0],
            ['Skipped', queue.skipped || 0],
          ]}
        />
        </div>
      </section>

      <div className="run-centers">
        <ScraperCenter
          startAction={startScraperRun}
          runs={data.scraperRuns}
          commandAction={commandRun}
          extendAction={extendRun}
          recentEvents={data.recentEvents}
          campaign={campaign}
        />
        <SenderCenter
          startAction={startSenderRun}
          runs={data.senderRuns}
          commandAction={commandRun}
          retryAction={retryRunFailures}
          requeueAllAction={requeueAllFailures}
          queueTotals={data.sendQueueTotals}
          accounts={data.senderAccounts}
          campaign={campaign}
          campaignSettings={data.campaignSettings}
        />
      </div>

      <SenderAccountsPanel
        accounts={data.senderAccounts}
        campaign={campaign}
        updateAction={updateSenderAccount}
      />

      {data.instantlyTotals ? <InstantlyPanel totals={data.instantlyTotals} /> : null}
      <CreatorKanbanBoard rows={data.acceptedCreators} />
      <EvalInstructions />
    </Shell>
  );
}

async function attachCloudStatuses(data) {
  const [scraperRuns, senderRuns] = await Promise.all([
    attachCloudStatusesToRuns(data.scraperRuns),
    attachCloudStatusesToRuns(data.senderRuns),
  ]);
  return {
    ...data,
    scraperRuns,
    senderRuns,
  };
}

async function attachCloudStatusesToRuns(runs) {
  return Promise.all(
    (runs || []).map(async (run) => ({
      ...run,
      cloud_status: await cloudStatusForRun(run),
    })),
  );
}

async function cloudStatusForRun(run) {
  if (run.cloud_trigger_error) {
    return {
      status: 'trigger_failed',
      error: run.cloud_trigger_error,
    };
  }
  if (!run.worker_target && !run.cloud_operation_name) return { status: 'not_triggered' };
  if (!run.cloud_operation_name) return { status: 'unknown' };
  return getCloudRunOperationStatus({ operationName: run.cloud_operation_name });
}

function ScraperCenter({ startAction, runs, commandAction, extendAction, recentEvents, campaign }) {
  return (
    <section className="band scraper-center">
      <div className="scraper-center-section">
        <h3>Start Scraper Run</h3>
        <form action={startAction} className="run-form">
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
          <div className="form-actions">
            <button type="submit">Create run</button>
          </div>
        </form>
      </div>

      <div className="run-tabs">
        <input type="radio" name="scraper-view" id="scraper-view-runs" className="run-tab-radio" defaultChecked />
        <input type="radio" name="scraper-view" id="scraper-view-events" className="run-tab-radio" />
        <div className="run-tab-buttons" role="tablist">
          <label htmlFor="scraper-view-runs" className="run-tab-button">
            Runs <span className="run-tab-count">{runs.length}</span>
          </label>
          <label htmlFor="scraper-view-events" className="run-tab-button">
            Recent events <span className="run-tab-count">{recentEvents.length}</span>
          </label>
        </div>

        <div className="run-tab-panel run-tab-panel-runs">
          <div className="scraper-terminal">
            {runs.length === 0 ? (
              <p className="muted-copy">No runs yet.</p>
            ) : (
              runs.map((run) => (
                <div className="run-row" key={run.id}>
                  <div>
                    <strong>DB: {displayRunStatus(run)}</strong>
                    <RunHealth run={run} />
                    <CloudStatusBadge run={run} />
                    <span>{run.seed_handles?.join(', ')}</span>
                    <small>{shortId(run.id)} | updated {formatDate(run.updated_at)}</small>
                    <small>{formatRunTimeline(run)}</small>
                    <ScraperRunDetails run={run} />
                    <CloudRunDetails run={run} />
                    {run.pending_commands?.length ? <small>pending command: {run.pending_commands.join(', ')}</small> : null}
                    {run.error ? <small className="run-error">{run.error}</small> : null}
                  </div>
                  {canCommandRun(run) || canExtendRun(run) ? (
                    <div className="run-actions">
                      {canPauseRun(run) ? (
                        <RunCommandButton action={commandAction} runType="scraper" runId={run.id} command="pause" />
                      ) : null}
                      {canResumeRun(run) ? (
                        <RunCommandButton action={commandAction} runType="scraper" runId={run.id} command="resume" />
                      ) : null}
                      {canStopRun(run) ? (
                        <RunCommandButton action={commandAction} runType="scraper" runId={run.id} command="stop" />
                      ) : null}
                      {canExtendRun(run) ? (
                        <ExtendRunForm action={extendAction} runId={run.id} />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="run-tab-panel run-tab-panel-events">
          <div className="scraper-terminal scraper-terminal-events">
            {recentEvents.length === 0 ? (
              <p className="muted-copy">No events yet.</p>
            ) : (
              recentEvents.map((event) => (
                <Link
                  className="event-row"
                  href={`/creators/${event.handle}?campaign=${campaign}`}
                  key={`${event.handle}-${event.event_type}-${event.event_at}`}
                >
                  <span className={`status-dot ${event.event_type}`} />
                  <span>@{event.handle}</span>
                  <span>{event.event_type}</span>
                  <span>{event.fit_score ? `${event.fit_score}/4` : ''}</span>
                  <span>{event.source_seed ? `from @${event.source_seed}` : ''}</span>
                  <time>{formatTime(event.event_at)}</time>
                </Link>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function SenderCenter({
  startAction,
  runs,
  commandAction,
  retryAction,
  requeueAllAction,
  queueTotals,
  accounts,
  campaign,
  campaignSettings,
}) {
  const eligibleAccounts = (accounts || []).filter(
    (account) => !account.campaign || account.campaign === campaign,
  );
  const campaignTemplate = campaignSettings?.message_template || '';
  const failedInQueue = Number(queueTotals?.failed_retryable || 0) + Number(queueTotals?.failed_final || 0);

  return (
    <section className="band scraper-center">
      <div className="scraper-center-section">
        <h3>Start Sender Run</h3>
        <form action={startAction} className="run-form">
          <div>
            <span>Send from</span>
            <p className="field-hint">None checked = any eligible account for {campaign}.</p>
            {eligibleAccounts.length === 0 ? (
              <p className="muted-copy">No sender accounts are assigned to this campaign yet. Assign them in Sender Accounts below.</p>
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
          <div className="form-actions">
            <button type="submit">Create run</button>
          </div>
        </form>
      </div>

      <div className="run-tabs">
        <div className="run-tab-buttons" role="tablist">
          <span className="run-tab-button is-active">
            Runs <span className="run-tab-count">{runs.length}</span>
          </span>
          {failedInQueue > 0 ? (
            <form action={requeueAllAction} className="run-tab-action">
              <button type="submit" className="secondary-button">
                Requeue all {failedInQueue} failed
              </button>
            </form>
          ) : null}
        </div>
        <div className="run-tab-panel run-tab-panel-runs is-active">
          <div className="scraper-terminal">
            {runs.length === 0 ? (
              <p className="muted-copy">No runs yet.</p>
            ) : (
              runs.map((run) => (
                <div className="run-row" key={run.id}>
                  <div>
                    <strong>DB: {displayRunStatus(run)}</strong>
                    <RunHealth run={run} />
                    <CloudStatusBadge run={run} />
                    {run.requested_by === 'drain-worker' ? (
                      <span className="run-health neutral">auto</span>
                    ) : null}
                    <span>{run.account_usernames?.join(', ')}</span>
                    <small>{shortId(run.id)} | updated {formatDate(run.updated_at)}</small>
                    <small>{formatRunTimeline(run)}</small>
                    <SenderRunDetails run={run} />
                    <CloudRunDetails run={run} />
                    {run.pending_commands?.length ? <small>pending command: {run.pending_commands.join(', ')}</small> : null}
                    {run.error ? <small className="run-error">{run.error}</small> : null}
                  </div>
                  {canCommandRun(run) || Number(run.failed_remaining || 0) > 0 ? (
                    <div className="run-actions">
                      {canPauseRun(run) ? (
                        <RunCommandButton action={commandAction} runType="sender" runId={run.id} command="pause" />
                      ) : null}
                      {canResumeRun(run) ? (
                        <RunCommandButton action={commandAction} runType="sender" runId={run.id} command="resume" />
                      ) : null}
                      {canStopRun(run) ? (
                        <RunCommandButton action={commandAction} runType="sender" runId={run.id} command="stop" />
                      ) : null}
                      {Number(run.failed_remaining || 0) > 0 ? (
                        <form action={retryAction}>
                          <input type="hidden" name="runId" value={run.id} />
                          <button type="submit" className="secondary-button">
                            retry {run.failed_remaining} failed
                          </button>
                        </form>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function SenderAccountsPanel({ accounts, campaign, updateAction }) {
  return (
    <section className="band sender-accounts-band">
      <div className="band-header">
        <h2>Sender Accounts</h2>
      </div>
      {(accounts || []).length === 0 ? (
        <p className="muted-copy">No sender accounts in the database yet. They appear after their first send or via add-account.</p>
      ) : (
        <table className="accounts-table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Sends today</th>
              <th>Total sent</th>
              <th>Last sent</th>
              <th>Manage</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.username}>
                <td>
                  <IgHandle
                    handle={account.username}
                    href={`/accounts/${account.username}?campaign=${campaign}`}
                  />
                </td>
                <td>{account.sends_today || 0}/{account.daily_send_limit}</td>
                <td>{account.total_sent || 0}</td>
                <td>{account.last_sent_at ? relativeTime(account.last_sent_at) : 'never'}</td>
                <td>
                  <form action={updateAction} className="account-assign-form">
                    <input type="hidden" name="username" value={account.username} />
                    <select name="status" defaultValue={account.status}>
                      <option value="active">active</option>
                      <option value="paused">paused</option>
                      <option value="blocked">blocked</option>
                    </select>
                    <input
                      name="dailySendLimit"
                      type="number"
                      min="0"
                      max="500"
                      defaultValue={account.daily_send_limit}
                      title="Daily send limit"
                      className="account-limit-input"
                    />
                    <select name="campaign" defaultValue={account.campaign || ''}>
                      <option value="">any campaign</option>
                      {CAMPAIGNS.map((name) => (
                        <option key={name} value={name}>{name}</option>
                      ))}
                    </select>
                    <button type="submit" className="secondary-button">Save</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted-copy">
        Accounts assigned to a campaign only send for that campaign. “Any campaign” accounts can be picked by every campaign.
        Click an account for its full DM history. Currently viewing {campaign}.
      </p>
    </section>
  );
}

function RunRequestPanel({ title, action, fields }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      <form action={action} className="run-form">
        {fields.map(([name, label, placeholder]) => (
          <label key={name}>
            <span>{label}</span>
            <input name={name} placeholder={placeholder} />
          </label>
        ))}
        <button type="submit">Create run</button>
      </form>
    </section>
  );
}

function RunsPanel({ title, description, runType, runs, commandAction }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {description ? <p className="muted-copy">{description}</p> : null}
      <div className="run-list">
        {runs.length === 0 ? (
          <p className="muted-copy">No runs yet.</p>
        ) : (
          runs.map((run) => (
            <div className="run-row" key={run.id}>
              <div>
                <strong>DB: {displayRunStatus(run)}</strong>
                <RunHealth run={run} />
                <CloudStatusBadge run={run} />
                <span>{runType === 'scraper' ? run.seed_handles?.join(', ') : run.account_usernames?.join(', ')}</span>
                <small>{shortId(run.id)} | updated {formatDate(run.updated_at)}</small>
                <small>{formatRunTimeline(run)}</small>
                {runType === 'scraper' ? <ScraperRunDetails run={run} /> : <SenderRunDetails run={run} />}
                <CloudRunDetails run={run} />
                {run.pending_commands?.length ? <small>pending command: {run.pending_commands.join(', ')}</small> : null}
                {run.error ? <small className="run-error">{run.error}</small> : null}
              </div>
              {canCommandRun(run) ? (
                <div className="run-actions">
                  {canPauseRun(run) ? (
                    <RunCommandButton action={commandAction} runType={runType} runId={run.id} command="pause" />
                  ) : null}
                  {canResumeRun(run) ? (
                    <RunCommandButton action={commandAction} runType={runType} runId={run.id} command="resume" />
                  ) : null}
                  {canStopRun(run) ? (
                    <RunCommandButton action={commandAction} runType={runType} runId={run.id} command="stop" />
                  ) : null}
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function RunCommandButton({ action, runType, runId, command }) {
  return (
    <form action={action}>
      <input type="hidden" name="runType" value={runType} />
      <input type="hidden" name="runId" value={runId} />
      <input type="hidden" name="command" value={command} />
      <button type="submit" className="secondary-button">{command}</button>
    </form>
  );
}

function ExtendRunForm({ action, runId }) {
  return (
    <form action={action}>
      <input type="hidden" name="runId" value={runId} />
      <input name="addAccepted" placeholder="+500" style={{ width: '64px' }} />
      <button type="submit" className="secondary-button">extend</button>
    </form>
  );
}

function RunHealth({ run }) {
  const seconds = Number(run.seconds_since_update || 0);
  let tone = 'neutral';
  let label = `updated ${relativeDuration(seconds)} ago`;

  if (run.status === 'requested') {
    // seconds_since_update, not age: an extended run keeps its old created_at
    // but was re-requested just now.
    tone = seconds > STALE_RUN_SECONDS ? 'bad' : 'warn';
    label = `waiting for worker ${relativeDuration(seconds)} ago`;
  } else if (['running', 'pause_requested', 'stop_requested'].includes(run.status) && seconds > STALE_RUN_SECONDS) {
    tone = 'bad';
    label = `stale ${relativeDuration(seconds)} ago`;
  } else if (run.status === 'running') {
    tone = 'good';
  } else if (['failed', 'stopped'].includes(run.status)) {
    tone = 'bad';
  } else if (['completed', 'paused'].includes(run.status)) {
    label = `finished ${relativeDuration(seconds)} ago`;
  }

  return <span className={`run-health ${tone}`}>{label}</span>;
}

function CloudStatusBadge({ run }) {
  const view = cloudStatusView(run);
  return <span className={`run-health ${view.tone}`}>Cloud: {view.label}</span>;
}

function ScraperRunDetails({ run }) {
  const counters = run.counters || {};
  return (
    <small>
      {[
        `accepted ${counters.accepted || 0}`,
        `processed ${counters.processed || 0}`,
        `failed ${counters.failed || 0}`,
        run.current_seed ? `seed @${run.current_seed}` : null,
        `frontier ${run.frontier_size || 0}`,
        `candidate queue ${run.queued_candidates || 0}`,
        run.state_updated_at ? `state ${relativeTime(run.state_updated_at)}` : null,
      ].filter(Boolean).join(' | ')}
    </small>
  );
}

function SenderRunDetails({ run }) {
  const counters = run.counters || {};
  const attempts = run.recent_attempts || [];
  return (
    <>
      <small>
        {[
          `attempted ${counters.attempted || 0}`,
          `dry ${counters.dry_run || 0}`,
          `sent ${counters.sent || 0}`,
          `skipped ${counters.skipped || 0}`,
          `failed ${(counters.failed_retryable || 0) + (counters.failed_final || 0)}`,
          `max sends ${run.max_sends || 'unset'}`,
          run.message_template ? `msg "${truncateText(run.message_template, 60)}"` : null,
          run.last_attempt_at ? `last attempt ${relativeTime(run.last_attempt_at)}` : 'no attempts yet',
        ].filter(Boolean).join(' | ')}
      </small>
      {attempts.length ? (
        <div className="attempt-list">
          {attempts.map((attempt, index) => (
            <small key={`${attempt.created_at}-${index}`}>
              {formatTime(attempt.created_at)} @{attempt.handle || 'unknown'} {attempt.status}
              {attempt.provider ? ` via ${attempt.provider}` : ''}
              {attempt.error ? `: ${attempt.error}` : ''}
            </small>
          ))}
        </div>
      ) : null}
    </>
  );
}

function CloudRunDetails({ run }) {
  const status = run.cloud_status || {};
  return (
    <small>
      {[
        `cloud ${cloudStatusView(run).label}`,
        run.worker_target ? `target ${run.worker_target}` : null,
        run.cloud_triggered_at ? `triggered ${relativeTime(run.cloud_triggered_at)}` : null,
        run.cloud_operation_name ? `operation ${shortOperation(run.cloud_operation_name)}` : null,
        status.message ? `message ${status.message}` : null,
        status.error ? `cloud error ${status.error}` : null,
        run.cloud_trigger_error ? `trigger error ${run.cloud_trigger_error}` : null,
      ].filter(Boolean).join(' | ')}
    </small>
  );
}

function InstantlyPanel({ totals }) {
  const qualified = Number(totals.qualified || 0);
  const withEmail = Number(totals.with_email || 0);
  return (
    <Panel title="Email Outreach (Instantly)">
      <p className="muted-copy">
        Qualified creators (fit 3-4) with an email are pushed to Instantly campaigns after each
        scraper run. Instantly handles the actual sending.
      </p>
      <StatRows
        rows={[
          ['Qualified creators', qualified],
          ['With email', `${formatNumber(withEmail)} (${percent(withEmail, qualified)})`],
          ['Leads pushed', Number(totals.pushed || 0)],
          ['Duplicates skipped', Number(totals.skipped || 0)],
          ['Push failures', Number(totals.failed || 0)],
          ['Last push', totals.last_pushed_at ? relativeTime(totals.last_pushed_at) : 'never'],
        ]}
      />
    </Panel>
  );
}

function Panel({ title, children }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function StatRows({ rows }) {
  return (
    <dl className="stat-rows">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{typeof value === 'number' ? formatNumber(value) : value}</dd>
        </div>
      ))}
    </dl>
  );
}

function CreatorKanbanBoard({ rows }) {
  const columns = [
    {
      key: 'scored',
      title: 'Scored Creators',
      description: 'Score 1-4',
      rows: rows.filter((row) => scoreValue(row) >= 1 && scoreValue(row) <= 4),
    },
    {
      key: 'qualified',
      title: 'Qualified',
      description: 'Score 3-4',
      rows: rows.filter((row) => scoreValue(row) >= 3 && scoreValue(row) <= 4),
    },
    {
      key: 'messaged',
      title: 'Messaged',
      description: 'Sender sent a DM',
      rows: rows.filter((row) => hasBeenMessaged(row)),
    },
  ];

  return (
    <section className="band creator-board-band">
      <div className="band-header">
        <h2>Creator Pipeline</h2>
      </div>
      <div className="creator-board">
        {columns.map((column) => (
          <section className="creator-column" key={column.key}>
            <div className="creator-column-header">
              <div>
                <h3>{column.title}</h3>
                <span>{column.description}</span>
              </div>
              <strong>{formatNumber(column.rows.length)}</strong>
            </div>
            <div className="creator-card-list">
              {column.rows.length === 0 ? (
                <p className="muted-copy">No creators yet.</p>
              ) : (
                column.rows.map((row) => (
                  <CreatorKanbanCard row={row} key={`${column.key}-${row.handle}`} />
                ))
              )}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function EvalInstructions() {
  return (
    <section className="band eval-instructions">
      <div className="band-header">
        <h2>Eval Commands</h2>
      </div>
      <pre>{`cd ~/Desktop/magichat-100m/v2/scraper-2

# Eval scraper accuracy
npm run eval:accuracy

# Eval scraper speed, cost, and accuracy
npm run eval:speed-cost

# Eval the run sender
# Send 1 message from the dashboard, then check the account it sent from.`}</pre>
    </section>
  );
}

function CreatorKanbanCard({ row }) {
  const profileUrl = row.profile_url || `https://www.instagram.com/${row.handle}/`;
  const reasoning = row.reasoning || 'No reasoning recorded.';

  return (
    <article className="creator-card" title={reasoning}>
      <div className="creator-card-main">
        <a className="ig-handle" href={profileUrl} target="_blank" rel="noreferrer" title={reasoning}>
          @{row.handle}
        </a>
        <span className={`score-pill score-${scoreValue(row)}`}>{scoreValue(row)}/4</span>
        <div className="score-tooltip" role="tooltip">
          {reasoning}
        </div>
      </div>
      {Array.isArray(row.emails) && row.emails.length > 0 ? (
        <small className="creator-card-email">
          <EmailNote emails={row.emails} />
        </small>
      ) : null}
      {row.queue_status || row.sent_at ? (
        <small>{row.queue_status || 'sent'}{row.sent_at ? ` | ${formatDate(row.sent_at)}` : ''}</small>
      ) : null}
    </article>
  );
}

function scoreValue(row) {
  return Number(row.fit_score || 0);
}

function hasBeenMessaged(row) {
  return row.queue_status === 'sent' || Boolean(row.sent_at);
}

function Shell({ campaign, range = '24h', children }) {
  return (
    <>
      <header className="topbar">
        <div>
          <h1>MagicHat Campaign Dashboard</h1>
          <p>{campaign}</p>
        </div>
        <div className="range-tabs">
          <Link href="/crm" className="range-tab">CRM</Link>
        </div>
        <CampaignTabs current={campaign} range={range} />
      </header>
      <main>{children}</main>
    </>
  );
}

function CampaignTabs({ current, range }) {
  return (
    <div className="range-tabs" role="tablist" aria-label="Campaign">
      {CAMPAIGNS.map((value) => {
        const active = value === current;
        const href = `/?campaign=${value}${range !== '24h' ? `&range=${range}` : ''}`;
        return (
          <Link
            key={value}
            href={href}
            className={`range-tab${active ? ' active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            {value}
          </Link>
        );
      })}
    </div>
  );
}

function HourlyBarChart({ title, unit, bucketKind = 'hour', data: rows, segments, derive, formatValue, totals }) {
  const isDaily = bucketKind === 'day';
  const tooltipFormat = isDaily ? formatDay : formatHour;
  const axisFormat = isDaily ? formatDayShort : formatHourShort;

  const buckets = (rows || []).map((row) => {
    const parts = derive(row);
    const total = segments.reduce((sum, seg) => sum + (Number(parts[seg.key]) || 0), 0);
    const formattedParts = Object.fromEntries(
      segments.map((seg) => [seg.key, formatValue(parts[seg.key] || 0)]),
    );
    return {
      hour: row.hour,
      parts,
      total,
      formattedParts,
      formattedTotal: formatValue(total),
      tooltipLabel: tooltipFormat(row.hour),
      axisLabel: axisFormat(row.hour),
    };
  });

  const maxTotal = buckets.reduce((max, b) => (b.total > max ? b.total : max), 0);
  const chartHeight = 140;
  const chartWidth = 100;
  const barCount = Math.max(1, buckets.length);
  const slotWidth = chartWidth / barCount;
  const barInset = slotWidth * 0.15;
  const unitSuffix = isDaily ? '/d' : '/h';
  const axisStride = Math.max(1, Math.ceil(barCount / 6));
  const safeSegments = segments.map(({ key, label, color }) => ({ key, label, color }));

  return (
    <section className="panel chart-panel">
      <div className="chart-header">
        <h2>{title}</h2>
        <span className="chart-max">
          peak {formatValue(maxTotal)} <span className="chart-unit">{unit}{unitSuffix}</span>
        </span>
      </div>
      <HourlyBarChartBody
        buckets={buckets}
        segments={safeSegments}
        chartHeight={chartHeight}
        chartWidth={chartWidth}
        slotWidth={slotWidth}
        barInset={barInset}
        maxTotal={maxTotal}
        axisStride={axisStride}
        ariaLabel={`${title} ${isDaily ? 'daily' : 'hourly'} chart`}
      />
      <div className="chart-legend">
        {segments.map((seg) => (
          <span key={seg.key} className="chart-legend-item">
            <span className="chart-swatch" style={{ background: seg.color }} />
            {seg.label}
          </span>
        ))}
      </div>
      {totals && totals.length ? (
        <div className="chart-totals">
          <div className="chart-totals-label">Totals</div>
          <StatRows rows={totals} />
        </div>
      ) : null}
    </section>
  );
}

function formatHour(value) {
  if (!value) return '';
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
  });
}

function formatHourShort(value) {
  if (!value) return '';
  return new Date(value).toLocaleString([], { hour: 'numeric' });
}

function formatDay(value) {
  if (!value) return '';
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDayShort(value) {
  if (!value) return '';
  return new Date(value).toLocaleString([], { month: 'short', day: 'numeric' });
}

function RangeTabs({ current, campaign }) {
  return (
    <div className="range-tabs" role="tablist" aria-label="Chart range">
      {RANGE_OPTIONS.map((opt) => {
        const href = `/?campaign=${campaign}${opt.value === '24h' ? '' : `&range=${opt.value}`}`;
        const active = opt.value === current;
        return (
          <Link
            key={opt.value}
            href={href}
            className={`range-tab${active ? ' active' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            {opt.label}
          </Link>
        );
      })}
    </div>
  );
}

function Donut({ centerLabel, total, segments }) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const normalized = segments.map((seg) => ({
    ...seg,
    value: Math.max(0, Number(seg.value) || 0),
  }));

  const radius = 78;
  const stroke = 22;
  const circumference = 2 * Math.PI * radius;

  let offset = 0;
  const arcs = normalized.map((seg) => {
    const length = safeTotal > 0 ? (seg.value / safeTotal) * circumference : 0;
    const arc = (
      <circle
        key={seg.key}
        cx="100"
        cy="100"
        r={radius}
        fill="none"
        stroke={seg.color}
        strokeWidth={stroke}
        strokeDasharray={`${length} ${circumference - length}`}
        strokeDashoffset={-offset}
        transform="rotate(-90 100 100)"
      />
    );
    offset += length;
    return arc;
  });

  return (
    <section className="panel pipeline-panel">
      <div className="pipeline-chart">
        <svg viewBox="0 0 200 200" width="200" height="200" role="img" aria-label={`${centerLabel} breakdown`}>
          <circle cx="100" cy="100" r={radius} fill="none" stroke="var(--line-soft)" strokeWidth={stroke} />
          {safeTotal > 0 ? arcs : null}
        </svg>
        <div className="pipeline-chart-center">
          <span>{centerLabel}</span>
          <strong>{formatNumber(safeTotal)}</strong>
        </div>
      </div>
      <div className="pipeline-legend">
        {normalized.map((seg) => (
          <div className="pipeline-legend-row" key={seg.key}>
            <span className="pipeline-swatch" style={{ background: seg.color }} />
            <span className="pipeline-label">{seg.label}</span>
            <span className="pipeline-value">
              {donutPercent(seg.value, safeTotal)}{' '}
              <span className="pipeline-fraction">
                ({formatNumber(seg.value)}/{formatNumber(safeTotal)})
              </span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function donutPercent(value, total) {
  if (!total) return '0%';
  const ratio = (value / total) * 100;
  return `${ratio >= 10 || ratio === 0 ? ratio.toFixed(0) : ratio.toFixed(1)}%`;
}

function pendingValue(seen, accepted, rejected) {
  return Math.max(0, (Number(seen) || 0) - (Number(accepted) || 0) - (Number(rejected) || 0));
}

function sendDmTotal(queue, sendTotals) {
  const sent = queue.sent || sendTotals.sent || 0;
  const failed = (queue.failed_retryable || 0) + (queue.failed_final || 0);
  return sent + failed + queuedPending(queue, sendTotals);
}

function queuedPending(queue, sendTotals) {
  return (
    (queue.queued || 0) +
    (queue.claimed || 0) +
    (queue.dry_run || sendTotals.dry_run || 0) +
    (queue.skipped || 0)
  );
}

function Metric({ label, value, tone = 'neutral', compact = false }) {
  return (
    <div className={`metric ${tone} ${compact ? 'compact' : ''}`}>
      <span>{label}</span>
      <strong>{formatNumber(value)}</strong>
    </div>
  );
}

function Freshness({ label, value }) {
  return (
    <div className="freshness-item">
      <span>{label}</span>
      <strong>{relativeTime(value)}</strong>
      <small>{value ? formatDate(value) : 'No event yet'}</small>
    </div>
  );
}

function withCostRates(cost, scrapeCounts) {
  return {
    ...cost,
    costPerProcessed: scrapeCounts.processed > 0 ? cost.totalUsd / scrapeCounts.processed : 0,
    costPerAccepted: scrapeCounts.accepted > 0 ? cost.totalUsd / scrapeCounts.accepted : 0,
  };
}

function cloudStatusView(run) {
  const status = run.cloud_status?.status || 'unknown';
  if (status === 'trigger_failed') return { label: 'trigger failed', tone: 'bad' };
  if (status === 'not_triggered') return { label: 'not triggered', tone: 'warn' };
  if (status === 'failed') return { label: 'failed', tone: 'bad' };
  if (status === 'succeeded') return { label: 'succeeded', tone: 'good' };
  if (status === 'running' && run.status === 'requested') return { label: 'starting', tone: 'warn' };
  if (status === 'running') return { label: 'running', tone: 'good' };
  return { label: 'unknown', tone: 'warn' };
}

function sumCounts(counts) {
  return Object.values(counts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
}

function percent(numerator, denominator) {
  if (!denominator) return '0%';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function usd(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function formatNumber(value) {
  if (value === null || value === undefined || value === '') return '';
  return new Intl.NumberFormat('en-US').format(Number(value));
}

function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString();
}

function formatTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString();
}

function relativeTime(value) {
  if (!value) return 'Never';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  return `${relativeDuration(seconds)} ago`;
}

function relativeDuration(value) {
  const seconds = Math.max(0, Number(value || 0));
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function parseHandles(value) {
  return [...new Set(value
    .split(/[\s,]+/)
    .map((handle) => handle.trim().replace(/^@/, ''))
    .filter(Boolean))]
    .slice(0, 10);
}

function boundedPositiveInt(value, fallback, cap) {
  const parsed = Number(value);
  const normalized = Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(normalized, cap);
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function truncateText(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function shortId(id) {
  return String(id || '').slice(0, 8);
}

function shortOperation(name) {
  const parts = String(name || '').split('/');
  return parts[parts.length - 1] || String(name || '').slice(0, 24);
}

function formatRunTimeline(run) {
  return [
    `created ${relativeTime(run.created_at)}`,
    run.started_at ? `claimed ${relativeTime(run.started_at)}` : 'not claimed',
    run.completed_at ? `finished ${relativeTime(run.completed_at)}` : null,
  ].filter(Boolean).join(' | ');
}

function canCommandRun(run) {
  return canPauseRun(run) || canResumeRun(run) || canStopRun(run);
}

function canPauseRun(run) {
  return run.status === 'running' && !run.pending_commands?.includes('pause') && !run.pending_commands?.includes('stop');
}

function canResumeRun(run) {
  return run.status === 'paused' && !run.pending_commands?.includes('resume') && !run.pending_commands?.includes('stop');
}

function canStopRun(run) {
  return ['requested', 'running', 'pause_requested', 'paused'].includes(run.status) && !run.pending_commands?.includes('stop');
}

function canExtendRun(run) {
  return ['completed', 'stopped', 'failed'].includes(run.status) && !run.pending_commands?.length;
}

function displayRunStatus(run) {
  if (run.pending_commands?.includes('stop')) return `${run.status} | stop pending`;
  if (run.pending_commands?.includes('resume')) return `${run.status} | resume pending`;
  if (run.pending_commands?.includes('pause')) return `${run.status} | pause pending`;
  if (run.status === 'paused' && run.pause_reason === 'daily_send_limits_exhausted') {
    return 'paused — daily limits exhausted, auto-resumes after reset';
  }
  if (run.status !== 'running') return run.status;
  return Number(run.seconds_since_update || 0) > STALE_RUN_SECONDS ? 'running stale' : 'running';
}
