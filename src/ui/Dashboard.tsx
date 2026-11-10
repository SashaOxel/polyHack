import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { networkStats } from '../core/networkStats'
import { store } from '../core/store'
import { ROLE_LABEL, reachabilityFor, type ReachGroup } from '../core/reachability'
import type { Issue } from '../validate'
import { traffic } from './trafficController'

const fmt = (x: number, d = 1) => x.toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: x < 10 && d ? Math.min(d, 1) : 0 })

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  )
}

/** Горизонтальные столбики (один ряд — один цвет, без легенды), значение у конца столбика. */
function Bars({ title, rows, unit, muted }: { title: string; rows: { key: string; label: string; km: number }[]; unit: string; muted?: string }) {
  const [table, setTable] = useState(false)
  const max = Math.max(1e-9, ...rows.map((r) => r.km))
  return (
    <section className="chart">
      <div className="chart-head">
        <h4>{title}</h4>
        <button className="link" onClick={() => setTable(!table)}>{table ? 'График' : 'Таблица'}</button>
      </div>
      {table ? (
        <table className="data">
          <tbody>{rows.map((r) => <tr key={r.key}><td>{r.label}</td><td className="num">{fmt(r.km, 2)} {unit}</td></tr>)}</tbody>
        </table>
      ) : (
        <div className="bars">
          {rows.map((r) => (
            <div className="bar-row" key={r.key} title={`${r.label}: ${fmt(r.km, 2)} ${unit}`}>
              <span className="bar-label">{r.label}</span>
              <span className="bar-track">
                <span className={r.key === muted ? 'bar muted' : 'bar'} style={{ width: `${Math.max(1.5, (r.km / max) * 100)}%` }} />
                <span className="bar-value">{fmt(r.km)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** Живой график средней скорости во время демо-движения: линия 2 px, заливка 10 %, точка на конце, подсказка при наведении. */
function SpeedTrend() {
  useSyncExternalStore(traffic.subscribe, traffic.getVersion)
  const hist = useRef<{ t: number; v: number }[]>([])
  const [hover, setHover] = useState<number | null>(null)
  const st = traffic.sim?.stats()
  useEffect(() => {
    if (!st) { hist.current = []; return }
    const last = hist.current.at(-1)
    if (!last || st.time > last.t) hist.current = [...hist.current, { t: st.time, v: st.avgKmh }].slice(-120)
    if (last && st.time < last.t) hist.current = [{ t: st.time, v: st.avgKmh }] // модель пересоздана
  })
  if (!st) return <div className="hint small">Запустите «▶ Движение» внизу карты — здесь появится живой график средней скорости.</div>
  const pts = hist.current
  const W = 300, H = 70, P = 4
  const maxV = Math.max(20, ...pts.map((p) => p.v)) * 1.1
  const x = (i: number) => P + (pts.length > 1 ? (i / (pts.length - 1)) * (W - 2 * P) : 0)
  const y = (v: number) => H - P - (v / maxV) * (H - 2 * P)
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('')
  const area = pts.length > 1 ? `${line}L${x(pts.length - 1)},${H - P}L${x(0)},${H - P}Z` : ''
  const h = hover !== null ? pts[hover] : undefined
  return (
    <section className="chart">
      <div className="chart-head"><h4>Средняя скорость, км/ч</h4><span className="tile-sub">{st.count} машин · стоят {st.stopped}</span></div>
      <svg className="trend" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Средняя скорость в демо-движении"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          const i = Math.round(((e.clientX - r.left) / r.width * W - P) / (W - 2 * P) * (pts.length - 1))
          setHover(Math.max(0, Math.min(pts.length - 1, i)))
        }}
        onMouseLeave={() => setHover(null)}>
        <line x1={P} x2={W - P} y1={H - P} y2={H - P} className="axis" />
        {area && <path d={area} className="trend-area" />}
        {line && <path d={line} className="trend-line" />}
        {pts.length > 0 && <circle cx={x(pts.length - 1)} cy={y(pts.at(-1)!.v)} r={4} className="trend-dot" />}
        {h && hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={P} y2={H - P} className="crosshair" />
            <circle cx={x(hover)} cy={y(h.v)} r={4} className="trend-dot" />
          </g>
        )}
      </svg>
      <div className="trend-foot">
        {h ? <>t = {Math.round(h.t)} с · <b>{fmt(h.v)}</b> км/ч</> : <>сейчас <b>{fmt(st.avgKmh)}</b> км/ч</>}
      </div>
    </section>
  )
}

/** Обзор сети: ключевые цифры, длина по классам и по ограничению скорости, проблемы, живое движение. */
const ROLE_DOT = { trap: '#f97316', noEntry: '#a855f7', detached: '#ef4444' } as const

/**
 * Достижимость для машин: участки, куда нельзя доехать или откуда нельзя выехать. Из-за них в SUMO «машина не нашла маршрут»,
 * а в MatSim часть спроса обрывается. Участки у края карты — скорее всего обрезка выгрузки, не ошибка.
 */
function Reach({ onShow, onGo }: { onShow: () => void; onGo: (g: ReachGroup) => void }) {
  const r = reachabilityFor(store.doc, store.docVersion)
  const real = r.groups.filter((g) => !g.border), border = r.groups.filter((g) => g.border)
  const share = r.totalEdges ? Math.round((r.mainEdges / r.totalEdges) * 100) : 100
  return (
    <section className="chart reach">
      <div className="chart-head">
        <h4>Достижимость для машин</h4>
        <button className="link" onClick={onShow}>Показать на карте</button>
      </div>
      <div className="reach-sum">В главной сети <b>{share}%</b> рёбер · вне её <b>{fmt(r.realKm)} км</b> вероятных ошибок и {fmt(r.borderKm)} км у края карты</div>
      {real.length === 0 && <div className="note">Внутри карты недостижимых участков нет.</div>}
      <ul className="reach-list">
        {[...real, ...border].slice(0, 12).map((g) => {
          const names = [...new Set(g.wayIds.map((w) => store.doc.ways.get(w)?.tags.name).filter(Boolean))].slice(0, 2).join(', ')
          return (
            <li key={g.id} className={g.border ? 'border' : ''} onClick={() => onGo(g)} title={ROLE_LABEL[g.role]}>
              <i style={{ background: ROLE_DOT[g.role] }} />
              <span className="nm">{ROLE_LABEL[g.role].split(':')[0]}{names ? ` · ${names}` : ''}
                <small>{fmt(g.km, 2)} км{g.border ? ' · у края карты, вероятно обрезка' : ''}{g.links.length ? ` · стык: узел ${g.links.slice(0, 2).join(', ')}` : ''}</small>
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function Dashboard({ issues, onShowReach, onGoReach }: { issues: Issue[]; onShowReach: () => void; onGoReach: (g: ReachGroup) => void }) {
  useSyncExternalStore(store.subscribe, store.getVersion)
  const s = useMemo(() => networkStats(store.doc), [store.docVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!store.doc.nodes.size) return <div className="hint">Откройте файл — здесь появится обзор сети.</div>
  const errors = issues.filter((i) => i.severity === 'error').length
  const warns = issues.length - errors
  return (
    <div className="panel-body dashboard">
      <div className="tiles">
        <Tile label="Дороги для машин" value={`${fmt(s.roadKm)} км`} sub={`${s.roads} отрезков`} />
        <Tile label="Полосы" value={`${fmt(s.laneKm)} км`} sub={`в среднем ${fmt(s.laneKm / Math.max(s.roadKm, 1e-9))} полосы`} />
        <Tile label="Перекрёстки" value={String(s.junctions)} sub={`связность ${Math.round(s.connectivity * 100)}%`} />
        <Tile label="Светофоры" value={String(s.signals)} sub={`с планом ${s.signalsWithPlan}`} />
        <Tile label="Остановки" value={`${s.stopsLinked}/${s.stops}`} sub="привязаны к узлу" />
        <Tile label="Пешеходные · трамвай" value={`${fmt(s.pedKm)} · ${fmt(s.tramKm)} км`} sub={`переходов ${s.crossings}`} />
      </div>

      <div className="status-row">
        <span className={errors ? 'status err' : 'status ok'}>{errors ? '✕' : '✓'} ошибок {errors}</span>
        <span className={warns ? 'status warn' : 'status ok'}>{warns ? '!' : '✓'} предупреждений {warns}</span>
      </div>

      <Reach onShow={onShowReach} onGo={onGoReach} />
      <SpeedTrend />
      <Bars title="Длина по классам дорог, км" rows={s.byClass} unit="км" />
      <Bars title="Длина по ограничению скорости, км" rows={s.bySpeed} unit="км" muted="unset" />
    </div>
  )
}
