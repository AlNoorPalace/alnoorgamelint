import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { ApiError, badRequest, notFound } from '../../http'
import { getSupabase } from '../../supabase'
import { toIstString } from '../../time'
import { mapRpcError } from '../bookings'

export const checkinQuery = z.object({ station_id: z.guid('Invalid station id') })

/** Assigns the station and starts the session; all rules live in one atomic database function. */
export async function checkin(bookingId: string, stationId: string, db: SupabaseClient = getSupabase(), now = new Date()) {
  const { data, error } = await db.rpc('checkin_booking', {
    p_booking_id: bookingId,
    p_station_id: stationId,
    p_now_ist: toIstString(now),
  })
  if (error || !data) throw mapRpcError(error, 'Failed to check in booking')
  return data
}

// ---- walk-ins -----------------------------------------------------------------------------------

export const walkinSchema = z
  .object({
    station_id: z.guid('Choose a station'),
    duration_hours: z.number().int().min(1).max(24).default(1),
    user_count: z.number().int().min(1).max(20).default(1),
    username: z.string().trim().min(1).max(30).optional(),
    guest_name: z.string().trim().min(1).max(60).optional(),
    guest_phone: z.string().trim().max(20).optional(),
    payment_method: z.string().trim().max(50).optional(),
    notes: z.string().trim().max(300).optional(),
    start_timer: z.boolean().default(true),
  })
  .refine((v) => v.username || v.guest_name, 'Enter the player\'s name, or a member\'s username')

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

const WALKIN_ERRORS: Record<string, [number, string]> = {
  STATION_BUSY: [400, 'Someone is already playing on that station'],
  SLOT_TAKEN: [400, 'A reservation on that station starts before this session would end. Choose a shorter time or another station'],
  GUEST_REQUIRED: [400, 'Enter the player\'s name, or a member\'s username'],
}

export const memberSearchQuery = z.object({ q: z.string().trim().max(60).default('') })

/** Members matching a username, name, email or phone fragment (staff screens only: it returns emails). */
export async function searchMembers(q: string, db: SupabaseClient = getSupabase()) {
  if (q.trim().length < 2) return []
  const { data, error } = await db.rpc('search_members', { p_query: q.trim(), p_limit: 8 })
  if (error) throw new ApiError(500, 'Failed to search members')
  return (data ?? []) as { user_id: string; username: string; full_name: string; phone: string | null; email: string | null }[]
}

/**
 * A player walks in without a reservation: staff pick a free station and the session starts now.
 * The player is a member (looked up by username, so prepaid minutes apply) or a guest with just a name.
 */
export async function walkIn(input: z.infer<typeof walkinSchema>, db: SupabaseClient = getSupabase(), now = new Date()) {
  let userId: string | null = null
  let guestName = input.guest_name ?? null
  if (input.username) {
    const { data: profile, error } = await db
      .from('user_profiles')
      .select('user_id, username, full_name')
      .ilike('username', escapeLike(input.username))
      .maybeSingle()
    if (error) throw new ApiError(500, 'Failed to look up the player')
    if (!profile) throw notFound('No member has that username')
    userId = profile.user_id as string
    guestName = null
  }

  const { data, error } = await db.rpc('walkin_checkin', {
    p_station_id: input.station_id,
    p_user_id: userId,
    p_guest_name: guestName,
    p_guest_phone: input.guest_phone ?? null,
    p_duration_hours: input.duration_hours,
    p_user_count: input.user_count,
    p_now_ist: toIstString(now),
    p_payment_method: input.payment_method ?? null,
    p_notes: input.notes ?? null,
  })
  if (error || !data) throw mapRpcError(error, 'Failed to check in the player', WALKIN_ERRORS)
  if (!input.start_timer) return data
  // the booking exists either way; a failed timer start is reported by the next click on "Start timer"
  try {
    return await startTimer((data as { id: string }).id, db)
  } catch (e) {
    console.error('Walk-in timer did not start:', e)
    return data
  }
}

export async function startTimer(bookingId: string, db: SupabaseClient = getSupabase()) {
  const { data: b, error } = await db.from('bookings').select('checked_in_at, timer_started_at').eq('id', bookingId).maybeSingle()
  if (error) throw new ApiError(500, 'Failed to start timer')
  if (!b) throw notFound('Booking not found')
  if (!b.checked_in_at) throw badRequest('Booking must be checked in before starting the timer')
  if (b.timer_started_at) throw badRequest('Timer already running')

  // conditional update: two staff clicking at once cannot both start it
  const { data, error: updateError } = await db
    .from('bookings')
    .update({ timer_started_at: new Date().toISOString() })
    .eq('id', bookingId)
    .is('timer_started_at', null)
    .select()
    .maybeSingle()
  if (updateError) throw new ApiError(500, 'Failed to start timer')
  if (!data) throw badRequest('Timer already running')
  return data
}

export async function stopTimer(bookingId: string, db: SupabaseClient = getSupabase()) {
  const { data, error } = await db.rpc('stop_timer', { p_booking_id: bookingId })
  if (error || !data) throw mapRpcError(error, 'Failed to stop timer')
  return data
}

/** Starts grace time once; calling it again returns the original start instead of resetting the clock. */
export async function startGrace(bookingId: string, db: SupabaseClient = getSupabase()) {
  const startedAt = new Date().toISOString()
  const { data, error } = await db
    .from('bookings')
    .update({ grace_time_started_at: startedAt })
    .eq('id', bookingId)
    .is('grace_time_started_at', null)
    .select('grace_time_started_at')
    .maybeSingle()
  if (error) throw new ApiError(500, 'Failed to start grace time')
  if (data) return { message: 'Grace time started', grace_started_at: startedAt }

  const { data: existing } = await db.from('bookings').select('grace_time_started_at').eq('id', bookingId).maybeSingle()
  if (!existing) throw notFound('Booking not found')
  return { message: 'Grace time started', grace_started_at: existing.grace_time_started_at }
}

export async function extendHour(bookingId: string, db: SupabaseClient = getSupabase()) {
  const { data, error } = await db.rpc('extend_booking_hour', { p_booking_id: bookingId })
  if (error || !data) throw mapRpcError(error, 'Failed to extend booking', { STATION_REQUIRED: [400, 'Booking has no station rate to extend'] })
  return data
}
