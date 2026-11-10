import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseOsm } from '../core/parse'
import { Store } from '../core/store'
import { validate } from './index'
import { applyAutoFixes, applyFix } from './fixes'

const load = () => {
  const s = new Store()
  s.load(parseOsm(readFileSync(new URL('../../data/example.osm', import.meta.url), 'utf8')), 'example.osm')
  return s
}
const count = (s: Store, code: string) => validate(s.doc).filter((i) => i.code === code).length

describe('исправления проблем', () => {
  it('автоисправление убирает битые запреты и дубли узлов одним шагом undo', () => {
    const s = load()
    const before = { rel: s.doc.relations.size, nodes: s.doc.nodes.size }
    expect(count(s, 'broken-relation')).toBeGreaterThan(0)
    expect(count(s, 'duplicate-nodes')).toBeGreaterThan(0)

    const applied = applyAutoFixes(s, validate(s.doc))
    expect(applied).toBeGreaterThan(0)
    expect(count(s, 'broken-relation')).toBe(0)
    expect(count(s, 'duplicate-nodes')).toBe(0)
    // битые запреты удалены; зато появились связки остановок, привязанных к ближайшим узлам (< 40 м)
    const restrictions = [...s.doc.relations.values()].filter((r) => r.tags.type === 'restriction').length
    expect(restrictions).toBeLessThan([...parseOsm(readFileSync(new URL('../../data/example.osm', import.meta.url), 'utf8')).relations.values()].filter((r) => r.tags.type === 'restriction').length)
    expect(count(s, 'unlinked-stop')).toBeLessThan(validate(load().doc).filter((i) => i.code === 'unlinked-stop').length)

    s.undo() // один шаг возвращает всё
    expect(s.doc.relations.size).toBe(before.rel)
    expect(s.doc.nodes.size).toBe(before.nodes)
    expect(count(s, 'broken-relation')).toBeGreaterThan(0)
  })

  it('повторное применение безопасно', () => {
    const s = load()
    const issues = validate(s.doc)
    applyAutoFixes(s, issues)
    const snapshot = { rel: s.doc.relations.size, nodes: s.doc.nodes.size, ways: s.doc.ways.size }
    applyAutoFixes(s, issues) // та же устаревшая выборка проблем
    expect({ rel: s.doc.relations.size, nodes: s.doc.nodes.size, ways: s.doc.ways.size }).toEqual(snapshot)
  })

  it('удаление изолированного участка (ручное исправление)', () => {
    const s = load()
    const iso = validate(s.doc).find((i) => i.code === 'isolated')!
    expect(iso.auto).toBeFalsy() // в автоисправление не входит
    const before = count(s, 'isolated')
    applyFix(s, iso.fix!)
    for (const id of iso.wayIds!) expect(s.doc.ways.has(id)).toBe(false)
    expect(count(s, 'isolated')).toBe(before - 1)
    s.undo()
    for (const id of iso.wayIds!) expect(s.doc.ways.has(id)).toBe(true)
  })

  it('ловушки и «нет въезда» без исправления — их можно только скрыть', () => {
    const s = load()
    for (const i of validate(s.doc).filter((x) => x.code === 'trap' || x.code === 'no-entry')) expect(i.fix).toBeUndefined()
  })
})
