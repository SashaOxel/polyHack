import { useEffect, useState } from 'react'
import { linkStopToNode } from '../core/ops'
import { store } from '../core/store'
import { stopsAt } from '../core/stops'

/**
 * Привязка остановки к узлу дороги по номеру узла.
 * platformId — место посадки (значок «А»); если остановка уже привязана, она переносится на новый узел.
 */
export function StopLinkEditor({ platformId }: { platformId: number }) {
  const current = stopsAt(store.doc, platformId).find((s) => s.platform === platformId)
  const [value, setValue] = useState(current ? String(current.anchor) : '')
  const [error, setError] = useState('')
  useEffect(() => { setValue(current ? String(current.anchor) : ''); setError('') }, [platformId, current?.anchor]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    const id = Number(value.trim())
    if (!Number.isSafeInteger(id) || id <= 0) { setError('Введите номер узла — целое положительное число'); return }
    try {
      linkStopToNode(store, platformId, id)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="stop-details">
      <strong>{current ? `Привязана к узлу № ${current.anchor}` : 'Не привязана к дороге'}</strong>
      <div className="stop-link">
        <label>Номер узла дороги
          <input inputMode="numeric" value={value} placeholder="например, 2412345678"
            onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
        </label>
        <button className="btn primary" onClick={submit}>{current ? 'Перепривязать' : 'Привязать'}</button>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="note">Номер узла видно, если включить слой «Номера узлов». Значок «А» можно перетащить мышью.</div>
    </div>
  )
}
