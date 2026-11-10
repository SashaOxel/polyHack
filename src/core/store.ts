import type { ElementRef, OsmDocument, OsmNode, OsmRelation, OsmWay } from './types'
import { emptyDocument } from './types'
import { createIdGenerator, positiveIds } from './ids'
import { splitRoadSegments } from './segments'

/**
 * Хранилище документа с undo/redo.
 *
 * Любая правка делается через store.commit(label, tx => { ... }).
 * Транзакция сама запоминает «было/стало», поэтому писать обратные операции не нужно:
 *   store.commit('Сдвинуть узел', tx => tx.setNode({ ...node, lat, lon }))
 */

type Entity = OsmNode | OsmWay | OsmRelation
type Kind = 'node' | 'way' | 'relation'

interface Change {
  kind: Kind
  id: number
  before: Entity | undefined
  after: Entity | undefined
}

interface Entry {
  label: string
  changes: Change[]
}

const clone = <T>(x: T): T => structuredClone(x)

export class Tx {
  readonly changes: Change[] = []
  constructor(private doc: OsmDocument, private nextId: () => number) {}

  /** Уникальный положительный номер нового объекта. */
  newId(): number {
    return this.nextId()
  }

  private map(kind: Kind): Map<number, Entity> {
    return (kind === 'node' ? this.doc.nodes : kind === 'way' ? this.doc.ways : this.doc.relations) as Map<number, Entity>
  }

  private put(kind: Kind, e: Entity) {
    const m = this.map(kind)
    this.changes.push({ kind, id: e.id, before: m.has(e.id) ? clone(m.get(e.id)) : undefined, after: clone(e) })
    m.set(e.id, clone(e))
  }

  private del(kind: Kind, id: number) {
    const m = this.map(kind)
    if (!m.has(id)) return
    this.changes.push({ kind, id, before: clone(m.get(id)), after: undefined })
    m.delete(id)
  }

  setNode(n: OsmNode) { this.put('node', n) }
  setWay(w: OsmWay) { this.put('way', w) }
  setRelation(r: OsmRelation) { this.put('relation', r) }
  deleteNode(id: number) { this.del('node', id) }
  deleteWay(id: number) { this.del('way', id) }
  deleteRelation(id: number) { this.del('relation', id) }
}

export type Listener = () => void

export class Store {
  constructor(private readonly options: { autoSplitRoads?: boolean } = {}) {}

  doc: OsmDocument = emptyDocument()
  /** Растёт при любом изменении — по нему React/Canvas понимают, что надо перерисоваться. */
  version = 0
  /** Растёт только при изменении документа (загрузка, правка, undo/redo), но не при выборе объекта. */
  docVersion = 0
  selection: ElementRef | null = null
  fileName = 'untitled.osm'
  dirty = false

  private undoStack: Entry[] = []
  private redoStack: Entry[] = []
  private listeners = new Set<Listener>()
  private nextId = createIdGenerator(this.doc)

  subscribe = (fn: Listener) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
  getVersion = () => this.version

  private emit() {
    this.version++
    this.listeners.forEach((l) => l())
  }

  load(doc: OsmDocument, fileName: string) {
    this.nextId = createIdGenerator(doc)
    const prepared = positiveIds(doc, this.nextId)
    this.doc = this.options.autoSplitRoads ? {
      ...prepared, nodes: new Map(prepared.nodes), ways: new Map(prepared.ways), relations: new Map(prepared.relations),
    } : prepared
    const tx = new Tx(this.doc, this.nextId)
    if (this.options.autoSplitRoads) splitRoadSegments(this.doc, tx)
    this.fileName = fileName
    this.undoStack = []
    this.redoStack = []
    this.selection = null
    this.dirty = prepared !== doc || tx.changes.length > 0
    this.docVersion++
    this.emit()
  }

  select(ref: ElementRef | null) {
    this.selection = ref
    this.emit()
  }

  commit(label: string, fn: (tx: Tx) => void) {
    const tx = new Tx(this.doc, this.nextId)
    try {
      fn(tx)
      if (this.options.autoSplitRoads) splitRoadSegments(this.doc, tx)
    } catch (error) {
      this.apply(tx.changes, 'undo')
      throw error
    }
    if (!tx.changes.length) return
    this.undoStack.push({ label, changes: tx.changes })
    this.redoStack = []
    this.dirty = true
    this.docVersion++
    this.emit()
  }

  /** Несколько правок = один шаг undo: store.group('Исправить всё', () => { opA(); opB() }). */
  group(label: string, fn: () => void) {
    const base = this.undoStack.length
    fn()
    const entries = this.undoStack.splice(base)
    if (!entries.length) return
    this.undoStack.push({ label, changes: entries.flatMap((e) => e.changes) })
    this.emit()
  }

  private apply(changes: Change[], dir: 'undo' | 'redo') {
    const list = dir === 'undo' ? [...changes].reverse() : changes
    for (const c of list) {
      const m = (c.kind === 'node' ? this.doc.nodes : c.kind === 'way' ? this.doc.ways : this.doc.relations) as Map<number, Entity>
      const target = dir === 'undo' ? c.before : c.after
      if (target) m.set(c.id, clone(target))
      else m.delete(c.id)
    }
  }

  undo() {
    const e = this.undoStack.pop()
    if (!e) return
    this.apply(e.changes, 'undo')
    this.redoStack.push(e)
    this.dirty = true
    this.docVersion++
    this.emit()
  }

  redo() {
    const e = this.redoStack.pop()
    if (!e) return
    this.apply(e.changes, 'redo')
    this.undoStack.push(e)
    this.dirty = true
    this.docVersion++
    this.emit()
  }

  get canUndo() { return this.undoStack.length > 0 }
  get canRedo() { return this.redoStack.length > 0 }
  get lastLabel() { return this.undoStack.at(-1)?.label }
}

export const store = new Store({ autoSplitRoads: true })
