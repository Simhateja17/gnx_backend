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
