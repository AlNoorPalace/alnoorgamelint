import { describe, expect, it } from 'vitest'
import { cleanPlayerPrices, groupHourlyRate } from './playerPricing'
import { computePrice } from '../server/pricing'

const station = { hourly_rate: 100, player_prices: [{ players: 1, price: 150 }, { players: 2, price: 250 }, { players: 3, price: 330 }] }

describe('player price presets', () => {
  it('uses the flat preset for that player count', () => {
    expect(groupHourlyRate(station, 2)).toBe(250)
    expect(groupHourlyRate(station, 3)).toBe(330)
  })
  it('falls back to rate x players when there is no preset', () => {
    expect(groupHourlyRate(station, 5)).toBe(500)
    expect(groupHourlyRate({ hourly_rate: 120 }, 3)).toBe(360)
    expect(groupHourlyRate({ hourly_rate: 120, player_prices: null }, 2)).toBe(240)
  })
  it('lets a custom per-player rate win over a preset', () => {
    expect(groupHourlyRate(station, 2, 90)).toBe(180)
  })
  it('cleans bad rows, duplicates and order', () => {
    expect(cleanPlayerPrices([{ players: '3', price: '330' }, { players: 1, price: 150 }, { players: 1, price: 160 }, { players: 0, price: 5 }, { players: 2, price: -1 }, { players: 'x', price: 1 }, null]))
      .toEqual([{ players: 1, price: 160 }, { players: 3, price: 330 }])
    expect(cleanPlayerPrices('nope')).toEqual([])
  })
  it('prices a booking from the group rate, flat per hour', () => {
    expect(computePrice({ hourlyRate: 100, durationHours: 2, userCount: 2, groupRate: 250, controllerCharge: 60 }).totalAmount).toBe(560)
    expect(computePrice({ hourlyRate: 100, durationHours: 2, userCount: 2 }).totalAmount).toBe(400)
  })
})
