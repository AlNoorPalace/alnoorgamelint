import { requireRole } from '@/server/auth'
import { parseJson, route } from '@/server/http'
import { uuidParam } from '@/server/services/bookings'
import { controllersSchema, setExtraControllers } from '@/server/services/admin/operations'

export const dynamic = 'force-dynamic'

export const POST = route(async (req, ctx: { params: { id: string } }) => {
  await requireRole(req, ['staff', 'admin'])
  const { count } = await parseJson(req, controllersSchema)
  return setExtraControllers(uuidParam.parse(ctx.params.id), count)
})
