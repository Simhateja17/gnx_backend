/**
 * Context readiness: what do we actually know about this lead, and is it
 * enough to write a truthful email?
 *
 * Two distinct things, deliberately not merged into one number:
 *
 *   Required ingredients - a hard checklist. Without these there is nothing
 *   honest to say, so we do not write at all.
 *
 *   Optional ingredients - the score. Each one is a fact the email is allowed
 *   to mention. Reported as "7 of 10 ready" rather than a percentage, because
 *   a customer can act on a missing ingredient and cannot act on "68%".
 *
 * Timing matters as much as the checklist. Scoring a lead before its
 * enrichment has finished measures our patience, not Apollo's data - and would
 * make a lead look thin when the facts were still in flight. Callers must only
 * score leads whose enrichment has reached a terminal state.
 *
 * The score is not only a gate. It is passed into the generation prompt as an
 * explicit list of what is known, which is the strongest available guard
 * against the model inventing the personalisation it wishes it had.
 */

type JsonRecord = Record<string, unknown>;

export type ReadinessLead = JsonRecord & {
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  title?: string | null;
  company?: string | null;
  email?: string | null;
  headline?: string | null;
  seniority?: string | null;
  department?: string | null;
  job_function?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  location?: string | null;
};

export type ReadinessAccount = JsonRecord | null;

export type IngredientState = {
  key: string;
  label: string;
  present: boolean;
  /** The concrete value, when present - this is what the prompt may cite. */
  value?: string;
};

export type ContextReadiness = {
  /** Every required ingredient is present. False means: do not generate. */
  requiredMet: boolean;
  missingRequired: string[];
  required: IngredientState[];
  optional: IngredientState[];
  score: number;
  scoreMax: number;
  /**
   * Enough optional material to say something specific. Below this the email
   * is still written, truthfully, but from role and company alone - and is
   * flagged so a reviewer can see how much of a batch is thin.
   */
  thin: boolean;
};

/** Below this many optional ingredients an email cannot be meaningfully specific. */
export const THIN_CONTEXT_THRESHOLD = 3;

function text(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function list(value: unknown, limit: number): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const items = value.map(item => text(item)).filter(Boolean) as string[];
  return items.length > 0 ? items.slice(0, limit).join(', ') : null;
}

function ingredient(key: string, label: string, value: string | null): IngredientState {
  return value === null
    ? { key, label, present: false }
    : { key, label, present: true, value };
}

/**
 * Required. Note that a missing first name is NOT disqualifying on its own -
 * the spec's rule is to drop the greeting rather than guess a name, so a lead
 * with a full name but no parsed first name is still writable.
 */
function requiredIngredients(lead: ReadinessLead, account: ReadinessAccount): IngredientState[] {
  const fullName = text(lead.name)
    ?? ([text(lead.first_name), text(lead.last_name)].filter(Boolean).join(' ') || null);

  return [
    ingredient('person_name', 'Person name', fullName),
    ingredient('job_title', 'Job title', text(lead.title) ?? text(lead.headline)),
    ingredient('company_name', 'Company name', text(lead.company) ?? text(account?.name)),
    ingredient('email', 'Work email', text(lead.email)),
  ];
}

/**
 * Optional. Each present item is a fact the email may cite; each absent one is
 * a fact the model must be told it does not have.
 */
function optionalIngredients(lead: ReadinessLead, account: ReadinessAccount): IngredientState[] {
  const location = text(lead.location)
    ?? ([text(lead.city), text(lead.state), text(lead.country)].filter(Boolean).join(', ') || null);

  const employees = account?.estimated_num_employees;
  const revenue = text(account?.annual_revenue_printed)
    ?? (typeof account?.annual_revenue === 'number' ? String(account.annual_revenue) : null);

  const growth = [
    account?.headcount_growth_six_months,
    account?.headcount_growth_twelve_months,
  ].find(value => typeof value === 'number' && value !== 0);

  return [
    ingredient('industry', 'Industry', text(account?.industry) ?? list(account?.industries, 1)),
    ingredient('company_size', 'Company size', typeof employees === 'number' ? `${employees} employees` : null),
    ingredient('company_description', 'What the company does', text(account?.description)),
    ingredient('location', 'Location', location),
    ingredient('technologies', 'Technologies used', list(account?.technology_names, 8)),
    ingredient('seniority', 'Seniority', text(lead.seniority)),
    ingredient('department', 'Department', text(lead.department) ?? text(lead.job_function)),
    ingredient('revenue', 'Estimated revenue', revenue),
    ingredient('growth', 'Headcount growth', typeof growth === 'number' ? `${growth > 0 ? '+' : ''}${growth}%` : null),
    ingredient('funding', 'Funding stage', text(account?.latest_funding_stage)),
  ];
}

export function evaluateContextReadiness(
  lead: ReadinessLead,
  account: ReadinessAccount = null,
): ContextReadiness {
  const required = requiredIngredients(lead, account);
  const optional = optionalIngredients(lead, account);

  const missingRequired = required.filter(item => !item.present).map(item => item.label);
  const score = optional.filter(item => item.present).length;

  return {
    requiredMet: missingRequired.length === 0,
    missingRequired,
    required,
    optional,
    score,
    scoreMax: optional.length,
    thin: score < THIN_CONTEXT_THRESHOLD,
  };
}

/**
 * The prompt's fact sheet. Only present ingredients are listed, and the absent
 * ones are named explicitly - telling a model what it does not know is far
 * more effective at preventing invention than telling it not to invent.
 */
export function readinessToPromptFacts(readiness: ContextReadiness) {
  const known: Record<string, string> = {};
  for (const item of [...readiness.required, ...readiness.optional]) {
    if (item.present && item.value) known[item.key] = item.value;
  }

  return {
    knownFacts: known,
    unavailableFacts: readiness.optional.filter(item => !item.present).map(item => item.key),
    contextScore: `${readiness.score} of ${readiness.scoreMax}`,
    thinContext: readiness.thin,
  };
}

/** Persisted shape for leads.context_ingredients. */
export function readinessToStoredIngredients(readiness: ContextReadiness) {
  return {
    required: Object.fromEntries(readiness.required.map(item => [item.key, item.present])),
    optional: Object.fromEntries(readiness.optional.map(item => [item.key, item.present])),
    missingRequired: readiness.missingRequired,
    thin: readiness.thin,
    evaluatedAt: new Date().toISOString(),
  };
}

/**
 * Import-level readiness. A single thin lead is noise; a whole import
 * averaging two of ten is a targeting problem the customer can actually fix,
 * and is worth surfacing on the import run rather than burying per lead.
 */
export function summarizeImportReadiness(scores: number[], scoreMax: number) {
  if (scores.length === 0) {
    return { averageScore: null, scoreMax, thinShare: 0, verdict: 'unknown' as const };
  }

  const average = scores.reduce((total, score) => total + score, 0) / scores.length;
  const thinCount = scores.filter(score => score < THIN_CONTEXT_THRESHOLD).length;
  const thinShare = thinCount / scores.length;

  const verdict = average >= 6
    ? ('rich' as const)
    : average >= THIN_CONTEXT_THRESHOLD
      ? ('adequate' as const)
      : ('thin' as const);

  return {
    averageScore: Number(average.toFixed(2)),
    scoreMax,
    thinShare: Number(thinShare.toFixed(2)),
    verdict,
  };
}
