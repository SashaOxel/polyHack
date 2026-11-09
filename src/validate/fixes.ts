import { deleteRelation, deleteWays, mergeNodes } from '../core/ops'
import type { Store } from '../core/store'
import type { Fix, Issue } from './index'

/** Подпись кнопки исправления. */
export function fixLabel(fix: Fix): string {
  switch (fix.kind) {
    case 'delete-relation': return 'Удалить запрет'
    case 'merge-nodes': return 'Склеить узлы'
    case 'delete-ways': return `Удалить участок (${fix.ids.length})`
  }
}

/** Применить исправление. Каждое — один шаг undo. Повторное применение безопасно (ничего не делает). */
export function applyFix(store: Store, fix: Fix) {
  switch (fix.kind) {
    case 'delete-relation': return deleteRelation(store, fix.id)
    case 'merge-nodes': return mergeNodes(store, fix.keep, fix.remove)
    case 'delete-ways': return deleteWays(store, fix.ids)
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
