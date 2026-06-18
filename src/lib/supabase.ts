import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// Anon-key client for user-context auth operations (sign in, refresh, password reset)
export const supabaseAuth = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);

export async function setOrgContext(orgId: string) {
  await supabase.rpc('set_config', { key: 'app.current_org_id', value: orgId });
}
