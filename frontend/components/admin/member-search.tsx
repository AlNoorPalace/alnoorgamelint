'use client'

import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api'

export interface Member { user_id: string; username: string; full_name: string; phone: string | null; email: string | null }

const field = 'w-full rounded border border-cp-cyan/30 bg-cp-black/50 px-3 py-2 text-white'

/** Type a username, name, email or phone; pick the member from the list. */
export function MemberSearch({ value, onChange, autoFocus }: { value: Member | null; onChange: (m: Member | null) => void; autoFocus?: boolean }) {
  const [text, setText] = useState('')
  const [results, setResults] = useState<Member[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const latest = useRef(0)

  useEffect(() => {
    const q = text.trim()
    if (q.length < 2) { setResults([]); setState('idle'); return }
    const id = ++latest.current // ignore answers that arrive after a newer keystroke
    setState('loading')
    const t = setTimeout(async () => {
      try {
        const res = await apiFetch(`/api/v1/admin/members/search?q=${encodeURIComponent(q)}`)
        if (!res.ok) throw new Error('search failed')
        const rows = (await res.json()) as Member[]
        if (id !== latest.current) return
        setResults(Array.isArray(rows) ? rows : [])
        setActive(0)
        setState('idle')
      } catch {
        if (id === latest.current) { setResults([]); setState('error') }
      }
    }, 250)
    return () => clearTimeout(t)
  }, [text])

  const pick = (m: Member) => { onChange(m); setText(''); setOpen(false) }

  if (value) {
    return (
      <div className="flex items-center justify-between gap-3 rounded border border-green-500/50 bg-green-900/20 px-3 py-2 text-white">
        <div className="min-w-0">
          <div className="truncate font-medium">{value.full_name} <span className="text-gray-400">@{value.username}</span></div>
          <div className="truncate text-xs text-gray-400">{[value.email, value.phone].filter(Boolean).join(' · ')}</div>
        </div>
        <button type="button" className="shrink-0 rounded bg-gray-600 px-2 py-1 text-xs hover:bg-gray-500" onClick={() => onChange(null)}>Change</button>
      </div>
    )
  }

  return (
    <div className="relative">
      <input
        className={field}
        value={text}
        autoFocus={autoFocus}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        placeholder="Search by username, email, name or phone"
        onChange={(e) => { setText(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
          else if (e.key === 'Enter' && open && results[active]) { e.preventDefault(); pick(results[active]) }
          else if (e.key === 'Escape') setOpen(false)
        }}
      />
      {open && text.trim().length >= 2 && (
        <ul role="listbox" className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded border border-cp-cyan/30 bg-cp-gray shadow-lg">
          {results.map((m, i) => (
            <li
              key={m.user_id}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); pick(m) }}
              onMouseEnter={() => setActive(i)}
              className={`cursor-pointer px-3 py-2 ${i === active ? 'bg-cp-cyan/20' : ''}`}
            >
              <div className="text-white">{m.full_name} <span className="text-gray-400">@{m.username}</span></div>
              <div className="text-xs text-gray-400">{[m.email, m.phone].filter(Boolean).join(' · ')}</div>
            </li>
          ))}
          {results.length === 0 && (
            <li className="px-3 py-2 text-sm text-gray-400">
              {state === 'loading' ? 'Searching…' : state === 'error' ? 'Search failed. Try again.' : 'No member found. Use "Guest" if they have no account.'}
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
