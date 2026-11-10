import { distanceM } from '../core/geo'
import { findCrossings } from '../core/crossings'
import { analyze, buildGraph, waysOfGroup, type RoadGraph } from '../core/graph'
import { MAXSPEED_KEYS, isDrivable, normalizedMaxspeed } from '../core/roads'
import { isBusPlatform, linkedStop } from '../core/stops'
import { checkPlan, readPlan, turnsAt } from '../core/signals'
import { isRouteRelation, readRoute, routePath } from '../core/routes'
import type { OsmDocument } from '../core/types'

/**
 * ВАЛИДАТОР. Принимает документ, возвращает список проблем.
 * Чтобы добавить проверку — напишите функцию (doc) => Issue[] и добавьте её в CHECKS.
 */

export type Severity = 'error' | 'warning'

/** Описание исправления проблемы. Применяется через applyFix (src/validate/fixes.ts). */
export type Fix =
  | { kind: 'delete-relation'; id: number }
  | { kind: 'merge-nodes'; keep: number; remove: number }
  | { kind: 'delete-ways'; ids: number[] }
  | { kind: 'link-stop'; platform: number; anchor: number }
  | { kind: 'rebuild-route'; id: number }
  | { kind: 'normalize-maxspeed'; wayIds: number[] }
  | { kind: 'make-junction'; a: number; b: number; lat: number; lon: number }

export interface Issue {
  /** уникальный ключ проблемы */
  id: string
  severity: Severity
  /** код для группировки и фильтров */
  code: string
  message: string
  nodeIds?: number[]
  wayIds?: number[]
  /** точка для подсветки на карте и перехода к проблеме */
  at?: { lat: number; lon: number }
  /** как исправить; если нет — проблему можно только показать или скрыть */
  fix?: Fix
  /** исправление безопасно и применяется кнопкой «Исправить автоматически» */
  auto?: boolean
}

/** Проверка получает документ и готовый транспортный граф (строится один раз на validate). */
type Check = (doc: OsmDocument, graph: RoadGraph) => Issue[]

/** way ссылается на узел, которого нет в файле (обрезка по рамке). */
const missingNodes: Check = (doc) => {
  const out: Issue[] = []
  for (const w of doc.ways.values()) {
    const missing = w.nodes.filter((n) => !doc.nodes.has(n))
    if (missing.length) {
      const first = w.nodes.map((n) => doc.nodes.get(n)).find(Boolean)
      out.push({
        id: `missing-nodes:${w.id}`, severity: 'error', code: 'missing-nodes', wayIds: [w.id],
        message: `Дорога ${w.id} ссылается на ${missing.length} несуществующих узлов`,
        at: first ? { lat: first.lat, lon: first.lon } : undefined,
      })
    }
  }
  return out
}

/**
 * Запрет поворота ссылается на объекты, которых нет в файле (SUMO: «unknown from-way»).
 * Маршруты общественного транспорта и поездов не проверяем: они обрезаются по рамке всегда,
 * к дорогам не относятся и при экспорте «только дороги» отбрасываются.
 */
const brokenRelations: Check = (doc) => {
  const out: Issue[] = []
  for (const r of doc.relations.values()) {
    if (r.tags.type !== 'restriction') continue
    const bad = r.members.filter((m) =>
      m.type === 'way' ? !doc.ways.has(m.ref) : m.type === 'node' ? !doc.nodes.has(m.ref) : !doc.relations.has(m.ref),
    )
    if (!bad.length) continue
    const node = r.members.filter((m) => m.type === 'node').map((m) => doc.nodes.get(m.ref)).find(Boolean)
    out.push({
      id: `broken-relation:${r.id}`, severity: 'error', code: 'broken-relation',
      message: `Запрет поворота ${r.id}${r.tags.restriction ? ' (' + r.tags.restriction + ')' : ''}: нет ${bad.length} из ${r.members.length} участников`,
      at: node ? { lat: node.lat, lon: node.lon } : undefined,
      fix: { kind: 'delete-relation', id: r.id }, auto: true,
    })
  }
  return out
}

/** Два разных узла почти в одной точке: «склеенный» перекрёсток или дубль. */
const duplicateNodes: Check = (doc) => {
  const out: Issue[] = []
  const used = new Set<number>()
  for (const w of doc.ways.values()) if (isDrivable(w)) for (const n of w.nodes) used.add(n)
  const cell = 0.00001 // ≈ 1 м
  const grid = new Map<string, number[]>()
  for (const id of used) {
    const n = doc.nodes.get(id)
    if (!n) continue
    const key = `${Math.round(n.lat / cell)}:${Math.round(n.lon / cell)}`
    ;(grid.get(key) ?? grid.set(key, []).get(key)!).push(id)
  }
  for (const ids of grid.values()) {
    if (ids.length < 2) continue
    const a = doc.nodes.get(ids[0])!
    const b = doc.nodes.get(ids[1])!
    if (distanceM(a.lat, a.lon, b.lat, b.lon) < 1) {
      out.push({
        id: `dup-nodes:${ids.join(',')}`, severity: 'warning', code: 'duplicate-nodes', nodeIds: ids,
        message: `Узлы ${ids.join(', ')} находятся в одной точке (<1 м) — возможно, перекрёсток не склеен`,
        at: { lat: a.lat, lon: a.lon },
        fix: { kind: 'merge-nodes', keep: ids[0], remove: ids[1] }, auto: true,
      })
    }
  }
  return out
}

/** Изолированные группы дорог для машин: не связаны с основной сетью. */
const isolatedComponents: Check = (doc) => {
  // union-find по узлам проезжих дорог
  const parent = new Map<number, number>()
  const find = (x: number): number => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    while (parent.get(x) !== r) { const nx = parent.get(x)!; parent.set(x, r); x = nx }
    return r
  }
  const wayOfRoot = new Map<number, number[]>()
  const drivable = [...doc.ways.values()].filter(isDrivable)
  for (const w of drivable) for (const n of w.nodes) if (!parent.has(n)) parent.set(n, n)
  for (const w of drivable) for (let i = 1; i < w.nodes.length; i++) parent.set(find(w.nodes[i]), find(w.nodes[0]))
  for (const w of drivable) {
    const r = find(w.nodes[0])
    ;(wayOfRoot.get(r) ?? wayOfRoot.set(r, []).get(r)!).push(w.id)
  }
  const groups = [...wayOfRoot.values()].sort((a, b) => b.length - a.length)
  if (groups.length < 2) return []
  const out: Issue[] = []
  // самая большая группа считается основной сетью, остальные — изолированные
  for (const wayIds of groups.slice(1)) {
    const w = doc.ways.get(wayIds[0])!
    const n = doc.nodes.get(w.nodes[0])
    out.push({
      id: `isolated:${wayIds[0]}`, severity: 'warning', code: 'isolated',
      message: `Изолированный участок из ${wayIds.length} дорог (первая: ${wayIds[0]}) не связан с основной сетью`,
      wayIds, at: n ? { lat: n.lat, lon: n.lon } : undefined,
      // удалять участок целиком — решение человека (это может быть реальный двор), поэтому не auto
      fix: { kind: 'delete-ways', ids: wayIds },
    })
  }
  return out
}

/**
 * Связность с учётом направлений (по транспортному графу):
 *  - ловушка: из основной сети въехать можно, выехать нельзя;
 *  - нет въезда: из этого участка можно выехать в сеть, попасть на него нельзя.
 * Для краёв карты (обрезка по рамке) это нормально, поэтому только предупреждение.
 */
const directedConnectivity: Check = (doc, g) => {
  const a = analyze(g)
  const out: Issue[] = []
  const emit = (groups: number[][], code: string, severity: Severity, text: (n: number) => string) => {
    for (const grp of groups) {
      const first = g.nodes.get(grp[0])!
      const wayIds = waysOfGroup(g, grp)
      out.push({
        id: `${code}:${grp[0]}`, severity, code, nodeIds: grp.slice(0, 20), wayIds,
        message: text(grp.length) + (wayIds[0] ? ` (дорога ${wayIds[0]})` : ''),
        at: { lat: first.lat, lon: first.lon },
      })
    }
  }
  emit(a.traps, 'trap', 'warning', (n) => `Ловушка: ${n} уз. — въехать можно, выехать нельзя (проверьте oneway)`)
  emit(a.noEntry, 'no-entry', 'warning', (n) => `Нет въезда: ${n} уз. — выехать можно, попасть сюда нельзя (проверьте oneway)`)
  return out
}

/**
 * TODO(валидатор): добавить проверки
 *  - пересечения дорог без общего узла (разорванные перекрёстки), кроме мостов (bridge/layer);
 *  - светофор не на перекрёстке; lanes vs turn:lanes; направление кольца;
 *  - way из одного узла или с повторяющимися подряд узлами.
 */
/**
 * Каждая автобусная остановка должна быть привязана к узлу дороги.
 * Исправление: привязать к ближайшему узлу дороги для машин (автоматически — если он ближе 40 м).
 */
const unlinkedStops: Check = (doc) => {
  const roadNodes: { id: number; lat: number; lon: number }[] = []
  const seen = new Set<number>()
  for (const w of doc.ways.values()) {
    if (!isDrivable(w)) continue
    for (const id of w.nodes) {
      const n = doc.nodes.get(id)
      if (n && !seen.has(id)) { seen.add(id); roadNodes.push(n) }
    }
  }
  // какие узлы уже заняты: опоры и места посадки привязанных остановок (считаем один раз)
  const anchors = new Set<number>(), platforms = new Set<number>()
  for (const r of doc.relations.values()) {
    const s = linkedStop(r)
    if (s) { anchors.add(s.anchor); platforms.add(s.platform) }
  }
  const out: Issue[] = []
  for (const n of doc.nodes.values()) {
    if (!isBusPlatform(n.tags) || platforms.has(n.id)) continue
    let best: { id: number; d: number } | undefined
    for (const r of roadNodes) {
      if (anchors.has(r.id)) continue
      const d = distanceM(n.lat, n.lon, r.lat, r.lon)
      if (!best || d < best.d) best = { id: r.id, d }
    }
    const name = n.tags.name ? ` «${n.tags.name}»` : ''
    out.push({
      id: `unlinked-stop:${n.id}`, severity: 'warning', code: 'unlinked-stop', nodeIds: [n.id],
      message: `Остановка${name} (узел ${n.id}) не привязана к узлу дороги` + (best ? ` — ближайший узел № ${best.id}, ${Math.round(best.d)} м` : ''),
      at: { lat: n.lat, lon: n.lon },
      fix: best ? { kind: 'link-stop', platform: n.id, anchor: best.id } : undefined,
      auto: !!best && best.d < 40,
    })
  }
  return out
}

/** Планы светофорного регулирования: конфликты, межзелёные, направления без группы. */
const signalPlans: Check = (doc) => {
  const out: Issue[] = []
  for (const n of doc.nodes.values()) {
    const plan = readPlan(n.tags)
    if (!plan) continue
    const problems = checkPlan(plan, turnsAt(doc, n.id))
    problems.forEach((p, i) => out.push({
      id: `signal-plan:${n.id}:${i}`, severity: p.level, code: 'signal-plan', nodeIds: [n.id],
      message: `Светофор ${n.id}: ${p.text}`, at: { lat: n.lat, lon: n.lon },
    }))
  }
  return out
}

/** Маршруты, созданные в редакторе: путь между остановками есть и совпадает с дорогами маршрута. */
const routes: Check = (doc) => {
  const out: Issue[] = []
  for (const r of doc.relations.values()) {
    if (!isRouteRelation(r) || r.tags['polyhack:route'] !== 'yes') continue
    const info = readRoute(doc, r)
    const path = routePath(doc, info.kind, info.stops.map((s) => s.node))
    const n = info.stops[0] && doc.nodes.get(info.stops[0].node)
    const at = n ? { lat: n.lat, lon: n.lon } : undefined
    const title = `Маршрут ${info.ref || r.id}`
    if (info.stops.some((s) => !doc.nodes.has(s.node))) {
      out.push({ id: `route-stop:${r.id}`, severity: 'error', code: 'route', message: `${title}: остановка удалена с карты`, at })
    } else if (path.broken.length) {
      out.push({ id: `route-broken:${r.id}`, severity: 'error', code: 'route', at,
        message: `${title}: нет пути между остановками ${path.broken.map((i) => `${i + 1}→${i + 2}`).join(', ')}` })
    } else if (path.ways.join(',') !== info.ways.join(',')) {
      out.push({ id: `route-stale:${r.id}`, severity: 'warning', code: 'route', at, fix: { kind: 'rebuild-route', id: r.id },
        message: `${title}: дороги изменились — маршрут стоит перестроить` })
    }
  }
  return out
}

/**
 * Ограничение скорости не числом (maxspeed=RU:urban, «60 km/h»): SUMO, MATSim и Webots числа читают надёжно,
 * а зоны — по-разному или никак. RU:urban → 60, RU:rural → 90, RU:motorway → 110, RU:living_street → 20.
 */
const numericMaxspeed: Check = (doc) => {
  const wayIds: number[] = []
  const seen = new Map<string, string>()
  for (const w of doc.ways.values()) {
    if (!isDrivable(w)) continue
    let bad = false
    for (const k of MAXSPEED_KEYS) {
      const n = normalizedMaxspeed(w.tags[k])
      if (n !== undefined) { bad = true; seen.set(w.tags[k], n) }
    }
    if (bad) wayIds.push(w.id)
  }
  if (!wayIds.length) return []
  const first = doc.ways.get(wayIds[0])!
  const n = doc.nodes.get(first.nodes[0])
  return [{
    id: 'maxspeed-nonnumeric', severity: 'warning', code: 'maxspeed-nonnumeric', wayIds,
    message: `Скорость задана не числом у ${wayIds.length} дорог: ${[...seen].map(([a, b]) => `${a} → ${b}`).join(', ')} км/ч`,
    at: n ? { lat: n.lat, lon: n.lon } : undefined,
    fix: { kind: 'normalize-maxspeed', wayIds }, auto: true,
  }]
}

/**
 * Разорванный перекрёсток: две дороги пересекаются без общего узла (на одном уровне, без моста/тоннеля).
 * Машины не смогут повернуть с одной на другую. Исправление не автоматическое: это может быть путепровод.
 */
const tornJunctions: Check = (doc) => {
  const nm = (id: number) => doc.ways.get(id)?.tags.name ?? `дорога ${id}`
  return findCrossings(doc).map((c) => ({
    id: `torn-junction:${c.a}-${c.b}`, severity: 'warning' as const, code: 'torn-junction', wayIds: [c.a, c.b],
    message: `Дороги «${nm(c.a)}» (${c.a}) и «${nm(c.b)}» (${c.b}) пересекаются без общего узла — перекрёсток не склеен? (если это путепровод, скройте)`,
    at: { lat: c.lat, lon: c.lon },
    fix: { kind: 'make-junction' as const, a: c.a, b: c.b, lat: c.lat, lon: c.lon },
  }))
}

const CHECKS: Check[] = [tornJunctions, numericMaxspeed, missingNodes, brokenRelations, duplicateNodes, isolatedComponents, directedConnectivity, unlinkedStops, signalPlans, routes]

export function validate(doc: OsmDocument): Issue[] {
  const graph = buildGraph(doc)
  return CHECKS.flatMap((c) => c(doc, graph))
}

/** Есть ли блокирующие ошибки (для проверки перед сохранением). */
export const hasErrors = (issues: Issue[]) => issues.some((i) => i.severity === 'error')
