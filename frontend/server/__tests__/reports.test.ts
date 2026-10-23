import { describe, expect, it } from 'vitest'
import { fakeDb, type Call } from './fakeDb'
import { MAX_DAYS, bookingsInRange, rangeQuery } from '../services/admin/reports'

const q = { from: '2026-10-23', to: '2026-10-23' }
const booking = (over: object) => ({ id: 'b', status: 'ENDED', start_at: '2026-10-23 17:00:00', end_at: '2026-10-23 18:00:00', start_time: '17:00:00', checked_in: true, total_amount: 100, amount_paid: 0, payment_method: null, user_profiles: null, guest_name: null, stations: { name: 'S', type: 'PC' }, ...over })

describe('range', () => {
  it('needs two ISO dates in order, and not more than a year', () => {
    expect(rangeQuery.parse(q)).toEqual(q)
    expect(() => rangeQuery.parse({ from: '23/10/2026', to: '2026-10-23' })).toThrow()
    expect(() => rangeQuery.parse({ from: '2026-10-24', to: '2026-10-23' })).toThrow()
    expect(() => rangeQuery.parse({ from: '2025-01-01', to: '2026-10-23' })).toThrow()
    expect(rangeQuery.parse({ from: '2025-10-24', to: '2026-10-23' })).toBeTruthy()
    expect(MAX_DAYS).toBe(366)
  })
})

describe('bookingsInRange', () => {
  it('asks for the whole range (IST days, both ends) and skips cancelled bookings', async () => {
    const f = fakeDb({ tables: { bookings: { data: [] } } })
    await bookingsInRange({ from: '2026-10-23', to: '2026-10-24' }, f.db)
    const calls = f.log[0].calls
    expect(calls).toContainEqual({ method: 'neq', args: ['status', 'CANCELLED'] })
    expect(calls).toContainEqual({ method: 'gte', args: ['start_at', '2026-10-23 00:00:00'] })
    expect(calls).toContainEqual({ method: 'lt', args: ['start_at', '2026-10-25 00:00:00'] })
  })
  it('explains your two numbers: 2 bookings, ₹300 booked, ₹100 collected, ₹200 still to collect', async () => {
    const rows = [
      booking({ id: 'pool', status: 'ONGOING', total_amount: 200, amount_paid: 0 }),
      booking({ id: 'neo', total_amount: 100, amount_paid: 100, payment_method: 'cash' }),
    ]
    const out = await bookingsInRange(q, fakeDb({ tables: { bookings: { data: rows } } }).db)
    expect(out.summary).toMatchObject({ bookings: 2, paid_bookings: 1, unpaid_bookings: 1, booked_value: 300, collected: 100, outstanding: 200 })
    expect(out.summary.by_method).toEqual({ CASH: 100, CARD: 0, BANK: 0, UPI: 0, OTHER: 0 })
  })
  it('counts only money received, never the price of an unpaid booking, and puts unknown methods under Other', async () => {
    const rows = [
      booking({ id: '1', total_amount: 100, amount_paid: 40, payment_method: 'UPI' }),
      booking({ id: '2', total_amount: 100, amount_paid: 100, payment_method: null }),
      booking({ id: '3', total_amount: 100, amount_paid: 0, payment_method: 'CASH' }), // method chosen but nothing paid yet
      booking({ id: '4', total_amount: 50, amount_paid: 80, payment_method: 'card' }), // overpaid: owes nothing
    ]
    const { summary } = await bookingsInRange(q, fakeDb({ tables: { bookings: { data: rows } } }).db)
    expect(summary.by_method).toEqual({ CASH: 0, CARD: 80, BANK: 0, UPI: 40, OTHER: 100 })
    expect(summary).toMatchObject({ collected: 220, outstanding: 60 + 0 + 100 + 0, paid_bookings: 3, unpaid_bookings: 1 })
  })
  it('shows a walk-in guest by name and number', async () => {
    const out = await bookingsInRange(q, fakeDb({ tables: { bookings: { data: [booking({ guest_name: 'Arjun', guest_phone: '9988776655' })] } } }).db)
    expect(out.data[0].user_profiles).toEqual({ username: 'Arjun', full_name: 'Arjun (walk-in)', phone: '9988776655' })
  })
  it('gives each booking its live status (an old unfinished session is ENDED, a checked-in one stays ONGOING)', async () => {
    const rows = [
      booking({ id: 'old', status: 'UPCOMING', checked_in: false, start_at: '2020-01-01 10:00:00', end_at: '2020-01-01 11:00:00' }),
      booking({ id: 'live', status: 'ONGOING', checked_in: true, start_at: '2020-01-01 10:00:00', end_at: '2020-01-01 11:00:00' }),
    ]
    const out = await bookingsInRange(q, fakeDb({ tables: { bookings: { data: rows } } }).db)
    expect(out.data.map((b) => b.status)).toEqual(['ENDED', 'ONGOING'])
  })
  it('reads past the 1000-row page limit', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => booking({ id: `b${i}` }))
    let calls = 0
    const f = fakeDb({ tables: { bookings: (c: Call[]) => { calls++; const r = c.find((x) => x.method === 'range')!.args[0] as number; return { data: r === 0 ? page(1000) : page(250) } } } })
    const out = await bookingsInRange(q, f.db)
    expect(out.summary.bookings).toBe(1250)
    expect(calls).toBe(2)
  })
  it('stops with a clear message instead of loading an enormous range', async () => {
    const f = fakeDb({ tables: { bookings: { data: Array.from({ length: 1000 }, () => booking({})) } } })
    await expect(bookingsInRange(q, f.db)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('too many') })
  })
  it('reports a database failure', async () => {
    await expect(bookingsInRange(q, fakeDb({ tables: { bookings: { error: { message: 'x' } } } }).db)).rejects.toMatchObject({ status: 500 })
  })
})
