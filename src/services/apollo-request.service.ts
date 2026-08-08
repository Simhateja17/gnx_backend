/**
 * Apollo request construction, shared by the single-match and bulk-match paths.
 *
 * The waterfall and webhook options are identical for both, and duplicating
 * them would let the two paths drift - the dangerous version of that being a
 * bulk call that quietly asks for a waterfall without supplying the webhook
 * URL its results would come back on.
 */

import { env } from '../config/env';
import { AppError } from '../types';
import { normalizeApolloDomain } from '../lib/apollo-domain';

type JsonRecord = Record<string, unknown>;

export type PersonIdentifiers = {
  apolloId?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  company?: string | null;
  domain?: string | null;
  linkedinUrl?: string | null;
};

/** Keys that identify a person, as opposed to keys that configure the request. */
const OPTION_KEYS = new Set([
  'reveal_personal_emails',
  'reveal_phone_number',
  'run_waterfall_email',
  'run_waterfall_phone',
  'webhook_url',
]);

export function waterfallRequested() {
  return env.APOLLO_REVEAL_PHONE_NUMBER
    || env.APOLLO_RUN_WATERFALL_EMAIL
    || env.APOLLO_RUN_WATERFALL_PHONE;
}

/**
 * The request-level options. Asking for a waterfall without a configured
 * webhook is a misconfiguration that would strand every result, so it fails
 * loudly here rather than producing an import that silently never completes.
 */
export function buildBulkMatchOptions(): JsonRecord {
  const options: JsonRecord = {};

  if (env.APOLLO_REVEAL_PERSONAL_EMAILS) options.reveal_personal_emails = true;

  const needsWebhook = waterfallRequested();
  if (needsWebhook && !env.APOLLO_ENRICHMENT_WEBHOOK_URL) {
    throw new AppError(503, 'Apollo phone or waterfall enrichment requires APOLLO_ENRICHMENT_WEBHOOK_URL');
  }
  if (needsWebhook && !env.APOLLO_ENRICHMENT_WEBHOOK_SECRET) {
    throw new AppError(503, 'Apollo phone or waterfall enrichment requires APOLLO_ENRICHMENT_WEBHOOK_SECRET');
  }

  if (env.APOLLO_REVEAL_PHONE_NUMBER) options.reveal_phone_number = true;
  if (env.APOLLO_RUN_WATERFALL_EMAIL) options.run_waterfall_email = true;
  if (env.APOLLO_RUN_WATERFALL_PHONE) options.run_waterfall_phone = true;

  if (needsWebhook && env.APOLLO_ENRICHMENT_WEBHOOK_URL) {
    const webhookUrl = new URL(env.APOLLO_ENRICHMENT_WEBHOOK_URL);
    webhookUrl.searchParams.set('secret', env.APOLLO_ENRICHMENT_WEBHOOK_SECRET);
    options.webhook_url = webhookUrl.toString();
  }

  return options;
}

/**
 * One entry in a bulk_match `details` array: identifiers only, no options.
 * Apollo takes request options at the top level of a bulk call, not per
 * contact.
 */
export function buildBulkMatchDetail(input: PersonIdentifiers): JsonRecord {
  const detail: JsonRecord = {};

  if (input.apolloId) detail.id = input.apolloId;
  if (input.email) detail.email = input.email;
  if (input.name) detail.name = input.name;
  if (input.firstName) detail.first_name = input.firstName;
  if (input.lastName) detail.last_name = input.lastName;
  if (input.company) detail.organization_name = input.company;
  if (input.domain) detail.domain = normalizeApolloDomain(input.domain);
  if (input.linkedinUrl) detail.linkedin_url = input.linkedinUrl;

  return detail;
}

/** True when there is at least one identifier Apollo can actually match on. */
export function hasMatchableIdentifiers(body: JsonRecord): boolean {
  return Object.keys(body).some(key => !OPTION_KEYS.has(key));
}
