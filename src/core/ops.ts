import { cumulativeDistance } from './elevation'
import { nearestOnSegment, project, unproject } from './geo'
import type { Store, Tx } from './store'
import type { OsmDocument, OsmRelation, OsmWay, Tags } from './types'

/**
 * Операции редактирования поверх store.commit. Каждая операция = один шаг undo.
 * Новые операции добавляйте сюда по тому же шаблону: store.commit('название', tx => ...).
 * Внутри транзакции документ (store.doc) обновляется сразу, так что можно читать результат своих же правок.
 */

// ---------- вспомогательное ----------

/** Убрать подряд идущие одинаковые узлы: [1,2,2,3] → [1,2,3]. */
const dedupe = (nodes: number[]) => nodes.filter((n, i) => i === 0 || n !== nodes[i - 1])

const isRestriction = (r: OsmRelation) => r.tags.type === 'restriction'

/**
 * Удалить дорогу внутри транзакции: сама дорога, запреты поворотов с её участием,
 * её членство в других relations и узлы, которые стали никому не нужны.
 */
function removeWayInTx(tx: Tx, doc: OsmDocument, way: OsmWay) {
  tx.deleteWay(way.id)
  for (const r of [...doc.relations.values()]) {
    if (!r.members.some((m) => m.type === 'way' && m.ref === way.id)) continue
    if (isRestriction(r)) tx.deleteRelation(r.id)
    else tx.setRelation({ ...r, members: r.members.filter((m) => !(m.type === 'way' && m.ref === way.id)) })
  }
  const stillUsed = new Set<number>()
  for (const other of doc.ways.values()) for (const n of other.nodes) stillUsed.add(n)
  for (const nid of new Set(way.nodes)) {
    const node = doc.nodes.get(nid)
    if (node && !stillUsed.has(nid) && Object.keys(node.tags).length === 0) tx.deleteNode(nid)
  }
}

/** Вставить в дорогу новый узел в ближайшем к (lat, lon) месте. Возвращает id нового узла. */
function insertIntoWay(tx: Tx, doc: OsmDocument, wayId: number, lat: number, lon: number): number {
  const way = doc.ways.get(wayId)
  if (!way) throw new Error(`Нет дороги ${wayId}`)
  const p = project(lat, lon)
  let best = { i: -1, x: p.x, y: p.y, dist: Infinity }
  for (let i = 0; i < way.nodes.length - 1; i++) {
    const a = doc.nodes.get(way.nodes[i]), b = doc.nodes.get(way.nodes[i + 1])
    if (!a || !b) continue
    const r = nearestOnSegment(p, project(a.lat, a.lon), project(b.lat, b.lon))
    if (r.dist < best.dist) best = { i, x: r.x, y: r.y, dist: r.dist }
  }
  if (best.i < 0) throw new Error(`У дороги ${wayId} нет отрезков`)
  const ll = unproject(best.x, best.y) // точка ровно на отрезке, форма дороги не меняется
  const id = tx.newId()
  tx.setNode({ id, lat: ll.lat, lon: ll.lon, tags: {}, meta: {} })
  tx.setWay({ ...way, nodes: [...way.nodes.slice(0, best.i + 1), id, ...way.nodes.slice(best.i + 1)] })
  return id
}

// ---------- базовые правки ----------

export function moveNode(store: Store, id: number, lat: number, lon: number) {
  const n = store.doc.nodes.get(id)
  if (!n) return
  store.commit('Переместить узел', (tx) => tx.setNode({ ...n, lat, lon }))
}

/** Заменить теги целиком (для узла или way). Пустое значение удаляет ключ. */
export function setTags(store: Store, kind: 'node' | 'way', id: number, tags: Tags) {
  const clean = Object.fromEntries(Object.entries(tags).filter(([k, v]) => k.trim() !== '' && v !== ''))
  if (kind === 'node') {
    const n = store.doc.nodes.get(id)
    if (n) store.commit('Изменить теги узла', (tx) => tx.setNode({ ...n, tags: clean }))
  } else {
    const w = store.doc.ways.get(id)
    if (w) store.commit('Изменить теги дороги', (tx) => tx.setWay({ ...w, tags: clean }))
  }
}

/** Развернуть направление: порядок узлов и oneway=-1 → yes. */
export function reverseWay(store: Store, id: number) {
  const w = store.doc.ways.get(id)
  if (!w) return
  store.commit('Развернуть дорогу', (tx) => {
    const tags = { ...w.tags }
    if (tags.oneway === '-1') tags.oneway = 'yes'
    // forward/backward-теги меняются местами
    for (const k of Object.keys(tags)) {
      if (k.endsWith(':forward')) { tags[k.replace(':forward', ':backward')] = tags[k]; delete tags[k] }
      else if (k.endsWith(':backward')) { tags[k.replace(':backward', ':forward')] = tags[k]; delete tags[k] }
    }
    tx.setWay({ ...w, nodes: [...w.nodes].reverse(), tags })
  })
}

/**
 * Плавный переход по Z: высоты узлов дороги линейно (по расстоянию) от `from` до `to`, метры.
 * Пишется в тег `ele` каждого узла — стандартный способ хранить высоту в OSM.
 */
export function setElevationRamp(store: Store, wayId: number, from: number, to: number) {
  const way = store.doc.ways.get(wayId)
  if (!way || !Number.isFinite(from) || !Number.isFinite(to)) return
  const d = cumulativeDistance(store.doc, way)
  const total = d[d.length - 1]
  store.commit('Плавный переход высоты', (tx) => {
    way.nodes.forEach((id, i) => {
      const n = store.doc.nodes.get(id)
      if (!n) return
      const t = total > 0 ? d[i] / total : way.nodes.length > 1 ? i / (way.nodes.length - 1) : 0
      const z = Math.round((from + (to - from) * t) * 10) / 10
      tx.setNode({ ...n, tags: { ...n.tags, ele: String(z) } })
    })
  })
}

/** Убрать высоты (`ele`) у всех узлов дороги. */
export function clearElevation(store: Store, wayId: number) {
  const way = store.doc.ways.get(wayId)
  if (!way) return
  store.commit('Сбросить высоту', (tx) => {
    for (const id of new Set(way.nodes)) {
      const n = store.doc.nodes.get(id)
      if (!n || n.tags.ele === undefined) continue
      const tags = { ...n.tags }
      delete tags.ele
      tx.setNode({ ...n, tags })
    }
  })
}

// ---------- создание ----------

/** Создать узел. */
export function addNode(store: Store, lat: number, lon: number, tags: Tags = {}) {
  let id = 0
  store.commit('Добавить узел', (tx) => {
    id = tx.newId()
    tx.setNode({ id, lat, lon, tags, meta: {} })
  })
  return id
}

/** Создать дорогу по списку существующих узлов. */
export function addWay(store: Store, nodes: number[], tags: Tags) {
  let id = 0
  store.commit('Добавить дорогу', (tx) => {
    id = tx.newId()
    tx.setWay({ id, nodes, tags, meta: {} })
  })
  return id
}

/** Точка новой дороги: существующий узел, точка на существующей дороге или свободная точка. */
export type DrawPoint =
  | { kind: 'node'; id: number }
  | { kind: 'way'; wayId: number; lat: number; lon: number }
  | { kind: 'new'; lat: number; lon: number }

/**
 * Нарисовать дорогу по точкам одним шагом undo.
 *  - 'node' — присоединиться к существующему узлу;
 *  - 'way' — вставить узел в существующую дорогу (получится перекрёсток);
 *  - 'new' — создать новый узел.
 * Возвращает id новой дороги (0, если точек меньше двух).
 */
export function drawRoad(store: Store, points: DrawPoint[], tags: Tags): number {
  if (points.length < 2) return 0
  let wayId = 0
  store.commit('Нарисовать дорогу', (tx) => {
    const ids: number[] = []
    for (const p of points) {
      let id: number
      if (p.kind === 'node') id = p.id
      else if (p.kind === 'way') id = insertIntoWay(tx, store.doc, p.wayId, p.lat, p.lon)
      else {
        id = tx.newId()
        tx.setNode({ id, lat: p.lat, lon: p.lon, tags: {}, meta: {} })
      }
      if (ids.at(-1) !== id) ids.push(id)
    }
    if (ids.length < 2) return
    wayId = tx.newId()
    tx.setWay({ id: wayId, nodes: ids, tags: { ...tags }, meta: {} })
  })
  return wayId
}

/** Поставить узел на дорогу (меняет геометрию на изгиб, не создаёт перекрёсток). Возвращает id узла. */
export function insertNodeOnWay(store: Store, wayId: number, lat: number, lon: number): number {
  let id = 0
  store.commit('Добавить узел на дорогу', (tx) => {
    id = insertIntoWay(tx, store.doc, wayId, lat, lon)
  })
  return id
}

// ---------- разрез ----------

function splitInTx(tx: Tx, doc: OsmDocument, way: OsmWay, index: number) {
  tx.setWay({ ...way, nodes: way.nodes.slice(0, index + 1) })
  const newId = tx.newId()
  tx.setWay({ id: newId, nodes: way.nodes.slice(index), tags: { ...way.tags }, meta: {} })
  // новая половина остаётся в маршрутах, где была исходная дорога.
  // TODO(команда): для restriction выбирать нужную половину по from/to; пока такие relations не трогаем.
  for (const r of doc.relations.values()) {
    const i = r.members.findIndex((m) => m.type === 'way' && m.ref === way.id)
    if (i < 0 || isRestriction(r)) continue
    const members = [...r.members]
    members.splice(i + 1, 0, { ...r.members[i], ref: newId })
    tx.setRelation({ ...r, members })
  }
}

/** Разрезать дорогу в узле `nodeId` на две. */
export function splitWayAt(store: Store, wayId: number, nodeId: number) {
  const w = store.doc.ways.get(wayId)
  if (!w) return
  const i = w.nodes.indexOf(nodeId)
  if (i <= 0 || i >= w.nodes.length - 1) return
  store.commit('Разрезать дорогу', (tx) => splitInTx(tx, store.doc, w, i))
}

/** Разрезать в узле все дороги, которые проходят через него насквозь. Возвращает число разрезанных. */
export function splitAtNode(store: Store, nodeId: number): number {
  let count = 0
  store.commit('Разрезать дороги в узле', (tx) => {
    for (const w of [...store.doc.ways.values()]) {
      const i = w.nodes.indexOf(nodeId)
      if (i > 0 && i < w.nodes.length - 1) {
        splitInTx(tx, store.doc, store.doc.ways.get(w.id)!, i)
        count++
      }
    }
  })
  return count
}

// ---------- удаление и склейка ----------

/** Удалить дорогу и всё, что от неё зависит (запреты поворотов, членство в маршрутах, ненужные узлы). */
export function deleteWay(store: Store, id: number) {
  const w = store.doc.ways.get(id)
  if (!w) return
  store.commit('Удалить дорогу', (tx) => removeWayInTx(tx, store.doc, w))
}

/** Удалить relation (например, запрет поворота с несуществующими участниками). */
export function deleteRelation(store: Store, id: number) {
  if (!store.doc.relations.has(id)) return
  store.commit('Удалить relation', (tx) => tx.deleteRelation(id))
}

/** Удалить несколько дорог одним шагом (например, изолированный участок). */
export function deleteWays(store: Store, ids: number[]) {
  const ways = ids.map((id) => store.doc.ways.get(id)).filter((w): w is OsmWay => !!w)
  if (!ways.length) return
  store.commit('Удалить участок', (tx) => {
    for (const w of ways) if (store.doc.ways.has(w.id)) removeWayInTx(tx, store.doc, w)
  })
}

/** Удалить узел: он пропадает из всех дорог (дороги короче двух узлов удаляются) и из relations. */
export function deleteNode(store: Store, id: number) {
  if (!store.doc.nodes.has(id)) return
  store.commit('Удалить узел', (tx) => {
    const doc = store.doc
    for (const w of [...doc.ways.values()]) {
      if (!w.nodes.includes(id)) continue
      const nodes = dedupe(w.nodes.filter((n) => n !== id))
      if (nodes.length < 2) removeWayInTx(tx, doc, w)
      else tx.setWay({ ...w, nodes })
    }
    for (const r of [...doc.relations.values()]) {
      if (!r.members.some((m) => m.type === 'node' && m.ref === id)) continue
      if (isRestriction(r)) tx.deleteRelation(r.id)
      else tx.setRelation({ ...r, members: r.members.filter((m) => !(m.type === 'node' && m.ref === id)) })
    }
    tx.deleteNode(id)
  })
}

/**
 * Склеить два узла в один (перекрёсток из двух разорванных, дубль узла).
 * Остаётся keepId, removeId заменяется на него во всех дорогах и relations; теги объединяются.
 */
export function mergeNodes(store: Store, keepId: number, removeId: number) {
  const keep = store.doc.nodes.get(keepId)
  const rem = store.doc.nodes.get(removeId)
  if (!keep || !rem || keepId === removeId) return
  store.commit('Склеить узлы', (tx) => {
    const doc = store.doc
    for (const w of [...doc.ways.values()]) {
      if (!w.nodes.includes(removeId)) continue
      const nodes = dedupe(w.nodes.map((n) => (n === removeId ? keepId : n)))
      if (nodes.length < 2) removeWayInTx(tx, doc, w)
      else tx.setWay({ ...w, nodes })
    }
    for (const r of [...doc.relations.values()]) {
      if (!r.members.some((m) => m.type === 'node' && m.ref === removeId)) continue
      tx.setRelation({ ...r, members: r.members.map((m) => (m.type === 'node' && m.ref === removeId ? { ...m, ref: keepId } : m)) })
    }
    const current = doc.nodes.get(keepId)
    if (current && Object.keys(rem.tags).length) tx.setNode({ ...current, tags: { ...rem.tags, ...current.tags } })
    tx.deleteNode(removeId)
  })
}
