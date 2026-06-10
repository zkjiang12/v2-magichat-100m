import { query } from './db';
import { CAMPAIGNS } from './campaigns';

export const LEAD_STATUSES = ['needs_reply', 'interested', 'closed', 'churned'];

// Every creator who has replied, newest reply first, with everything the CRM
// row needs joined in. Leads with no lead_statuses row are 'needs_reply'.
export async function getCrmLeads() {
  const result = await query(
    `
      with response_rollup as (
        select
          creator_id,
          campaign,
          count(*)::int as response_count,
          max(coalesce(responded_at, scraped_at)) as last_responded_at,
          min(coalesce(responded_at, scraped_at)) as first_responded_at
        from dm_responses
        group by creator_id, campaign
      )
      select
        c.handle,
        c.display_name,
        c.profile_url,
        c.followers_count,
        r.campaign,
        r.response_count,
        r.last_responded_at,
        r.first_responded_at,
        ce.fit_score,
        ce.reasoning,
        sq.message as outbound_message,
        sq.sent_at,
        acct.username as sender_username,
        coalesce(ls.status, 'needs_reply') as lead_status,
        cn.note,
        msgs.messages
      from response_rollup r
      join creators c on c.id = r.creator_id
      left join creator_evaluations ce
        on ce.creator_id = r.creator_id and ce.campaign = r.campaign
      left join send_queue sq
        on sq.creator_id = r.creator_id and sq.campaign = r.campaign
      left join sender_accounts acct on acct.id = sq.sender_account_id
      left join lead_statuses ls
        on ls.creator_id = r.creator_id and ls.campaign = r.campaign
      left join campaign_notes cn
        on cn.creator_id = r.creator_id and cn.campaign = r.campaign
      left join lateral (
        select json_agg(
          json_build_object(
            'text', dr.message_text,
            'responded_at', dr.responded_at,
            'account', sa2.username
          )
          order by coalesce(dr.responded_at, dr.scraped_at) desc
        ) as messages
        from (
          select *
          from dm_responses
          where creator_id = r.creator_id and campaign = r.campaign
          order by coalesce(responded_at, scraped_at) desc
          limit 20
        ) dr
        left join sender_accounts sa2 on sa2.id = dr.sender_account_id
      ) msgs on true
      order by r.last_responded_at desc
    `,
  );
  return result.rows;
}

// Sent vs replied per campaign, with the manual status breakdown.
export async function getCrmCampaignStats() {
  const [sends, responses] = await Promise.all([
    query(
      `
        select campaign, count(*) filter (where status = 'sent')::int as sent
        from send_queue
        group by campaign
      `,
    ),
    query(
      `
        select
          r.campaign,
          count(distinct r.creator_id)::int as responders,
          count(distinct r.creator_id) filter (where coalesce(ls.status, 'needs_reply') = 'needs_reply')::int as needs_reply,
          count(distinct r.creator_id) filter (where ls.status = 'interested')::int as interested,
          count(distinct r.creator_id) filter (where ls.status = 'closed')::int as closed,
          count(distinct r.creator_id) filter (where ls.status = 'churned')::int as churned
        from dm_responses r
        left join lead_statuses ls
          on ls.creator_id = r.creator_id and ls.campaign = r.campaign
        group by r.campaign
      `,
    ),
  ]);

  const sendsByCampaign = Object.fromEntries(sends.rows.map((row) => [row.campaign, row]));
  const responsesByCampaign = Object.fromEntries(responses.rows.map((row) => [row.campaign, row]));
  const names = [...new Set([
    ...CAMPAIGNS,
    ...sends.rows.map((row) => row.campaign),
    ...responses.rows.map((row) => row.campaign),
  ])];

  return names.map((name) => {
    const sent = Number(sendsByCampaign[name]?.sent || 0);
    const replied = Number(responsesByCampaign[name]?.responders || 0);
    return {
      campaign: name,
      sent,
      responders: replied,
      replyRate: sent > 0 ? replied / sent : 0,
      needsReply: Number(responsesByCampaign[name]?.needs_reply || 0),
      interested: Number(responsesByCampaign[name]?.interested || 0),
      closed: Number(responsesByCampaign[name]?.closed || 0),
      churned: Number(responsesByCampaign[name]?.churned || 0),
    };
  });
}

export async function setLeadStatus({ handle, campaign, status }) {
  if (!LEAD_STATUSES.includes(status)) throw new Error('Invalid lead status');
  await query(
    `
      insert into lead_statuses (creator_id, campaign, status, updated_at)
      select id, $2, $3, now()
      from creators
      where handle = $1
      on conflict (creator_id, campaign)
      do update set status = excluded.status, updated_at = now()
    `,
    [handle, campaign, status],
  );
}
