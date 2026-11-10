import { stopsAt } from '../core/stops'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { deleteNode, deleteWay, featureTags, reverseWay, setTags, splitAtNode } from '../core/ops'
import { store } from '../core/store'
import { speedLimit } from '../core/roads'
import { ROAD_TEMPLATES } from '../core/templates'
import type { OsmWay, Tags } from '../core/types'
import { ElevationEditor } from './ElevationEditor'

const HIGHWAYS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'service',
  'primary_link', 'secondary_link', 'living_street', 'footway', 'pedestrian', 'steps', 'path']

/** Текст про ограничение скорости под полем ввода. */
function describeSpeed(s: ReturnType<typeof speedLimit>, highway?: string): string {
  const dir = s.forward != null || s.backward != null
    ? ` · туда ${s.forward ?? '—'} / обратно ${s.backward ?? '—'}` : ''
  if (s.source === 'default') {
    return s.kmh
      ? `Ограничение не задано в OSM. SUMO подставит ${s.kmh} км/ч по классу «${highway ?? '?'}»${s.raw ? ` (значение «${s.raw}» не распознано)` : ''}`
      : 'Ограничение не задано в OSM'
  }
  if (s.kmh === null) return `Ограничения нет (maxspeed=${s.raw})${dir}`
  if (s.source === 'zone') return `Ограничение ${s.kmh} км/ч (зона ${s.raw})${dir}`
  return `Ограничение ${s.kmh} км/ч${s.raw && s.raw !== String(s.kmh) ? ` (maxspeed=${s.raw})` : ''}${dir}`
}

export function AttributePanel() {
  useSyncExternalStore(store.subscribe, store.getVersion)
  const sel = store.selection
  const el = sel?.kind === 'way' ? store.doc.ways.get(sel.id) : sel?.kind === 'node' ? store.doc.nodes.get(sel.id) : undefined
  const selectedStops = sel?.kind === 'node' ? stopsAt(store.doc, sel.id) : []
  const [rows, setRows] = useState<[string, string][]>([])

  useEffect(() => {
    setRows(el ? Object.entries(el.tags) : [])
  }, [el, store.version])

  if (!sel || !el) {
    return <div className="hint">Выберите узел или дорогу на карте.<br />Узел можно перетащить мышью.</div>
  }

  const kind = sel.kind as 'node' | 'way'
  const speed = speedLimit(el as OsmWay)
  const apply = (tags: Tags) => setTags(store, kind, sel.id, tags)
  const commitRows = (r: [string, string][]) => apply(Object.fromEntries(r))
  const patch = (p: Tags) => apply({ ...el.tags, ...p })

  return (
    <div className="panel-body">
      <h3>{selectedStops.length ? 'Остановка · опорный узел № ' + selectedStops[0].anchor :
        (kind === 'way' ? 'Отрезок дороги ' : 'Узел ') + sel.id}</h3>
      {kind === 'way' && 'nodes' in el && el.nodes.length === 2 && (
        <div className="note">Границы отрезка · узлы {el.nodes[0]} и {el.nodes[1]}</div>
      )}

      {selectedStops.map(stop => (
        <div className="stop-details" key={stop.area}>
          <strong>Автобусная остановка</strong>
          <div>Пункт остановки · опорный узел № {stop.anchor}</div>
          <div>Потяните значок остановки, чтобы переместить место посадки.</div>
        </div>
      ))}
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
            <label>Скорость, км/ч
              <input value={el.tags.maxspeed ?? ''} placeholder={speed.source === 'default' && speed.kmh ? `${speed.kmh}` : ''}
                onChange={(e) => patch({ maxspeed: e.target.value })} />
            </label>
          </div>
          <div className="chips">
            {[20, 30, 40, 50, 60, 70, 80, 90].map((v) => (
              <button key={v} className={speed.source !== 'default' && speed.kmh === v ? 'on' : ''} onClick={() => patch({ maxspeed: String(v) })}>{v}</button>
            ))}
          </div>
          <div className={speed.source === 'default' ? 'note' : 'note strong'}>{describeSpeed(speed, el.tags.highway)}</div>
          <div className="row">
            <button onClick={() => patch({ oneway: el.tags.oneway === 'yes' ? 'no' : 'yes' })}>
              Односторонняя: {el.tags.oneway === 'yes' ? 'да' : 'нет'}
            </button>
            <button onClick={() => reverseWay(store, sel.id)} title="R">Развернуть (R)</button>
            <button className="danger" onClick={() => { deleteWay(store, sel.id); store.select(null) }} title="Delete">Удалить</button>
          </div>
          <div className="sub">Шаблоны</div>
          <div className="row wrap">
            {ROAD_TEMPLATES.map((t) => <button key={t.name} onClick={() => patch(t.tags)}>{t.name}</button>)}
          </div>
          <ElevationEditor wayId={sel.id} />
        </>
      )}

      {kind === 'node' && (
        <div className="row wrap">
          <button onClick={() => apply(featureTags(el.tags, 'signal'))}>Светофор</button>
          <button onClick={() => apply(featureTags(el.tags, 'crossing'))}>Переход</button>
          <button onClick={() => { const t = { ...el.tags }; delete t.highway; apply(t) }}>Убрать highway</button>
          <button onClick={() => splitAtNode(store, sel.id)} title="S">Разрезать в узле (S)</button>
          <button className="danger" onClick={() => { deleteNode(store, sel.id); store.select(null) }} title="Delete">Удалить узел</button>
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
