import { project } from './geo'
import { buildGraph, type GEdge, type RoadGraph } from './graph'
import { SUMO_DEFAULT_KMH, hasSignal, laneInfo, speedLimit } from './roads'
import { defaultPlan, isGreenAt, readPlan, type SignalPlan } from './signals'
import type { OsmDocument } from './types'

/**
 * ДЕМО-ДВИЖЕНИЕ для наглядности (не замена SUMO).
 * Машины едут по транспортному графу (с учётом oneway), разгоняются до ограничения скорости дороги,
 * держат дистанцию до впереди идущей и на перекрёстках выбирают следующее ребро случайно.
 * На светофорах стоят на красный по плану регулирования (если плана нет — по плану по умолчанию).
 */

export interface Vehicle {
  id: number
  edge: number
  /** пройдено по ребру, м */
  s: number
  /** скорость, м/с */
  v: number
  /** личный множитель желаемой скорости (водители разные) */
  pace: number
  next: number | undefined
  /** полоса на ребре: 0 — ближняя к оси дороги (левая по ходу), дальше — правее */
  lane: number
  /** полоса, в которую машина встанет на следующем ребре */
  nextLane: number
  /** оттенок цвета кузова */
  hue: number
}

export type LightState = 'green' | 'yellow' | 'red'

interface EdgeGeom {
  pts: { lat: number; lon: number; x: number; y: number }[]
  cum: number[]
  len: number
  vmax: number
  /** смещение центра каждой полосы от оси дороги, м (вправо по ходу — плюс) */
  lanes: number[]
}

const LANE_W = 3.2

/**
 * Полосы ребра по ходу движения. Правостороннее движение: встречные полосы — слева от осевой.
 * Ось way: слева (по ходу way) lanes:backward полос, справа — lanes:forward; для односторонней — все полосы в одну сторону.
 */
export function laneOffsets(total: number, twoWay: boolean, centerAfter: number | null, forward: boolean): number[] {
  const W = total * LANE_W
  if (!twoWay) return Array.from({ length: total }, (_, j) => -W / 2 + (j + 0.5) * LANE_W)
  if (total === 1) return [forward ? LANE_W / 4 : LANE_W / 4] // узкая двусторонняя: каждый у своего края
  const B = centerAfter ?? Math.floor(total / 2) // полос слева от осевой (по ходу way)
  const axis = -W / 2 + B * LANE_W // положение осевой (вправо по ходу way — плюс)
  const n = forward ? total - B : B
  // j = 0 — полоса у осевой; по ходу движения это самая левая
  return Array.from({ length: Math.max(1, n) }, (_, j) => (forward ? axis + (j + 0.5) * LANE_W : -(axis - (j + 0.5) * LANE_W)))
}

const CAR = 4.5 // длина машины, м
const GAP = 2.5 // минимальный зазор, м
const ACC = 2.0 // разгон, м/с²
const DEC = 4.5 // комфортное торможение, м/с²
const HEADWAY = 1.2 // интервал безопасности, с

/** Детерминированный генератор случайных чисел (одинаковый результат при одинаковом зерне). */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class TrafficSim {
  readonly graph: RoadGraph
  readonly edges: GEdge[]
  readonly vehicles: Vehicle[] = []
  /** время моделирования, с */
  t = 0
  private geom: EdgeGeom[] = []
  private outOf = new Map<number, number[]>() // узел → индексы исходящих рёбер
  private plans = new Map<number, { plan: SignalPlan; group: Map<string, number> }>()
  private random: () => number

  constructor(private doc: OsmDocument, count: number, seed = 1) {
    this.random = rng(seed)
    this.graph = buildGraph(doc)
    this.edges = this.graph.edges.filter((e) => e.length > 1)
    this.edges.forEach((e, i) => {
      const pts = e.nodes.map((id) => doc.nodes.get(id)!).map((n) => ({ lat: n.lat, lon: n.lon, ...project(n.lat, n.lon) }))
      const cum = [0]
      for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + (e.length * (Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y))) / this.mercLen(pts))
      const way = doc.ways.get(e.wayId)!
      const sp = speedLimit(way)
      const kmh = sp.kmh ?? SUMO_DEFAULT_KMH[way.tags.highway ?? ''] ?? 50
      const li = laneInfo(way)
      const forward = e.id.endsWith(':f')
      const lanes = li ? laneOffsets(li.total, li.twoWay, li.centerAfter, forward) : [0]
      this.geom.push({ pts, cum, len: e.length, vmax: Math.max(10, Math.min(kmh, 110)) / 3.6, lanes })
      if (!this.outOf.has(e.from)) this.outOf.set(e.from, [])
      this.outOf.get(e.from)!.push(i)
    })
    // светофоры: свой план или план по умолчанию
    for (const n of doc.nodes.values()) {
      if (!hasSignal(n.tags) || !this.graph.nodes.has(n.id)) continue
      const plan = readPlan(n.tags) ?? defaultPlan(doc, n.id)
      const group = new Map<string, number>()
      plan.groups.forEach((g, gi) => g.turns.forEach((k) => group.set(k, gi)))
      this.plans.set(n.id, { plan, group })
    }
    this.spawn(count)
  }

  private mercLen(pts: { x: number; y: number }[]) {
    let l = 0
    for (let k = 1; k < pts.length; k++) l += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y)
    return l || 1
  }

  /** Расставить машины по рёбрам пропорционально длине, без наложений. */
  private spawn(count: number) {
    const total = this.geom.reduce((a, g) => a + g.len, 0)
    if (!total || !this.edges.length) return
    let id = 0
    for (let tries = 0; this.vehicles.length < count && tries < count * 20; tries++) {
      let r = this.random() * total, edge = 0
      while (edge < this.geom.length - 1 && r > this.geom[edge].len) { r -= this.geom[edge].len; edge++ }
      const s = this.random() * this.geom[edge].len
      const lane = Math.floor(this.random() * this.geom[edge].lanes.length)
      if (this.vehicles.some((v) => v.edge === edge && v.lane === lane && Math.abs(v.s - s) < CAR + GAP * 2)) continue
      this.vehicles.push({ id: id++, edge, s, v: 0, pace: 0.85 + this.random() * 0.2, next: undefined, lane, nextLane: 0, hue: Math.floor(this.random() * 360) })
    }
    for (const v of this.vehicles) this.planNext(v)
  }

  /** Выбрать следующее ребро и полосу на нём (по возможности ту же по счёту). */
  private planNext(v: Vehicle) {
    v.next = this.chooseNext(v.edge)
    if (v.next === undefined) { v.nextLane = 0; return }
    const n = this.geom[v.next].lanes.length
    // на более широкой дороге иногда перестраиваемся в случайную полосу, иначе держим свою
    v.nextLane = v.lane < n && this.random() < 0.7 ? v.lane : Math.floor(this.random() * n)
  }

  /** Следующее ребро: случайное из разрешённых, без разворота (если есть выбор). */
  private chooseNext(edge: number): number | undefined {
    const e = this.edges[edge]
    const outs = this.outOf.get(e.to) ?? []
    const noUturn = outs.filter((o) => !(this.edges[o].wayId === e.wayId && this.edges[o].to === e.from))
    const list = noUturn.length ? noUturn : outs
    return list.length ? list[Math.floor(this.random() * list.length)] : undefined
  }

  /** Ключ направления «дорога±>дорога±» — как в планах светофоров. */
  static turnKey(a: GEdge, b: GEdge) {
    return `${a.wayId}${a.id.endsWith(':f') ? '+' : '-'}>${b.wayId}${b.id.endsWith(':f') ? '+' : '-'}`
  }

  /** Сигнал для проезда с ребра a на ребро b (в момент t). Нерегулируемое — зелёный. */
  light(a: number, b: number | undefined, t = this.t): LightState {
    const ea = this.edges[a]
    const sig = this.plans.get(ea.to)
    if (!sig || b === undefined) return 'green'
    const gi = sig.group.get(TrafficSim.turnKey(ea, this.edges[b]))
    if (gi === undefined) return 'green'
    const { plan } = sig
    const g = plan.groups[gi]
    const local = (((t - plan.offset) % plan.cycle) + plan.cycle) % plan.cycle
    if (isGreenAt(g, plan.cycle, local)) return 'green'
    const sinceEnd = (((local - g.end) % plan.cycle) + plan.cycle) % plan.cycle
    return sinceEnd < plan.yellow ? 'yellow' : 'red'
  }

  /** Узлы со светофорами (для отрисовки стоп-линий). */
  signalNodes(): number[] { return [...this.plans.keys()] }

  /**
   * Сигналы на подходах ко всем светофорам: точка у стоп-линии и цвет
   * (зелёный, если хоть одно направление с этого подхода открыто).
   */
  approachLights(): { lat: number; lon: number; state: LightState }[] {
    if (!this.approaches) {
      // подходы к светофорам и точки стоп-линий не меняются — считаем один раз
      this.approaches = []
      this.edges.forEach((e, i) => {
        if (!this.plans.has(e.to)) return
        const outs = (this.outOf.get(e.to) ?? []).filter((o) => !(this.edges[o].wayId === e.wayId && this.edges[o].to === e.from))
        const p = this.position({ id: -1, edge: i, s: Math.max(0, this.geom[i].len - 5), v: 0, pace: 1, next: undefined, lane: 0, nextLane: 0, hue: 0 })
        this.approaches!.push({ edge: i, outs, lat: p.lat, lon: p.lon })
      })
    }
    return this.approaches.map((a) => {
      const states = a.outs.map((o) => this.light(a.edge, o))
      const state: LightState = states.includes('green') ? 'green' : states.includes('yellow') ? 'yellow' : 'red'
      return { lat: a.lat, lon: a.lon, state }
    })
  }
  private approaches: { edge: number; outs: number[]; lat: number; lon: number }[] | undefined

  /** Шаг моделирования на dt секунд. */
  step(dt: number) {
    // машины по рёбрам, по возрастанию пройденного пути
    // машины по полосам рёбер, по возрастанию пройденного пути
    const key = (edge: number, lane: number) => edge * 16 + lane
    const onEdge = new Map<number, Vehicle[]>()
    for (const v of this.vehicles) {
      const k = key(v.edge, v.lane)
      if (!onEdge.has(k)) onEdge.set(k, [])
      onEdge.get(k)!.push(v)
    }
    for (const list of onEdge.values()) list.sort((a, b) => a.s - b.s)

    for (const list of onEdge.values()) {
      for (let i = 0; i < list.length; i++) {
        const v = list[i]
        const g = this.geom[v.edge]
        const vmax = g.vmax * v.pace
        // препятствие впереди: машина на этом ребре или первая на следующем
        let obstacle = Infinity
        if (i + 1 < list.length) obstacle = list[i + 1].s - CAR
        else if (v.next !== undefined) {
          const ahead = onEdge.get(key(v.next, v.nextLane))
          if (ahead?.length) obstacle = g.len + ahead[0].s - CAR
        }
        // стоп-линия на красный / жёлтый (если ещё успеваем остановиться)
        const light = this.light(v.edge, v.next)
        const toLine = g.len - v.s - 1
        if (v.next === undefined) obstacle = Math.min(obstacle, g.len + 50) // тупик: развернёмся в конце
        if (light === 'red' || (light === 'yellow' && toLine > (v.v * v.v) / (2 * DEC))) obstacle = Math.min(obstacle, v.s + Math.max(0, toLine))
        const gap = obstacle - v.s - GAP
        // безопасная скорость: успеть остановиться до препятствия
        const vSafe = gap <= 0 ? 0 : Math.min(gap / HEADWAY, Math.sqrt(2 * DEC * gap))
        const target = Math.min(vmax, vSafe)
        v.v = target > v.v ? Math.min(target, v.v + ACC * dt) : Math.max(target, v.v - DEC * 2 * dt)
        v.s += v.v * dt
      }
    }
    // переход на следующее ребро
    for (const v of this.vehicles) {
      while (v.s >= this.geom[v.edge].len) {
        const over = v.s - this.geom[v.edge].len
        const next = v.next ?? this.uturnOrRespawn(v)
        v.lane = v.next !== undefined ? Math.min(v.nextLane, this.geom[next].lanes.length - 1) : Math.floor(this.random() * this.geom[next].lanes.length)
        v.edge = next
        v.s = over
        this.planNext(v)
      }
    }
    this.t += dt
  }

  /** Тупик: разворот, если он есть, иначе машина появляется в случайном месте сети. */
  private uturnOrRespawn(v: Vehicle): number {
    const e = this.edges[v.edge]
    const back = (this.outOf.get(e.to) ?? []).find((o) => this.edges[o].to === e.from && this.edges[o].wayId === e.wayId) ?? -1
    if (back >= 0) return back
    v.v = 0
    return Math.floor(this.random() * this.edges.length)
  }

  /** Положение машины: координаты и курс (радианы, Меркатор: восток = 0, север = π/2). */
  position(v: Vehicle): { lat: number; lon: number; x: number; y: number; heading: number; a: number; b: number; t: number; offset: number } {
    const g = this.geom[v.edge]
    const s = Math.min(v.s, g.len)
    let k = 1
    while (k < g.cum.length - 1 && g.cum[k] < s) k++
    const a = g.pts[k - 1], b = g.pts[k]
    const seg = g.cum[k] - g.cum[k - 1]
    const t = seg > 0 ? (s - g.cum[k - 1]) / seg : 0
    const ids = this.edges[v.edge].nodes
    const lanes = g.lanes
    return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, heading: Math.atan2(b.y - a.y, b.x - a.x), a: ids[k - 1], b: ids[k], t, offset: lanes[Math.min(v.lane, lanes.length - 1)] ?? 0 }
  }

  /** Ограничение скорости ребра, м/с. */
  vmax(edge: number) { return this.geom[edge].vmax }

  stats() {
    const n = this.vehicles.length
    const avg = n ? this.vehicles.reduce((a, v) => a + v.v, 0) / n : 0
    return { count: n, avgKmh: avg * 3.6, stopped: this.vehicles.filter((v) => v.v < 0.5).length, time: this.t }
  }
}
