import { describe, expect, it } from 'vitest';
import {
  dedupeKeys,
  emailStatusAllowed,
  isGenericInbox,
  normalizeEmail,
  qualifyLeadOffline,
  searchEmailStatuses,
} from './lead-qualification.service';

describe('generic inbox detection', () => {
  it('rejects shared inboxes, including separated and suffixed forms', () => {
    for (const email of [
      'info@acme.com',
      'sales@acme.com',
      'support@acme.com',
      'hello@acme.com',
      'no-reply@acme.com',
      'sales.team@acme.com',
      'info-uk@acme.com',
      'careers+jobs@acme.com',
    ]) {
      expect(isGenericInbox(email), email).toBe(true);
    }
  });

  it('does not reject real people whose names merely start like a generic prefix', () => {
    // The bug this guards: a prefix match on "sal" would drop Salvador, and a
    // substring match would drop anyone named Marketa or Helena.
    for (const email of [
      'salvador@acme.com',
      'helena@acme.com',
      'marketa@acme.com',
      'infante@acme.com',
      'teamer@acme.com',
      'john.smith@acme.com',
    ]) {
      expect(isGenericInbox(email), email).toBe(false);
    }
  });
});

describe('email status policy', () => {
  it('accepts only verified under the default policy', () => {
    expect(emailStatusAllowed('verified', 'verified')).toBe(true);
    expect(emailStatusAllowed('likely_to_engage', 'verified')).toBe(false);
    expect(emailStatusAllowed('guessed', 'verified')).toBe(false);
    expect(emailStatusAllowed(null, 'verified')).toBe(false);
  });

  it('accepts likely-to-engage only when the policy is loosened', () => {
    expect(emailStatusAllowed('likely_to_engage', 'verified_or_likely')).toBe(true);
    expect(emailStatusAllowed('likely to engage', 'verified_or_likely')).toBe(true);
    expect(emailStatusAllowed('unavailable', 'verified_or_likely')).toBe(false);
  });

  it('accepts anything under the permissive policy', () => {
    expect(emailStatusAllowed('anything', 'any')).toBe(true);
    expect(emailStatusAllowed(null, 'any')).toBe(true);
  });

  it('sends the filter to Apollo so unqualifiable candidates cost no credits', () => {
    expect(searchEmailStatuses('verified')).toEqual(['verified']);
    expect(searchEmailStatuses('verified_or_likely')).toEqual(['verified', 'likely_to_engage']);
    expect(searchEmailStatuses('any')).toEqual([]);
  });
});

describe('lead qualification', () => {
  const base = {
    first_name: 'Jane',
    last_name: 'Doe',
    name: 'Jane Doe',
    title: 'Head of Sales',
    company: 'Acme',
    email: 'jane@acme.com',
    email_status: 'verified',
    apollo_id: 'apollo-1',
  };

  it('admits a verified, named, non-generic contact', () => {
    expect(qualifyLeadOffline(base, 'verified')).toEqual({ qualified: true });
  });

  it('rejects an unverified address under the default policy', () => {
    const verdict = qualifyLeadOffline({ ...base, email_status: 'guessed' }, 'verified');
    expect(verdict).toMatchObject({ qualified: false, reason: 'unverified_email' });
  });

  it('rejects a generic inbox before it can consume an enrichment credit', () => {
    const verdict = qualifyLeadOffline({ ...base, email: 'info@acme.com' }, 'verified');
    expect(verdict).toMatchObject({ qualified: false, reason: 'generic_inbox' });
  });

  it('rejects an address Apollo already flagged as unsubscribed', () => {
    const verdict = qualifyLeadOffline({ ...base, email_unsubscribed: true }, 'verified');
    expect(verdict).toMatchObject({ qualified: false, reason: 'suppressed' });
  });

  it('rejects a do-not-contact flag', () => {
    const verdict = qualifyLeadOffline({ ...base, dnc_status: 'do_not_call' }, 'verified');
    expect(verdict).toMatchObject({ qualified: false, reason: 'do_not_contact' });
  });

  it('rejects a contact with no email at all', () => {
    const verdict = qualifyLeadOffline({ ...base, email: null }, 'verified');
    expect(verdict).toMatchObject({ qualified: false, reason: 'no_email' });
  });

  it('rejects a record with no identity to write to', () => {
    const verdict = qualifyLeadOffline(
      { ...base, first_name: null, name: null, apollo_id: null },
      'verified',
    );
    expect(verdict).toMatchObject({ qualified: false, reason: 'missing_identity' });
  });

  it('reports suppression ahead of verification, so the reason stays actionable', () => {
    // Both rules fail here. Suppression is the one the customer must act on;
    // "unverified" would send them looking at the wrong problem.
    const verdict = qualifyLeadOffline(
      { ...base, email_status: 'guessed', do_not_email: true },
      'verified',
    );
    expect(verdict).toMatchObject({ qualified: false, reason: 'suppressed' });
  });
});

describe('email normalization', () => {
  it('lowercases and trims valid addresses', () => {
    expect(normalizeEmail('  Jane@Acme.COM ')).toBe('jane@acme.com');
  });

  it('rejects malformed addresses rather than passing them through', () => {
    for (const value of ['not-an-email', 'a@b', '', null, undefined, 'a b@c.com']) {
      expect(normalizeEmail(value)).toBeNull();
    }
  });
});

describe('dedupe keys', () => {
  it('emits keys in the spec priority order', () => {
    const keys = dedupeKeys({
      apollo_id: 'apollo-1',
      email: 'Jane@Acme.com',
      phone: '+1 (555) 123-4567',
      linkedin_url: 'https://linkedin.com/in/jane/',
      name: 'Jane Doe',
      company: 'Acme',
    });

    expect(keys.map(key => key.field)).toEqual([
      'apollo_id',
      'email',
      'phone',
      'linkedin_url',
      'name_company',
    ]);
    expect(keys.find(key => key.field === 'email')?.value).toBe('jane@acme.com');
    expect(keys.find(key => key.field === 'phone')?.value).toBe('+15551234567');
  });

  it('omits the name+company fallback unless both halves exist', () => {
    const keys = dedupeKeys({ name: 'Jane Doe', company: null, email: 'jane@acme.com' });
    expect(keys.some(key => key.field === 'name_company')).toBe(false);
  });

  it('ignores phone fragments too short to identify anyone', () => {
    const keys = dedupeKeys({ phone: '123', email: 'jane@acme.com' });
    expect(keys.some(key => key.field === 'phone')).toBe(false);
  });
});
