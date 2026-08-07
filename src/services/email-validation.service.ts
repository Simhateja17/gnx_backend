/**
 * Generated-email validation.
 *
 * A draft is valid by definition. Anything that fails these checks is never
 * written to email_messages - it is regenerated, and if the retry also fails
 * it is recorded as a generation failure instead. There is deliberately no
 * "needs attention" pile mixed into the drafts list: a reviewer approving
 * thirty emails should not have to be the last line of defence against one of
 * them being addressed to the wrong person.
 *
 * The identity checks are the reason this file exists. Everything else here is
 * about polish; those are about not emailing a stranger by someone else's name.
 */

type JsonRecord = Record<string, unknown>;

export type ValidationTarget = {
  subject: string;
  body: string;
  stepNumber: number;
};

export type CanonicalLead = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  company?: string | null;
  email?: string | null;
};

export type ValidationFailure = {
  code:
    | 'empty_subject'
    | 'empty_body'
    | 'wrong_step'
    | 'wrong_recipient_name'
    | 'foreign_company'
    | 'unresolved_placeholder'
    | 'markdown_or_html'
    | 'duplicate_content'
    | 'subject_too_long'
    | 'missing_json';
  detail: string;
};

export type ValidationResult =
  | { valid: true }
  | { valid: false; failures: ValidationFailure[] };

/** `{{first_name}}`, `[Company]`, `<name>`, `XXX` - anything left unfilled. */
const PLACEHOLDER_PATTERNS = [
  /\{\{[^}]*\}\}/,
  /\{[a-z_][a-z0-9_]*\}/i,
  /\[(?:insert|your|their|company|name|title|first[\s_-]?name|placeholder)[^\]]*\]/i,
  /<[a-z_][a-z0-9_]*>/i,
  /\bXXX+\b/,
  /\bTODO\b/i,
  /\bLorem ipsum\b/i,
];

/**
 * Markdown and HTML. Deliberately narrow: an asterisk or underscore can appear
 * legitimately in prose, so only structural markers count - a bare `*` in
 * "5 * 3" must not fail an otherwise good email.
 */
const MARKUP_PATTERNS = [
  /<\/?[a-z][a-z0-9]*(?:\s[^>]*)?>/i,
  /^#{1,6}\s/m,
  /\*\*[^*\n]+\*\*/,
  /^\s*[-*+]\s+\S/m,
  /\[[^\]\n]+\]\([^)\n]+\)/,
  /^```/m,
];

const SUBJECT_MAX_LENGTH = 120;

function normalizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Pulls the name out of an opening greeting, if there is one.
 *
 * Returns null when the email opens without a name at all, which is a valid
 * choice: when Apollo has no reliable first name the rule is to drop the
 * greeting rather than guess one.
 */
export function extractGreetingName(body: string): string | null {
  const firstLine = body.split('\n').map(line => line.trim()).find(line => line.length > 0);
  if (!firstLine) return null;

  const match = firstLine.match(
    /^(?:hi|hey|hello|dear|good\s+(?:morning|afternoon|evening))\b[\s,]*([^,!.\n]{1,60})?/i,
  );
  if (!match) return null;

  const captured = match[1]?.trim();
  if (!captured) return null;

  // "Hi there" and "Hello team" are greetings without a name, not a wrong name.
  const generic = new Set(['there', 'team', 'folks', 'all', 'everyone']);
  const firstWord = captured.split(/\s+/)[0].toLowerCase().replace(/[^a-z'-]/g, '');
  if (!firstWord || generic.has(firstWord)) return null;

  return firstWord;
}

/**
 * Does the greeting name belong to this lead?
 *
 * Accepts the canonical first name, the first token of a full name, and
 * prefix shortenings - Chris for Christopher, Matt for Matthew, Sam for
 * Samuel, which covers most of what a model produces naturally.
 *
 * Non-prefix nicknames (Kate for Katherine, Bob for Robert) are rejected. That
 * is deliberate rather than an oversight: the prompt instructs the model to
 * use the exact first name, so this only fires when it disobeyed, and the cost
 * is one regeneration against the risk of accepting a name that is not the
 * prospect's. A nickname table would trade a rare, self-correcting failure for
 * a permanent maintenance burden and a new class of false accepts.
 */
function greetingMatchesLead(greeting: string, lead: CanonicalLead): boolean {
  const candidates = new Set<string>();

  const first = normalizeName(lead.first_name);
  if (first) candidates.add(first);

  const full = normalizeName(lead.name);
  if (full) candidates.add(full.split(/\s+/)[0]);

  if (candidates.size === 0) return false;

  for (const candidate of candidates) {
    if (candidate === greeting) return true;
    // One is a prefix of the other and long enough not to be a coincidence.
    const [shorter, longer] = candidate.length <= greeting.length
      ? [candidate, greeting]
      : [greeting, candidate];
    if (shorter.length >= 3 && longer.startsWith(shorter)) return true;
  }

  return false;
}

export function validateGeneratedEmail(input: {
  target: ValidationTarget;
  lead: CanonicalLead;
  expectedStep: number;
  previousBodies?: string[];
}): ValidationResult {
  const failures: ValidationFailure[] = [];
  const { target, lead, expectedStep } = input;

  const subject = (target.subject ?? '').trim();
  const body = (target.body ?? '').trim();

  if (!subject) failures.push({ code: 'empty_subject', detail: 'Subject is empty.' });
  if (!body) failures.push({ code: 'empty_body', detail: 'Body is empty.' });

  if (target.stepNumber !== expectedStep) {
    failures.push({
      code: 'wrong_step',
      detail: `Model returned step ${target.stepNumber} where step ${expectedStep} was requested.`,
    });
  }

  if (subject.length > SUBJECT_MAX_LENGTH) {
    failures.push({
      code: 'subject_too_long',
      detail: `Subject is ${subject.length} characters; the ceiling is ${SUBJECT_MAX_LENGTH}.`,
    });
  }

  // The check this file exists for. A greeting naming anyone but the canonical
  // lead means the model reached for a name from somewhere it should not have.
  const greeting = extractGreetingName(body);
  if (greeting && !greetingMatchesLead(greeting, lead)) {
    failures.push({
      code: 'wrong_recipient_name',
      detail: `Email opens with "${greeting}" but the lead is ${lead.first_name ?? lead.name ?? 'unnamed'}.`,
    });
  }

  const combined = `${subject}\n${body}`;

  for (const pattern of PLACEHOLDER_PATTERNS) {
    const match = combined.match(pattern);
    if (match) {
      failures.push({
        code: 'unresolved_placeholder',
        detail: `Unfilled placeholder left in the text: "${match[0].slice(0, 40)}".`,
      });
      break;
    }
  }

  for (const pattern of MARKUP_PATTERNS) {
    const match = combined.match(pattern);
    if (match) {
      failures.push({
        code: 'markdown_or_html',
        detail: `Markup found where plain text was required: "${match[0].slice(0, 40)}".`,
      });
      break;
    }
  }

  // Follow-ups must add an angle, not restate the first email. Compared on
  // normalized text so whitespace and casing differences do not mask a repeat.
  if (body && input.previousBodies?.length) {
    const normalized = body.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const previous of input.previousBodies) {
      const previousNormalized = previous.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!previousNormalized) continue;
      if (normalized === previousNormalized || overlapRatio(normalized, previousNormalized) > 0.7) {
        failures.push({
          code: 'duplicate_content',
          detail: 'This step largely repeats an earlier email in the sequence.',
        });
        break;
      }
    }
  }

  return failures.length === 0 ? { valid: true } : { valid: false, failures };
}

/** Rough sentence-level overlap, enough to catch a follow-up that is a reworded copy. */
function overlapRatio(a: string, b: string): number {
  const sentences = (text: string) => new Set(
    text.split(/[.!?]+/).map(part => part.trim()).filter(part => part.length > 25),
  );

  const first = sentences(a);
  const second = sentences(b);
  if (first.size === 0 || second.size === 0) return 0;

  let shared = 0;
  for (const sentence of first) if (second.has(sentence)) shared++;
  return shared / Math.min(first.size, second.size);
}

/**
 * Recipient identity, checked immediately before save.
 *
 * The greeting and the recipient address must come from the same lead record.
 * This catches the class of bug where a message is built for one lead and
 * saved against another - which no amount of prompt care can prevent.
 */
export function validateRecipientBinding(input: {
  messageLeadId: string;
  canonicalLeadId: string;
  recipientEmail: string | null | undefined;
  canonicalEmail: string | null | undefined;
}): ValidationResult {
  const failures: ValidationFailure[] = [];

  if (input.messageLeadId !== input.canonicalLeadId) {
    failures.push({
      code: 'wrong_recipient_name',
      detail: 'Message lead does not match the lead the content was generated for.',
    });
  }

  const recipient = (input.recipientEmail ?? '').trim().toLowerCase();
  const canonical = (input.canonicalEmail ?? '').trim().toLowerCase();
  if (recipient && canonical && recipient !== canonical) {
    failures.push({
      code: 'wrong_recipient_name',
      detail: 'Recipient address does not match the lead record.',
    });
  }

  return failures.length === 0 ? { valid: true } : { valid: false, failures };
}

/**
 * Parses the model's JSON envelope.
 *
 * Tolerates a fenced code block, because models wrap JSON in one often enough
 * that failing the whole generation over formatting would waste a good email.
 */
export function parseGeneratedEmails(raw: string): { steps: ValidationTarget[] } | { error: string } {
  const trimmed = raw.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    // Last resort: the outermost {...} in the response.
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start === -1 || end <= start) return { error: 'Model response was not JSON.' };
    try {
      parsed = JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      return { error: 'Model response was not parseable JSON.' };
    }
  }

  const record = parsed as JsonRecord;
  const emails = Array.isArray(record?.emails) ? record.emails : null;
  if (!emails) return { error: 'Model response had no "emails" array.' };

  const steps: ValidationTarget[] = [];
  for (const entry of emails) {
    const item = entry as JsonRecord;
    steps.push({
      stepNumber: typeof item?.step === 'number' ? item.step : Number(item?.step ?? 0),
      subject: typeof item?.subject === 'string' ? item.subject : '',
      body: typeof item?.body === 'string' ? item.body : '',
    });
  }

  return { steps };
}
