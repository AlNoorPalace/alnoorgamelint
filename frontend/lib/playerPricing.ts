/** Preset prices by number of players. Each price is a FLAT price per hour for that many players. */
export interface PlayerPrice { players: number; price: number }

/** Cleans whatever is stored/typed: whole player counts >= 1 (max 50), prices >= 0, one row per count, sorted. */
export function cleanPlayerPrices(raw: unknown): PlayerPrice[] {
  if (!Array.isArray(raw)) return []
  const byPlayers = new Map<number, number>()
  raw.forEach((r) => {
    const players = Math.floor(Number((r as PlayerPrice)?.players))
    const price = Math.round(Number((r as PlayerPrice)?.price) * 100) / 100
    if (Number.isFinite(players) && players >= 1 && players <= 50 && Number.isFinite(price) && price >= 0) byPlayers.set(players, price)
  })
  const out: PlayerPrice[] = []
  byPlayers.forEach((price, players) => out.push({ players, price }))
  return out.sort((a, b) => a.players - b.players)
}

/**
 * Per-hour price for the whole group. A custom rate on a booking is per player and wins; otherwise the station's preset for
 * that player count; otherwise hourly rate x players (also what the database does, see group_hourly_rate).
 */
export function groupHourlyRate(station: { hourly_rate?: number | string | null; player_prices?: unknown } | null | undefined, players: number, customRate?: number | string | null): number {
  const n = Math.max(1, players || 1)
  if (customRate != null && customRate !== '' && Number.isFinite(Number(customRate))) return Math.round(Number(customRate) * n * 100) / 100
  const preset = cleanPlayerPrices(station?.player_prices).find((p) => p.players === n)
  if (preset) return preset.price
  return Math.round(Number(station?.hourly_rate ?? 0) * n * 100) / 100
}
