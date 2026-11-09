import { useEffect, useState, useSyncExternalStore } from 'react'
import { cumulativeDistance, elevationContext, wayElevations } from '../core/elevation'
import { clearElevation, setElevationRamp } from '../core/ops'
import { store } from '../core/store'

const round1 = (v: number) => Math.round(v * 10) / 10

/** Редактор высоты (Z) выбранной дороги: плавный переход от начала к концу, виден в режиме 3D. */
export function ElevationEditor({ wayId }: { wayId: number }) {
  useSyncExternalStore(store.subscribe, store.getVersion)
  const way = store.doc.ways.get(wayId)
  const z = way ? wayElevations(store.doc, way, elevationContext(store.doc)) : []
  const length = way ? cumulativeDistance(store.doc, way).at(-1) ?? 0 : 0
  const curFrom = z.length ? round1(z[0]) : 0
  const curTo = z.length ? round1(z[z.length - 1]) : 0

  const [from, setFrom] = useState(String(curFrom))
  const [to, setTo] = useState(String(curTo))
  // подставляем текущие значения при выборе другой дороги и после любой правки документа
  useEffect(() => { setFrom(String(curFrom)); setTo(String(curTo)) }, [wayId, store.docVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  const f = parseFloat(from), t = parseFloat(to)
  const valid = Number.isFinite(f) && Number.isFinite(t)
  const grade = valid && length > 0 ? (Math.abs(t - f) / length) * 100 : 0
  const hasEle = !!way && way.nodes.some((id) => store.doc.nodes.get(id)?.tags.ele !== undefined)

  return (
    <>
      <div className="sub">Высота (Z)</div>
      <div className="row">
        <label>Начало, м
          <input type="number" step={0.5} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>Конец, м
          <input type="number" step={0.5} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button disabled={!valid} onClick={() => setElevationRamp(store, wayId, f, t)}
          title="Высоты узлов дороги меняются линейно по расстоянию. Пишутся в тег ele">Плавный переход</button>
        <button disabled={!hasEle} onClick={() => clearElevation(store, wayId)}>Сбросить Z</button>
      </div>
      <div className={grade > 10 ? 'note warn' : 'note'}>
        Длина {Math.round(length)} м · уклон {grade.toFixed(1)}%{grade > 10 ? ' — слишком крутой для дороги' : ''}
        {!hasEle && (way?.tags.bridge || way?.tags.tunnel) ? ' · высота моста/тоннеля считается по layer автоматически' : ''}
      </div>
    </>
  )
}
