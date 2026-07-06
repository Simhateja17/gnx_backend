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
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  weekStart.setHours(0, 0, 0, 0);

  const [
    userResult,
    emailsResult,
    repliesResult,
    meetingActivityResult,
    emailsSentResult,
    repliesCountResult,
    leadsCountResult,
    meetingsCountResult,
    weeklyMeetingsResult,
    hotLeadsResult,
    activeCampaignsResult,
    pendingDraftsResult,
    queuedEmailsResult,
    agentResult,
    gmailResult,
    nextMeetingResult,
  ] = await Promise.all([
    supabase
      .from('users')
      .select('first_name, last_name')
      .eq('id', userId)
      .single(),
    supabase
      .from('email_messages')
      .select('id, subject, status, sent_at, created_at, lead_id, leads(first_name, last_name, company)')
      .eq('organization_id', orgId)
      .eq('status', 'sent')
      .order('sent_at', { ascending: false, nullsFirst: false })
      .limit(10),
    supabase
      .from('email_replies')
      .select('id, body, ai_draft_status, received_at, lead_id, leads(first_name, last_name, company)')
      .eq('organization_id', orgId)
      .order('received_at', { ascending: false })
      .limit(10),
    supabase
      .from('leads')
      .select('id, first_name, last_name, company, updated_at')
      .eq('organization_id', orgId)
      .eq('status', 'meeting_booked')
      .order('updated_at', { ascending: false })
      .limit(5),
    supabase
      .from('email_messages')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('status', 'sent'),
    supabase
      .from('email_replies')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId),
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId),
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('status', 'meeting_booked'),
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('status', 'meeting_booked')
      .gte('updated_at', weekStart.toISOString()),
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .or('score.gte.80,status.eq.engaged'),
    supabase
      .from('campaigns')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('status', 'active'),
    supabase
      .from('email_replies')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('ai_draft_status', 'pending'),
    supabase
      .from('email_messages')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('status', 'queued'),
    supabase
      .from('agent_configs')
      .select('meeting_target, booking_link')
      .eq('organization_id', orgId)
      .maybeSingle(),
    supabase
      .from('connected_accounts')
      .select('id, provider_account_id')
      .eq('organization_id', orgId)
      .eq('provider', 'gmail')
      .maybeSingle(),
    supabase
      .from('meetings')
      .select('id, title, scheduled_at, duration_minutes, join_url, leads(first_name, last_name, title, company)')
      .eq('organization_id', orgId)
      .eq('status', 'scheduled')
      .gte('scheduled_at', now.toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  const dashboardErrors = [
    ['user', userResult.error],
    ['email activity', emailsResult.error],
    ['reply activity', repliesResult.error],
    ['meeting activity', meetingActivityResult.error],
    ['email count', emailsSentResult.error],
    ['reply count', repliesCountResult.error],
    ['lead count', leadsCountResult.error],
    ['meeting count', meetingsCountResult.error],
    ['weekly meeting count', weeklyMeetingsResult.error],
    ['hot lead count', hotLeadsResult.error],
    ['campaign count', activeCampaignsResult.error],
    ['pending draft count', pendingDraftsResult.error],
    ['queued email count', queuedEmailsResult.error],
    ['agent configuration', agentResult.error],
    ['Gmail connection', gmailResult.error],
    ['next meeting', nextMeetingResult.error],
  ] as const;
  const failedQuery = dashboardErrors.find(([, error]) => error);
  if (failedQuery) {
    throw new AppError(500, `Failed to fetch dashboard ${failedQuery[0]}`, failedQuery[1]);
  }

  const emails = emailsResult.data ?? [];
  const replies = repliesResult.data ?? [];
  const meetingActivity = meetingActivityResult.data ?? [];
  const emailsSent = emailsSentResult.count ?? 0;
  const queuedEmails = queuedEmailsResult.count ?? 0;
  const replyCount = repliesCountResult.count ?? 0;
  const meetingsBooked = meetingsCountResult.count ?? 0;
  const weeklyMeetingsBooked = weeklyMeetingsResult.count ?? 0;
  const hotLeads = hotLeadsResult.count ?? 0;
  const replyRate = emailsSent > 0 ? ((replyCount / emailsSent) * 100).toFixed(1) : '0';
  const pendingDrafts = pendingDraftsResult.count ?? 0;
  const savedLeads = leadsCountResult.count ?? 0;
  const activeCampaigns = activeCampaignsResult.count ?? 0;
  const monthlyMeetingTarget = agentResult.data?.meeting_target ?? 15;
  const weeklyMeetingTarget = Math.max(1, Math.ceil(monthlyMeetingTarget / 4));

  type ActivityItem = {
    type: string;
    text: string;
    time: string;
    timeAgo: string;
    hot: boolean;
  };

  const activity: ActivityItem[] = [];

  for (const email of emails) {
    const lead = email.leads as any;
    const name = [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || 'Unknown';
    const company = lead?.company || '';
    const time = email.sent_at ?? email.created_at;
    activity.push({
      type: 'email_sent',
      text: `Sent email to ${name}${company ? ` · ${company}` : ''}`,
      time,
      timeAgo: timeAgo(time),
      hot: false,
    });
  }

  for (const reply of replies) {
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

  for (const lead of meetingActivity) {
    const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Unknown';
    activity.push({
      type: 'meeting',
      text: `Meeting booked with ${name}${lead.company ? ` · ${lead.company}` : ''}`,
      time: lead.updated_at,
      timeAgo: timeAgo(lead.updated_at),
      hot: true,
    });
  }

  activity.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  const tasks = [
    ...(gmailResult.data ? [] : [{
      type: 'gmail',
      title: 'Connect Gmail',
      detail: 'Required before campaigns can send real emails.',
      actionLabel: 'Open settings',
      href: '/settings',
      priority: 'high',
    }]),
    ...(pendingDrafts > 0 ? [{
      type: 'reply',
      title: 'Review AI draft replies',
      detail: `${pendingDrafts} ${pendingDrafts === 1 ? 'reply is' : 'replies are'} waiting for approval.`,
      actionLabel: 'Open inbox',
      href: '/inbox',
      priority: 'high',
    }] : []),
    ...(queuedEmails > 0 ? [{
      type: 'email',
      title: 'Queued emails pending send',
      detail: `${queuedEmails} ${queuedEmails === 1 ? 'email is' : 'emails are'} queued.`,
      actionLabel: 'Review campaigns',
      href: '/campaigns',
      priority: 'medium',
    }] : []),
    ...(activeCampaigns === 0 ? [{
      type: 'campaign',
      title: 'Start a campaign',
      detail: 'No active campaigns are running right now.',
      actionLabel: 'Create campaign',
      href: '/campaigns/new',
      priority: 'medium',
    }] : []),
    ...(savedLeads === 0 ? [{
      type: 'lead',
      title: 'Import leads',
      detail: 'Add Apollo or CSV leads before launching outreach.',
      actionLabel: 'Open prospects',
      href: '/prospects',
      priority: 'medium',
    }] : []),
  ].slice(0, 5);

  const nextMeeting = nextMeetingResult.data;
  const nextMeetingLead = nextMeeting?.leads as any;

  return {
    user: {
      firstName: userResult.data?.first_name ?? '',
      lastName: userResult.data?.last_name ?? '',
    },
    kpis: {
      emailsSent,
      replies: replyCount,
      meetings: meetingsBooked,
      hotLeads,
      replyRate,
      activeCampaigns,
      savedLeads,
    },
    activity: activity.slice(0, 10),
    tasks,
    weeklyGoal: {
      label: 'Meetings booked',
      current: weeklyMeetingsBooked,
      target: weeklyMeetingTarget,
      monthlyTarget: monthlyMeetingTarget,
      progress: Math.min(100, Math.round((weeklyMeetingsBooked / weeklyMeetingTarget) * 100)),
    },
    nextMeeting: nextMeeting ? {
      id: nextMeeting.id,
      title: nextMeeting.title,
      scheduledAt: nextMeeting.scheduled_at,
      durationMinutes: nextMeeting.duration_minutes,
      joinUrl: nextMeeting.join_url,
      attendee: {
        name: [nextMeetingLead?.first_name, nextMeetingLead?.last_name].filter(Boolean).join(' ') || 'Guest',
        title: nextMeetingLead?.title ?? '',
        company: nextMeetingLead?.company ?? '',
      },
    } : null,
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
