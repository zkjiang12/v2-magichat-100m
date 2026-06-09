export const CAMPAIGNS = ['day_in_life_creators', 'ugc_creators'];

export function resolveCampaign(value) {
  if (CAMPAIGNS.includes(value)) return value;
  const fallback = process.env.OUTBOUND_CAMPAIGN || CAMPAIGNS[0];
  return CAMPAIGNS.includes(fallback) ? fallback : CAMPAIGNS[0];
}
