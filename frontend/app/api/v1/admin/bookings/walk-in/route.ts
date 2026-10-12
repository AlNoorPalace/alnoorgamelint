import { requireRole } from '@/server/auth'
import { parseJson, route } from '@/server/http'
import { walkIn, walkinSchema } from '@/server/services/admin/operations'

export const dynamic = 'force-dynamic'

export const POST = route(async (req) => {
  await requireRole(req, ['staff', 'admin'])
  return walkIn(await parseJson(req, walkinSchema))
})
