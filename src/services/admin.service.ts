import { supabase } from '../lib/supabase';
import { AppError } from '../types';

function countBy<T extends Record<string, any>>(rows: T[], key: keyof T) {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const value = String(row[key] ?? 'unknown');
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function sum(rows: Array<Record<string, any>>, key: string) {
  return rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
}

export async function getAdminOverview() {
  const [
    orgsResult,
    usersResult,
    campaignsResult,
    leadsResult,
    emailsResult,
    repliesResult,
    callsResult,
    ticketsResult,
  ] = await Promise.all([
    supabase.from('organizations').select('id,name,website,plan_id,subscription_status,created_at,updated_at'),
    supabase.from('users').select('id,organization_id,email,first_name,last_name,role,created_at'),
    supabase.from('campaigns').select('id,organization_id,name,channel,status,created_at,updated_at'),
    supabase.from('leads').select('id,organization_id,campaign_id,status,score,created_at'),
    supabase.from('email_messages').select('id,organization_id,campaign_id,status,sent_at,created_at'),
    supabase.from('email_replies').select('id,organization_id,ai_draft_status,received_at'),
    supabase.from('calls').select('id,organization_id,status,disposition,created_at'),
    supabase.from('support_tickets').select('id,organization_id,status,created_at,updated_at'),
  ]);

  const failures = [
    ['organizations', orgsResult.error],
    ['users', usersResult.error],
    ['campaigns', campaignsResult.error],
    ['leads', leadsResult.error],
    ['emails', emailsResult.error],
    ['replies', repliesResult.error],
    ['calls', callsResult.error],
    ['support tickets', ticketsResult.error],
  ] as const;
  const failure = failures.find(([, error]) => error);
  if (failure) throw new AppError(500, `Failed to fetch admin ${failure[0]}`, failure[1]);

  const orgs = orgsResult.data ?? [];
  const users = usersResult.data ?? [];
  const campaigns = campaignsResult.data ?? [];
  const leads = leadsResult.data ?? [];
  const emails = emailsResult.data ?? [];
  const replies = repliesResult.data ?? [];
  const calls = callsResult.data ?? [];
  const tickets = ticketsResult.data ?? [];

  const organizations = orgs.map(org => {
    const orgUsers = users.filter(user => user.organization_id === org.id);
    const orgCampaigns = campaigns.filter(campaign => campaign.organization_id === org.id);
    const orgLeads = leads.filter(lead => lead.organization_id === org.id);
    const orgEmails = emails.filter(email => email.organization_id === org.id);
    const orgReplies = replies.filter(reply => reply.organization_id === org.id);
    const orgCalls = calls.filter(call => call.organization_id === org.id);
    const orgTickets = tickets.filter(ticket => ticket.organization_id === org.id);

    return {
      id: org.id,
      name: org.name,
      website: org.website ?? '',
      planId: org.plan_id,
      subscriptionStatus: org.subscription_status,
      createdAt: org.created_at,
      updatedAt: org.updated_at,
      counts: {
        users: orgUsers.length,
        campaigns: orgCampaigns.length,
        activeCampaigns: orgCampaigns.filter(campaign => campaign.status === 'active').length,
        leads: orgLeads.length,
        hotLeads: orgLeads.filter(lead => Number(lead.score ?? 0) >= 80 || lead.status === 'engaged').length,
        meetings: orgLeads.filter(lead => lead.status === 'meeting_booked').length + orgCalls.filter(call => call.disposition === 'meeting_booked').length,
        emailsSent: orgEmails.filter(email => email.status === 'sent').length,
        replies: orgReplies.length,
        calls: orgCalls.length,
        openTickets: orgTickets.filter(ticket => ticket.status === 'open').length,
      },
    };
  });

  return {
    metrics: {
      organizations: orgs.length,
      users: users.length,
      campaigns: campaigns.length,
      activeCampaigns: campaigns.filter(campaign => campaign.status === 'active').length,
      leads: leads.length,
      hotLeads: leads.filter(lead => Number(lead.score ?? 0) >= 80 || lead.status === 'engaged').length,
      emailsSent: emails.filter(email => email.status === 'sent').length,
      replies: replies.length,
      calls: calls.length,
      meetings: leads.filter(lead => lead.status === 'meeting_booked').length + calls.filter(call => call.disposition === 'meeting_booked').length,
      openTickets: tickets.filter(ticket => ticket.status === 'open').length,
      plans: countBy(orgs, 'plan_id'),
      subscriptionStatuses: countBy(orgs, 'subscription_status'),
    },
    organizations: organizations.sort((a, b) => b.counts.leads - a.counts.leads),
    users: users.map(user => ({
      id: user.id,
      organizationId: user.organization_id,
      email: user.email,
      name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email,
      role: user.role,
      createdAt: user.created_at,
      organizationName: orgs.find(org => org.id === user.organization_id)?.name ?? 'Unknown org',
    })),
    campaigns: campaigns.map(campaign => {
      const campaignLeads = leads.filter(lead => lead.campaign_id === campaign.id);
      const campaignEmails = emails.filter(email => email.campaign_id === campaign.id);
      return {
        id: campaign.id,
        organizationId: campaign.organization_id,
        organizationName: orgs.find(org => org.id === campaign.organization_id)?.name ?? 'Unknown org',
        name: campaign.name,
        channel: campaign.channel,
        status: campaign.status,
        createdAt: campaign.created_at,
        updatedAt: campaign.updated_at,
        stats: {
          leads: campaignLeads.length,
          emailsSent: campaignEmails.filter(email => email.status === 'sent').length,
          meetings: campaignLeads.filter(lead => lead.status === 'meeting_booked').length,
        },
      };
    }).sort((a, b) => sum([b.stats], 'leads') - sum([a.stats], 'leads')),
  };
}

export async function listOrganizations() {
  const overview = await getAdminOverview();
  return { items: overview.organizations };
}

export async function listUsers() {
  const overview = await getAdminOverview();
  return { items: overview.users };
}

export async function listCampaigns() {
  const overview = await getAdminOverview();
  return { items: overview.campaigns };
}

export async function getMetrics() {
  const overview = await getAdminOverview();
  return overview.metrics;
}

export async function suspendOrganization(id: string) {
  const { data, error } = await supabase
    .from('organizations')
    .update({ subscription_status: 'suspended', updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id,name,subscription_status,updated_at')
    .maybeSingle();

  if (error) throw new AppError(500, 'Failed to suspend organization', error);
  if (!data) throw new AppError(404, 'Organization not found');

  return {
    id: data.id,
    name: data.name,
    subscriptionStatus: data.subscription_status,
    updatedAt: data.updated_at,
  };
}

export async function createImpersonationToken(id: string, adminUserId: string) {
  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .select('id,name')
    .eq('id', id)
    .maybeSingle();

  if (orgError) throw new AppError(500, 'Failed to read organization', orgError);
  if (!org) throw new AppError(404, 'Organization not found');

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id,email')
    .eq('organization_id', id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (userError) throw new AppError(500, 'Failed to read impersonation user', userError);
  if (!user) throw new AppError(404, 'No user exists for this organization');

  const payload = {
    organizationId: org.id,
    organizationName: org.name,
    userId: user.id,
    userEmail: user.email,
    adminUserId,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };

  return {
    ...payload,
    token: Buffer.from(JSON.stringify(payload)).toString('base64url'),
  };
}
