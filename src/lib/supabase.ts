import { createClient } from '@supabase/supabase-js';
import type { WebSocketLikeConstructor } from '@supabase/realtime-js';
import WebSocket from 'ws';
import { env } from '../config/env';

const realtimeOptions = {
  realtime: { transport: WebSocket as unknown as WebSocketLikeConstructor },
};

export const supabase = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  realtimeOptions,
);

// Anon-key client for user-context auth operations (sign in, refresh, password reset)
export const supabaseAuth = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_ANON_KEY,
  realtimeOptions,
);

export async function setOrgContext(orgId: string) {
  await supabase.rpc('set_config', { key: 'app.current_org_id', value: orgId });
}
