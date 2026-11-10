/**
 * Оформление карты для светлой и тёмной («центр управления») темы.
 * Интерфейс берёт цвета из CSS-переменных (styles.css), а карта на canvas — отсюда.
 */
export type Theme = 'light' | 'dark'

export interface MapPalette {
  mapBg: string
  /** фильтр для растровой подложки: в тёмной теме OSM-тайлы инвертируются и приглушаются */
  tileFilter: string
  tileOverlay: string
  asphalt: string
  nodeFill: string
  nodeStroke: string
  labelBg: string
  labelBorder: string
  labelText: string
  text: string
  textHalo: string
  tram: string
  tramTies: string
  stop: string
  /** светящиеся магистрали */
  glow: boolean
  road: (highway: string | undefined) => string
}

const LIGHT_ROADS: Record<string, string> = {
  motorway: '#e0605a', trunk: '#e0605a', primary: '#e89a3c', primary_link: '#e89a3c',
  secondary: '#d9c441', secondary_link: '#d9c441', tertiary: '#6aa84f', tertiary_link: '#6aa84f',
  residential: '#4a6fa5', unclassified: '#4a6fa5', living_street: '#4a6fa5', service: '#7b8794',
}
const DARK_ROADS: Record<string, string> = {
  motorway: '#fb7185', trunk: '#fb7185', primary: '#f59e0b', primary_link: '#f59e0b',
  secondary: '#facc15', secondary_link: '#facc15', tertiary: '#4ade80', tertiary_link: '#4ade80',
  residential: '#60a5fa', unclassified: '#60a5fa', living_street: '#60a5fa', service: '#64748b',
}
const PED = new Set(['footway', 'steps', 'path', 'pedestrian', 'cycleway', 'crossing'])

export const PALETTES: Record<Theme, MapPalette> = {
  light: {
    mapBg: '#f4f1ea', tileFilter: 'none', tileOverlay: 'rgba(255,255,255,0.35)', asphalt: '#59626f',
    nodeFill: '#ffffff', nodeStroke: '#444444', labelBg: 'rgba(255,255,255,0.94)', labelBorder: '#9fb3c8', labelText: '#1f3b57',
    text: '#1f3b57', textHalo: '#ffffff', tram: '#4b4f56', tramTies: '#f2f2f2', stop: '#155aa8', glow: false,
    road: (hw) => (hw && PED.has(hw) ? '#b5838d' : LIGHT_ROADS[hw ?? ''] ?? '#9aa0a6'),
  },
  dark: {
    mapBg: '#070d18', tileFilter: 'invert(1) hue-rotate(180deg) brightness(0.62) contrast(1.15) saturate(0.35)',
    tileOverlay: 'rgba(7,13,24,0.45)', asphalt: '#1b2536',
    nodeFill: '#0b1324', nodeStroke: '#94a3b8', labelBg: 'rgba(15,23,42,0.92)', labelBorder: '#334155', labelText: '#cbd5e1',
    text: '#cbd5e1', textHalo: '#070d18', tram: '#9ca3af', tramTies: '#111827', stop: '#38bdf8', glow: true,
    road: (hw) => (hw && PED.has(hw) ? '#a78bfa' : DARK_ROADS[hw ?? ''] ?? '#94a3b8'),
  },
}

/** Классы, которые в тёмной теме подсвечиваются (неоновое свечение). */
export const GLOW_CLASSES = new Set(['motorway', 'trunk', 'primary', 'primary_link', 'secondary', 'secondary_link'])

const KEY = 'uds-theme'
export function loadTheme(): Theme {
  try { return (window.localStorage.getItem(KEY) as Theme) || 'dark' } catch { return 'dark' }
}
export function saveTheme(t: Theme) {
  try { window.localStorage.setItem(KEY, t) } catch { /* приватный режим — не критично */ }
}
