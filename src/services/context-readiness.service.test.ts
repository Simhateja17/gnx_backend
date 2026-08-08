import { describe, expect, it } from 'vitest';
import {
  evaluateContextReadiness,
  readinessToPromptFacts,
  summarizeImportReadiness,
  THIN_CONTEXT_THRESHOLD,
} from './context-readiness.service';

const lead = {
  first_name: 'Jane',
  last_name: 'Doe',
  name: 'Jane Doe',
  title: 'Head of Sales',
  company: 'Acme',
  email: 'jane@acme.com',
};

const richAccount = {
  name: 'Acme',
  industry: 'Computer Software',
  estimated_num_employees: 45,
  description: 'Acme builds scheduling tools for field teams.',
  technology_names: ['Salesforce', 'Segment'],
  annual_revenue_printed: '$5M',
  headcount_growth_twelve_months: 22,
  latest_funding_stage: 'Series A',
  city: 'Austin',
  country: 'United States',
};

describe('required ingredients', () => {
  it('passes when name, title, company and email are all present', () => {
    expect(evaluateContextReadiness(lead, null).requiredMet).toBe(true);
  });

  it('fails and names what is missing', () => {
    const readiness = evaluateContextReadiness({ ...lead, title: null, email: null }, null);
    expect(readiness.requiredMet).toBe(false);
    expect(readiness.missingRequired).toEqual(['Job title', 'Work email']);
  });

  it('accepts a full name when the first name was never parsed out', () => {
    // The spec drops the greeting rather than guessing, so this is writable.
    const readiness = evaluateContextReadiness({ ...lead, first_name: null, name: 'Jane Doe' }, null);
    expect(readiness.requiredMet).toBe(true);
  });

  it('falls back to the headline when no title is set', () => {
    const readiness = evaluateContextReadiness({ ...lead, title: null, headline: 'Sales leader' }, null);
    expect(readiness.requiredMet).toBe(true);
  });
});

describe('optional ingredient scoring', () => {
  it('counts only ingredients actually present', () => {
    const bare = evaluateContextReadiness(lead, null);
    expect(bare.score).toBe(0);
    expect(bare.thin).toBe(true);

    const rich = evaluateContextReadiness(
      { ...lead, seniority: 'Director', department: 'Sales', location: 'Austin, TX' },
      richAccount,
    );
    expect(rich.score).toBeGreaterThanOrEqual(8);
    expect(rich.thin).toBe(false);
  });

  it('marks a lead thin only below the threshold', () => {
    const readiness = evaluateContextReadiness(lead, {
      name: 'Acme',
      industry: 'Software',
      estimated_num_employees: 45,
      description: 'Builds tools.',
    });
    expect(readiness.score).toBe(THIN_CONTEXT_THRESHOLD);
    expect(readiness.thin).toBe(false);
  });

  it('scores out of a stable maximum so the fraction stays meaningful', () => {
    expect(evaluateContextReadiness(lead, null).scoreMax)
      .toBe(evaluateContextReadiness(lead, richAccount).scoreMax);
  });
});

describe('prompt fact sheet', () => {
  it('lists known facts with their values', () => {
    const facts = readinessToPromptFacts(evaluateContextReadiness(lead, richAccount));
    expect(facts.knownFacts.industry).toBe('Computer Software');
    expect(facts.knownFacts.company_size).toBe('45 employees');
    expect(facts.knownFacts.person_name).toBe('Jane Doe');
  });

  it('names the facts Apollo does not have, so the model cannot reach for them', () => {
    // Telling a model what it does not know is what actually prevents
    // invented personalisation; "do not invent facts" alone does not.
    const facts = readinessToPromptFacts(evaluateContextReadiness(lead, null));
    expect(facts.unavailableFacts).toContain('industry');
    expect(facts.unavailableFacts).toContain('technologies');
    expect(facts.unavailableFacts).toContain('company_description');
    expect(facts.thinContext).toBe(true);
  });

  it('never reports a fact as both known and unavailable', () => {
    const readiness = evaluateContextReadiness(lead, richAccount);
    const facts = readinessToPromptFacts(readiness);
    for (const key of facts.unavailableFacts) {
      expect(facts.knownFacts).not.toHaveProperty(key);
    }
  });
});

describe('import-level readiness', () => {
  it('calls a thin batch thin, which is an ICP problem not a lead problem', () => {
    const summary = summarizeImportReadiness([0, 1, 2, 1], 10);
    expect(summary.verdict).toBe('thin');
    expect(summary.thinShare).toBe(1);
  });

  it('calls a well-enriched batch rich', () => {
    const summary = summarizeImportReadiness([7, 8, 9, 6], 10);
    expect(summary.verdict).toBe('rich');
    expect(summary.thinShare).toBe(0);
  });

  it('reports adequate in between', () => {
    expect(summarizeImportReadiness([4, 5, 3, 4], 10).verdict).toBe('adequate');
  });

  it('handles an import that qualified nobody', () => {
    const summary = summarizeImportReadiness([], 10);
    expect(summary.averageScore).toBeNull();
    expect(summary.verdict).toBe('unknown');
  });
});
