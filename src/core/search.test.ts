import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseOsm } from './parse'
import { normalize, searchDoc } from './search'

const doc = parseOsm(readFileSync(new URL('../../data/example.osm', import.meta.url), 'utf8'))

describe('поиск для командной палитры', () => {
  it('улица по началу названия, одна запись на улицу', () => {
    const hits = searchDoc(doc, 1, 'лермонт')
    expect(hits[0].kind).toBe('street')
    expect(hits[0].label).toBe('улица Лермонтова')
    expect(hits.filter((h) => h.label === 'улица Лермонтова')).toHaveLength(1)
    expect(hits[0].ref?.kind).toBe('way')
  })

  it('несколько слов и «ё»', () => {
    expect(normalize('  Улица   Ёлкина ')).toBe('улица елкина')
    expect(searchDoc(doc, 1, 'улица лермонтова')[0].label).toBe('улица Лермонтова')
  })

  it('номер узла и дороги', () => {
    const node = [...doc.nodes.keys()][0]
    expect(searchDoc(doc, 1, String(node))[0]).toMatchObject({ kind: 'node', ref: { kind: 'node', id: node } })
    expect(searchDoc(doc, 1, `узел ${node}`)[0].kind).toBe('node')
    const way = [...doc.ways.keys()][0]
    expect(searchDoc(doc, 1, String(way)).some((h) => h.kind === 'way')).toBe(true)
  })

  it('остановки и маршруты из файла', () => {
    expect(searchDoc(doc, 1, 'технический').some((h) => h.kind === 'stop')).toBe(true)
    expect(searchDoc(doc, 1, 'автобус 80').some((h) => h.kind === 'route')).toBe(true)
  })

  it('пустой запрос и ничего не найдено', () => {
    expect(searchDoc(doc, 1, '   ')).toEqual([])
    expect(searchDoc(doc, 1, 'несуществующаяулица')).toEqual([])
  })
})
