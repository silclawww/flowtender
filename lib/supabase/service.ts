import { createClient as createSupabaseClient } from '@supabase/supabase-js';

let _serviceClient: ReturnType<typeof createSupabaseClient> | null = null;

export function createServiceClient() {
  if (_serviceClient) return _serviceClient;
  _serviceClient = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  return _serviceClient;
}
