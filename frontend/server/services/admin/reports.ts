import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { ApiError, badRequest } from '../../http'
import { getSupabase } from '../../supabase'
import { addDays } from '../../time'
import { withLiveStatus } from './bookings'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
export const MAX_DAYS = 366
const PAGE = 1000 // the database returns at most 1000 rows per request
const MAX_PAGES = 10

export const rangeQuery = z
  .object({ from: day, to: day })
  .refine((v) => v.from <= v.to, { message: 'The start date is after the end date', path: ['from'] })
  .refine((v) => addDays(v.from, MAX_DAYS) > v.to, { message: `Choose at most ${MAX_DAYS} days`, path: ['to'] })

const METHODS = ['CASH', 'CARD', 'BANK', 'UPI'] as const
const money = (v: unknown) => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Every booking that is not cancelled and starts in the range (IST dates, both ends included), with the numbers
 * that explain how "bookings" and "money" relate: what was booked, what has actually been paid, what is still owed.
 * One place for the Analytics and Reports screens, so they can never disagree.
 */
export async function bookingsInRange(q: z.infer<typeof rangeQuery>, db: SupabaseClient = getSupabase()) {
  const rows: Row[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await db
      .from('bookings')
      .select('*, stations(name, type, hourly_rate), user_profiles!bookings_user_fk(username, full_name, phone)')
      .neq('status', 'CANCELLED')
      .gte('start_at', `${q.from} 00:00:00`)
      .lt('start_at', `${addDays(q.to, 1)} 00:00:00`)
      .order('start_at')
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) throw new ApiError(500, 'Failed to load bookings')
    rows.push(...((data ?? []) as Row[]))
    if ((data?.length ?? 0) < PAGE) break
    if (page === MAX_PAGES - 1) throw badRequest('That range has too many bookings. Choose a shorter one.')
  }

  // a walk-in guest has no account: show the name staff typed where the profile would be
  const data = withLiveStatus(rows).map((b: Row) =>
    b.user_profiles || !b.guest_name ? b : { ...b, user_profiles: { username: b.guest_name, full_name: `${b.guest_name} (walk-in)`, phone: b.guest_phone ?? null } },
  )

  const byMethod: Record<string, number> = { CASH: 0, CARD: 0, BANK: 0, UPI: 0, OTHER: 0 }
  let booked = 0
  let collected = 0
  let outstanding = 0
  let paidBookings = 0
  for (const b of data) {
    const total = money(b.total_amount)
    const paid = money(b.amount_paid)
    booked += total
    collected += paid
    outstanding += Math.max(0, total - paid)
    if (paid > 0) {
      paidBookings++
      const method = String(b.payment_method ?? '').toUpperCase()
      byMethod[(METHODS as readonly string[]).includes(method) ? method : 'OTHER'] += paid
    }
  }
  return {
    from: q.from,
    to: q.to,
    data,
    summary: {
      bookings: data.length,
      paid_bookings: paidBookings,
      unpaid_bookings: data.length - paidBookings,
      booked_value: round2(booked),
      collected: round2(collected),
      outstanding: round2(outstanding),
      by_method: Object.fromEntries(Object.entries(byMethod).map(([k, v]) => [k, round2(v)])),
    },
  }
}
