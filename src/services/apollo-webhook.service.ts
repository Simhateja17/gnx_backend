import {
  completeApolloEnrichmentRun,
  hashApolloPayload,
  persistApolloPersonToLead,
  type ApolloPerson,
} from './apollo-data.service';
import { supabase } from '../lib/supabase';
import { AppError } from '../types';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function asArray(value: unknown): Array<unknown> {
  return Array.isArray(value) ? value : [];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function normalizeWebhookPerson(input: JsonRecord): ApolloPerson {
  const waterfall = asRecord(input.waterfall);
  const existingPhones = asArray(input.phone_numbers).filter(item => asRecord(item));
  const waterfallPhones = asArray(waterfall?.phone_numbers)
    .flatMap(entry => asArray(asRecord(entry)?.vendors))
    .flatMap(vendor => asArray(asRecord(vendor)?.phone_numbers))
    .map(phone => typeof phone === 'string' ? { sanitized_number: phone } : asRecord(phone))
    .filter((phone): phone is JsonRecord => Boolean(phone?.sanitized_number));
  const phoneNumbers = existingPhones.length > 0 ? existingPhones : waterfallPhones;

  const email = firstString(
    input.email,
    asArray(input.emails).map(item => asRecord(item)?.email).find(value => typeof value === 'string'),
    asArray(waterfall?.emails)
      .flatMap(entry => asArray(asRecord(entry)?.vendors))
      .flatMap(vendor => asArray(asRecord(vendor)?.emails))
      .map(value => asRecord(value)?.email)
      .find(value => typeof value === 'string'),
  );
  const firstPhone = asRecord(phoneNumbers[0]);

  return {
    ...input,
    id: firstString(input.id) ?? undefined,
    email: email ?? undefined,
    phone_numbers: phoneNumbers as Array<JsonRecord>,
    dnc_status: firstString(input.dnc_status, firstPhone?.dnc_status_cd) ?? undefined,
  };
}

function webhookPeople(payload: JsonRecord): JsonRecord[] {
  return asArray(payload.people).map(asRecord).filter(Boolean) as JsonRecord[];
}

export async function handleApolloWebhook(payload: unknown) {
  const body = asRecord(payload);
  if (!body) throw new AppError(400, 'Invalid Apollo webhook payload');

  const people = webhookPeople(body);
  const personIds = people.map(person => firstString(person.id)).filter(Boolean) as string[];
  if (personIds.length === 0) throw new AppError(400, 'Apollo webhook contains no person identifiers');

  const requestId = firstString(body.request_id);
  const eventKey = `apollo:${requestId ?? 'no-request-id'}:${hashApolloPayload(body)}`;

  let runs: Array<{ id: string; organization_id: string; lead_id: string | null; account_id: string | null }> = [];
  if (requestId) {
    const runsResult = await supabase
      .from('apollo_enrichment_runs')
      .select('id,organization_id,lead_id,account_id')
      .eq('provider_request_id', requestId);
    if (runsResult.error) throw new AppError(500, 'Failed to find Apollo enrichment run for webhook', runsResult.error);
    runs = (runsResult.data ?? []) as Array<{ id: string; organization_id: string; lead_id: string | null; account_id: string | null }>;
  }
  const defaultRun = runs[0] ?? null;
  const { data: event, error: eventError } = await supabase
    .from('apollo_webhook_events')
    .insert({
      event_key: eventKey,
      organization_id: defaultRun?.organization_id ?? null,
      lead_id: defaultRun?.lead_id ?? null,
      account_id: defaultRun?.account_id ?? null,
      enrichment_run_id: defaultRun?.id ?? null,
      event_type: firstString(body.target_fields, body.status) ?? 'apollo_enrichment_completed',
      payload: body,
    })
    .select('id')
    .single();

  if (eventError?.code === '23505') return { received: true, duplicate: true, eventKey };
  if (eventError || !event) throw new AppError(500, 'Failed to record Apollo webhook', eventError);

  try {
    const leadResult = await supabase
      .from('leads')
      .select('id,organization_id,apollo_id')
      .in('apollo_id', personIds);
    if (leadResult.error) throw new AppError(500, 'Failed to find leads for Apollo webhook', leadResult.error);

    const leads = (leadResult.data ?? []) as Array<{ id: string; organization_id: string; apollo_id: string | null }>;
    if (!requestId && runs.length === 0 && leads.length > 0) {
      const pendingRunsResult = await supabase
        .from('apollo_enrichment_runs')
        .select('id,organization_id,lead_id,account_id')
        .in('lead_id', leads.map(lead => lead.id))
        .eq('status', 'awaiting_webhook');
      if (pendingRunsResult.error) throw new AppError(500, 'Failed to find pending Apollo webhook runs', pendingRunsResult.error);
      runs = (pendingRunsResult.data ?? []) as Array<{ id: string; organization_id: string; lead_id: string | null; account_id: string | null }>;
      if (runs[0]) {
        await supabase
          .from('apollo_webhook_events')
          .update({
            organization_id: runs[0].organization_id,
            lead_id: runs[0].lead_id,
            account_id: runs[0].account_id,
            enrichment_run_id: runs[0].id,
          })
          .eq('id', event.id);
      }
    }
    const processedLeadIds = new Set<string>();
    for (const personInput of people) {
      const personId = firstString(personInput.id);
      if (!personId) continue;
      const person = normalizeWebhookPerson(personInput);
      const linkedLeads = leads.filter(lead => lead.apollo_id === personId);

      for (const lead of linkedLeads) {
        if (processedLeadIds.has(lead.id)) continue;
        await persistApolloPersonToLead(lead.organization_id, lead.id, person);
        processedLeadIds.add(lead.id);
      }
    }

    const creditCost = typeof body.credits_consumed === 'number' ? body.credits_consumed : null;
    const completedAt = new Date().toISOString();
    for (const run of runs) {
      await completeApolloEnrichmentRun(run.organization_id, run.id, {
        providerRequestId: requestId,
        providerStatus: firstString(body.status),
        creditCost,
        rawPayload: body,
        status: 'completed',
        webhookReceivedAt: completedAt,
      });
    }

    await supabase
      .from('apollo_webhook_events')
      .update({ processed_at: completedAt, attempt_count: 1 })
      .eq('id', event.id);

    return {
      received: true,
      duplicate: false,
      eventKey,
      updatedLeads: processedLeadIds.size,
      updatedRuns: runs.length,
    };
  } catch (error) {
    await supabase
      .from('apollo_webhook_events')
      .update({ attempt_count: 1, last_error: error instanceof Error ? error.message : 'Apollo webhook processing failed' })
      .eq('id', event.id);
    throw error;
  }
}
