const CACHE_TTL_MS = 60_000;
const cache = new Map();

let warnedMissingTable = false;

export async function getCampaignMessageTemplate(pool, campaign) {
  if (!campaign) return null;

  const cached = cache.get(campaign);
  if (cached && cached.expiresAt > Date.now()) return cached.template;

  let template = null;
  try {
    const result = await pool.query(
      'select message_template from campaigns where name = $1',
      [campaign],
    );
    template = textOrNull(result.rows[0]?.message_template);
  } catch (error) {
    // undefined_table: campaigns table not migrated yet; fall back to env/default template.
    if (error.code !== '42P01') throw error;
    if (!warnedMissingTable) {
      warnedMissingTable = true;
      console.warn('campaigns table not found; run sql/migrations/010_add_campaign_routing_and_templates.sql to enable per-campaign message templates.');
    }
  }

  cache.set(campaign, { template, expiresAt: Date.now() + CACHE_TTL_MS });
  return template;
}

export function clearCampaignTemplateCache() {
  cache.clear();
}

function textOrNull(value) {
  const text = String(value || '').trim();
  return text ? text : null;
}
