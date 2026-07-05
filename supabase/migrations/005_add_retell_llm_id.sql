-- Add retell_llm_id to agent_configs
-- Required to update the LLM prompt without an extra Retell API roundtrip
ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS retell_llm_id TEXT;
