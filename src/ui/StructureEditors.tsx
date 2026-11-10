import { setTags, setWayLevel } from '../core/ops'
import { PARKING_TYPES, wayLevel } from '../core/roads'
import { store } from '../core/store'
import type { OsmWay } from '../core/types'

/** Уровень дороги: на земле, мост, тоннель (+ номер уровня layer). */
export function LevelEditor({ way }: { way: OsmWay }) {
  const level = wayLevel(way)
  const layer = Number(way.tags.layer) || (level === 'bridge' ? 1 : level === 'tunnel' ? -1 : 0)
  return (
    <>
      <div className="sub">Уровень</div>
      <div className="row">
        <div className="seg">
          {([['ground', 'На земле'], ['bridge', '🌉 Мост'], ['tunnel', '🕳 Тоннель']] as const).map(([k, l]) => (
            <button key={k} className={level === k ? 'active' : ''} onClick={() => level !== k && setWayLevel(store, way.id, k)}>{l}</button>
          ))}
        </div>
        {level !== 'ground' && (
          <label className="narrow">Уровень (layer)
            <input type="number" min={level === 'bridge' ? 1 : -5} max={level === 'bridge' ? 5 : -1} value={layer}
              onChange={(e) => setWayLevel(store, way.id, level, Number(e.target.value))} />
          </label>
        )}
      </div>
      {way.tags.tunnel === 'building_passage' && <div className="note">Проход сквозь здание (tunnel=building_passage) — на уровне земли.</div>}
    </>
  )
}

/** Свойства парковки: тип, вместимость, платная. */
export function ParkingEditor({ way }: { way: OsmWay }) {
  const patch = (p: Record<string, string>) => {
    const tags = { ...way.tags, ...p }
    setTags(store, 'way', way.id, tags) // пустое значение удаляет тег
  }
  return (
    <>
      <div className="sub">Парковка</div>
      <div className="row wrap">
        <div className="seg">
          {PARKING_TYPES.map((t) => (
            <button key={t.key} className={(way.tags.parking ?? 'surface') === t.key ? 'active' : ''} onClick={() => patch({ parking: t.key })}>{t.label}</button>
          ))}
        </div>
      </div>
      <div className="row">
        <label>Мест<input type="number" min={0} value={way.tags.capacity ?? ''} onChange={(e) => patch({ capacity: e.target.value })} /></label>
        <label>Этажей<input type="number" min={1} value={way.tags['building:levels'] ?? ''} disabled={way.tags.parking !== 'multi-storey'}
          onChange={(e) => patch({ 'building:levels': e.target.value })} /></label>
        <label>Оплата
          <select value={way.tags.fee ?? ''} onChange={(e) => patch({ fee: e.target.value })}>
            <option value="">—</option><option value="no">бесплатная</option><option value="yes">платная</option>
          </select>
        </label>
      </div>
    </>
  )
}
