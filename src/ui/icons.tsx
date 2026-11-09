import type { ReactNode } from 'react'

/** Небольшой набор линейных иконок (24×24, штрих currentColor). */
const paths: Record<string, ReactNode> = {
  select: <path d="M5 3l14 7-6 2-2 6L5 3z" />,
  road: <><path d="M4 20L10 4M20 20L14 4" /><path d="M12 6v3M12 12v3M12 18v2" /></>,
  node: <><circle cx="12" cy="12" r="3" /><path d="M3 12h6M15 12h6" /></>,
  undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h9a6 6 0 010 12h-3" /></>,
  redo: <><path d="M15 14l5-5-5-5" /><path d="M20 9h-9a6 6 0 000 12h3" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  fit: <><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></>,
  open: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />,
  save: <><path d="M5 4h11l3 3v13H5V4z" /><path d="M8 4v5h7V4M8 20v-6h8v6" /></>,
  signal: <><rect x="8" y="2.5" width="8" height="19" rx="3" /><circle cx="12" cy="7" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="12" cy="17" r="1.3" /></>,
  crossing: <><path d="M3 5v14M8 5v14M13 5v14M18 5v14M22 5v14" /></>,
  chevron: <path d="M6 9l6 6 6-6" />,
  layers: <><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" /></>,
  export: <><path d="M12 4v11M7 10l5 5 5-5" /><path d="M5 20h14" /></>,
}

export function Icon({ name, size = 18 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}
