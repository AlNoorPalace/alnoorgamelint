import { describe, expect, it } from 'vitest'
import { fakeDb, rpcArgs, type Call } from './fakeDb'
import { walkIn, walkinSchema } from '../services/admin/operations'

const ST = '00000000-0000-4000-8000-000000000001'
const parse = (o: object) => walkinSchema.parse({ station_id: ST, ...o })
const NOW = new Date('2026-10-12T09:30:00Z') // 15:00 IST
const has = (c: Call[], m: string) => c.some((x) => x.method === m)

const world = (over: { rpc?: object; profile?: object | null; timerRow?: object | null } = {}) =>
  fakeDb({
    tables: {
      user_profiles: { data: 'profile' in over ? over.profile : { user_id: 'u9', username: 'neo', full_name: 'Neo' } },
      bookings: (calls: Call[]) => (has(calls, 'update') ? { data: 'timerRow' in over ? over.timerRow : { id: 'b1', timer_started_at: 'now' } } : { data: { checked_in_at: 'x', timer_started_at: null } }),
    },
    rpcs: { walkin_checkin: over.rpc ?? { data: { id: 'b1', status: 'ONGOING' } } },
  })

describe('walk-in schema', () => {
  it('needs a name or a member username, and sane numbers', () => {
    expect(() => parse({})).toThrow()
    expect(parse({ guest_name: ' Rahul ' })).toMatchObject({ guest_name: 'Rahul', duration_hours: 1, user_count: 1, start_timer: true })
    expect(() => parse({ guest_name: 'A', duration_hours: 0 })).toThrow()
    expect(() => parse({ guest_name: 'A', user_count: 21 })).toThrow()
    expect(() => walkinSchema.parse({ guest_name: 'A', station_id: 'nope' })).toThrow()
  })
})

describe('walkIn', () => {
  it('checks a guest in now (IST) and starts the timer', async () => {
    const w = world()
    const out = await walkIn(parse({ guest_name: 'Rahul', guest_phone: '99999', duration_hours: 2, user_count: 2, payment_method: 'CASH' }), w.db, NOW)
    expect(out).toMatchObject({ id: 'b1' })
    expect(rpcArgs(w.log, 'walkin_checkin')).toEqual({
      p_station_id: ST, p_user_id: null, p_guest_name: 'Rahul', p_guest_phone: '99999', p_duration_hours: 2, p_user_count: 2,
      p_now_ist: '2026-10-12 15:00:00', p_payment_method: 'CASH', p_notes: null, p_extra_controllers: 0,
    })
    expect(w.log.some((e) => e.table === 'bookings' && has(e.calls, 'update'))).toBe(true) // timer started
  })
  it('passes extra controllers to the database and rejects absurd counts', async () => {
    const w = world()
    await walkIn(parse({ guest_name: 'A', extra_controllers: 3 }), w.db, NOW)
    expect(rpcArgs(w.log, 'walkin_checkin')!.p_extra_controllers).toBe(3)
    expect(() => parse({ guest_name: 'A', extra_controllers: 11 })).toThrow()
    expect(() => parse({ guest_name: 'A', extra_controllers: -1 })).toThrow()
  })
  it('links a member by username (ignoring case) so their prepaid minutes apply', async () => {
    const w = world()
    await walkIn(parse({ username: 'NEO', guest_name: 'ignored' }), w.db, NOW)
    const args = rpcArgs(w.log, 'walkin_checkin')!
    expect(args.p_user_id).toBe('u9')
    expect(args.p_guest_name).toBeNull()
    expect(w.log.find((e) => e.table === 'user_profiles')!.calls).toContainEqual({ method: 'ilike', args: ['username', 'NEO'] })
  })
  it('reports an unknown member', async () => {
    await expect(walkIn(parse({ username: 'ghost' }), world({ profile: null }).db, NOW)).rejects.toMatchObject({ status: 404 })
  })
  it('can skip starting the timer', async () => {
    const w = world()
    await walkIn(parse({ guest_name: 'A', start_timer: false }), w.db, NOW)
    expect(w.log.some((e) => e.table === 'bookings')).toBe(false)
  })
  it('keeps the booking even when the timer cannot start', async () => {
    const w = world({ timerRow: null })
    await expect(walkIn(parse({ guest_name: 'A' }), w.db, NOW)).resolves.toMatchObject({ id: 'b1' })
  })
  it('turns database refusals into clear messages', async () => {
    const run = (code: string) => walkIn(parse({ guest_name: 'A' }), world({ rpc: { error: { message: code } } }).db, NOW)
    await expect(run('STATION_BUSY')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('already playing') })
    await expect(run('SLOT_TAKEN')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('reservation') })
    await expect(run('STATION_NOT_FOUND')).rejects.toMatchObject({ status: 404 })
    await expect(run('weird')).rejects.toMatchObject({ status: 500 })
  })
})

import { searchMembers } from '../services/admin/operations'

describe('searchMembers', () => {
  it('ignores fragments under 2 characters without asking the database', async () => {
    const w = fakeDb({ rpcs: { search_members: { data: [{ username: 'x' }] } } })
    await expect(searchMembers(' a ', w.db)).resolves.toEqual([])
    expect(rpcArgs(w.log, 'search_members')).toBeUndefined()
  })
  it('passes the trimmed text and a small limit, and returns the rows', async () => {
    const rows = [{ user_id: 'u1', username: 'rahulk', full_name: 'Rahul', phone: null, email: 'r@x.com' }]
    const w = fakeDb({ rpcs: { search_members: { data: rows } } })
    await expect(searchMembers(' rahul ', w.db)).resolves.toEqual(rows)
    expect(rpcArgs(w.log, 'search_members')).toEqual({ p_query: 'rahul', p_limit: 8 })
  })
  it('reports a database failure', async () => {
    await expect(searchMembers('rahul', fakeDb({ rpcs: { search_members: { error: { message: 'x' } } } }).db)).rejects.toMatchObject({ status: 500 })
  })
})

describe('walk-in failures explain themselves to staff', () => {
  const run = (error: object) => walkIn(parse({ guest_name: 'A' }), world({ rpc: { error } }).db, NOW)
  it('says which SQL file to run when the function is missing', async () => {
    await expect(run({ code: 'PGRST202', message: 'Could not find the function public.walkin_checkin(...) in the schema cache' })).rejects.toMatchObject({
      status: 503, message: expect.stringContaining('15_extra_controllers.sql'),
    })
  })
  it('passes on the database message for anything unexpected', async () => {
    await expect(run({ code: '23514', message: 'new row violates check constraint "bookings_x"' })).rejects.toMatchObject({
      status: 500, message: expect.stringContaining('violates check constraint "bookings_x"'),
    })
  })
  it('keeps the plain messages for known refusals', async () => {
    await expect(run({ message: 'STATION_BUSY' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Someone is already playing on that station') })
  })
})

describe('a busy station says who is on it', () => {
  it('names the session so staff can end it', async () => {
    const db = fakeDb({
      tables: { bookings: { data: { id: 'b-old', status: 'ONGOING', start_at: '2026-10-17 21:00:00', guest_name: 'Rahul', user_profiles: null } } },
      rpcs: { walkin_checkin: { error: { message: 'STATION_BUSY' } } },
    }).db
    await expect(walkIn(parse({ guest_name: 'A' }), db, NOW)).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/Rahul.*2026-10-17 21:00:00.*ONGOING.*b-old/),
    })
  })
  it('falls back to the plain message when no session can be found', async () => {
    const db = fakeDb({ tables: { bookings: { data: null } }, rpcs: { walkin_checkin: { error: { message: 'STATION_BUSY' } } } }).db
    await expect(walkIn(parse({ guest_name: 'A' }), db, NOW)).rejects.toMatchObject({ message: 'Someone is already playing on that station' })
  })
})

describe('extra controllers on a booking', () => {
  it('sends the new count to set_extra_controllers', async () => {
    const { setExtraControllers } = await import('../services/admin/operations')
    const w = fakeDb({ rpcs: { set_extra_controllers: { data: { id: 'b1', extra_controllers: 2 } } } })
    await expect(setExtraControllers(ST, 2, w.db)).resolves.toMatchObject({ extra_controllers: 2 })
    expect(rpcArgs(w.log, 'set_extra_controllers')).toEqual({ p_booking_id: ST, p_count: 2 })
  })
  it('explains refusals', async () => {
    const { setExtraControllers } = await import('../services/admin/operations')
    const run = (code: string) => setExtraControllers(ST, 1, fakeDb({ rpcs: { set_extra_controllers: { error: { message: code } } } }).db)
    await expect(run('CONTROLLERS_NOT_OFFERED')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Stations') })
    await expect(run('NOT_EDITABLE')).rejects.toMatchObject({ status: 400 })
  })
})
