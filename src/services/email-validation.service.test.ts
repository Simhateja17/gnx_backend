import { describe, expect, it } from 'vitest';
import {
  extractGreetingName,
  parseGeneratedEmails,
  validateGeneratedEmail,
  validateRecipientBinding,
} from './email-validation.service';

const lead = {
  id: 'lead-1',
  first_name: 'Jane',
  last_name: 'Doe',
  name: 'Jane Doe',
  company: 'Acme',
  email: 'jane@acme.com',
};

function target(body: string, subject = 'Quick question about hiring', step = 1) {
  return { subject, body, stepNumber: step };
}

function codesOf(result: ReturnType<typeof validateGeneratedEmail>) {
  return result.valid ? [] : result.failures.map(failure => failure.code);
}

describe('greeting extraction', () => {
  it('reads the name out of common greetings', () => {
    expect(extractGreetingName('Hi Jane,\n\nSaw you lead sales.')).toBe('jane');
    expect(extractGreetingName('Hello Mark\n\nText')).toBe('mark');
    expect(extractGreetingName('Dear Katherine,\n\nText')).toBe('katherine');
    expect(extractGreetingName('Good morning Sam,\n\nText')).toBe('sam');
  });

  it('returns nothing for a greeting that names no one', () => {
    // Not a wrong name - a deliberate choice when Apollo has no first name.
    expect(extractGreetingName('Hi there,\n\nText')).toBeNull();
    expect(extractGreetingName('Hello team,\n\nText')).toBeNull();
    expect(extractGreetingName('Saw your team is hiring.')).toBeNull();
  });
});

describe('recipient identity', () => {
  it('rejects an email addressed to somebody else entirely', () => {
    // The failure this whole layer exists to stop: the model reaching for a
    // name it saw elsewhere in the payload.
    const result = validateGeneratedEmail({
      target: target('Hi Mark,\n\nSaw Acme is growing. Worth a chat?'),
      lead,
      expectedStep: 1,
    });
    expect(codesOf(result)).toContain('wrong_recipient_name');
  });

  it('accepts the canonical first name', () => {
    const result = validateGeneratedEmail({
      target: target('Hi Jane,\n\nSaw Acme is growing. Worth a chat?'),
      lead,
      expectedStep: 1,
    });
    expect(result.valid).toBe(true);
  });

  it('accepts prefix shortenings, which is most of what models produce', () => {
    for (const [greeting, canonical] of [
      ['Chris', 'Christopher'],
      ['Matt', 'Matthew'],
      ['Sam', 'Samuel'],
      ['Alex', 'Alexandra'],
    ]) {
      const result = validateGeneratedEmail({
        target: target(`Hi ${greeting},\n\nSaw Acme is growing. Worth a chat?`),
        lead: { ...lead, first_name: canonical, name: `${canonical} Doe` },
        expectedStep: 1,
      });
      expect(result.valid, `${greeting} for ${canonical}`).toBe(true);
    }
  });

  it('rejects non-prefix nicknames, preferring a regeneration to a guess', () => {
    // Kate/Katherine and Bob/Robert are real nicknames, but the prompt tells
    // the model to use the exact first name - so this only fires when it
    // disobeyed, and one retry is cheaper than accepting a name we cannot
    // prove belongs to the prospect.
    for (const [greeting, canonical] of [['Kate', 'Katherine'], ['Bob', 'Robert']]) {
      const result = validateGeneratedEmail({
        target: target(`Hi ${greeting},\n\nSaw Acme is growing. Worth a chat?`),
        lead: { ...lead, first_name: canonical, name: `${canonical} Doe` },
        expectedStep: 1,
      });
      expect(codesOf(result), `${greeting} for ${canonical}`).toContain('wrong_recipient_name');
    }
  });

  it('accepts an email that opens with no name at all', () => {
    const result = validateGeneratedEmail({
      target: target('Saw Acme is growing. Worth a short chat?'),
      lead: { ...lead, first_name: null, name: null },
      expectedStep: 1,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a guessed name when Apollo supplied none', () => {
    const result = validateGeneratedEmail({
      target: target('Hi Jane,\n\nSaw Acme is growing.'),
      lead: { ...lead, first_name: null, name: null },
      expectedStep: 1,
    });
    expect(codesOf(result)).toContain('wrong_recipient_name');
  });
});

describe('content rules', () => {
  it('rejects unfilled placeholders', () => {
    for (const body of [
      'Hi Jane,\n\nSaw {{company}} is growing.',
      'Hi Jane,\n\nSaw [Company] is growing.',
      'Hi Jane,\n\nSaw <company> is growing.',
      'Hi Jane,\n\nSaw XXX is growing.',
    ]) {
      expect(codesOf(validateGeneratedEmail({ target: target(body), lead, expectedStep: 1 })))
        .toContain('unresolved_placeholder');
    }
  });

  it('rejects markdown and html', () => {
    for (const body of [
      'Hi Jane,\n\n**Bold** pitch here.',
      'Hi Jane,\n\n<p>Html body</p>',
      'Hi Jane,\n\n# Heading\n\nText',
      'Hi Jane,\n\n- bullet one\n- bullet two',
      'Hi Jane,\n\nSee [our site](https://acme.com).',
    ]) {
      expect(codesOf(validateGeneratedEmail({ target: target(body), lead, expectedStep: 1 })))
        .toContain('markdown_or_html');
    }
  });

  it('does not mistake ordinary prose for markup', () => {
    const result = validateGeneratedEmail({
      target: target('Hi Jane,\n\nYour team of 5 * 3 reps could save time. Worth a chat?'),
      lead,
      expectedStep: 1,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects empty subject or body', () => {
    expect(codesOf(validateGeneratedEmail({ target: target('Hi Jane,\n\nText', ''), lead, expectedStep: 1 })))
      .toContain('empty_subject');
    expect(codesOf(validateGeneratedEmail({ target: target(''), lead, expectedStep: 1 })))
      .toContain('empty_body');
  });

  it('rejects a step the model numbered differently than requested', () => {
    expect(codesOf(validateGeneratedEmail({ target: target('Hi Jane,\n\nText', 'Subject', 2), lead, expectedStep: 1 })))
      .toContain('wrong_step');
  });

  it('rejects a follow-up that repeats an earlier email', () => {
    const body = 'Hi Jane,\n\nSaw Acme is hiring across sales and wondered whether coordination is getting harder as the team grows. Worth a short chat?';
    const result = validateGeneratedEmail({
      target: target(body, 'Following up', 2),
      lead,
      expectedStep: 2,
      previousBodies: [body],
    });
    expect(codesOf(result)).toContain('duplicate_content');
  });

  it('accepts a follow-up that genuinely changes angle', () => {
    const result = validateGeneratedEmail({
      target: target(
        'Hi Jane,\n\nOne more thought: most teams your size lose a day a week to manual handoffs. Happy to share what others changed.',
        'One more thought',
        2,
      ),
      lead,
      expectedStep: 2,
      previousBodies: ['Hi Jane,\n\nSaw Acme is hiring across sales and wondered whether coordination is getting harder. Worth a chat?'],
    });
    expect(result.valid).toBe(true);
  });
});

describe('recipient binding', () => {
  it('rejects content generated for a different lead', () => {
    const result = validateRecipientBinding({
      messageLeadId: 'lead-1',
      canonicalLeadId: 'lead-2',
      recipientEmail: 'jane@acme.com',
      canonicalEmail: 'jane@acme.com',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a recipient address that is not the lead address', () => {
    const result = validateRecipientBinding({
      messageLeadId: 'lead-1',
      canonicalLeadId: 'lead-1',
      recipientEmail: 'someone.else@acme.com',
      canonicalEmail: 'jane@acme.com',
    });
    expect(result.valid).toBe(false);
  });

  it('accepts a correctly bound message', () => {
    const result = validateRecipientBinding({
      messageLeadId: 'lead-1',
      canonicalLeadId: 'lead-1',
      recipientEmail: 'Jane@Acme.com',
      canonicalEmail: 'jane@acme.com',
    });
    expect(result.valid).toBe(true);
  });
});

describe('response parsing', () => {
  it('parses the expected envelope', () => {
    const parsed = parseGeneratedEmails('{"emails":[{"step":1,"subject":"Hi","body":"Body"}]}');
    expect('steps' in parsed && parsed.steps).toHaveLength(1);
  });

  it('tolerates a fenced code block rather than discarding a good email', () => {
    const parsed = parseGeneratedEmails('```json\n{"emails":[{"step":1,"subject":"Hi","body":"Body"}]}\n```');
    expect('steps' in parsed && parsed.steps[0].subject).toBe('Hi');
  });

  it('recovers JSON wrapped in prose', () => {
    const parsed = parseGeneratedEmails('Sure! {"emails":[{"step":1,"subject":"Hi","body":"Body"}]} Hope that helps.');
    expect('steps' in parsed && parsed.steps[0].body).toBe('Body');
  });

  it('reports an error rather than throwing on unparseable output', () => {
    expect(parseGeneratedEmails('not json at all')).toHaveProperty('error');
    expect(parseGeneratedEmails('{"wrong":"shape"}')).toHaveProperty('error');
  });
});
