export const PLANS = {
  starter: { name: 'Starter', dailyEmailCap: 100, maxCampaigns: 3, maxLeadsPerCampaign: 100 },
  growth: { name: 'Growth', dailyEmailCap: 200, maxCampaigns: Infinity, maxLeadsPerCampaign: 100 },
  scale: { name: 'Scale', dailyEmailCap: 500, maxCampaigns: Infinity, maxLeadsPerCampaign: 100 },
} as const;

export const DEFAULT_BUSINESS_HOURS = {
  start: '09:00',
  end: '17:00',
  days: [1, 2, 3, 4, 5], // Monday-Friday
};

export const EMAIL_SEQUENCE_DEFAULTS = [
  { stepNumber: 1, delayDays: 0 },
  { stepNumber: 2, delayDays: 3 },
  { stepNumber: 3, delayDays: 7 },
];

export const GMAIL_SEND_LIMITS = {
  personal: 500,
  workspace: 2000,
  defaultCap: 100,
};

export const VOICE_DEFAULTS = {
  callsPerHour: 5,
};

export const APOLLO_ENRICHMENT_CAP = 100;

// Onboarding prepares a useful first campaign asynchronously. Ten qualified
// leads, not fifty: with verified-only qualification a smaller target is
// reliably reachable, and ten leads across a three step sequence is thirty
// drafts - a reviewable number for someone seeing the product for the first
// time. Fifty was three times that and made the first run feel like work.
export const ONBOARDING_ENRICHED_LEAD_TARGET = 10;
export const ONBOARDING_APOLLO_MAX_SEARCH_PAGES = 5;
// Ten times the target. If a hundred verified candidates cannot yield ten
// usable leads the ICP is wrong, and spending more credits will not fix it -
// failing fast sends the customer back to their targeting instead.
export const ONBOARDING_APOLLO_MAX_CANDIDATES = 100;

// Apollo import pipeline.
//
// Batches of ten (Apollo's bulk_match ceiling) with three in flight at once,
// refilled the moment any one finishes rather than in waves - a single slow
// batch must not leave two slots idle.
export const APOLLO_BULK_BATCH_SIZE = 10;
export const APOLLO_BULK_CONCURRENCY = 3;

// One clock for the whole import. Individual leads also have their own
// deadline, but this is the backstop that guarantees an import can never sit
// in a non-terminal state - the failure mode the customer experiences as a
// progress bar that never finishes.
export const APOLLO_IMPORT_TIMEOUT_MS = 10 * 60 * 1000;
export const APOLLO_LEAD_ENRICHMENT_TIMEOUT_MS = 2 * 60 * 1000;

// Generation is auto-triggered by leads becoming ready. Leads arrive in
// bursts, so attachment schedules a job and further arrivals coalesce into it
// instead of starting a run per lead.
export const CAMPAIGN_GENERATION_DEBOUNCE_MS = 15_000;
// Mirrors APOLLO_ENRICHMENT_CAP: no import, however large, can trigger
// unbounded AI spend without someone asking for it.
export const CAMPAIGN_GENERATION_LEAD_CAP = 100;

// Guardrails for the AI agent's "get me N ICP leads" tool: never fetch more
// than this many net-new leads in one request, and never make more than this
// many Apollo search calls chasing that count (each call costs real credits).
export const AGENT_ICP_SEARCH_MAX_LEADS = 100;
export const AGENT_ICP_SEARCH_MAX_ATTEMPTS = 5;
