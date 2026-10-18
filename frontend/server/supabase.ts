import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getEnv } from './env'

let client: SupabaseClient | undefined

/** Service-role client. Bypasses RLS, so only use it behind `authenticate`/`requireRole`. */
export function getSupabase(): SupabaseClient {
  if (!client) {
    const env = getEnv()
    client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      // Next.js caches fetch() GET responses on the server by default. Database reads must never come from that cache,
      // or staff see old data (a session that was just started, a registration that was just made).
      global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }) },
    })
  }
  return client
}
