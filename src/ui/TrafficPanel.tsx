import { useSyncExternalStore } from 'react'
import { store } from '../core/store'
import { traffic } from './trafficController'

const mmss = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`

/** Пульт демо-движения: старт/пауза, ускорение времени, число машин, живая сводка. */
export function TrafficPanel() {
  useSyncExternalStore(traffic.subscribe, traffic.getVersion)
  useSyncExternalStore(store.subscribe, store.getVersion)
  if (!store.doc.nodes.size) return null
  const st = traffic.sim?.stats()
  return (
    <div className="traffic-panel">
      <button className={traffic.running ? 'btn sim-btn on' : 'btn sim-btn'} onClick={() => (traffic.running ? traffic.pause() : traffic.start())}
        title="Демо-движение машин по сети с учётом светофоров (не замена SUMO)">
        {traffic.running ? '⏸ Пауза' : '▶ Движение'}
      </button>
      <label title="Ускорение времени">
        <span>Время</span>
        <select value={traffic.speed} onChange={(e) => traffic.setSpeed(Number(e.target.value))}>
          {[1, 2, 5, 10, 20].map((x) => <option key={x} value={x}>×{x}</option>)}
        </select>
      </label>
      <label title="Сколько машин в сети">
        <span>Машин</span>
        <select value={traffic.count} onChange={(e) => traffic.setCount(Number(e.target.value))}>
          {[50, 150, 300, 600, 1000].map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      </label>
      {st && (
        <div className="sim-stats">
          <b>{st.count}</b> машин · <b>{Math.round(st.avgKmh)}</b> км/ч · стоят <b>{st.stopped}</b> · <span className="mono">{mmss(st.time)}</span>
        </div>
      )}
      {st && (
        <div className="heat-legend" title="Загруженность: средняя скорость относительно ограничения (слой «Загруженность»)">
          <span>свободно</span><i /><span>пробка</span>
        </div>
      )}
      {traffic.sim && <button className="btn icon" title="Убрать машины" onClick={() => traffic.stop()}>■</button>}
    </div>
  )
}
