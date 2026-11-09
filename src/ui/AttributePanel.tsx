import { useEffect, useState, useSyncExternalStore } from 'react'
import { deleteWay, reverseWay, setTags } from '../core/ops'
import { store } from '../core/store'
import type { Tags } from '../core/types'

/** Шаблоны дорог: один клик ставит типовой набор тегов. Добавляйте свои. */
const TEMPLATES: { name: string; tags: Tags }[] = [
  { name: 'Магистраль 3 полосы', tags: { highway: 'primary', lanes: '3', maxspeed: '60' } },
  { name: 'Улица 2 полосы', tags: { highway: 'secondary', lanes: '2', maxspeed: '60' } },
  { name: 'Жилая улица', tags: { highway: 'residential', lanes: '2', maxspeed: '40' } },
  { name: 'Одностороння 2 полосы', tags: { highway: 'secondary', lanes: '2', oneway: 'yes', maxspeed: '60' } },
  { name: 'Мост', tags: { bridge: 'yes', layer: '1' } },
]

const HIGHWAYS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'service',
  'primary_link', 'secondary_link', 'living_street', 'footway']

export function AttributePanel() {
  useSyncExternalStore(store.subscribe, store.getVersion)
  const sel = store.selection
  const el = sel?.kind === 'way' ? store.doc.ways.get(sel.id) : sel?.kind === 'node' ? store.doc.nodes.get(sel.id) : undefined
  const [rows, setRows] = useState<[string, string][]>([])

  useEffect(() => {
    setRows(el ? Object.entries(el.tags) : [])
  }, [el, store.version])

  if (!sel || !el) {
    return <div className="hint">Выберите узел или дорогу на карте.<br />Узел можно перетащить мышью.</div>
  }

  const kind = sel.kind as 'node' | 'way'
  const apply = (tags: Tags) => setTags(store, kind, sel.id, tags)
  const commitRows = (r: [string, string][]) => apply(Object.fromEntries(r))
  const patch = (p: Tags) => apply({ ...el.tags, ...p })

  return (
    <div className="panel-body">
      <h3>{kind === 'way' ? 'Дорога' : 'Узел'} {sel.id}</h3>

      {kind === 'way' && (
        <>
          <div className="row">
            <label>Класс
              <select value={el.tags.highway ?? ''} onChange={(e) => patch({ highway: e.target.value })}>
                <option value="">—</option>
                {HIGHWAYS.map((h) => <option key={h}>{h}</option>)}
              </select>
            </label>
            <label>Полосы
              <input type="number" min={1} max={8} value={el.tags.lanes ?? ''}
                onChange={(e) => patch({ lanes: e.target.value })} />
            </label>
            <label>Скорость
              <input type="number" min={5} max={130} step={5} value={el.tags.maxspeed ?? ''}
                onChange={(e) => patch({ maxspeed: e.target.value })} />
            </label>
          </div>
          <div className="row">
            <button onClick={() => patch({ oneway: el.tags.oneway === 'yes' ? 'no' : 'yes' })}>
              Односторонняя: {el.tags.oneway === 'yes' ? 'да' : 'нет'}
            </button>
            <button onClick={() => reverseWay(store, sel.id)} title="R">Развернуть (R)</button>
            <button className="danger" onClick={() => { deleteWay(store, sel.id); store.select(null) }} title="Delete">Удалить</button>
          </div>
          <div className="sub">Шаблоны</div>
          <div className="row wrap">
            {TEMPLATES.map((t) => <button key={t.name} onClick={() => patch(t.tags)}>{t.name}</button>)}
          </div>
        </>
      )}

      {kind === 'node' && (
        <div className="row wrap">
          <button onClick={() => patch({ highway: 'traffic_signals' })}>Светофор</button>
          <button onClick={() => patch({ highway: 'crossing' })}>Переход</button>
          <button onClick={() => { const t = { ...el.tags }; delete t.highway; apply(t) }}>Убрать highway</button>
        </div>
      )}

      <div className="sub">Теги</div>
      <table className="tags">
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={i}>
              <td><input value={k} onChange={(e) => setRows(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
                onBlur={() => commitRows(rows)} /></td>
              <td><input value={v} onChange={(e) => setRows(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
                onBlur={() => commitRows(rows)} /></td>
              <td><button onClick={() => commitRows(rows.filter((_, j) => j !== i))}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={() => setRows([...rows, ['', '']])}>+ тег</button>
    </div>
  )
}
