/**
 * Lead qualification.
 *
 * A lead is admitted to a campaign only when it passes every check here. The
 * guiding rule: Apollo returning a person record is not evidence that the
 * person is contactable. Before this existed the pipeline enriched and emailed
 * anything Apollo returned, including shared inboxes and addresses Apollo
 * itself had flagged as unsubscribed.
 *
 * Qualification is deliberately separate from a lead's CRM lifecycle. A
 * rejected lead stays visible with its reason - a customer who asked for ten
 * leads and got six deserves to see why, not to wonder whether the product is
 * broken.
 *
 * Deliberately pure: policy only, no database and no configuration. The rules
 * that decide whether a stranger gets emailed should be testable without
 * standing up an environment, and callers supply the lead rows they have
 * already loaded.
 */

export type EmailQualificationPolicy = 'verified' | 'verified_or_likely' | 'any';

export type RejectionReason =
  | 'no_email'
  | 'unverified_email'
  | 'generic_inbox'
  | 'duplicate'
  | 'suppressed'
  | 'do_not_contact'
  | 'missing_identity';

export type QualificationVerdict =
  | { qualified: true }
  | { qualified: false; reason: RejectionReason; detail: string };

/**
 * Shared inboxes. Mail sent here reaches a queue, not a person, so the
 * personalisation the whole pipeline exists to produce is wasted - and these
 * addresses are disproportionately likely to mark outreach as spam.
 */
const GENERIC_INBOX_PREFIXES = new Set([
  'info',
  'support',
  'hello',
  'contact',
  'admin',
  'sales',
  'help',
  'team',
  'office',
  'enquiries',
  'inquiries',
  'billing',
  'accounts',
  'careers',
  'jobs',
  'hr',
  'marketing',
  'press',
  'media',
  'legal',
  'privacy',
  'security',
  'abuse',
  'postmaster',
  'webmaster',
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'mail',
  'email',
  'general',
]);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Apollo's own labels. 'verified' means Apollo checked the mailbox exists;
 * 'likely_to_engage' and its variants are educated guesses that bounce more
 * often - and bounces damage the sending domain every future campaign relies
 * on, which is why 'verified' is the default policy.
 */
const VERIFIED_STATUSES = new Set(['verified']);
const LIKELY_STATUSES = new Set([
  'likely_to_engage',
  'likely to engage',
  'extrapolated',
  'guessed',
]);

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed && EMAIL_PATTERN.test(trimmed) ? trimmed : null;
}

export function isGenericInbox(email: string): boolean {
  const localPart = email.split('@')[0] ?? '';
  if (!localPart) return true;

  // Match the bare prefix and common separated forms (sales.team@, info-uk@)
  // without catching a real person whose name merely starts the same way -
  // "sales" is generic, "salesforce.admin" is not a person either, but
  // "salvador@" must not be.
  const head = localPart.split(/[._+-]/)[0];
  return GENERIC_INBOX_PREFIXES.has(localPart) || GENERIC_INBOX_PREFIXES.has(head);
}

export function emailStatusAllowed(
  emailStatus: string | null | undefined,
  policy: EmailQualificationPolicy,
): boolean {
  if (policy === 'any') return true;

  const status = (emailStatus ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (VERIFIED_STATUSES.has(status)) return true;
  if (policy === 'verified_or_likely') return LIKELY_STATUSES.has(status);
  return false;
}

/**
 * The email statuses to send to Apollo's search endpoint, so a candidate that
 * could never qualify is filtered out before we spend an enrichment credit on
 * it. Previously the pipeline enriched everything and discarded the failures
 * afterwards - paying for every one.
 */
export function searchEmailStatuses(policy: EmailQualificationPolicy): string[] {
  if (policy === 'any') return [];
  if (policy === 'verified_or_likely') return ['verified', 'likely_to_engage'];
  return ['verified'];
}

export type QualifiableLead = {
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  title?: string | null;
  company?: string | null;
  email?: string | null;
  email_status?: string | null;
  apollo_id?: string | null;
  do_not_email?: boolean | null;
  email_unsubscribed?: boolean | null;
  dnc_status?: string | null;
};

/**
 * Checks that need no database access. Ordered cheapest-first, and reported
 * with the most actionable reason rather than the first one tripped: a
 * customer seeing "5 generic inbox" learns something about their targeting
 * that "5 rejected" does not tell them.
 */
export function qualifyLeadOffline(
  lead: QualifiableLead,
  policy: EmailQualificationPolicy,
): QualificationVerdict {
  const hasIdentity = Boolean(
    (lead.apollo_id && lead.apollo_id.trim())
    || (lead.first_name && lead.first_name.trim())
    || (lead.name && lead.name.trim()),
  );
  if (!hasIdentity) {
    return {
      qualified: false,
      reason: 'missing_identity',
      detail: 'Apollo returned no usable identity for this person.',
    };
  }

  const email = normalizeEmail(lead.email);
  if (!email) {
    return {
      qualified: false,
      reason: 'no_email',
      detail: 'No work email address is available.',
    };
  }

  if (isGenericInbox(email)) {
    return {
      qualified: false,
      reason: 'generic_inbox',
      detail: `${email} is a shared inbox, not a person.`,
    };
  }

  if (lead.email_unsubscribed === true || lead.do_not_email === true) {
    return {
      qualified: false,
      reason: 'suppressed',
      detail: 'This address has unsubscribed or is marked do-not-email.',
    };
  }

  const dnc = (lead.dnc_status ?? '').trim().toLowerCase();
  if (['dnc', 'do_not_call', 'do-not-call', 'do_not_contact'].includes(dnc)) {
    return {
      qualified: false,
      reason: 'do_not_contact',
      detail: 'Apollo flagged this contact as do-not-contact.',
    };
  }

  if (!emailStatusAllowed(lead.email_status, policy)) {
    return {
      qualified: false,
      reason: 'unverified_email',
      detail: policy === 'verified'
        ? `Apollo could not verify ${email}, and unverified sends damage your sending domain.`
        : `Apollo's confidence in ${email} is below the configured policy.`,
    };
  }

  return { qualified: true };
}

/**
 * Deduplication keys in the spec's priority order. Apollo person id is
 * strongest; the name+company pair is a deliberate last resort because it is
 * the only one that can produce a false match between two real people.
 */
export function dedupeKeys(lead: QualifiableLead & { phone?: string | null; linkedin_url?: string | null }) {
  const keys: Array<{ field: string; value: string }> = [];

  const apolloId = lead.apollo_id?.trim();
  if (apolloId) keys.push({ field: 'apollo_id', value: apolloId });

  const email = normalizeEmail(lead.email);
  if (email) keys.push({ field: 'email', value: email });

  const phone = lead.phone?.replace(/[^\d+]/g, '');
  if (phone && phone.length >= 8) keys.push({ field: 'phone', value: phone });

  const linkedin = lead.linkedin_url?.trim().toLowerCase().replace(/\/+$/, '');
  if (linkedin) keys.push({ field: 'linkedin_url', value: linkedin });

  const name = (lead.name ?? [lead.first_name, lead.last_name].filter(Boolean).join(' ')).trim().toLowerCase();
  const company = lead.company?.trim().toLowerCase();
  if (name && company) keys.push({ field: 'name_company', value: `${name}|${company}` });

  return keys;
}
