'use client'

import { useState } from 'react'

/** Shares the page link: the phone's share sheet where there is one, otherwise copy, plus a WhatsApp shortcut. */
export function ShareButton({ title, text, path }: { title: string; text: string; path?: string }) {
  const [copied, setCopied] = useState(false)
  // `path` shares a fixed page (the admin screen shares the public page, not its own address)
  const url = () => (typeof window === 'undefined' ? '' : path ? `${window.location.origin}${path}` : window.location.href.split('#')[0])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url())
    } catch {
      window.prompt('Copy this link', url())
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const share = async () => {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, text, url: url() })
        return
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
      }
    }
    await copy()
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button onClick={share} className="rounded bg-cp-cyan px-4 py-2 font-semibold text-black hover:bg-cp-yellow">
        {copied ? 'Link copied ✓' : 'Share'}
      </button>
      <button onClick={copy} className="rounded bg-gray-700 px-4 py-2 font-semibold text-white hover:bg-gray-600">Copy link</button>
      <a
        href={`https://wa.me/?text=${encodeURIComponent(`${text} ${url()}`)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="rounded bg-green-700 px-4 py-2 font-semibold text-white hover:bg-green-600"
      >WhatsApp</a>
    </div>
  )
}
