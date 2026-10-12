import { requireRole } from '@/server/auth'
import { parseQuery, route } from '@/server/http'
import { memberSearchQuery, searchMembers } from '@/server/services/admin/operations'

export const dynamic = 'force-dynamic'

export const GET = route(async (req) => {
  await requireRole(req, ['staff', 'admin'])
  return searchMembers(parseQuery(req, memberSearchQuery).q)
})
