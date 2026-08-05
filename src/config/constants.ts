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

// Onboarding prepares a useful first campaign asynchronously. The target is
// deliberately below the enrichment cap so there is room for retries and
// later user-requested enrichment without exhausting the campaign allowance.
export const ONBOARDING_ENRICHED_LEAD_TARGET = 50;
export const ONBOARDING_APOLLO_MAX_SEARCH_PAGES = 5;
export const ONBOARDING_APOLLO_MAX_CANDIDATES = 250;

// Guardrails for the AI agent's "get me N ICP leads" tool: never fetch more
// than this many net-new leads in one request, and never make more than this
// many Apollo search calls chasing that count (each call costs real credits).
export const AGENT_ICP_SEARCH_MAX_LEADS = 100;
export const AGENT_ICP_SEARCH_MAX_ATTEMPTS = 5;
