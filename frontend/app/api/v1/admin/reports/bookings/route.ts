import { requireRole } from '@/server/auth'
import { parseQuery, route } from '@/server/http'
import { bookingsInRange, rangeQuery } from '@/server/services/admin/reports'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export const GET = route(async (req) => {
  await requireRole(req, ['staff', 'admin'])
  return bookingsInRange(parseQuery(req, rangeQuery))
})
