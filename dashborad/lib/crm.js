import { query } from './db';
import { CAMPAIGNS } from './campaigns';

export const LEAD_STATUSES = ['needs_reply', 'interested', 'closed', 'churned'];

// Every creator who has replied to an Instantly campaign email, newest reply
// first, with everything the CRM row needs joined in. Leads with no
// lead_statuses row are 'needs_reply'.
export async function getCrmLeads() {
  const result = await query(
    `
      with response_rollup as (
        select
          creator_id,
          campaign,
          count(*)::int as response_count,
          max(coalesce(received_at, scraped_at)) as last_responded_at,
          min(coalesce(received_at, scraped_at)) as first_responded_at,
          (array_agg(lead_email order by coalesce(received_at, scraped_at) desc))[1] as lead_email
        from email_responses
        where creator_id is not null
        group by creator_id, campaign
      )
      select
        c.handle,
        c.display_name,
        c.profile_url,
        c.followers_count,
        c.emails,
        r.campaign,
        r.response_count,
        r.last_responded_at,
        r.first_responded_at,
        r.lead_email,
        ce.fit_score,
        ce.reasoning,
        s.pushed_at,
        coalesce(ls.status, 'needs_reply') as lead_status,
        cn.note,
        msgs.messages
      from response_rollup r
      join creators c on c.id = r.creator_id
      left join creator_evaluations ce
        on ce.creator_id = r.creator_id and ce.campaign = r.campaign
      left join lateral (
        select pushed_at
        from instantly_sync
        where creator_id = r.creator_id
          and campaign = r.campaign
          and status = 'pushed'
        order by pushed_at asc nulls last
        limit 1
      ) s on true
      left join lead_statuses ls
        on ls.creator_id = r.creator_id and ls.campaign = r.campaign
      left join campaign_notes cn
        on cn.creator_id = r.creator_id and cn.campaign = r.campaign
      left join lateral (
        select json_agg(
          json_build_object(
            'subject', er.subject,
            'text', er.body_text,
            'responded_at', er.received_at,
            'from', er.from_address
          )
          order by coalesce(er.received_at, er.scraped_at) desc
        ) as messages
        from (
          select *
          from email_responses
          where creator_id = r.creator_id and campaign = r.campaign
          order by coalesce(received_at, scraped_at) desc
          limit 20
        ) er
      ) msgs on true
      order by r.last_responded_at desc
    `,
  );
  return result.rows;
}

// Leads pushed to Instantly vs distinct creators who replied, per source
// campaign, with the manual status breakdown and Instantly's own send counts.
export async function getCrmCampaignStats() {
  const [pushes, responses, sendStats] = await Promise.all([
    query(
      `
        select campaign, count(distinct creator_id)::int as contacted
        from instantly_sync
        where status = 'pushed'
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
        from email_responses r
        left join lead_statuses ls
          on ls.creator_id = r.creator_id and ls.campaign = r.campaign
        where r.creator_id is not null
        group by r.campaign
      `,
    ),
    queryInstantlySendStats(),
  ]);

  const pushesByCampaign = Object.fromEntries(pushes.rows.map((row) => [row.campaign, row]));
  const responsesByCampaign = Object.fromEntries(responses.rows.map((row) => [row.campaign, row]));
  const statsByCampaign = Object.fromEntries(sendStats.map((row) => [row.campaign, row]));
  const names = [...new Set([
    ...CAMPAIGNS,
    ...pushes.rows.map((row) => row.campaign),
    ...responses.rows.map((row) => row.campaign),
    ...sendStats.map((row) => row.campaign),
  ])];

  return names.map((name) => {
    const contacted = Number(pushesByCampaign[name]?.contacted || 0);
    const replied = Number(responsesByCampaign[name]?.responders || 0);
    return {
      campaign: name,
      contacted,
      responders: replied,
      replyRate: contacted > 0 ? replied / contacted : 0,
      needsReply: Number(responsesByCampaign[name]?.needs_reply || 0),
      interested: Number(responsesByCampaign[name]?.interested || 0),
      closed: Number(responsesByCampaign[name]?.closed || 0),
      churned: Number(responsesByCampaign[name]?.churned || 0),
      emailsSent: Number(statsByCampaign[name]?.emails_sent || 0),
      emailsBounced: Number(statsByCampaign[name]?.bounced || 0),
      statsFetchedAt: statsByCampaign[name]?.fetched_at || null,
    };
  });
}

// Instantly's own per-campaign send counts (written by the reply-check job).
// Summed per source campaign in case one ever maps to multiple Instantly
// campaigns. Returns [] when migration 020 isn't applied yet.
async function queryInstantlySendStats() {
  try {
    const result = await query(
      `
        select
          campaign,
          sum(emails_sent_count)::int as emails_sent,
          sum(bounced_count)::int as bounced,
          max(fetched_at) as fetched_at
        from instantly_campaign_stats
        group by campaign
      `,
    );
    return result.rows;
  } catch (error) {
    console.warn(`[crm] instantly campaign stats unavailable: ${error.message}`);
    return [];
  }
}

// Replies whose sender couldn't be matched to a pushed lead. They stay in
// email_responses (attribution is retried on every check run); surfacing the
// count keeps them from silently disappearing from the CRM.
export async function getUnattributedReplyCount() {
  const result = await query(
    `select count(*)::int as count from email_responses where creator_id is null`,
  );
  return Number(result.rows[0]?.count || 0);
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
