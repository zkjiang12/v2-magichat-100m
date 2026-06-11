'use server';

import { revalidatePath } from 'next/cache';

import { CAMPAIGNS, resolveCampaign } from '../lib/campaigns';
import { triggerScraperCloudRunJob, triggerSenderCloudRunJob } from '../lib/cloud-run';
import { setLeadStatus } from '../lib/crm';
import {
  createRunCommand,
  createScraperRun,
  createSenderRun,
  extendScraperRun,
  recordScraperCloudTrigger,
  recordSenderCloudTrigger,
  requeueCampaignFailures,
  requeueCreatorSend,
  requeueRunFailures,
  saveCreatorNote,
  updateSenderAccountSettings,
} from '../lib/queries';

// Every action returns { ok, message|error, at } instead of throwing, so the
// client forms can show inline feedback rather than crashing to an error page.
function ok(message = null) {
  return { ok: true, message, error: null, at: Date.now() };
}

function fail(error) {
  return { ok: false, message: null, error: String(error || 'Something went wrong'), at: Date.now() };
}

export async function startScraperRunAction(prevState, formData) {
  try {
    const campaign = resolveCampaign(String(formData.get('campaign') || ''));
    const seedHandles = parseHandles(String(formData.get('seedHandles') || ''));
    if (seedHandles.length === 0) return fail('Enter at least one seed handle.');

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
      revalidatePath('/');
      return fail(`Run created, but the cloud trigger failed: ${caught.message}`);
    }

    revalidatePath('/');
    return ok(`Scraper run ${String(run.id).slice(0, 8)} created`);
  } catch (caught) {
    return fail(caught.message);
  }
}

export async function startSenderRunAction(prevState, formData) {
  try {
    const campaign = resolveCampaign(String(formData.get('campaign') || ''));
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
      revalidatePath('/');
      return fail(`Run created, but the cloud trigger failed: ${caught.message}`);
    }

    revalidatePath('/');
    return ok(`Sender run ${String(run.id).slice(0, 8)} created`);
  } catch (caught) {
    return fail(caught.message);
  }
}

export async function extendRunAction(prevState, formData) {
  try {
    const campaign = resolveCampaign(String(formData.get('campaign') || ''));
    const runId = String(formData.get('runId'));
    const addAccepted = positiveInt(formData.get('addAccepted'), 500);

    const extended = await extendScraperRun({ campaign, runId, addAccepted });
    if (!extended) return fail('Run can no longer be extended.');

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
      revalidatePath('/');
      return fail(`Run extended, but the cloud trigger failed: ${caught.message}`);
    }

    revalidatePath('/');
    return ok(`Run extended by ${addAccepted}`);
  } catch (caught) {
    return fail(caught.message);
  }
}

export async function commandRunAction(prevState, formData) {
  try {
    const campaign = resolveCampaign(String(formData.get('campaign') || ''));
    await createRunCommand({
      campaign,
      runType: String(formData.get('runType')),
      runId: String(formData.get('runId')),
      command: String(formData.get('command')),
    });
    revalidatePath('/');
    return ok();
  } catch (caught) {
    return fail(caught.message);
  }
}

export async function retryRunFailuresAction(prevState, formData) {
  try {
    const campaign = resolveCampaign(String(formData.get('campaign') || ''));
    const count = await requeueRunFailures({
      runId: String(formData.get('runId') || ''),
      campaign,
    });
    revalidatePath('/');
    return ok(`Requeued ${count} sends`);
  } catch (caught) {
    return fail(caught.message);
  }
}

export async function requeueAllFailuresAction(prevState, formData) {
  try {
    const campaign = resolveCampaign(String(formData.get('campaign') || ''));
    const count = await requeueCampaignFailures({ campaign });
    revalidatePath('/');
    return ok(`Requeued ${count} sends`);
  } catch (caught) {
    return fail(caught.message);
  }
}

export async function updateSenderAccountAction(prevState, formData) {
  try {
    const username = String(formData.get('username') || '').trim();
    if (!username) return fail('Missing account username.');
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
    revalidatePath(`/accounts/${username}`);
    return ok('Saved');
  } catch (caught) {
    return fail(caught.message);
  }
}

export async function setLeadStatusAction(prevState, formData) {
  try {
    await setLeadStatus({
      handle: String(formData.get('handle') || ''),
      campaign: String(formData.get('campaign') || ''),
      status: String(formData.get('status') || ''),
    });
    revalidatePath('/crm');
    return ok();
  } catch (caught) {
    return fail(caught.message);
  }
}

export async function saveNoteAction(prevState, formData) {
  try {
    const handle = String(formData.get('handle') || '');
    await saveCreatorNote({
      handle,
      campaign: String(formData.get('campaign') || ''),
      note: String(formData.get('note') || ''),
    });
    revalidatePath('/crm');
    revalidatePath(`/creators/${handle}`);
    revalidatePath('/');
    return ok('Note saved');
  } catch (caught) {
    return fail(caught.message);
  }
}

export async function requeueCreatorSendAction(prevState, formData) {
  try {
    const handle = String(formData.get('handle') || '');
    const campaign = resolveCampaign(String(formData.get('campaign') || ''));
    const count = await requeueCreatorSend({ handle, campaign });
    revalidatePath(`/creators/${handle}`);
    revalidatePath('/');
    return count > 0 ? ok('DM requeued') : fail('Nothing to requeue.');
  } catch (caught) {
    return fail(caught.message);
  }
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
