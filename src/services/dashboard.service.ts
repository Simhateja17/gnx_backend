import { supabase } from '../lib/supabase';
import { AppError } from '../types';

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export async function getDashboard(userId: string, orgId: string) {
  const { data: user } = await supabase
    .from('users')
    .select('first_name, last_name')
    .eq('id', userId)
    .single();

  const [emailsResult, repliesResult, leadsResult, campaignsResult] = await Promise.all([
    supabase
      .from('email_messages')
      .select('id, subject, sent_at, lead_id, leads(first_name, last_name, company)')
      .eq('organization_id', orgId)
      .eq('status', 'sent')
      .order('sent_at', { ascending: false })
      .limit(50),
    supabase
      .from('email_replies')
      .select('id, body, received_at, lead_id, leads(first_name, last_name, company)')
      .eq('organization_id', orgId)
      .order('received_at', { ascending: false })
      .limit(50),
    supabase
      .from('leads')
      .select('id, status, score, first_name, last_name, company')
      .eq('organization_id', orgId),
    supabase
      .from('campaigns')
      .select('id')
      .eq('organization_id', orgId)
      .eq('status', 'active'),
  ]);

  if (emailsResult.error) throw new AppError(500, 'Failed to fetch email data');
  if (repliesResult.error) throw new AppError(500, 'Failed to fetch reply data');
  if (leadsResult.error) throw new AppError(500, 'Failed to fetch leads data');

  const emails = emailsResult.data ?? [];
  const replies = repliesResult.data ?? [];
  const leads = leadsResult.data ?? [];

  const emailsSent = emails.length;
  const replyCount = replies.length;
  const meetingsBooked = leads.filter(l => l.status === 'meeting_booked').length;
  const hotLeads = leads.filter(l => (l.score ?? 0) >= 80 || l.status === 'engaged').length;
  const replyRate = emailsSent > 0 ? ((replyCount / emailsSent) * 100).toFixed(1) : '0';

  type ActivityItem = {
    type: string;
    text: string;
    time: string;
    timeAgo: string;
    hot: boolean;
  };

  const activity: ActivityItem[] = [];

  for (const email of emails.slice(0, 20)) {
    const lead = email.leads as any;
    const name = [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || 'Unknown';
    const company = lead?.company || '';
    activity.push({
      type: 'email_sent',
      text: `Sent email to ${name}${company ? ` · ${company}` : ''}`,
      time: email.sent_at,
      timeAgo: timeAgo(email.sent_at),
      hot: false,
    });
  }

  for (const reply of replies.slice(0, 20)) {
    const lead = reply.leads as any;
    const name = [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || 'Unknown';
    const company = lead?.company || '';
    activity.push({
      type: 'reply',
      text: `Reply from ${name}${company ? ` · ${company}` : ''}`,
      time: reply.received_at,
      timeAgo: timeAgo(reply.received_at),
      hot: true,
    });
  }

  for (const lead of leads.filter(l => l.status === 'meeting_booked').slice(0, 5)) {
    const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Unknown';
    activity.push({
      type: 'meeting',
      text: `Meeting booked with ${name}${lead.company ? ` · ${lead.company}` : ''}`,
      time: new Date().toISOString(),
      timeAgo: '',
      hot: true,
    });
  }

  activity.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  return {
    user: {
      firstName: user?.first_name ?? '',
      lastName: user?.last_name ?? '',
    },
    kpis: {
      emailsSent,
      replies: replyCount,
      meetings: meetingsBooked,
      hotLeads,
      replyRate,
      activeCampaigns: campaignsResult.data?.length ?? 0,
    },
    activity: activity.slice(0, 10),
  };
}

export async function getAnalytics(orgId: string) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [emailsResult, repliesResult, leadsResult] = await Promise.all([
    supabase
      .from('email_messages')
      .select('id, status, sent_at, created_at')
      .eq('organization_id', orgId)
      .eq('status', 'sent')
      .gte('sent_at', thirtyDaysAgo.toISOString()),
    supabase
      .from('email_replies')
      .select('id, received_at')
      .eq('organization_id', orgId)
      .gte('received_at', thirtyDaysAgo.toISOString()),
    supabase
      .from('leads')
      .select('id, status, score, created_at')
      .eq('organization_id', orgId),
  ]);

  const emails = emailsResult.data ?? [];
  const replies = repliesResult.data ?? [];
  const leads = leadsResult.data ?? [];

  const totalEmails = emails.length;
  const totalReplies = replies.length;
  const totalMeetings = leads.filter(l => l.status === 'meeting_booked').length;
  const replyRate = totalEmails > 0 ? ((totalReplies / totalEmails) * 100).toFixed(1) : '0';

  const dailyEmails: number[] = [];
  const dailyMeetings: number[] = [];
  const dayLabels: string[] = [];

  for (let i = 6; i >= 0; i--) {
    const day = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dayStr = day.toISOString().split('T')[0];
    dayLabels.push(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day.getDay()]);

    dailyEmails.push(
      emails.filter(e => e.sent_at?.startsWith(dayStr)).length
    );
    dailyMeetings.push(
      leads.filter(l => l.status === 'meeting_booked' && l.created_at?.startsWith(dayStr)).length
    );
  }

  const funnel = {
    prospects: leads.length,
    emailed: emails.length,
    replied: replies.length,
    meetingsBooked: totalMeetings,
    closed: leads.filter(l => l.status === 'won').length,
  };

  return {
    summary: {
      meetings: totalMeetings,
      replyRate,
      emailsSent: totalEmails,
    },
    dailyEmails,
    dailyMeetings,
    dayLabels,
    funnel,
  };
}

export async function getCampaignAnalytics(orgId: string) {
  const { data: campaigns, error } = await supabase
    .from('campaigns')
    .select('id, name, channel, status')
    .eq('organization_id', orgId);

  if (error) throw new AppError(500, 'Failed to fetch campaigns');

  const results = await Promise.all(
    (campaigns ?? []).map(async (campaign) => {
      const [enrolledResult, sentResult, repliesResult, meetingsResult] = await Promise.all([
        supabase
          .from('leads')
          .select('id', { count: 'exact', head: true })
          .eq('campaign_id', campaign.id),
        supabase
          .from('email_messages')
          .select('id', { count: 'exact', head: true })
          .eq('campaign_id', campaign.id)
          .eq('status', 'sent'),
        supabase
          .from('email_replies')
          .select('id, email_messages!inner(campaign_id)', { count: 'exact', head: true })
          .eq('email_messages.campaign_id', campaign.id),
        supabase
          .from('leads')
          .select('id', { count: 'exact', head: true })
          .eq('campaign_id', campaign.id)
          .eq('status', 'meeting_booked'),
      ]);

      const enrolled = enrolledResult.count ?? 0;
      const sent = sentResult.count ?? 0;
      const replies = repliesResult.count ?? 0;
      const meetings = meetingsResult.count ?? 0;

      return {
        campaignId: campaign.id,
        name: campaign.name,
        channel: campaign.channel,
        status: campaign.status,
        enrolled,
        sent,
        replies,
        meetings,
        replyRate: sent > 0 ? ((replies / sent) * 100).toFixed(1) : '0',
      };
    })
  );

  return { campaigns: results };
}

export async function getCallAnalytics(orgId: string) {
  const { data: calls, error } = await supabase
    .from('calls')
    .select('id, status, disposition, campaign_id, campaigns(name)')
    .eq('organization_id', orgId);

  if (error) throw new AppError(500, 'Failed to fetch calls');

  const rows = calls ?? [];
  const totalCalls = rows.length;
  const answered = rows.filter(c => !['queued', 'failed', 'no_answer'].includes(c.status)).length;
  const meetingsBooked = rows.filter(c => c.disposition === 'meeting_booked').length;
  const voicemail = rows.filter(c => c.status === 'voicemail').length;
  const failed = rows.filter(c => c.status === 'failed').length;

  const byCampaign = new Map<string, { campaignId: string; name: string; calls: number; meetings: number }>();
  for (const call of rows) {
    if (!call.campaign_id) continue;
    const campaign = call.campaigns as any;
    const entry = byCampaign.get(call.campaign_id) ?? {
      campaignId: call.campaign_id,
      name: campaign?.name ?? 'Unknown',
      calls: 0,
      meetings: 0,
    };
    entry.calls += 1;
    if (call.disposition === 'meeting_booked') entry.meetings += 1;
    byCampaign.set(call.campaign_id, entry);
  }

  return {
    summary: {
      totalCalls,
      answered,
      answerRate: totalCalls > 0 ? ((answered / totalCalls) * 100).toFixed(1) : '0',
      meetingsBooked,
      voicemail,
      failed,
    },
    campaigns: Array.from(byCampaign.values()),
  };
}
