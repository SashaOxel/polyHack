import type { Store } from './store'
import type { Tags } from './types'

/**
 * Операции редактирования поверх store.commit. Каждая операция = один шаг undo.
 * Новые операции добавляйте сюда по тому же шаблону.
 */

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

/** Удалить дорогу и узлы, которые больше нигде не используются и ничего не значат. */
export function deleteWay(store: Store, id: number) {
  const w = store.doc.ways.get(id)
  if (!w) return
  store.commit('Удалить дорогу', (tx) => {
    tx.deleteWay(id)
    const stillUsed = new Set<number>()
    for (const other of store.doc.ways.values()) if (other.id !== id) for (const n of other.nodes) stillUsed.add(n)
    for (const nid of new Set(w.nodes)) {
      const node = store.doc.nodes.get(nid)
      if (node && !stillUsed.has(nid) && Object.keys(node.tags).length === 0) tx.deleteNode(nid)
    }
  })
}

/** Разрезать дорогу в узле `nodeId` на две. TODO(команда): сохранить участие в relations. */
export function splitWayAt(store: Store, wayId: number, nodeId: number) {
  const w = store.doc.ways.get(wayId)
  if (!w) return
  const i = w.nodes.indexOf(nodeId)
  if (i <= 0 || i >= w.nodes.length - 1) return
  store.commit('Разрезать дорогу', (tx) => {
    tx.setWay({ ...w, nodes: w.nodes.slice(0, i + 1) })
    tx.setWay({ id: tx.newId(), nodes: w.nodes.slice(i), tags: { ...w.tags }, meta: {} })
  })
}

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
