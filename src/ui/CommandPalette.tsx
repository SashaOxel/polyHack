import { useEffect, useMemo, useRef, useState } from 'react'
import { normalize, searchDoc, type SearchHit } from '../core/search'
import { store } from '../core/store'

export interface Command {
  id: string
  label: string
  /** горячая клавиша для подсказки справа */
  hint?: string
  /** доп. слова для поиска (синонимы, английские названия) */
  keywords?: string
  icon?: string
  run: () => void
}

type Item = { type: 'cmd'; cmd: Command } | { type: 'hit'; hit: SearchHit }

const HIT_ICON: Record<SearchHit['kind'], string> = { street: '🛣', stop: '🚏', route: '🚌', node: '•', way: '〰' }
const HIT_GROUP: Record<SearchHit['kind'], string> = { street: 'Улицы', stop: 'Остановки', route: 'Маршруты', node: 'Узлы', way: 'Дороги' }

/**
 * Командная палитра (Ctrl+K): один поиск по действиям редактора и по карте — улицы, остановки, маршруты,
 * номера узлов и дорог. Стрелки — выбор, Enter — выполнить, Esc — закрыть.
 */
export function CommandPalette({ commands, onPick, onClose }: { commands: Command[]; onPick: (hit: SearchHit) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { input.current?.focus() }, [])

  const items: Item[] = useMemo(() => {
    const nq = normalize(q)
    const words = nq.split(' ').filter(Boolean)
    const cmds = commands
      .filter((c) => !words.length || words.every((w) => normalize(`${c.label} ${c.keywords ?? ''}`).includes(w)))
      .slice(0, nq ? 6 : 12)
      .map((cmd) => ({ type: 'cmd' as const, cmd }))
    const hits = nq.length >= 2 ? searchDoc(store.doc, store.docVersion, q, 8).map((hit) => ({ type: 'hit' as const, hit })) : []
    // если ищут место на карте — результаты карты выше действий
    return hits.length && hits[0].hit.score >= 2 ? [...hits, ...cmds] : [...cmds, ...hits]
  }, [q, commands])

  useEffect(() => { setActive(0) }, [q])
  useEffect(() => { list.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' }) }, [active])

  const run = (it: Item | undefined) => {
    if (!it) return
    onClose()
    if (it.type === 'cmd') it.cmd.run(); else onPick(it.hit)
  }

  let lastGroup = ''
  return (
    <div className="palette-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="cmdk" role="dialog" aria-label="Командная палитра">
        <input
          ref={input} value={q} placeholder="Улица, остановка, маршрут, № узла или действие: «светофор», «3D», «ночь», «движение»…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
            else if (e.key === 'Enter') { e.preventDefault(); run(items[active]) }
            else if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) { e.preventDefault(); onClose() }
          }}
        />
        <div className="cmdk-list" ref={list} role="listbox">
          {items.length === 0 && <div className="cmdk-empty">Ничего не найдено</div>}
          {items.map((it, i) => {
            const group = it.type === 'cmd' ? 'Действия' : HIT_GROUP[it.hit.kind]
            const head = group !== lastGroup ? <div className="cmdk-group" key={`g${i}`}>{group}</div> : null
            lastGroup = group
            return (
              <div key={i}>
                {head}
                <div role="option" aria-selected={i === active} className={i === active ? 'cmdk-item active' : 'cmdk-item'}
                  onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); run(it) }}>
                  <span className="ic">{it.type === 'cmd' ? it.cmd.icon ?? '›' : HIT_ICON[it.hit.kind]}</span>
                  <span className="tx">
                    {it.type === 'cmd' ? it.cmd.label : it.hit.label}
                    {it.type === 'hit' && <small>{it.hit.sub}</small>}
                  </span>
                  {it.type === 'cmd' && it.cmd.hint && <kbd>{it.cmd.hint}</kbd>}
                </div>
              </div>
            )
          })}
        </div>
        <div className="cmdk-foot"><kbd>↑</kbd><kbd>↓</kbd> выбрать · <kbd>Enter</kbd> выполнить · <kbd>Esc</kbd> закрыть</div>
      </div>
    </div>
  )
}
