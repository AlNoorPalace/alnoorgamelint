import { requireRole } from '@/server/auth'
import { parseJsonOptional, route } from '@/server/http'
import { uuidParam } from '@/server/services/bookings'
import { reshuffleBracket, reshuffleSchema } from '@/server/services/admin/tournaments'

export const dynamic = 'force-dynamic'

export const POST = route(async (req, ctx: { params: { id: string } }) => {
  await requireRole(req, ['admin'])
  const body = await parseJsonOptional(req, reshuffleSchema)
  return reshuffleBracket(uuidParam.parse(ctx.params.id), undefined, undefined, { replaceFromWaitlist: body.replace_from_waitlist })
})
