import { fetchJsonWithRetry, HttpError } from './retry.js';

const INSTANTLY_API_BASE = 'https://api.instantly.ai/api/v2';

export function createInstantlyClient({ apiKey, fetchImpl = fetch }) {
  if (!apiKey) throw new Error('Instantly API key is required.');

  async function request({ method = 'GET', path, body, label }) {
    const { body: responseBody } = await fetchJsonWithRetry({
      url: `${INSTANTLY_API_BASE}${path}`,
      label: label || `Instantly ${method} ${path}`,
      fetchImpl,
      options: {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    });
    return responseBody;
  }

  return {
    async listCampaigns() {
      const campaigns = [];
      const seenCursors = new Set();
      let startingAfter = null;
      do {
        const query = new URLSearchParams({ limit: '100' });
        if (startingAfter) query.set('starting_after', startingAfter);
        const page = await request({
          path: `/campaigns?${query}`,
          label: 'Instantly list campaigns',
        });
        campaigns.push(...(page.items || []));
        startingAfter = page.next_starting_after || null;
        if (startingAfter && seenCursors.has(startingAfter)) break;
        if (startingAfter) seenCursors.add(startingAfter);
      } while (startingAfter);
      return campaigns;
    },

    async createCampaign(campaign) {
      return request({
        method: 'POST',
        path: '/campaigns',
        body: campaign,
        label: `Instantly create campaign ${campaign.name}`,
      });
    },

    async createLead(lead) {
      return request({
        method: 'POST',
        path: '/leads',
        body: lead,
        label: `Instantly create lead ${lead.email}`,
      });
    },

    async deleteLead(leadId) {
      return request({
        method: 'DELETE',
        path: `/leads/${leadId}`,
        label: `Instantly delete lead ${leadId}`,
      });
    },

    async listEmails({ campaignId, emailType = 'received', maxPages = 50 } = {}) {
      const emails = [];
      const seenCursors = new Set();
      let startingAfter = null;
      let pages = 0;
      do {
        const query = new URLSearchParams({ limit: '100' });
        if (campaignId) query.set('campaign_id', campaignId);
        if (emailType) query.set('email_type', emailType);
        if (startingAfter) query.set('starting_after', startingAfter);
        const page = await request({
          path: `/emails?${query}`,
          label: 'Instantly list emails',
        });
        emails.push(...(page.items || []));
        startingAfter = page.next_starting_after || null;
        if (startingAfter && seenCursors.has(startingAfter)) break;
        if (startingAfter) seenCursors.add(startingAfter);
        pages += 1;
      } while (startingAfter && pages < maxPages);
      return emails;
    },
  };
}

export function isDuplicateLeadError(error) {
  if (!(error instanceof HttpError)) return false;
  if (error.status !== 400 && error.status !== 409) return false;
  const message = JSON.stringify(error.body || '').toLowerCase();
  return message.includes('duplicate') || message.includes('already exist');
}
