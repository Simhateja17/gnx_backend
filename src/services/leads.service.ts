import { env } from '../config/env';
import { supabase } from '../lib/supabase';
import { redis } from '../lib/redis';
import { AppError } from '../types';
import { mapRow } from '../lib/csv-parser';
import type { ApolloEnrichInput, ApolloSearchInput, CsvUploadInput, LeadCreateInput } from '../schemas/leads.schema';
import type { CsvImportJobData, CsvImportProgress } from '../jobs/csv-import.job';

type LeadRow = {
  id: string;
  organization_id: string;
  campaign_id: string | null;
  source: 'apollo' | 'csv' | 'manual';
  apollo_id: string | null;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  title: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  linkedin_url: string | null;
  timezone: string | null;
  score: number | null;
  status: string;
  raw_data: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type ApolloPerson = {
  id?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  title?: string;
  headline?: string;
  email?: string;
  phone_numbers?: Array<{ raw_number?: string; sanitized_number?: string }>;
  organization?: { name?: string };
  employment_history?: Array<{ organization_name?: string; current?: boolean }>;
  city?: string;
  state?: string;
  country?: string;
  linkedin_url?: string;
  photo_url?: string;
};

const LEAD_COLUMNS = [
  'id',
  'organization_id',
  'campaign_id',
  'source',
  'apollo_id',
  'first_name',
  'last_name',
  'name',
  'title',
  'company',
  'email',
  'phone',
  'location',
  'linkedin_url',
  'timezone',
  'score',
  'status',
  'raw_data',
  'created_at',
  'updated_at',
].join(',');

function clean(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function toApiLead(row: LeadRow) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    source: row.source,
    firstName: row.first_name,
    lastName: row.last_name,
    name: row.name,
    title: row.title,
    company: row.company,
    email: row.email,
    phone: row.phone,
    location: row.location,
    linkedinUrl: row.linkedin_url,
    score: row.score ?? 0,
    status: row.status,
    createdAt: row.created_at,
    rawData: row.raw_data,
  };
}

function toLeadRecord(orgId: string, input: LeadCreateInput, rawData?: Record<string, unknown>) {
  const firstName = clean(input.firstName);
  const lastName = clean(input.lastName);
  const name = clean(input.name) ?? ([firstName, lastName].filter(Boolean).join(' ') || null);

  return {
    organization_id: orgId,
    campaign_id: input.campaignId ?? null,
    source: input.source,
    apollo_id: clean(input.apolloId),
    first_name: firstName,
    last_name: lastName,
    name,
    title: clean(input.title),
    company: clean(input.company),
    email: clean(input.email),
    phone: clean(input.phone),
    location: clean(input.location),
    linkedin_url: clean(input.linkedinUrl),
    status: 'new',
    raw_data: rawData ?? null,
    updated_at: new Date().toISOString(),
  };
}

function mapApolloPerson(person: ApolloPerson) {
  const company =
    person.organization?.name ??
    person.employment_history?.find(item => item.current)?.organization_name ??
    person.employment_history?.[0]?.organization_name ??
    '';
  const phone = person.phone_numbers?.[0]?.sanitized_number ?? person.phone_numbers?.[0]?.raw_number ?? '';
  const location = [person.city, person.state, person.country].filter(Boolean).join(', ');

  return {
    apolloId: person.id ?? '',
    firstName: person.first_name ?? '',
    lastName: person.last_name ?? '',
    name: person.name ?? [person.first_name, person.last_name].filter(Boolean).join(' '),
    title: person.title ?? person.headline ?? '',
    company,
    email: person.email ?? '',
    phone,
    location,
    linkedinUrl: person.linkedin_url ?? '',
    photoUrl: person.photo_url ?? '',
  };
}

export async function listLeads(orgId: string) {
  const { data, error } = await supabase
    .from('leads')
    .select(LEAD_COLUMNS)
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) throw new AppError(500, 'Failed to fetch leads', error);
  return { items: ((data ?? []) as unknown as LeadRow[]).map(toApiLead) };
}

export async function createLead(orgId: string, input: LeadCreateInput) {
  const { data, error } = await supabase
    .from('leads')
    .insert(toLeadRecord(orgId, input))
    .select(LEAD_COLUMNS)
    .single();

  if (error) throw new AppError(500, 'Failed to create lead', error);
  return toApiLead(data as unknown as LeadRow);
}

export async function searchApollo(input: ApolloSearchInput) {
  const body: Record<string, unknown> = {
    page: input.page,
    per_page: input.perPage,
  };

  if (input.titles.length > 0) body.person_titles = input.titles;
  if (input.locations.length > 0) body.person_locations = input.locations;
  if (input.companySizes.length > 0) body.organization_num_employees_ranges = input.companySizes;
  if (input.keywords) body.q_keywords = input.keywords;

  const response = await fetch('https://api.apollo.io/api/v1/mixed_people/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'x-api-key': env.APOLLO_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new AppError(response.status, 'Apollo search failed', details.slice(0, 1000));
  }

  const data = await response.json() as {
    people?: ApolloPerson[];
    contacts?: ApolloPerson[];
    pagination?: { page?: number; per_page?: number; total_entries?: number; total_pages?: number };
  };
  const people = data.people ?? data.contacts ?? [];

  return {
    items: people.map(mapApolloPerson),
    pagination: data.pagination ?? {
      page: input.page,
      perPage: input.perPage,
      totalEntries: people.length,
    },
  };
}

export async function uploadCsvLeads(orgId: string, input: CsvUploadInput) {
  const records = input.rows.map(row => toLeadRecord(
    orgId,
    {
      campaignId: input.campaignId,
      source: 'csv',
      firstName: row.firstName,
      lastName: row.lastName,
      name: row.name,
      title: row.title,
      company: row.company,
      email: row.email,
      phone: row.phone,
      location: row.location,
      linkedinUrl: row.linkedinUrl,
    },
    row.rawData
  ));

  const { data, error } = await supabase
    .from('leads')
    .insert(records)
    .select(LEAD_COLUMNS);

  if (error) throw new AppError(500, 'Failed to upload CSV leads', error);

  return {
    inserted: data?.length ?? 0,
    items: ((data ?? []) as unknown as LeadRow[]).map(toApiLead),
  };
}

export async function deleteLead(orgId: string, id: string) {
  const { data, error } = await supabase
    .from('leads')
    .delete()
    .eq('organization_id', orgId)
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (error) throw new AppError(500, 'Failed to delete lead', error);
  if (!data) throw new AppError(404, 'Lead not found');
  return { success: true };
}

export async function enrichLead(orgId: string, input: ApolloEnrichInput) {
  const { data: lead, error: fetchError } = await supabase
    .from('leads')
    .select(LEAD_COLUMNS)
    .eq('organization_id', orgId)
    .eq('id', input.leadId)
    .single();

  if (fetchError || !lead) throw new AppError(404, 'Lead not found');

  const row = lead as unknown as LeadRow;
  const enrichBody: Record<string, unknown> = {};

  if (row.apollo_id) {
    enrichBody.id = row.apollo_id;
  } else if (row.email) {
    enrichBody.email = row.email;
  } else {
    const parts: Record<string, unknown> = {};
    if (row.first_name) parts.first_name = row.first_name;
    if (row.last_name) parts.last_name = row.last_name;
    if (row.company) parts.organization_name = row.company;
    if (Object.keys(parts).length === 0) {
      throw new AppError(400, 'Lead has no identifiers for enrichment (need email, apollo_id, or name+company)');
    }
    Object.assign(enrichBody, parts);
  }

  const response = await fetch('https://api.apollo.io/api/v1/people/match', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'x-api-key': env.APOLLO_API_KEY,
    },
    body: JSON.stringify(enrichBody),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new AppError(502, `Apollo enrich failed (${response.status})`, details.slice(0, 1000));
  }

  const result = await response.json() as { person?: ApolloPerson };
  const person = result.person;

  if (!person) {
    await supabase
      .from('leads')
      .update({ status: 'enrichment_failed', updated_at: new Date().toISOString() })
      .eq('id', input.leadId)
      .eq('organization_id', orgId);
    throw new AppError(404, 'No enrichment data found for this lead');
  }

  const mapped = mapApolloPerson(person);
  const updates: Record<string, unknown> = {
    apollo_id: person.id ?? row.apollo_id,
    first_name: mapped.firstName || row.first_name,
    last_name: mapped.lastName || row.last_name,
    name: mapped.name || row.name,
    title: mapped.title || row.title,
    company: mapped.company || row.company,
    email: mapped.email || row.email,
    phone: mapped.phone || row.phone,
    location: mapped.location || row.location,
    linkedin_url: mapped.linkedinUrl || row.linkedin_url,
    raw_data: person,
    status: 'new',
    updated_at: new Date().toISOString(),
  };

  const { data: updated, error: updateError } = await supabase
    .from('leads')
    .update(updates)
    .eq('id', input.leadId)
    .eq('organization_id', orgId)
    .select(LEAD_COLUMNS)
    .single();

  if (updateError) throw new AppError(500, 'Failed to save enriched lead', updateError);
  return toApiLead(updated as unknown as LeadRow);
}

export async function listLeadsFiltered(orgId: string, filters: {
  search?: string;
  status?: string;
  source?: string;
  page?: number;
  perPage?: number;
}) {
  const page = filters.page ?? 1;
  const perPage = filters.perPage ?? 50;
  const from = (page - 1) * perPage;
  const to = from + perPage - 1;

  let query = supabase
    .from('leads')
    .select(LEAD_COLUMNS, { count: 'exact' })
    .eq('organization_id', orgId);

  if (filters.status) {
    query = query.eq('status', filters.status);
  }
  if (filters.source) {
    query = query.eq('source', filters.source);
  }
  if (filters.search) {
    const term = `%${filters.search}%`;
    query = query.or(`name.ilike.${term},email.ilike.${term},company.ilike.${term},first_name.ilike.${term},last_name.ilike.${term}`);
  }

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new AppError(500, 'Failed to fetch leads', error);

  return {
    items: ((data ?? []) as unknown as LeadRow[]).map(toApiLead),
    pagination: {
      page,
      perPage,
      total: count ?? 0,
    },
  };
}

const PROGRESS_TTL = 3600;

function progressKey(jobId: string) {
  return `csv-import:${jobId}:progress`;
}

export async function setCsvImportProgress(jobId: string, progress: CsvImportProgress) {
  await redis.set(progressKey(jobId), JSON.stringify(progress), 'EX', PROGRESS_TTL);
}

export async function getCsvImportProgress(jobId: string): Promise<CsvImportProgress | null> {
  const raw = await redis.get(progressKey(jobId));
  if (!raw) return null;
  return JSON.parse(raw);
}

const BATCH_SIZE = 50;

export async function processCsvImportJob(jobId: string, data: CsvImportJobData) {
  const { organizationId, campaignId, columnMapping, rows, totalRows, fileName } = data;

  const progress: CsvImportProgress = {
    status: 'processing',
    total: totalRows,
    processed: 0,
    inserted: 0,
    skipped: 0,
    errors: [],
    fileName,
  };
  await setCsvImportProgress(jobId, progress);

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const records: ReturnType<typeof toLeadRecord>[] = [];

    for (let j = 0; j < batch.length; j++) {
      const rowIndex = i + j + 2;
      const mapped = mapRow(batch[j], columnMapping);

      if (!mapped.email && !mapped.name && !mapped.firstName && !mapped.lastName) {
        progress.errors.push({ row: rowIndex, message: 'Row has no identifiable data (no email or name)' });
        progress.skipped++;
        progress.processed++;
        continue;
      }

      records.push(toLeadRecord(organizationId, {
        campaignId: campaignId,
        source: 'csv',
        firstName: mapped.firstName,
        lastName: mapped.lastName,
        name: mapped.name,
        title: mapped.title,
        company: mapped.company,
        email: mapped.email,
        phone: mapped.phone,
        location: mapped.location,
        linkedinUrl: mapped.linkedinUrl,
      }, batch[j] as unknown as Record<string, unknown>));
    }

    if (records.length > 0) {
      const { data: inserted, error } = await supabase
        .from('leads')
        .insert(records)
        .select('id');

      if (error) {
        for (let j = 0; j < records.length; j++) {
          progress.errors.push({
            row: i + j + 2,
            message: error.message || 'Database insert failed',
          });
        }
        progress.skipped += records.length;
      } else {
        progress.inserted += inserted?.length ?? 0;
      }
    }

    progress.processed = Math.min(i + batch.length, totalRows);
    await setCsvImportProgress(jobId, progress);
  }

  progress.status = 'completed';
  progress.processed = totalRows;
  await setCsvImportProgress(jobId, progress);
  return progress;
}
