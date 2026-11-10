import { deleteRelation, deleteWays, linkStopToNode, mergeNodes, saveRoute } from '../core/ops'
import { readRoute } from '../core/routes'
import type { Store } from '../core/store'
import type { Fix, Issue } from './index'

/** Подпись кнопки исправления. */
export function fixLabel(fix: Fix): string {
  switch (fix.kind) {
    case 'delete-relation': return 'Удалить запрет'
    case 'merge-nodes': return 'Склеить узлы'
    case 'delete-ways': return `Удалить участок (${fix.ids.length})`
    case 'link-stop': return `Привязать к узлу № ${fix.anchor}`
    case 'rebuild-route': return 'Перестроить маршрут'
  }
}

/** Применить исправление. Каждое — один шаг undo. Повторное применение безопасно (ничего не делает). */
export function applyFix(store: Store, fix: Fix) {
  switch (fix.kind) {
    case 'delete-relation': return deleteRelation(store, fix.id)
    case 'merge-nodes': return mergeNodes(store, fix.keep, fix.remove)
    case 'delete-ways': return deleteWays(store, fix.ids)
    case 'rebuild-route': {
      const r = store.doc.relations.get(fix.id)
      if (!r) return
      const info = readRoute(store.doc, r)
      try { saveRoute(store, { kind: info.kind, ref: info.ref, name: r.tags.name, colour: r.tags.colour, stops: info.stops }, fix.id) } catch { /* пути нет — останется ошибкой */ }
      return
    }
    case 'link-stop': {
      // остановка могла быть уже привязана другим исправлением или вручную — тогда ничего не делаем
      try { linkStopToNode(store, fix.platform, fix.anchor) } catch { /* узел занят или остановка уже привязана */ }
      return
    }
  }
}

/** Применить все безопасные исправления одним шагом undo. Возвращает, сколько применено. */
export function applyAutoFixes(store: Store, issues: Issue[]): number {
  const todo = issues.filter((i) => i.auto && i.fix)
  if (!todo.length) return 0
  store.group(`Исправить автоматически (${todo.length})`, () => {
    for (const i of todo) applyFix(store, i.fix!)
  })
  return todo.length
}
