import type { ElementRef, Marker, OsmDocument, OsmNode, OsmRelation, OsmWay } from './types'
import { emptyDocument } from './types'

/**
 * Хранилище документа с undo/redo.
 *
 * Любая правка делается через store.commit(label, tx => { ... }).
 * Транзакция сама запоминает «было/стало», поэтому писать обратные операции не нужно:
 *   store.commit('Сдвинуть узел', tx => tx.setNode({ ...node, lat, lon }))
 */

type Entity = OsmNode | OsmWay | OsmRelation | Marker
type Kind = 'node' | 'way' | 'relation' | 'marker'

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

// Маркеры «только UI» запоминаем в браузере по имени файла: после перезагрузки страницы они на месте.
// В .osm они не пишутся никогда.
const markersKey = (fileName: string) => `uds-markers:${fileName}`
const canPersist = () => typeof window !== 'undefined' && !!window.localStorage

function loadMarkers(fileName: string): Map<number, Marker> {
  const m = new Map<number, Marker>()
  try {
    if (!canPersist()) return m
    const raw = window.localStorage.getItem(markersKey(fileName))
    if (raw) for (const x of JSON.parse(raw) as Marker[]) m.set(x.id, x)
  } catch { /* повреждённые данные или доступ закрыт — начинаем с пустого слоя */ }
  return m
}

function saveMarkers(fileName: string, markers: Map<number, Marker>) {
  try {
    if (!canPersist()) return
    if (markers.size) window.localStorage.setItem(markersKey(fileName), JSON.stringify([...markers.values()]))
    else window.localStorage.removeItem(markersKey(fileName))
  } catch { /* нет места или доступ закрыт — не критично */ }
}

export class Tx {
  readonly changes: Change[] = []
  constructor(private doc: OsmDocument, private markers: Map<number, Marker>, private nextId: () => number) {}

  /** Новый отрицательный id для созданных объектов (как в JOSM). */
  newId(): number {
    return this.nextId()
  }

  private map(kind: Kind): Map<number, Entity> {
    return (kind === 'node' ? this.doc.nodes : kind === 'way' ? this.doc.ways : kind === 'relation' ? this.doc.relations : this.markers) as Map<number, Entity>
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
  /** Маркеры «только UI» (светофор, переход): в документ и в .osm не попадают. */
  setMarker(m: Marker) { this.put('marker', m) }
  deleteMarker(id: number) { this.del('marker', id) }
}

export type Listener = () => void

export class Store {
  doc: OsmDocument = emptyDocument()
  /** Растёт при любом изменении — по нему React/Canvas понимают, что надо перерисоваться. */
  version = 0
  /** Растёт только при изменении документа (загрузка, правка, undo/redo), но не при выборе объекта. */
  docVersion = 0
  /** Светофоры и переходы, нарисованные в редакторе. Не часть документа и не сохраняются в .osm. */
  markers = new Map<number, Marker>()
  selection: ElementRef | null = null
  fileName = 'untitled.osm'
  dirty = false

  private undoStack: Entry[] = []
  private redoStack: Entry[] = []
  private listeners = new Set<Listener>()
  private idCounter = 0

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
    this.doc = doc
    this.fileName = fileName
    this.undoStack = []
    this.redoStack = []
    this.selection = null
    this.dirty = false
    this.markers = loadMarkers(fileName)
    // новые id не должны совпасть с id восстановленных маркеров
    this.idCounter = Math.min(0, ...[...this.markers.keys()])
    this.docVersion++
    this.emit()
  }

  select(ref: ElementRef | null) {
    this.selection = ref
    this.emit()
  }

  commit(label: string, fn: (tx: Tx) => void) {
    const tx = new Tx(this.doc, this.markers, () => --this.idCounter)
    fn(tx)
    if (!tx.changes.length) return
    this.undoStack.push({ label, changes: tx.changes })
    this.redoStack = []
    this.touched(tx.changes)
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

  /** После правки: документ стал «несохранённым» только если менялся он, а не слой маркеров. */
  private touched(changes: Change[]) {
    if (changes.some((c) => c.kind !== 'marker')) this.dirty = true
    if (changes.some((c) => c.kind === 'marker')) saveMarkers(this.fileName, this.markers)
  }

  private apply(changes: Change[], dir: 'undo' | 'redo') {
    const list = dir === 'undo' ? [...changes].reverse() : changes
    for (const c of list) {
      const m = (c.kind === 'node' ? this.doc.nodes : c.kind === 'way' ? this.doc.ways : c.kind === 'relation' ? this.doc.relations : this.markers) as Map<number, Entity>
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
    this.touched(e.changes)
    this.docVersion++
    this.emit()
  }

  redo() {
    const e = this.redoStack.pop()
    if (!e) return
    this.apply(e.changes, 'redo')
    this.undoStack.push(e)
    this.touched(e.changes)
    this.docVersion++
    this.emit()
  }

  get canUndo() { return this.undoStack.length > 0 }
  get canRedo() { return this.redoStack.length > 0 }
  get lastLabel() { return this.undoStack.at(-1)?.label }
}

export const store = new Store()
