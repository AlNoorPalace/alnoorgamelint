'use client'

import { useState, useEffect } from 'react'
import { AdminGuard } from '@/components/ui/admin-guard'
import { admin } from '@/lib/supabase'
import { apiFetch, apiError } from '@/lib/api'

const tabs = ['Day Settlement', 'Day Use', 'Customer']

export default function AdminReports() {
  const [activeTab, setActiveTab] = useState('Day Settlement')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [reportData, setReportData] = useState<any[]>([]) // finished sessions (Day Use and Customer reports)
  const [paidRows, setPaidRows] = useState<any[]>([]) // every booking with money received (Day Settlement)
  const [summary, setSummary] = useState<{ bookings: number; paid_bookings: number; unpaid_bookings: number; booked_value: number; collected: number; outstanding: number; by_method: Record<string, number> } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [customerSearch, setCustomerSearch] = useState('')
  const [bookingModal, setBookingModal] = useState<{userId: string, name: string} | null>(null)
  const [receiptModal, setReceiptModal] = useState<{userId: string, name: string} | null>(null)

  const fetchReport = async () => {
    if (!fromDate || !toDate) return
    setLoading(true)
    setLoadError(null)
    try {
      // one server request for the whole range (no 100-booking limit, no browser time zones)
      const res = await apiFetch(`/api/v1/admin/reports/bookings?from=${fromDate}&to=${toDate}`)
      if (!res.ok) throw new Error(await apiError(res, 'Could not load the report'))
      const out = await res.json()
      const all: any[] = out.data ?? []
      setSummary(out.summary)
      setPaidRows(all.filter((b) => Number(b.amount_paid) > 0))
      setReportData(all.filter((b) => b.status === 'ENDED'))
    } catch (e) {
      setLoadError((e as Error).message)
      setSummary(null)
      setPaidRows([])
      setReportData([])
    }
    setLoading(false)
  }

  useEffect(() => { fetchReport() }, [fromDate, toDate])

  const getPaymentAmount = (booking: any, method: string) => {
    const known = ['CASH', 'CARD', 'BANK', 'UPI']
    const m = String(booking.payment_method ?? '').toUpperCase()
    const column = known.includes(m) ? m : 'OTHER'
    return column === method ? Number(booking.amount_paid || 0) : 0 // money received only, never the price of an unpaid booking
  }

  const totals = {
    cash: summary?.by_method.CASH ?? 0,
    card: summary?.by_method.CARD ?? 0,
    bank: summary?.by_method.BANK ?? 0,
    upi: summary?.by_method.UPI ?? 0,
    other: summary?.by_method.OTHER ?? 0,
  }
  const grandTotal = summary?.collected ?? 0

  const dayUseData = Object.values(
    reportData.reduce((acc: any, b: any) => {
      const date = b.start_at?.split('T')[0] || b.start_at
      if (!acc[date]) acc[date] = { date, bookings: 0, revenue: 0, hours: 0 }
      acc[date].bookings++
      acc[date].revenue += Number(b.total_amount || 0)
      acc[date].hours += Number(b.duration_hours || 0)
      return acc
    }, {})
  ) as any[]

  const customerData = Object.values(
    reportData.reduce((acc: any, b: any) => {
      const id = b.user_id ?? `guest:${b.user_profiles?.username ?? b.id}`
      const name = b.user_profiles?.username || b.user_profiles?.full_name || 'Unknown'
      const phone = b.user_profiles?.phone || '-'
      if (!acc[id]) acc[id] = { id, name, phone, cash: 0, card: 0, bank: 0, upi: 0, other: 0, total: 0, hours: 0 }
      const amt = Number(b.amount_paid || 0)
      const method = b.payment_method?.toUpperCase()
      if (method === 'CASH') acc[id].cash += amt
      else if (method === 'CARD') acc[id].card += amt
      else if (method === 'BANK') acc[id].bank += amt
      else if (method === 'UPI') acc[id].upi += amt
      else if (amt > 0) acc[id].other += amt
      acc[id].total += amt
      acc[id].hours += Number(b.duration_hours || 0)
      return acc
    }, {})
  ).filter((c: any) => !customerSearch || c.name.toLowerCase().includes(customerSearch.toLowerCase()) || c.phone.includes(customerSearch)) as any[]

  const exportCSV = () => {
    if (!paidRows.length) return
    const headers = ['Booking ID', 'Station', 'User', 'Cash', 'Card', 'Bank', 'UPI', 'Other', 'Staff', 'Time']
    const rows = paidRows.map((b: any) => [
      b.id.slice(0, 8), b.stations?.name || 'N/A', b.user_profiles?.username || 'N/A',
      getPaymentAmount(b, 'CASH'), getPaymentAmount(b, 'CARD'), getPaymentAmount(b, 'BANK'), getPaymentAmount(b, 'UPI'), getPaymentAmount(b, 'OTHER'),
      '-', new Date(b.updated_at).toLocaleTimeString()
    ])
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${activeTab}_${fromDate}_${toDate}.csv`
    a.click()
  }

  const exportPDF = () => window.print()

  return (
    <AdminGuard>
      <div className="min-h-screen bg-cp-black">
        
        
        <main className="pt-6 pb-12 px-6">
          <div className="max-w-7xl mx-auto">
            <div className="mb-8">
              <h1 className="text-4xl font-bold text-cp-yellow">
                Reports <span className="text-cp-cyan">Management</span>
              </h1>
              <p className="text-gray-300 mt-2">View and generate various reports</p>
            </div>

            {/* Tab Navigation */}
            <div className="flex gap-2 mb-6">
              {tabs.map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 rounded font-medium ${
                    activeTab === tab
                      ? 'bg-cp-cyan text-cp-black'
                      : 'bg-cp-gray/40 text-gray-300 hover:bg-cp-gray/60'
                  }`}
                >
                  {tab} Report
                </button>
              ))}
            </div>

            {/* Date Filter */}
            <div className="flex gap-4 mb-6 items-end">
              <div>
                <label className="block text-sm text-gray-400 mb-1">From Date</label>
                <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="bg-cp-gray/40 border border-cp-cyan/30 rounded px-3 py-2 text-white [&::-webkit-calendar-picker-indicator]:invert" />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">To Date</label>
                <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="bg-cp-gray/40 border border-cp-cyan/30 rounded px-3 py-2 text-white [&::-webkit-calendar-picker-indicator]:invert" />
              </div>
              <button onClick={fetchReport} className="bg-cp-cyan text-cp-black px-4 py-2 rounded font-medium hover:bg-cp-yellow">Generate Report</button>
              <button onClick={exportCSV} className="bg-green-600 text-white px-4 py-2 rounded font-medium hover:bg-green-700">Export CSV</button>
              <button onClick={exportPDF} className="bg-red-600 text-white px-4 py-2 rounded font-medium hover:bg-red-700">Export PDF</button>
            </div>

            {/* Report Content */}
            <div className="bg-cp-gray/20 border border-cp-cyan/30 rounded-lg p-6">
              <h2 className="text-2xl font-bold text-cp-yellow mb-4">{activeTab} Report</h2>
              
              {activeTab === 'Day Settlement' && (
                <div>
                  {!fromDate || !toDate ? (
                    <p className="text-gray-400">Select date range to view report</p>
                  ) : loading ? (
                    <p className="text-gray-400">Loading...</p>
                  ) : loadError ? (
                    <p className="text-red-400">{loadError}</p>
                  ) : !summary || summary.bookings === 0 ? (
                    <p className="text-gray-400">No bookings in the selected date range</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <p className="mb-4 rounded bg-cp-black/40 p-3 text-sm text-gray-300">
                        {summary.bookings} booking{summary.bookings === 1 ? '' : 's'} in this range: booked <b className="text-white">₹{summary.booked_value}</b>,
                        received <b className="text-green-400">₹{summary.collected}</b> ({summary.paid_bookings} paid),
                        still to collect <b className="text-yellow-300">₹{summary.outstanding}</b> ({summary.unpaid_bookings} with nothing received).
                        The table lists the bookings that have money received, whatever their status.
                      </p>
                      <table className="w-full text-sm">
                        <thead className="bg-cp-gray/40">
                          <tr>
                            <th className="px-3 py-2 text-left text-cp-yellow">Booking ID</th>
                            <th className="px-3 py-2 text-left text-cp-yellow">Station</th>
                            <th className="px-3 py-2 text-left text-cp-yellow">User</th>
                            <th className="px-3 py-2 text-right text-cp-yellow">Cash</th>
                            <th className="px-3 py-2 text-right text-cp-yellow">Card</th>
                            <th className="px-3 py-2 text-right text-cp-yellow">Bank</th>
                            <th className="px-3 py-2 text-right text-cp-yellow">UPI</th>
                            <th className="px-3 py-2 text-right text-cp-yellow">Other</th>
                            <th className="px-3 py-2 text-left text-cp-yellow">Staff</th>
                            <th className="px-3 py-2 text-left text-cp-yellow">Time</th>
                          </tr>
                        </thead>
                        <tbody>
                          {paidRows.map((b: any) => (
                            <tr key={b.id} className="border-t border-cp-cyan/20">
                              <td className="px-3 py-2 text-white text-xs">{b.id}</td>
                              <td className="px-3 py-2 text-white">{b.stations?.name || 'N/A'}</td>
                              <td className="px-3 py-2 text-white">{b.user_profiles?.username || 'N/A'}</td>
                              <td className="px-3 py-2 text-right text-white">₹{getPaymentAmount(b, 'CASH')}</td>
                              <td className="px-3 py-2 text-right text-white">₹{getPaymentAmount(b, 'CARD')}</td>
                              <td className="px-3 py-2 text-right text-white">₹{getPaymentAmount(b, 'BANK')}</td>
                              <td className="px-3 py-2 text-right text-white">₹{getPaymentAmount(b, 'UPI')}</td>
                              <td className="px-3 py-2 text-right text-white">₹{getPaymentAmount(b, 'OTHER')}</td>
                              <td className="px-3 py-2 text-white">{b.staff?.username || '-'}</td>
                              <td className="px-3 py-2 text-white">{new Date(b.updated_at).toLocaleTimeString()}</td>
                            </tr>
                          ))}
                          <tr className="border-t-2 border-cp-cyan bg-cp-gray/30 font-bold">
                            <td className="px-3 py-2 text-cp-yellow" colSpan={3}>TOTAL</td>
                            <td className="px-3 py-2 text-right text-cp-yellow">₹{totals.cash}</td>
                            <td className="px-3 py-2 text-right text-cp-yellow">₹{totals.card}</td>
                            <td className="px-3 py-2 text-right text-cp-yellow">₹{totals.bank}</td>
                            <td className="px-3 py-2 text-right text-cp-yellow">₹{totals.upi}</td>
                            <td className="px-3 py-2 text-right text-cp-yellow">₹{totals.other}</td>
                            <td className="px-3 py-2 text-cp-cyan" colSpan={2}>Grand Total: ₹{grandTotal}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'Day Use' && (
                <div>
                  {!fromDate || !toDate ? (
                    <p className="text-gray-400">Select date range to view report</p>
                  ) : loading ? (
                    <p className="text-gray-400">Loading...</p>
                  ) : dayUseData.length === 0 ? (
                    <p className="text-gray-400">No data for selected date range</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-cp-gray/40">
                          <tr>
                            <th className="px-3 py-2 text-left text-cp-yellow">Date</th>
                            <th className="px-3 py-2 text-right text-cp-yellow">Total Bookings</th>
                            <th className="px-3 py-2 text-right text-cp-yellow">Total Revenue</th>
                            <th className="px-3 py-2 text-right text-cp-yellow">Total Hours</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dayUseData.map((d: any) => (
                            <tr key={d.date} className="border-t border-cp-cyan/20">
                              <td className="px-3 py-2 text-white">{d.date}</td>
                              <td className="px-3 py-2 text-right text-white">{d.bookings}</td>
                              <td className="px-3 py-2 text-right text-white">₹{d.revenue}</td>
                              <td className="px-3 py-2 text-right text-white">{d.hours}h</td>
                            </tr>
                          ))}
                          <tr className="border-t-2 border-cp-cyan bg-cp-gray/30 font-bold">
                            <td className="px-3 py-2 text-cp-yellow">TOTAL</td>
                            <td className="px-3 py-2 text-right text-cp-yellow">{dayUseData.reduce((s, d) => s + d.bookings, 0)}</td>
                            <td className="px-3 py-2 text-right text-cp-yellow">₹{dayUseData.reduce((s, d) => s + d.revenue, 0)}</td>
                            <td className="px-3 py-2 text-right text-cp-yellow">{dayUseData.reduce((s, d) => s + d.hours, 0)}h</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'Customer' && (
                <div>
                  <div className="mb-4">
                    <input
                      type="text"
                      placeholder="Search by name or phone..."
                      value={customerSearch}
                      onChange={(e) => setCustomerSearch(e.target.value)}
                      className="bg-cp-gray/40 border border-cp-cyan/30 rounded px-3 py-2 text-white w-64"
                    />
                  </div>
                  {!fromDate || !toDate ? (
                    <p className="text-gray-400">Select date range to view report</p>
                  ) : loading ? (
                    <p className="text-gray-400">Loading...</p>
                  ) : customerData.length === 0 ? (
                    <p className="text-gray-400">No data for selected criteria</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-cp-gray/40">
                          <tr>
                            <th className="px-3 py-2 text-left text-cp-yellow">Name</th>
                            <th className="px-3 py-2 text-left text-cp-yellow">Phone</th>
                            <th className="px-3 py-2 text-right text-cp-yellow">Cash</th>
                            <th className="px-3 py-2 text-right text-cp-yellow">Card</th>
                            <th className="px-3 py-2 text-right text-cp-yellow">Bank</th>
                            <th className="px-3 py-2 text-right text-cp-yellow">UPI</th>
                            <th className="px-3 py-2 text-right text-cp-yellow">Total</th>
                            <th className="px-3 py-2 text-right text-cp-yellow">Hours</th>
                            <th className="px-3 py-2 text-left text-cp-yellow">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {customerData.map((c: any) => (
                            <tr key={c.id} className="border-t border-cp-cyan/20">
                              <td className="px-3 py-2 text-white">{c.name}</td>
                              <td className="px-3 py-2 text-white">{c.phone}</td>
                              <td className="px-3 py-2 text-right text-white">₹{c.cash}</td>
                              <td className="px-3 py-2 text-right text-white">₹{c.card}</td>
                              <td className="px-3 py-2 text-right text-white">₹{c.bank}</td>
                              <td className="px-3 py-2 text-right text-white">₹{c.upi}</td>
                              <td className="px-3 py-2 text-right text-cp-cyan font-bold">₹{c.total}</td>
                              <td className="px-3 py-2 text-right text-white">{c.hours}h</td>
                              <td className="px-3 py-2">
                                <button onClick={() => setBookingModal({userId: c.id, name: c.name})} className="text-cp-cyan hover:underline text-xs mr-2">Bookings</button>
                                <button onClick={() => setReceiptModal({userId: c.id, name: c.name})} className="text-cp-yellow hover:underline text-xs">Receipts</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

            </div>

            {/* Receipt Modal */}
            {receiptModal && (
              <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={() => setReceiptModal(null)}>
                <div className="bg-cp-gray border border-cp-cyan/30 rounded-lg p-6 max-w-2xl w-full max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-xl font-bold text-cp-yellow">Receipts - {receiptModal.name}</h3>
                    <button onClick={() => setReceiptModal(null)} className="text-gray-400 hover:text-white text-2xl">&times;</button>
                  </div>
                  <table className="w-full text-sm">
                    <thead className="bg-cp-gray/40">
                      <tr>
                        <th className="px-3 py-2 text-left text-cp-yellow">Date</th>
                        <th className="px-3 py-2 text-left text-cp-yellow">Station</th>
                        <th className="px-3 py-2 text-right text-cp-yellow">Amount</th>
                        <th className="px-3 py-2 text-left text-cp-yellow">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reportData.filter(b => b.user_id === receiptModal.userId).map((b: any) => (
                        <tr key={b.id} className="border-t border-cp-cyan/20">
                          <td className="px-3 py-2 text-white">{new Date(b.start_at).toLocaleDateString()}</td>
                          <td className="px-3 py-2 text-white">{b.stations?.name || 'N/A'}</td>
                          <td className="px-3 py-2 text-right text-white">₹{b.amount_paid || b.total_amount || 0}</td>
                          <td className="px-3 py-2"><button onClick={() => admin.generateReceipt(b.id)} className="bg-cp-cyan text-cp-black px-2 py-1 rounded text-xs hover:bg-cp-yellow">View</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Booking History Modal */}
            {bookingModal && (
              <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={() => setBookingModal(null)}>
                <div className="bg-cp-gray border border-cp-cyan/30 rounded-lg p-6 max-w-3xl w-full max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-xl font-bold text-cp-yellow">Booking History - {bookingModal.name}</h3>
                    <button onClick={() => setBookingModal(null)} className="text-gray-400 hover:text-white text-2xl">&times;</button>
                  </div>
                  <table className="w-full text-sm">
                    <thead className="bg-cp-gray/40">
                      <tr>
                        <th className="px-3 py-2 text-left text-cp-yellow">Date</th>
                        <th className="px-3 py-2 text-left text-cp-yellow">Station</th>
                        <th className="px-3 py-2 text-right text-cp-yellow">Amount</th>
                        <th className="px-3 py-2 text-left text-cp-yellow">Payment</th>
                        <th className="px-3 py-2 text-left text-cp-yellow">Start</th>
                        <th className="px-3 py-2 text-left text-cp-yellow">End</th>
                        <th className="px-3 py-2 text-right text-cp-yellow">Playtime</th>
                        <th className="px-3 py-2 text-left text-cp-yellow">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reportData.filter(b => b.user_id === bookingModal.userId).map((b: any) => (
                        <tr key={b.id} className="border-t border-cp-cyan/20">
                          <td className="px-3 py-2 text-white">{new Date(b.start_at).toLocaleDateString()}</td>
                          <td className="px-3 py-2 text-white">{b.stations?.name || 'N/A'}</td>
                          <td className="px-3 py-2 text-right text-white">₹{b.amount_paid || b.total_amount || 0}</td>
                          <td className="px-3 py-2 text-white">{b.payment_method || '-'}</td>
                          <td className="px-3 py-2 text-white">{new Date(b.start_at).toLocaleTimeString()}</td>
                          <td className="px-3 py-2 text-white">{b.end_at ? new Date(b.end_at).toLocaleTimeString() : '-'}</td>
                          <td className="px-3 py-2 text-right text-white">{b.start_at && b.end_at ? (() => { const mins = Math.round((new Date(b.end_at).getTime() - new Date(b.start_at).getTime()) / 60000); return mins >= 60 ? `${Math.floor(mins/60)}h ${mins%60}m` : `${mins}m` })() : '-'}</td>
                          <td className="px-3 py-2 text-white">{b.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </AdminGuard>
  )
}

