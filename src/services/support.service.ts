import { supabase } from '../lib/supabase';
import { sendSupportReplyNotification } from '../lib/resend';
import { AppError } from '../types';

type TicketInput = {
  subject: string;
  body: string;
};

function displayName(user: any) {
  return [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.email || 'User';
}

function toTicket(row: any) {
  const messages = row.support_messages ?? [];
  const lastMessage = messages[0];
  return {
    id: row.id,
    subject: row.subject,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    organizationId: row.organization_id,
    organizationName: row.organizations?.name ?? '',
    user: row.users ? {
      id: row.users.id,
      name: displayName(row.users),
      email: row.users.email,
    } : null,
    lastMessage: lastMessage ? {
      body: lastMessage.body,
      senderType: lastMessage.sender_type,
      createdAt: lastMessage.created_at,
    } : null,
  };
}

function toMessage(row: any) {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    senderType: row.sender_type,
    senderId: row.sender_id,
    body: row.body,
    createdAt: row.created_at,
    sender: row.users ? {
      name: displayName(row.users),
      email: row.users.email,
    } : null,
  };
}

export async function listTickets(orgId: string) {
  const { data, error } = await supabase
    .from('support_tickets')
    .select('id,organization_id,user_id,subject,status,created_at,updated_at, support_messages(body,sender_type,created_at)')
    .eq('organization_id', orgId)
    .order('updated_at', { ascending: false })
    .order('created_at', { referencedTable: 'support_messages', ascending: false })
    .limit(1, { referencedTable: 'support_messages' });

  if (error) throw new AppError(500, 'Failed to fetch support tickets', error);
  return { items: (data ?? []).map(toTicket) };
}

export async function createTicket(orgId: string, userId: string, input: TicketInput) {
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (!subject) throw new AppError(400, 'Ticket subject is required');
  if (!body) throw new AppError(400, 'Ticket message is required');

  const { data: ticket, error: ticketError } = await supabase
    .from('support_tickets')
    .insert({
      organization_id: orgId,
      user_id: userId,
      subject,
      status: 'open',
      updated_at: new Date().toISOString(),
    })
    .select('id,organization_id,user_id,subject,status,created_at,updated_at')
    .single();

  if (ticketError) throw new AppError(500, 'Failed to create support ticket', ticketError);

  const { error: messageError } = await supabase
    .from('support_messages')
    .insert({
      ticket_id: ticket.id,
      sender_type: 'user',
      sender_id: userId,
      body,
    });

  if (messageError) throw new AppError(500, 'Failed to create support message', messageError);

  return getTicket(orgId, ticket.id);
}

export async function getTicket(orgId: string, ticketId: string) {
  const { data: ticket, error: ticketError } = await supabase
    .from('support_tickets')
    .select('id,organization_id,user_id,subject,status,created_at,updated_at, users(id,email,first_name,last_name), organizations(name)')
    .eq('organization_id', orgId)
    .eq('id', ticketId)
    .maybeSingle();

  if (ticketError) throw new AppError(500, 'Failed to fetch support ticket', ticketError);
  if (!ticket) throw new AppError(404, 'Support ticket not found');

  const { data: messages, error: messagesError } = await supabase
    .from('support_messages')
    .select('id,ticket_id,sender_type,sender_id,body,created_at, users(id,email,first_name,last_name)')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true });

  if (messagesError) throw new AppError(500, 'Failed to fetch support messages', messagesError);

  return {
    ...toTicket(ticket),
    messages: (messages ?? []).map(toMessage),
  };
}

export async function addUserMessage(orgId: string, userId: string, ticketId: string, body: string) {
  return addMessage({ orgId, userId, ticketId, body, senderType: 'user' });
}

export async function addAdminMessage(adminUserId: string, ticketId: string, body: string) {
  return addMessage({ adminUserId, ticketId, body, senderType: 'admin' });
}

async function addMessage(input: {
  orgId?: string;
  userId?: string;
  adminUserId?: string;
  ticketId: string;
  body: string;
  senderType: 'user' | 'admin';
}) {
  const body = input.body.trim();
  if (!body) throw new AppError(400, 'Message body is required');

  let ticketQuery = supabase
    .from('support_tickets')
    .select('id,organization_id,user_id,subject,status, users(id,email,first_name,last_name)')
    .eq('id', input.ticketId);

  if (input.orgId) ticketQuery = ticketQuery.eq('organization_id', input.orgId);

  const { data: ticket, error: ticketError } = await ticketQuery.maybeSingle();
  if (ticketError) throw new AppError(500, 'Failed to fetch support ticket', ticketError);
  if (!ticket) throw new AppError(404, 'Support ticket not found');
  if (ticket.status === 'closed') throw new AppError(400, 'Closed tickets cannot receive new messages');

  const senderId = input.senderType === 'admin' ? input.adminUserId : input.userId;
  if (!senderId) throw new AppError(401, 'Sender not found');

  const now = new Date().toISOString();
  const { data: message, error: messageError } = await supabase
    .from('support_messages')
    .insert({
      ticket_id: ticket.id,
      sender_type: input.senderType,
      sender_id: senderId,
      body,
    })
    .select('id,ticket_id,sender_type,sender_id,body,created_at, users(id,email,first_name,last_name)')
    .single();

  if (messageError) throw new AppError(500, 'Failed to send support message', messageError);

  const { error: updateError } = await supabase
    .from('support_tickets')
    .update({
      status: input.senderType === 'admin' ? 'open' : ticket.status,
      updated_at: now,
    })
    .eq('id', ticket.id);

  if (updateError) throw new AppError(500, 'Failed to update support ticket', updateError);

  const ticketUser = Array.isArray((ticket as any).users) ? (ticket as any).users[0] : (ticket as any).users;
  if (input.senderType === 'admin' && ticketUser?.email) {
    try {
      await sendSupportReplyNotification({
        to: ticketUser.email,
        userName: displayName(ticketUser),
        subject: ticket.subject,
        ticketId: ticket.id,
        message: body,
      });
    } catch (err) {
      console.error('[support] Failed to send admin reply notification:', err);
    }
  }

  return toMessage(message);
}

export async function updateTicketStatus(orgId: string | undefined, ticketId: string, status: 'open' | 'resolved' | 'closed') {
  let query = supabase
    .from('support_tickets')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', ticketId);

  if (orgId) query = query.eq('organization_id', orgId);

  const { data, error } = await query
    .select('id,organization_id,user_id,subject,status,created_at,updated_at')
    .maybeSingle();
  if (error) throw new AppError(500, 'Failed to update support ticket status', error);
  if (!data) throw new AppError(404, 'Support ticket not found');
  return toTicket(data);
}

export async function listAdminTickets() {
  const { data, error } = await supabase
    .from('support_tickets')
    .select('id,organization_id,user_id,subject,status,created_at,updated_at, users(id,email,first_name,last_name), organizations(name), support_messages(body,sender_type,created_at)')
    .order('updated_at', { ascending: false })
    .order('created_at', { referencedTable: 'support_messages', ascending: false })
    .limit(1, { referencedTable: 'support_messages' });

  if (error) throw new AppError(500, 'Failed to fetch admin support tickets', error);
  return { items: (data ?? []).map(toTicket) };
}

export async function getAdminTicket(ticketId: string) {
  const { data: ticket, error: ticketError } = await supabase
    .from('support_tickets')
    .select('id,organization_id,user_id,subject,status,created_at,updated_at, users(id,email,first_name,last_name), organizations(name)')
    .eq('id', ticketId)
    .maybeSingle();

  if (ticketError) throw new AppError(500, 'Failed to fetch admin support ticket', ticketError);
  if (!ticket) throw new AppError(404, 'Support ticket not found');

  const { data: messages, error: messagesError } = await supabase
    .from('support_messages')
    .select('id,ticket_id,sender_type,sender_id,body,created_at, users(id,email,first_name,last_name)')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true });

  if (messagesError) throw new AppError(500, 'Failed to fetch support messages', messagesError);

  return {
    ...toTicket(ticket),
    messages: (messages ?? []).map(toMessage),
  };
}
