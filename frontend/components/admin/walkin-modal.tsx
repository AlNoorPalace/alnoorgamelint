'use client'

import { useState } from 'react'
import { apiFetch, apiError } from '@/lib/api'
import { cleanPlayerPrices, groupHourlyRate } from '@/lib/playerPricing'
import { MemberSearch, type Member } from './member-search'

export interface WalkinStation { id: string; name: string; type: string; hourly_rate?: number | null; extra_controller_rate?: number | null; player_prices?: unknown; status: 'available' | 'pending' | 'occupied' }

const field = 'w-full rounded border border-cp-cyan/30 bg-cp-black/50 px-3 py-2 text-white'

/** Checks a player in straight to a free station when they arrive without a reservation. */
export function WalkinModal({ stations, stationId, onClose, onDone }: { stations: WalkinStation[]; stationId?: string | null; onClose: () => void; onDone: () => void }) {
  const free = stations.filter((s) => s.status !== 'occupied')
  const [station, setStation] = useState(stationId && free.some((s) => s.id === stationId) ? stationId : free.find((s) => s.status === 'available')?.id ?? free[0]?.id ?? '')
  const [member, setMember] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [picked, setPicked] = useState<Member | null>(null)
  const [hours, setHours] = useState(1)
  const [players, setPlayers] = useState(1)
  const [controllers, setControllers] = useState(0)
  const [payment, setPayment] = useState('')
  const [notes, setNotes] = useState('')
  const [startTimer, setStartTimer] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const chosen = free.find((s) => s.id === station)
  const rate = Number(chosen?.hourly_rate ?? 0)
  const presets = cleanPlayerPrices(chosen?.player_prices)
  const hasPresets = presets.length > 0
  const groupRate = groupHourlyRate(chosen, players)
  const controllerRate = Number(chosen?.extra_controller_rate ?? 0)
  const controllerCost = controllers * controllerRate * hours
  const estimate = groupRate * hours + controllerCost
  const ready = !!station && (member ? picked : name.trim())

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const body: Record<string, unknown> = { station_id: station, duration_hours: hours, user_count: players, extra_controllers: controllerRate > 0 ? controllers : 0, start_timer: startTimer }
      if (member) body.username = picked!.username
      else { body.guest_name = name.trim(); if (phone.trim()) body.guest_phone = phone.trim() }
      if (payment) body.payment_method = payment
      if (notes.trim()) body.notes = notes.trim()
      const res = await apiFetch('/api/v1/admin/bookings/walk-in', { method: 'POST', body: JSON.stringify(body) })
      if (!res.ok) throw new Error(await apiError(res, 'Could not check the player in'))
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-lg border border-cp-cyan/30 bg-cp-gray p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-1 text-xl font-bold text-cp-yellow">Walk-in check-in</h3>
        <p className="mb-4 text-sm text-gray-400">For a player who arrives without a reservation. The session starts now.</p>

        {stations.length === 0 ? (
          <p className="text-gray-300">Loading stations…</p>
        ) : free.length === 0 ? (
          <p className="text-gray-300">Every station is in use right now.</p>
        ) : (
          <div className="space-y-4">
            <label className="block text-sm text-white">Station
              <select className={`${field} mt-1`} value={station} onChange={(e) => {
                setStation(e.target.value)
                const next = cleanPlayerPrices(free.find((s) => s.id === e.target.value)?.player_prices)
                if (next.length > 0 && !next.some((p) => p.players === players)) setPlayers(next[0].players)
              }}>
                {free.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.type}){s.status === 'pending' ? ' - has a reservation today' : ''}</option>)}
              </select>
            </label>

            <div className="flex gap-2">
              {[false, true].map((m) => (
                <button key={String(m)} type="button" onClick={() => setMember(m)} className={`flex-1 rounded px-3 py-2 text-sm font-medium ${member === m ? 'bg-cp-cyan text-cp-black' : 'bg-gray-600 text-white'}`}>
                  {m ? 'Member (has an account)' : 'Guest (no account)'}
                </button>
              ))}
            </div>
            {member ? (
              <div className="text-sm text-white">Member<div className="mt-1"><MemberSearch value={picked} onChange={setPicked} autoFocus /></div></div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm text-white">Name<input className={`${field} mt-1`} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
                <label className="block text-sm text-white">Phone (optional)<input className={`${field} mt-1`} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm text-white">Hours
                <div className="mt-1 flex items-center gap-2">
                  <button type="button" className="rounded bg-gray-600 px-3 py-2" onClick={() => setHours((h) => Math.max(1, h - 1))}>-</button>
                  <span className="w-8 text-center">{hours}</span>
                  <button type="button" className="rounded bg-gray-600 px-3 py-2" onClick={() => setHours((h) => Math.min(24, h + 1))}>+</button>
                </div>
              </label>
              <label className="block text-sm text-white">Players
                {hasPresets ? (
                  <select className={`${field} mt-1`} value={players} onChange={(e) => setPlayers(Number(e.target.value))}>
                    {presets.map((p) => <option key={p.players} value={p.players}>{p.players} player{p.players > 1 ? 's' : ''} - ₹{p.price}/hr</option>)}
                  </select>
                ) : (
                <div className="mt-1 flex items-center gap-2">
                  <button type="button" className="rounded bg-gray-600 px-3 py-2" onClick={() => setPlayers((p) => Math.max(1, p - 1))}>-</button>
                  <span className="w-8 text-center">{players}</span>
                  <button type="button" className="rounded bg-gray-600 px-3 py-2" onClick={() => setPlayers((p) => Math.min(20, p + 1))}>+</button>
                </div>
                )}
              </label>
            </div>

            {controllerRate > 0 && (
              <div className="text-sm text-white">Extra controllers <span className="text-gray-400">(₹{controllerRate} per controller per hour)</span>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <button type="button" className="rounded bg-gray-600 px-3 py-2" onClick={() => setControllers((c) => Math.max(0, c - 1))}>-</button>
                  <span className="w-8 text-center">{controllers}</span>
                  <button type="button" className="rounded bg-gray-600 px-3 py-2" onClick={() => setControllers((c) => Math.min(10, c + 1))}>+</button>
                  {[1, 2, 3].map((n) => (
                    <button key={n} type="button" onClick={() => setControllers(n)} className={`rounded px-3 py-2 text-xs ${controllers === n ? 'bg-cp-cyan text-cp-black' : 'bg-gray-700 text-white'}`}>{n}</button>
                  ))}
                </div>
              </div>
            )}

            <label className="block text-sm text-white">Payment method (optional)
              <select className={`${field} mt-1`} value={payment} onChange={(e) => setPayment(e.target.value)}>
                <option value="">Not yet / decide later</option>
                <option value="CASH">Cash</option>
                <option value="UPI">UPI</option>
                <option value="CARD">Card</option>
              </select>
            </label>
            <label className="block text-sm text-white">Notes (optional)<input className={`${field} mt-1`} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
            <label className="flex items-center gap-2 text-sm text-white"><input type="checkbox" checked={startTimer} onChange={(e) => setStartTimer(e.target.checked)} />Start the timer now</label>

            {(rate > 0 || hasPresets) && <div className="rounded bg-black/30 p-3 text-sm text-gray-300">Estimated: {hasPresets ? `${players} player${players > 1 ? 's' : ''} ₹${groupRate}` : `₹${rate} × ${players}`} × {hours} h{controllers > 0 ? ` + ${controllers} extra controller${controllers > 1 ? 's' : ''} × ₹${controllerRate} × ${hours} h (₹${controllerCost})` : ''} = <b className="text-cp-yellow">₹{estimate}</b> (payment is recorded afterwards on the booking)</div>}
          </div>
        )}

        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button className="rounded bg-gray-600 px-4 py-2 text-white hover:bg-gray-500" onClick={onClose}>Cancel</button>
          <button disabled={busy || !ready || free.length === 0} className="rounded bg-cp-cyan px-4 py-2 font-semibold text-cp-black disabled:opacity-50" onClick={submit}>{busy ? 'Checking in…' : 'Check in'}</button>
        </div>
      </div>
    </div>
  )
}
