import { isStopPlatform, linkedStop, nearestWayNode, stopsAt } from './stops'
import { isDrivable, onewayDirection } from './roads'
import { SIGNS, approachDirection, blocksSign, driveWaysAt, signTags, type SignKind } from './signs'
import { cumulativeDistance } from './elevation'
import { PAIR_TAG, defaultPlan, pairOf, readPlan, syncTimings, writePlan, type SignalPlan } from './signals'
import { hasSignal } from './roads'
import { buildRouteRelation, type RouteDraft } from './routes'
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
  store.commit('Переместить узел', tx => {
    for (const stop of stopsAt(store.doc, id)) {
      const platform = store.doc.nodes.get(stop.platform)
      if (stop.anchor === id && platform) {
        tx.setNode({ ...platform, lat: platform.lat + lat - n.lat, lon: platform.lon + lon - n.lon })
      }
    }
    tx.setNode({ ...n, lat, lon })
  })
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

/** Вставить уже существующий узел в ближайший отрезок дороги (форма дороги не меняется, узел лежит на отрезке). */
function insertNodeRefIntoWay(tx: Tx, doc: OsmDocument, wayId: number, nodeId: number) {
  const way = doc.ways.get(wayId), node = doc.nodes.get(nodeId)
  if (!way || !node) throw new Error('Нет дороги или узла')
  if (way.nodes.includes(nodeId)) return
  const p = project(node.lat, node.lon)
  let best = { i: -1, dist: Infinity }
  for (let i = 0; i < way.nodes.length - 1; i++) {
    const a = doc.nodes.get(way.nodes[i]), b = doc.nodes.get(way.nodes[i + 1])
    if (!a || !b) continue
    const r = nearestOnSegment(p, project(a.lat, a.lon), project(b.lat, b.lon))
    if (r.dist < best.dist) best = { i, dist: r.dist }
  }
  if (best.i < 0) throw new Error(`У дороги ${wayId} нет отрезков`)
  tx.setWay({ ...way, nodes: [...way.nodes.slice(0, best.i + 1), nodeId, ...way.nodes.slice(best.i + 1)] })
}

/**
 * Сделать перекрёсток там, где две дороги пересекаются без общего узла: общий узел в точке пересечения,
 * вставленный в обе дороги. Один шаг undo.
 */
export function makeJunction(store: Store, wayA: number, wayB: number, lat: number, lon: number): number {
  const doc = store.doc
  if (!doc.ways.has(wayA) || !doc.ways.has(wayB)) throw new Error('Дороги не найдены')
  let id = 0
  store.commit('Создать перекрёсток', (tx) => {
    id = insertIntoWay(tx, doc, wayA, lat, lon)
    insertNodeRefIntoWay(tx, doc, wayB, id)
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
    for (const stop of stopsAt(doc, id)) {
      // пометку читаем до удаления связки: место посадки, созданное редактором, удаляем, остановку из OSM оставляем
      const existing = doc.relations.get(stop.area)?.tags['polyhack:platform'] === 'existing'
      tx.deleteRelation(stop.area)
      if (stop.anchor === id) {
        const shared = [...doc.ways.values()].some(w => w.nodes.includes(stop.platform)) ||
          [...doc.relations.values()].some(r => r.members.some(m => m.type === 'node' && m.ref === stop.platform))
        if (!shared && !existing) tx.deleteNode(stop.platform)
      }
    }
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

// ---------- светофоры и пешеходные переходы (реальная правка OSM) ----------

export type RoadFeature = 'signal' | 'crossing'

/**
 * Теги узла после добавления светофора или перехода. Правила OSM:
 *  - светофор: highway=traffic_signals;
 *  - переход: highway=crossing + crossing=uncontrolled (зебра без светофора);
 *  - переход со светофором: crossing=traffic_signals (узел остаётся светофором или переходом).
 */
export function featureTags(tags: Tags, feature: RoadFeature): Tags {
  const t = { ...tags }
  if (feature === 'signal') {
    if (t.highway === 'crossing') t.crossing = t.crossing ?? 'traffic_signals'
    t.highway = 'traffic_signals'
  } else if (t.highway === 'traffic_signals') {
    t.crossing = t.crossing ?? 'traffic_signals'
  } else {
    t.highway = 'crossing'
    t.crossing = t.crossing ?? 'uncontrolled'
  }
  return t
}

/** Куда ставить: на существующий узел дороги или в точку на отрезке дороги (там появится новый узел). */
export type FeatureTarget = { kind: 'node'; id: number } | { kind: 'way'; wayId: number; lat: number; lon: number }

/** Поставить светофор или переход одним шагом undo. Возвращает id узла, на котором он стоит. */
export function placeRoadFeature(store: Store, target: FeatureTarget, feature: RoadFeature): number {
  let nodeId = 0
  store.commit(feature === 'signal' ? 'Добавить светофор' : 'Добавить пешеходный переход', (tx) => {
    nodeId = target.kind === 'node' ? target.id : insertIntoWay(tx, store.doc, target.wayId, target.lat, target.lon)
    const n = store.doc.nodes.get(nodeId)
    if (n) tx.setNode({ ...n, tags: featureTags(n.tags, feature) })
  })
  return nodeId
}

/**
 * Поставить знак приоритета (главная / уступи / стоп) одним шагом undo.
 * Клик по отрезку — новый узел со знаком, клик по узлу — знак на нём (на перекрёстке сам узел не годится:
 * непонятно, на какую дорогу знак — ставьте на дорогу рядом с ним).
 */
export function placeSign(store: Store, target: FeatureTarget, kind: SignKind): number {
  const doc = store.doc
  let way: OsmWay | undefined
  let at: { node: number } | { lat: number; lon: number }
  if (target.kind === 'node') {
    const ways = driveWaysAt(doc, target.id)
    if (ways.length === 0) throw new Error('Знак ставится на автомобильную дорогу')
    if (ways.length > 1) throw new Error('Это перекрёсток — кликните по дороге рядом с ним, чтобы было ясно, для какой дороги знак')
    way = ways[0]; at = { node: target.id }
    if (blocksSign(doc.nodes.get(target.id)?.tags ?? {}, kind)) throw new Error('На этом узле уже светофор или переход — выберите другую точку дороги')
  } else {
    way = doc.ways.get(target.wayId)
    if (!way || !isDrivable(way)) throw new Error('Знак ставится на автомобильную дорогу')
    at = { lat: target.lat, lon: target.lon }
  }
  const direction = onewayDirection(way) === 0 ? approachDirection(doc, way, at) : undefined
  let nodeId = 0
  store.commit(`Знак ${SIGNS[kind].code} ${SIGNS[kind].label}`, (tx) => {
    nodeId = target.kind === 'node' ? target.id : insertIntoWay(tx, doc, target.wayId, target.lat, target.lon)
    const n = store.doc.nodes.get(nodeId)
    if (n) tx.setNode({ ...n, tags: signTags(n.tags, kind, direction) })
  })
  return nodeId
}

/** Место посадки: точка, где создать новую остановку, или уже существующая остановка из OSM. */
export type StopPlatform = { lat: number; lon: number } | { id: number }

/**
 * Автобусная остановка одним действием: опорный узел на дороге + место посадки + stop_area.
 * Новые узлы в дорогу не вставляются: при клике по отрезку берётся ближайший существующий узел этой дороги.
 * Если место посадки — существующая остановка ({ id }), новый узел не создаётся, она просто привязывается.
 */
export function placeBusStop(store: Store, target: FeatureTarget, platform: StopPlatform) {
  const doc = store.doc
  const anchor = target.kind === 'node' ? target.id : nearestWayNode(doc, target.wayId, target.lat, target.lon)
  if (anchor === undefined) throw new Error('Выберите узел или участок автомобильной дороги')
  const road = [...doc.ways.values()].find(w => isDrivable(w) && w.nodes.includes(anchor))
  if (!road) throw new Error('Выберите узел или участок автомобильной дороги')
  const node = doc.nodes.get(anchor)
  if (!node) throw new Error('Узел отсутствует на карте')
  if (stopsAt(doc, anchor).length) throw new Error('К этому узлу уже привязана остановка')
  if (node.tags.public_transport && node.tags.public_transport !== 'stop_position') {
    throw new Error('У этого узла уже есть другое транспортное назначение')
  }
  if ('id' in platform) {
    const existing = doc.nodes.get(platform.id)
    if (!existing || !isStopPlatform(existing.tags)) throw new Error('Это не остановка')
    const linked = stopsAt(doc, platform.id)
    if (linked.length) throw new Error('Эта остановка уже привязана к узлу № ' + linked[0].anchor)
  }

  store.commit('Добавить автобусную остановку', tx => {
    tx.setNode({ ...node, tags: { ...node.tags, public_transport: 'stop_position', bus: 'yes' } })
    let platformId: number
    if ('id' in platform) {
      // существующая остановка: свои теги (название и т.д.) сохраняет, недостающие дополняем
      const existing = doc.nodes.get(platform.id)!
      platformId = existing.id
      tx.setNode({ ...existing, tags: { highway: 'bus_stop', ...existing.tags, public_transport: 'platform', bus: 'yes' } })
    } else {
      platformId = tx.newId()
      tx.setNode({ id: platformId, lat: platform.lat, lon: platform.lon, meta: {}, tags: { highway: 'bus_stop', public_transport: 'platform', bus: 'yes' } })
    }
    tx.setRelation({
      id: tx.newId(), meta: {},
      tags: {
        type: 'public_transport', public_transport: 'stop_area', 'polyhack:linked': 'yes',
        // остановка была в файле до редактора: при удалении опорного узла её не удалять
        ...('id' in platform ? { 'polyhack:platform': 'existing' } : {}),
      },
      members: [{ type: 'node', ref: anchor, role: 'stop' }, { type: 'node', ref: platformId, role: 'platform' }],
    })
  })
  return anchor
}

/**
 * Привязать остановку (место посадки) к узлу дороги по номеру узла.
 * Уже привязанная остановка переносится на новый узел; старый узел теряет метку stop_position.
 */
export function linkStopToNode(store: Store, platformId: number, nodeId: number) {
  const doc = store.doc
  const platform = doc.nodes.get(platformId)
  if (!platform || !isStopPlatform(platform.tags)) throw new Error('Выбранный объект — не остановка')
  const node = doc.nodes.get(nodeId)
  if (!node) throw new Error(`Узла № ${nodeId} нет на карте`)
  if (!(([...doc.ways.values()].some(w => isDrivable(w) && w.nodes.includes(nodeId))))) {
    throw new Error(`Узел № ${nodeId} не лежит на дороге для автомобилей`)
  }
  if (nodeId === platformId) throw new Error('Остановку нельзя привязать к самой себе')
  const current = stopsAt(doc, platformId).find(s => s.platform === platformId)
  if (!current) return placeBusStop(store, { kind: 'node', id: nodeId }, { id: platformId })
  if (current.anchor === nodeId) return nodeId
  const busy = stopsAt(doc, nodeId).find(s => s.anchor === nodeId)
  if (busy) throw new Error(`К узлу № ${nodeId} уже привязана другая остановка`)

  store.commit('Привязать остановку к узлу', tx => {
    const area = doc.relations.get(current.area)!
    tx.setRelation({ ...area, members: area.members.map(m => (m.role === 'stop' && m.type === 'node' ? { ...m, ref: nodeId } : m)) })
    tx.setNode({ ...node, tags: { ...node.tags, public_transport: 'stop_position', bus: 'yes' } })
    // старый узел больше не опора ни одной остановки — снимаем метку, которую ставил редактор
    const old = doc.nodes.get(current.anchor)
    const stillAnchor = [...doc.relations.values()].some(r => r.id !== area.id && linkedStop(r)?.anchor === current.anchor)
    if (old && !stillAnchor && old.tags.public_transport === 'stop_position') {
      const tags = { ...old.tags }
      delete tags.public_transport
      if (tags.bus === 'yes') delete tags.bus
      tx.setNode({ ...old, tags })
    }
  })
  return nodeId
}

// ---------- светофорное регулирование ----------

/** Записать (или удалить при null) план светофорного регулирования на узле светофора. */
export function setSignalPlan(store: Store, nodeId: number, plan: SignalPlan | null) {
  const n = store.doc.nodes.get(nodeId)
  if (!n) return
  store.commit(plan ? 'Изменить план светофора' : 'Удалить план светофора', (tx) => {
    tx.setNode({ ...n, tags: writePlan(n.tags, plan) })
    // светофор в паре: тайминги повторяются на втором (если у него нет плана — создаём по умолчанию и синхронизируем)
    const partner = plan ? store.doc.nodes.get(pairOf(n.tags) ?? 0) : undefined
    if (plan && partner && partner.id !== nodeId) {
      const base = readPlan(partner.tags) ?? defaultPlan(store.doc, partner.id, plan.cycle)
      tx.setNode({ ...partner, tags: writePlan(partner.tags, syncTimings(plan, base)) })
    }
  })
}

/**
 * Связать два светофора в пару (например, на одном пешеходном переходе): у них будут одинаковые тайминги,
 * а правка плана одного повторится на втором. Если план есть только у одного — он копируется второму.
 */
export function linkSignals(store: Store, a: number, b: number) {
  const A = store.doc.nodes.get(a), B = store.doc.nodes.get(b)
  if (!A || !B || a === b) throw new Error('Выберите два разных светофора')
  if (!hasSignal(A.tags) || !hasSignal(B.tags)) throw new Error('Оба узла должны быть светофорами')
  store.commit('Связать светофоры', (tx) => {
    // прежние пары этих узлов распадаются
    for (const id of [a, b]) {
      const old = store.doc.nodes.get(pairOf(store.doc.nodes.get(id)!.tags) ?? 0)
      if (old && old.id !== a && old.id !== b) { const t = { ...old.tags }; delete t[PAIR_TAG]; tx.setNode({ ...old, tags: t }) }
    }
    const planA = readPlan(A.tags), planB = readPlan(B.tags)
    const src = planA ?? planB
    let tagsA: Tags = { ...A.tags, [PAIR_TAG]: String(b) }, tagsB: Tags = { ...B.tags, [PAIR_TAG]: String(a) }
    if (src) {
      // у источника — его тайминги; у второго — они же поверх его (или плана по умолчанию) состава направлений
      const baseA = planA ?? defaultPlan(store.doc, a, src.cycle), baseB = planB ?? defaultPlan(store.doc, b, src.cycle)
      tagsA = writePlan(tagsA, src === planA ? planA : syncTimings(src, baseA))
      tagsB = writePlan(tagsB, src === planB ? planB : syncTimings(src, baseB))
    }
    tx.setNode({ ...A, tags: tagsA }); tx.setNode({ ...B, tags: tagsB })
  })
}

export function unlinkSignals(store: Store, nodeId: number) {
  const n = store.doc.nodes.get(nodeId)
  const partner = store.doc.nodes.get(pairOf(n?.tags ?? {}) ?? 0)
  if (!n) return
  store.commit('Разорвать пару светофоров', (tx) => {
    const t = { ...n.tags }; delete t[PAIR_TAG]; tx.setNode({ ...n, tags: t })
    if (partner) { const p = { ...partner.tags }; delete p[PAIR_TAG]; tx.setNode({ ...partner, tags: p }) }
  })
}

// ---------- маршруты общественного транспорта ----------

/**
 * Создать или обновить маршрут (relation route=bus|tram). Путь между остановками строится автоматически;
 * если между какими-то соседними остановками пути нет — ошибка с номерами остановок.
 */
export function saveRoute(store: Store, draft: RouteDraft, routeId?: number): number {
  if (!draft.ref.trim()) throw new Error('Укажите номер маршрута')
  if (draft.stops.length < 2) throw new Error('Нужно минимум две остановки')
  const old = routeId !== undefined ? store.doc.relations.get(routeId) : undefined
  let id = routeId ?? 0
  const probe = buildRouteRelation(store.doc, id, draft)
  if (probe.path.broken.length) {
    const legs = probe.path.broken.map((i) => `${i + 1}→${i + 2}`).join(', ')
    throw new Error(`Нет пути ${draft.kind === 'tram' ? 'по трамвайным путям' : 'по дорогам (с учётом одностороннего движения)'} между остановками ${legs}`)
  }
  store.commit(old ? `Изменить маршрут ${draft.ref}` : `Создать маршрут ${draft.ref}`, (tx) => {
    if (!old) id = tx.newId()
    // свои посторонние теги (если были) сохраняем
    const keep: Tags = {}
    if (old) for (const [k, v] of Object.entries(old.tags)) if (!['name', 'from', 'to', 'colour'].includes(k)) keep[k] = v
    tx.setRelation({ ...buildRouteRelation(store.doc, id, draft, keep).relation, meta: old?.meta ?? {} })
  })
  return id
}

export function deleteRoute(store: Store, routeId: number) {
  if (!store.doc.relations.has(routeId)) return
  store.commit('Удалить маршрут', (tx) => tx.deleteRelation(routeId))
}

// ---------- площади (парковки) и уровень дороги ----------

/** Нарисовать замкнутую площадь (например, парковку) по точкам: новые узлы + замкнутый контур. */
export function drawArea(store: Store, points: { lat: number; lon: number }[], tags: Tags): number {
  if (points.length < 3) throw new Error('Нужно минимум три точки')
  let wayId = 0
  store.commit(tags.amenity === 'parking' ? 'Добавить парковку' : 'Добавить площадь', (tx) => {
    const ids = points.map((p) => {
      const id = tx.newId()
      tx.setNode({ id, lat: p.lat, lon: p.lon, tags: {}, meta: {} })
      return id
    })
    wayId = tx.newId()
    tx.setWay({ id: wayId, nodes: [...ids, ids[0]], tags: { ...tags }, meta: {} })
  })
  return wayId
}

/** Сделать дорогу мостом, тоннелем или вернуть на землю (теги bridge/tunnel/layer). */
export function setWayLevel(store: Store, wayId: number, level: 'ground' | 'bridge' | 'tunnel', layer?: number) {
  const w = store.doc.ways.get(wayId)
  if (!w) return
  const tags = { ...w.tags }
  delete tags.bridge; delete tags.tunnel; delete tags.layer
  if (level === 'bridge') { tags.bridge = 'yes'; tags.layer = String(layer && layer > 0 ? layer : 1) }
  if (level === 'tunnel') { tags.tunnel = 'yes'; tags.layer = String(layer && layer < 0 ? layer : -1) }
  store.commit(level === 'bridge' ? 'Сделать мостом' : level === 'tunnel' ? 'Сделать тоннелем' : 'Вернуть на землю', (tx) => tx.setWay({ ...w, tags }))
}
