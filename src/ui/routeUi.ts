import { routePath, ROUTE_COLORS, type RouteKind, type RoutePath, type RouteStop } from '../core/routes'
import { store } from '../core/store'

/** Черновик маршрута в панели (ещё не сохранён в документ). */
export interface RouteDraftUi {
  id?: number
  kind: RouteKind
  ref: string
  name: string
  colour: string
  stops: RouteStop[]
}

/**
 * Общее состояние «Маршрутов» для панели и карты: какой маршрут показан, черновик, режим выбора остановок кликом.
 * Путь черновика/маршрута пересчитывается только при изменении остановок или дорог.
 */
class RouteUi {
  selected: number | undefined
  draft: RouteDraftUi | undefined
  picking = false
  private v = 0
  private listeners = new Set<() => void>()
  private cache: { key: string; path: RoutePath } | undefined

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  getVersion = () => this.v
  private changed() { this.v++; this.listeners.forEach((l) => l()) }

  select(id: number | undefined) { this.selected = id; this.changed() }
  edit(draft: RouteDraftUi | undefined) { this.draft = draft; this.picking = !!draft && draft.stops.length < 2; this.changed() }
  update(patch: Partial<RouteDraftUi>) { if (this.draft) { this.draft = { ...this.draft, ...patch }; this.changed() } }
  setPicking(on: boolean) { this.picking = on; this.changed() }

  newDraft(kind: RouteKind, colourIndex: number): RouteDraftUi {
    return { kind, ref: '', name: '', colour: ROUTE_COLORS[colourIndex % ROUTE_COLORS.length], stops: [] }
  }

  addStop(stop: RouteStop) {
    if (!this.draft) return
    if (this.draft.stops.at(-1)?.node === stop.node) return // повторный клик по той же остановке
    this.update({ stops: [...this.draft.stops, stop] })
  }

  /** Путь, который показывать на карте: черновика (если редактируем) или выбранного маршрута. */
  path(stops: RouteStop[] | undefined, kind: RouteKind | undefined): RoutePath | undefined {
    if (!stops || !kind || stops.length < 2) return undefined
    const key = `${store.docVersion}|${kind}|${stops.map((s) => s.node).join(',')}`
    if (this.cache?.key === key) return this.cache.path
    const path = routePath(store.doc, kind, stops.map((s) => s.node))
    this.cache = { key, path }
    return path
  }
}

export const routeUi = new RouteUi()
