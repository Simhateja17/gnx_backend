-- Each voice/both-channel campaign now gets its own Retell agent + LLM
-- (created on launch) instead of sharing the org-wide agent_configs row, so
-- campaigns can have genuinely different pitches/objections/tone. Null on
-- these columns means "not yet launched" (Retell fields) or "inherit the
-- org's agent_configs default" (pitch content fields) for pre-existing rows.
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS retell_agent_id TEXT,
  ADD COLUMN IF NOT EXISTS retell_llm_id TEXT,
  ADD COLUMN IF NOT EXISTS product_description TEXT,
  ADD COLUMN IF NOT EXISTS value_proposition TEXT,
  ADD COLUMN IF NOT EXISTS objections TEXT,
  ADD COLUMN IF NOT EXISTS pain_points TEXT,
  ADD COLUMN IF NOT EXISTS tone TEXT,
  ADD COLUMN IF NOT EXISTS hook_style TEXT;
