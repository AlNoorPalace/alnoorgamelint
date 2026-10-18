import { afterEach, describe, expect, it, vi } from 'vitest'

describe('database client', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.unstubAllEnvs() })

  it('never lets Next.js cache database reads', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
    vi.stubEnv('SUPABASE_JWT_SECRET', 'x'.repeat(40))
    const seen: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => { seen.push(init); return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }) }))
    const { getSupabase } = await import('../supabase')
    await getSupabase().from('bookings').select('id')
    expect(seen).toHaveLength(1)
    expect(seen[0].cache).toBe('no-store')
  })
})
