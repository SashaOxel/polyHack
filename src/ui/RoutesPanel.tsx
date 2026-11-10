import { useState, useSyncExternalStore } from 'react'
import { deleteRoute, saveRoute } from '../core/ops'
import { listRoutes, resolveStop, ROUTE_COLORS, ROUTE_KIND_RU, type RouteKind } from '../core/routes'
import { store } from '../core/store'
import { routeUi } from './routeUi'

const KIND_ICON: Record<RouteKind, string> = { bus: '🚌', tram: '🚋' }
const km = (m: number) => (m / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })

/**
 * Маршруты общественного транспорта: список, создание и правка.
 * Остановки добавляются кликом по карте (режим «Выбирать на карте») или по номеру узла.
 */
export function RoutesPanel({ onHint }: { onHint: (msg: string) => void }) {
  useSyncExternalStore(store.subscribe, store.getVersion)
  useSyncExternalStore(routeUi.subscribe, routeUi.getVersion)
  const [nodeInput, setNodeInput] = useState('')
  const [error, setError] = useState('')
  const routes = listRoutes(store.doc)
  const d = routeUi.draft

  if (!store.doc.nodes.size) return <div className="hint">Откройте файл — здесь можно будет создавать маршруты автобусов и трамваев.</div>

  // ---------- форма маршрута ----------
  if (d) {
    const path = routeUi.path(d.stops, d.kind)
    const broken = new Set(path?.broken ?? [])
    const move = (i: number, j: number) => {
      const stops = [...d.stops]
      ;[stops[i], stops[j]] = [stops[j], stops[i]]
      routeUi.update({ stops })
    }
    const addByNumber = () => {
      const id = Number(nodeInput.trim())
      const stop = Number.isSafeInteger(id) ? resolveStop(store.doc, id, d.kind) : undefined
      if (!stop) { setError(`Узел № ${nodeInput} не ${d.kind === 'tram' ? 'на трамвайных путях' : 'на дороге и не остановка'}`); return }
      routeUi.addStop(stop); setNodeInput(''); setError('')
    }
    const save = () => {
      try {
        const id = saveRoute(store, { kind: d.kind, ref: d.ref, name: d.name, colour: d.colour, stops: d.stops }, d.id)
        routeUi.edit(undefined)
        routeUi.select(id)
        setError('')
        onHint(`Маршрут ${d.ref} сохранён — он попадёт в .osm`)
      } catch (e) { setError((e as Error).message) }
    }
    return (
      <div className="panel-body routes">
        <h3>{d.id ? `Маршрут ${d.ref}` : 'Новый маршрут'}</h3>
        <div className="seg kind-seg">
          {(['bus', 'tram'] as RouteKind[]).map((k) => (
            <button key={k} className={d.kind === k ? 'active' : ''} disabled={!!d.id && d.kind !== k}
              onClick={() => routeUi.update({ kind: k, stops: k === d.kind ? d.stops : [] })}>{KIND_ICON[k]} {ROUTE_KIND_RU[k]}</button>
          ))}
        </div>
        <div className="row">
          <label>Номер<input value={d.ref} placeholder="80" onChange={(e) => routeUi.update({ ref: e.target.value })} /></label>
          <label className="grow">Название (необязательно)<input value={d.name} placeholder="само по остановкам" onChange={(e) => routeUi.update({ name: e.target.value })} /></label>
        </div>
        <div className="swatches" role="radiogroup" aria-label="Цвет маршрута">
          {ROUTE_COLORS.map((c) => (
            <button key={c} role="radio" aria-checked={d.colour === c} className={d.colour === c ? 'sw on' : 'sw'} style={{ background: c }}
              title={c} onClick={() => routeUi.update({ colour: c })} />
          ))}
        </div>

        <div className="sub">Остановки по порядку</div>
        {d.stops.length === 0 && <div className="note">Кликайте по остановкам на карте {d.kind === 'bus' ? '(значок «А» или узел дороги)' : '(узлы трамвайных путей)'} — они добавятся по порядку.</div>}
        <ol className="stop-list">
          {d.stops.map((s, i) => (
            <li key={`${s.node}-${i}`} className={broken.has(i) ? 'leg-broken' : ''}>
              <span className="num" style={{ background: d.colour }}>{i + 1}</span>
              <span className="nm">{s.name}<small>узел {s.node}</small></span>
              <button disabled={i === 0} onClick={() => move(i, i - 1)} title="Выше">↑</button>
              <button disabled={i === d.stops.length - 1} onClick={() => move(i, i + 1)} title="Ниже">↓</button>
              <button onClick={() => routeUi.update({ stops: d.stops.filter((_, j) => j !== i) })} title="Убрать">×</button>
            </li>
          ))}
        </ol>
        {broken.size > 0 && <div className="error-text">Нет пути после остановок: {[...broken].map((i) => `${i + 1}→${i + 2}`).join(', ')}. {d.kind === 'bus' ? 'Проверьте одностороннее движение.' : 'Остановки должны быть на связанных трамвайных путях.'}</div>}
        {path && !broken.size && <div className="note strong">Длина маршрута {km(path.meters)} км · {path.ways.length} участков дорог</div>}

        <div className="row">
          <button className={routeUi.picking ? 'btn primary' : 'btn'} onClick={() => routeUi.setPicking(!routeUi.picking)}>
            {routeUi.picking ? '◉ Выбор на карте…' : '◎ Выбирать на карте'}
          </button>
        </div>
        <div className="row">
          <label className="grow">или № узла<input inputMode="numeric" value={nodeInput} onChange={(e) => setNodeInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addByNumber() }} /></label>
          <button onClick={addByNumber}>Добавить</button>
        </div>
        {error && <div className="error-text">{error}</div>}
        <div className="row">
          <button className="btn primary" onClick={save}>Сохранить маршрут</button>
          <button onClick={() => { routeUi.edit(undefined); setError('') }}>Отмена</button>
        </div>
      </div>
    )
  }

  // ---------- список ----------
  const mine = routes.filter((r) => r.editable), fromFile = routes.filter((r) => !r.editable)
  const startNew = (kind: RouteKind) => routeUi.edit(routeUi.newDraft(kind, mine.length))
  const row = (r: (typeof routes)[number]) => (
    <li key={r.id} className={routeUi.selected === r.id ? 'route on' : 'route'} onClick={() => routeUi.select(routeUi.selected === r.id ? undefined : r.id)}>
      <span className="badge-route" style={{ background: r.colour }}>{r.ref || '—'}</span>
      <span className="nm">{KIND_ICON[r.kind]} {r.name || ROUTE_KIND_RU[r.kind]}<small>{r.stops.length} остановок{r.editable ? '' : ' · из файла, только просмотр'}</small></span>
      {r.editable && (
        <span className="acts" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => routeUi.edit({ id: r.id, kind: r.kind, ref: r.ref, name: store.doc.relations.get(r.id)?.tags.name ?? '', colour: r.colour, stops: r.stops })}>Изменить</button>
          <button className="danger" onClick={() => { if (window.confirm(`Удалить маршрут ${r.ref}?`)) { deleteRoute(store, r.id); routeUi.select(undefined) } }}>×</button>
        </span>
      )}
    </li>
  )
  return (
    <div className="panel-body routes">
      <div className="row">
        <button className="btn primary" onClick={() => startNew('bus')}>🚌 Новый автобус</button>
        <button className="btn primary" onClick={() => startNew('tram')}>🚋 Новый трамвай</button>
      </div>
      <div className="sub">Маршруты редактора · {mine.length}</div>
      {mine.length ? <ul className="route-list">{mine.map(row)}</ul> : <div className="note">Пока нет. Создайте маршрут и укажите остановки по порядку — путь между ними построится сам.</div>}
      {fromFile.length > 0 && (
        <details className="from-file">
          <summary className="sub">Из файла · {fromFile.length} (только просмотр)</summary>
          <ul className="route-list">{fromFile.map(row)}</ul>
        </details>
      )}
      <div className="note">Маршрут сохраняется в .osm как relation route=bus|tram (Public Transport v2). SUMO читает его как линию общественного транспорта.</div>
    </div>
  )
}
