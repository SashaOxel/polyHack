import { XMLParser } from 'fast-xml-parser'
import { isGreenAt, readPlan, type SignalPlan } from './signals'
import type { OsmDocument } from './types'

/**
 * Перевод планов светофорного регулирования в программы светофоров SUMO (tlLogic).
 *
 * SUMO строит сеть сам (netconvert), поэтому порядок сигналов в светофоре (linkIndex) известен только
 * из готового net.xml. Берём оттуда соединения светофорного узла, сопоставляем каждое с направлением
 * плана по рёбрам («W#k» — по ходу way, «-W#k» — против), и для каждого отрезка цикла собираем строку
 * состояний: G — зелёный, g — зелёный с уступкой (левые повороты и развороты), y — жёлтый, r — красный.
 */

interface Conn { from: string; to: string; tl: string; linkIndex: number; dir: string }

export interface TlProgram {
  node: number
  tlId: string
  links: number
  phases: { duration: number; state: string }[]
  offset: number
  /** соединения, не нашедшие направления в плане (горят вместе со своим подходом или красным) */
  unmatched: number
}

/** «-123#4» → { way: 123, dir: '-' }; внутренние рёбра и пешеходные переходы — undefined. */
export function edgeToWay(edgeId: string): { way: number; dir: '+' | '-' } | undefined {
  if (edgeId.startsWith(':')) return undefined
  const m = /^(-?)(\d+)(?:#\d+)?$/.exec(edgeId)
  return m ? { way: Number(m[2]), dir: m[1] === '-' ? '-' : '+' } : undefined
}

const arr = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x])

/** Собрать программы для всех светофоров документа, у которых есть план. */
export function buildSumoSignals(doc: OsmDocument, netXml: string): { programs: TlProgram[]; xml: string; warnings: string[] } {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' })
  const net = parser.parse(netXml).net
  const edgeTo = new Map<string, string>()
  for (const e of arr<Record<string, string>>(net.edge)) edgeTo.set(e.id, e.to)
  const conns: Conn[] = arr<Record<string, string>>(net.connection)
    .filter((c) => c.tl !== undefined && c.linkIndex !== undefined)
    .map((c) => ({ from: c.from, to: c.to, tl: c.tl, linkIndex: Number(c.linkIndex), dir: c.dir ?? 's' }))

  const programs: TlProgram[] = []
  const warnings: string[] = []

  for (const node of doc.nodes.values()) {
    const plan = readPlan(node.tags)
    if (!plan) continue
    const nid = String(node.id)
    // соединения, въезжающие в этот узел (узел может войти в объединённый кластер SUMO — ищем по id в имени)
    const mine = conns.filter((c) => {
      const j = edgeTo.get(c.from) ?? ''
      return j === nid || j.split('_').includes(nid)
    })
    if (!mine.length) { warnings.push(`Узел ${nid}: в сети SUMO нет светофора (узел не стал регулируемым перекрёстком)`); continue }
    const tlId = mine[0].tl
    const all = conns.filter((c) => c.tl === tlId) // весь светофор (с кластером)
    const links = Math.max(...all.map((c) => c.linkIndex)) + 1

    // какая группа управляет каждым сигналом
    const groupOfKey = new Map<string, number>()
    plan.groups.forEach((g, gi) => g.turns.forEach((k) => groupOfKey.set(k, gi)))
    const groupOfApproach = new Map<string, number>()
    plan.groups.forEach((g, gi) => g.turns.forEach((k) => { const a = k.split('>')[0]; if (!groupOfApproach.has(a)) groupOfApproach.set(a, gi) }))
    const linkGroup: (number | undefined)[] = Array(links).fill(undefined)
    const linkYield: boolean[] = Array(links).fill(false)
    let unmatched = 0
    for (const c of all) {
      const f = edgeToWay(c.from), t = edgeToWay(c.to)
      const key = f && t ? `${f.way}${f.dir}>${t.way}${t.dir}` : undefined
      let gi = key !== undefined ? groupOfKey.get(key) : undefined
      if (gi === undefined) {
        // разворот SUMO добавляет сам, в плане их нет — он горит вместе со своим подходом (с уступкой) и ошибкой не считается
        if (c.dir !== 't') unmatched++
        if (f) gi = groupOfApproach.get(`${f.way}${f.dir}`) // хотя бы вместе со своим подходом
      }
      linkGroup[c.linkIndex] = gi
      linkYield[c.linkIndex] = c.dir === 'l' || c.dir === 'L' || c.dir === 't'
    }
    if (unmatched) warnings.push(`Узел ${nid}: ${unmatched} соединений SUMO не нашли направления в плане`)

    programs.push({ node: node.id, tlId, links, phases: phasesFor(plan, linkGroup, linkYield), offset: plan.offset, unmatched })
  }

  const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<additional>']
  for (const p of programs) {
    xml.push(`  <tlLogic id="${p.tlId}" type="static" programID="polyhack" offset="${p.offset}">`)
    for (const ph of p.phases) xml.push(`    <phase duration="${ph.duration}" state="${ph.state}"/>`)
    xml.push('  </tlLogic>')
  }
  xml.push('</additional>', '')
  return { programs, xml: xml.join('\n'), warnings }
}

/** Разбить цикл на отрезки между переключениями и собрать строку состояний для каждого. */
export function phasesFor(plan: SignalPlan, linkGroup: (number | undefined)[], linkYield: boolean[]) {
  const C = plan.cycle
  const cuts = new Set<number>([0])
  for (const g of plan.groups) {
    cuts.add(((g.start % C) + C) % C)
    cuts.add(((g.end % C) + C) % C)
    cuts.add((((g.end + plan.yellow) % C) + C) % C)
  }
  const times = [...cuts].sort((a, b) => a - b)
  const phases: { duration: number; state: string }[] = []
  times.forEach((t, i) => {
    const next = i + 1 < times.length ? times[i + 1] : C
    const duration = Math.round((next - t) * 10) / 10
    if (duration <= 0) return
    const mid = t + duration / 2
    const state = linkGroup.map((gi, li) => {
      if (gi === undefined) return 'r'
      const g = plan.groups[gi]
      if (isGreenAt(g, C, mid)) return linkYield[li] ? 'g' : 'G'
      const sinceEnd = ((mid - g.end) % C + C) % C
      return sinceEnd < plan.yellow ? 'y' : 'r'
    }).join('')
    // одинаковые соседние отрезки склеиваем
    if (phases.length && phases[phases.length - 1].state === state) phases[phases.length - 1].duration += duration
    else phases.push({ duration, state })
  })
  if (phases.length > 1 && phases[0].state === phases[phases.length - 1].state) {
    // отрезок, переходящий через конец цикла, — одна фаза (SUMO крутит программу по кругу)
    phases[phases.length - 1].duration += phases[0].duration
    phases.shift()
  }
  return phases.map((p) => ({ ...p, duration: Math.round(p.duration * 10) / 10 }))
}
