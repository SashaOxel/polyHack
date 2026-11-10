import { distanceM, project } from './geo'
import { buildGraph } from './graph'
import { HIGHWAY_LABELS, isDrivable, onewayDirection } from './roads'
import type { OsmDocument, Tags } from './types'

/**
 * СВЕТОФОРНОЕ РЕГУЛИРОВАНИЕ (по схеме Visum).
 *
 *   светофорный узел  →  сигнальные группы  →  повороты (направления движения)
 *
 * Режим — фиксированное время: длительность цикла, для каждой группы момент включения и выключения
 * зелёного (секунды внутри цикла), жёлтый, межзелёный интервал между конфликтующими группами,
 * сдвиг фаз (offset) для «зелёной волны».
 *
 * План хранится тегами на узле светофора (polyhack:signal:*), поэтому сохраняется в .osm.
 * В SUMO переводится скриптом `npm run export:sumo` (см. sumoSignals.ts).
 */

// ---------- повороты ----------

export type TurnKind = 'left' | 'straight' | 'right'

/** Направление движения по дороге: '+' — по порядку узлов way, '-' — против (как у рёбер SUMO: «W#k» и «-W#k»). */
export type Dir = '+' | '-'

export interface Turn {
  /** ключ направления «дорога±>дорога±», например «123+>456-»; по нему направления входят в группы */
  key: string
  from: number
  fromDir: Dir
  to: number
  toDir: Dir
  kind: TurnKind
  /** подход: дорога и узел, с которого въезжают на перекрёсток */
  approach: string
  /** направление въезда и выезда (единичные векторы, Меркатор, y вверх) */
  inDir: { x: number; y: number }
  outDir: { x: number; y: number }
  fromName?: string
  toName?: string
}

export const turnKey = (from: number, fromDir: Dir, to: number, toDir: Dir) => `${from}${fromDir}>${to}${toDir}`

const KIND_RU: Record<TurnKind, string> = { left: 'налево', straight: 'прямо', right: 'направо' }

/** Подпись поворота для интерфейса: «ул. Лермонтова → ул. Чернышевского (налево)». */
export function turnLabel(t: Turn): string {
  const a = t.fromName ?? `дорога ${t.from}`, b = t.toName ?? `дорога ${t.to}`
  return a === b ? `${a}: ${KIND_RU[t.kind]}` : `${a} → ${b} (${KIND_RU[t.kind]})`
}

/**
 * Все разрешённые направления движения через узел: каждый въезд × каждый выезд, без разворотов,
 * с учётом односторонних дорог. Считается прямо по дорогам, поэтому работает и для светофора посреди улицы.
 */
export function turnsAt(doc: OsmDocument, nodeId: number): Turn[] {
  const center = doc.nodes.get(nodeId)
  if (!center) return []
  const c = project(center.lat, center.lon)
  const ins: { way: number; sign: Dir; prev: number; dir: { x: number; y: number }; name?: string }[] = []
  const outs: { way: number; sign: Dir; next: number; dir: { x: number; y: number }; name?: string }[] = []
  const unit = (dx: number, dy: number) => { const l = Math.hypot(dx, dy) || 1; return { x: dx / l, y: dy / l } }

  for (const w of doc.ways.values()) {
    if (!isDrivable(w)) continue
    const dir = onewayDirection(w)
    w.nodes.forEach((id, i) => {
      if (id !== nodeId) return
      const before = i > 0 ? doc.nodes.get(w.nodes[i - 1]) : undefined
      const after = i < w.nodes.length - 1 ? doc.nodes.get(w.nodes[i + 1]) : undefined
      // безымянная дорога подписывается классом: «Проезд 780751420»
      const name = w.tags.name ?? `${HIGHWAY_LABELS[w.tags.highway ?? ''] ?? 'Дорога'} ${w.id}`
      if (before) {
        const p = project(before.lat, before.lon)
        if (dir >= 0) ins.push({ way: w.id, sign: '+', prev: before.id, dir: unit(c.x - p.x, c.y - p.y), name })
        if (dir <= 0) outs.push({ way: w.id, sign: '-', next: before.id, dir: unit(p.x - c.x, p.y - c.y), name })
      }
      if (after) {
        const p = project(after.lat, after.lon)
        if (dir >= 0) outs.push({ way: w.id, sign: '+', next: after.id, dir: unit(p.x - c.x, p.y - c.y), name })
        if (dir <= 0) ins.push({ way: w.id, sign: '-', prev: after.id, dir: unit(c.x - p.x, c.y - p.y), name })
      }
    })
  }

  const turns = new Map<string, Turn>()
  for (const a of ins) {
    for (const b of outs) {
      if (a.way === b.way && a.prev === b.next) continue // разворот в обратную сторону той же дороги
      const cross = a.dir.x * b.dir.y - a.dir.y * b.dir.x
      const dot = a.dir.x * b.dir.x + a.dir.y * b.dir.y
      const angle = Math.atan2(cross, dot) // > 0 — поворот против часовой (налево)
      if (Math.abs(angle) > (150 * Math.PI) / 180) continue // разворот
      const kind: TurnKind = Math.abs(angle) < (30 * Math.PI) / 180 ? 'straight' : angle > 0 ? 'left' : 'right'
      const key = turnKey(a.way, a.sign, b.way, b.sign)
      if (!turns.has(key)) {
        turns.set(key, {
          key, from: a.way, fromDir: a.sign, to: b.way, toDir: b.sign, kind,
          approach: `${a.way}${a.sign}`, inDir: a.dir, outDir: b.dir, fromName: a.name, toName: b.name,
        })
      }
    }
  }
  return [...turns.values()]
}

// ---------- план ----------

export interface SignalGroup {
  name: string
  /** включение и выключение зелёного, секунды внутри цикла (может переходить через 0) */
  start: number
  end: number
  /** ключи направлений «from±>to±» */
  turns: string[]
}

export interface SignalPlan {
  cycle: number
  offset: number
  yellow: number
  intergreen: number
  groups: SignalGroup[]
}

const P = 'polyhack:signal:'
const MAX_TAG = 255

export const hasPlanTags = (t: Tags) => Object.keys(t).some((k) => k.startsWith(P))

/** Прочитать план из тегов узла (undefined, если плана нет или он повреждён). */
export function readPlan(tags: Tags): SignalPlan | undefined {
  const cycle = Number(tags[P + 'cycle'])
  if (!(cycle > 0)) return undefined
  const n = Number(tags[P + 'groups']) || 0
  const groups: SignalGroup[] = []
  for (let k = 1; k <= n; k++) {
    const head = tags[`${P}group:${k}`]
    if (!head) continue
    const [name, start, end] = head.split('|')
    let turnsText = tags[`${P}group:${k}:turns`] ?? ''
    for (let part = 2; tags[`${P}group:${k}:turns${part}`] !== undefined; part++) turnsText += ',' + tags[`${P}group:${k}:turns${part}`]
    groups.push({ name, start: Number(start) || 0, end: Number(end) || 0, turns: turnsText.split(',').filter(Boolean) })
  }
  return {
    cycle,
    offset: Number(tags[P + 'offset']) || 0,
    yellow: Number(tags[P + 'yellow']) || 3,
    intergreen: Number(tags[P + 'intergreen']) || 4,
    groups,
  }
}

/** Записать план в теги (старые теги плана заменяются). Значения тегов не длиннее 255 символов, как требует OSM. */
export function writePlan(tags: Tags, plan: SignalPlan | null): Tags {
  const out: Tags = {}
  for (const [k, v] of Object.entries(tags)) if (!k.startsWith(P)) out[k] = v
  if (!plan) return out
  const r = (x: number) => String(Math.round(x * 10) / 10)
  out[P + 'cycle'] = r(plan.cycle)
  out[P + 'offset'] = r(plan.offset)
  out[P + 'yellow'] = r(plan.yellow)
  out[P + 'intergreen'] = r(plan.intergreen)
  out[P + 'groups'] = String(plan.groups.length)
  plan.groups.forEach((g, i) => {
    const k = i + 1
    out[`${P}group:${k}`] = `${g.name.replace(/[|,]/g, ' ').slice(0, 200)}|${r(g.start)}|${r(g.end)}`
    // повороты — частями не длиннее 255 символов
    const parts: string[] = []
    let cur = ''
    for (const t of g.turns) {
      if (cur && cur.length + 1 + t.length > MAX_TAG) { parts.push(cur); cur = t } else cur = cur ? `${cur},${t}` : t
    }
    if (cur) parts.push(cur)
    parts.forEach((p, j) => { out[`${P}group:${k}:turns${j === 0 ? '' : j + 1}`] = p })
  })
  return out
}

const parallel = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(a.x * b.y - a.y * b.x) < Math.sin((40 * Math.PI) / 180) // одна ось (попутно или навстречу)

/**
 * План по умолчанию: подходы делятся на оси (попутные и встречные — вместе), каждая ось — своя группа,
 * цикл делится поровну, в конце каждой группы — межзелёный интервал.
 */
export function defaultPlan(doc: OsmDocument, nodeId: number, cycle = 60): SignalPlan {
  const turns = turnsAt(doc, nodeId)
  const axes: Turn[][] = []
  for (const t of turns) {
    const axis = axes.find((a) => parallel(a[0].inDir, t.inDir))
    if (axis) axis.push(t)
    else axes.push([t])
  }
  const intergreen = 4, yellow = 3
  const n = Math.max(1, axes.length)
  const span = cycle / n
  const groups = axes.map((axis, i) => {
    const names = [...new Set(axis.map((t) => t.fromName).filter(Boolean))]
    return {
      name: `Фаза ${i + 1}${names.length ? ': ' + names.join(' / ') : ''}`,
      start: Math.round(i * span),
      end: Math.round((i + 1) * span - intergreen),
      turns: axis.map((t) => t.key),
    }
  })
  return { cycle, offset: 0, yellow, intergreen, groups }
}

// ---------- расчёты и проверки ----------

/** Длительность зелёного, с (интервал может переходить через конец цикла). */
export function greenTime(g: SignalGroup, cycle: number): number {
  const d = ((g.end - g.start) % cycle + cycle) % cycle
  return d === 0 && g.end !== g.start ? cycle : d
}

/** Горит ли зелёный у группы в момент t (секунды внутри цикла). */
export function isGreenAt(g: SignalGroup, cycle: number, t: number): boolean {
  const rel = ((t - g.start) % cycle + cycle) % cycle
  return rel < greenTime(g, cycle)
}

/**
 * Равномерная задержка по Вебстеру (в духе HCM), с/авт: d = 0.5·C·(1 − g/C)² / (1 − x·g/C).
 * x — степень насыщения; интенсивность в OSM не хранится, поэтому берём типичную x = 0.8.
 */
export function websterDelay(green: number, cycle: number, x = 0.8): number {
  const l = Math.min(1, Math.max(0, green / cycle))
  return (0.5 * cycle * (1 - l) ** 2) / (1 - Math.min(0.99, x) * l)
}

/** Конфликтуют ли два направления (пересекаются или сливаются в одну дорогу). */
export function turnsConflict(a: Turn, b: Turn): boolean {
  if (a.approach === b.approach) return false
  // встречные подходы: левый поворот уступает встречным (разрешённый с уступкой) — не конфликт по фазам
  if (parallel(a.inDir, b.inDir)) return false
  if (a.kind === 'right' && b.kind === 'right') return false
  if (a.kind === 'right' || b.kind === 'right') return a.to === b.to && a.toDir === b.toDir
  return true
}

export interface PlanIssue { level: 'error' | 'warning'; text: string }

/** Проверка плана: все направления в группах, конфликтующие группы не горят вместе, межзелёные выдержаны. */
export function checkPlan(plan: SignalPlan, turns: Turn[]): PlanIssue[] {
  const out: PlanIssue[] = []
  const C = plan.cycle
  if (!(C >= 20 && C <= 240)) out.push({ level: 'warning', text: `Цикл ${C} с — обычно 30–150 с` })
  if (plan.yellow > plan.intergreen) out.push({ level: 'error', text: `Жёлтый (${plan.yellow} с) длиннее межзелёного (${plan.intergreen} с)` })
  const byKey = new Map(turns.map((t) => [t.key, t]))
  const assigned = new Set(plan.groups.flatMap((g) => g.turns))
  for (const t of turns) if (!assigned.has(t.key)) out.push({ level: 'error', text: `Направление без сигнальной группы: ${turnLabel(t)}` })
  for (const k of assigned) if (!byKey.has(k)) out.push({ level: 'warning', text: `Группа ссылается на направление, которого нет на перекрёстке (${k}) — дорога изменилась?` })
  for (const g of plan.groups) {
    const gt = greenTime(g, C)
    if (g.start < 0 || g.start >= C || g.end < 0 || g.end > C) out.push({ level: 'error', text: `«${g.name}»: время включения/выключения вне цикла 0–${C} с` })
    else if (gt < 5) out.push({ level: 'warning', text: `«${g.name}»: зелёный всего ${gt} с` })
  }
  // попарно: конфликт и межзелёный интервал
  for (let i = 0; i < plan.groups.length; i++) {
    for (let j = i + 1; j < plan.groups.length; j++) {
      const A = plan.groups[i], B = plan.groups[j]
      const conflict = A.turns.some((a) => B.turns.some((b) => byKey.has(a) && byKey.has(b) && turnsConflict(byKey.get(a)!, byKey.get(b)!)))
      if (!conflict) continue
      const gA = greenTime(A, C), gB = greenTime(B, C)
      const rel = ((B.start - A.start) % C + C) % C
      if (rel < gA || rel + gB > C) {
        out.push({ level: 'error', text: `Конфликт: «${A.name}» и «${B.name}» горят зелёным одновременно` })
        continue
      }
      const gapAB = ((B.start - (A.start + gA)) % C + C) % C
      const gapBA = ((A.start - (B.start + gB)) % C + C) % C
      for (const [gap, x, y] of [[gapAB, A, B], [gapBA, B, A]] as const) {
        if (gap < plan.intergreen) out.push({ level: 'error', text: `Межзелёный «${x.name}» → «${y.name}» ${gap} с, нужно ≥ ${plan.intergreen} с` })
      }
    }
  }
  return out
}

// ---------- зелёная волна ----------

/** Расстояние между двумя узлами по дорогам (кратчайший путь по транспортному графу), иначе по прямой. */
export function corridorDistance(doc: OsmDocument, a: number, b: number): { meters: number; byRoad: boolean } {
  const g = buildGraph(doc)
  if (g.nodes.has(a) && g.nodes.has(b)) {
    const dist = new Map<number, number>([[a, 0]])
    const done = new Set<number>()
    while (true) {
      let u: number | undefined, best = Infinity
      for (const [k, d] of dist) if (!done.has(k) && d < best) { best = d; u = k }
      if (u === undefined) break
      if (u === b) return { meters: best, byRoad: true }
      done.add(u)
      for (const e of g.nodes.get(u)!.out) {
        const nd = best + e.length
        if (nd < (dist.get(e.to) ?? Infinity)) dist.set(e.to, nd)
      }
    }
  }
  const na = doc.nodes.get(a), nb = doc.nodes.get(b)
  return { meters: na && nb ? distanceM(na.lat, na.lon, nb.lat, nb.lon) : 0, byRoad: false }
}

/**
 * Сдвиг фаз для «зелёной волны»: зелёный главной группы (первой) у этого светофора включается,
 * когда до него доезжает пачка машин, тронувшаяся на зелёный главной группы опорного светофора.
 *   offset = offset_опорного + время_в_пути + (начало_зелёного_опорного − начало_зелёного_этого)   (mod цикл)
 */
export function greenWaveOffset(ref: SignalPlan, plan: SignalPlan, meters: number, speedKmh: number): number {
  const travel = meters / (speedKmh / 3.6)
  const refStart = ref.groups[0]?.start ?? 0, myStart = plan.groups[0]?.start ?? 0
  const C = plan.cycle
  return Math.round((((ref.offset + travel + refStart - myStart) % C) + C) % C)
}

/** Цвета сигнальных групп (одинаковые в панели и на карте). */
export const GROUP_COLORS = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#65a30d', '#db2777']
