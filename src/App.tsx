import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { deleteWay, reverseWay } from './core/ops'
import { parseOsm } from './core/parse'
import { serializeOsm } from './core/serialize'
import { store } from './core/store'
import { hasErrors, validate, type Issue } from './validate'
import { AttributePanel } from './ui/AttributePanel'
import { IssuesPanel } from './ui/IssuesPanel'
import { MapView } from './ui/MapView'
import { downloadText, pickOsmFile } from './ui/files'
import { DEFAULT_TILE_URL } from './ui/tiles'

export function App() {
  const version = useSyncExternalStore(store.subscribe, store.getVersion)
  const [tab, setTab] = useState<'attrs' | 'issues'>('attrs')
  const [tiles, setTiles] = useState(true)
  const [tileUrl, setTileUrl] = useState(DEFAULT_TILE_URL)
  const [showPed, setShowPed] = useState(true)
  const [onlyRoads, setOnlyRoads] = useState(true)
  const [withPed, setWithPed] = useState(false)
  const [keepMeta, setKeepMeta] = useState(false)
  const [issues, setIssues] = useState<Issue[]>([])
  const [focus, setFocus] = useState<{ lat: number; lon: number; n: number } | null>(null)
  const [status, setStatus] = useState('Откройте файл .osm или загрузите пример')

  const load = useCallback((text: string, name: string) => {
    try {
      const t0 = performance.now()
      const doc = parseOsm(text)
      store.load(doc, name)
      setStatus(`${name}: ${doc.nodes.size} узлов, ${doc.ways.size} путей, ${doc.relations.size} relations (${Math.round(performance.now() - t0)} мс)`)
    } catch (e) {
      setStatus('Ошибка чтения файла: ' + (e as Error).message)
    }
  }, [])

  const open = useCallback(async () => {
    const f = await pickOsmFile()
    if (f) load(f.text, f.name)
  }, [load])

  const loadExample = async () => {
    const r = await fetch('example.osm')
    load(await r.text(), 'example.osm')
  }

  // перепроверка с небольшой задержкой после любых правок
  useEffect(() => {
    if (!store.doc.nodes.size) return
    const t = setTimeout(() => setIssues(validate(store.doc)), 300)
    return () => clearTimeout(t)
  }, [version])

  const save = useCallback(() => {
    if (!store.doc.nodes.size) return
    const found = validate(store.doc)
    setIssues(found)
    const errors = found.filter((i) => i.severity === 'error')
    const warns = found.length - errors.length
    if (found.length > 0) {
      const msg =
        `Перед сохранением найдено: ошибок ${errors.length}, предупреждений ${warns}.\n` +
        (hasErrors(found) ? errors.slice(0, 5).map((e) => '• ' + e.message).join('\n') + '\n' : '') +
        '\nСохранить всё равно?'
      if (!window.confirm(msg)) { setTab('issues'); return }
    }
    const text = serializeOsm(store.doc, { onlyRoads, includePedestrian: withPed, keepMeta })
    const base = store.fileName.replace(/\.osm$/i, '').replace(/\.edited$/i, '')
    downloadText(`${base}.edited.osm`, text)
    store.dirty = false
    setStatus(`Сохранено ${base}.edited.osm (${(text.length / 1e6).toFixed(1)} МБ)`)
  }, [onlyRoads, withPed, keepMeta])

  // горячие клавиши
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      const sel = store.selection
      if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo() }
      else if (mod && key === 'y') { e.preventDefault(); store.redo() }
      else if (mod && key === 's') { e.preventDefault(); save() }
      else if (mod && key === 'o') { e.preventDefault(); open() }
      else if (e.key === 'Escape') store.select(null)
      else if (sel?.kind === 'way' && key === 'r' && !mod) reverseWay(store, sel.id)
      else if (sel?.kind === 'way' && (e.key === 'Delete' || e.key === 'Backspace')) { deleteWay(store, sel.id); store.select(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save, open])

  const focusIssue = (i: Issue) => {
    const wayFirst = i.wayIds?.[0] ? store.doc.ways.get(i.wayIds[0]) : undefined
    const p = i.at ?? (wayFirst ? store.doc.nodes.get(wayFirst.nodes[0]) : undefined)
    if (p) setFocus({ lat: p.lat, lon: p.lon, n: Date.now() })
    if (i.wayIds?.[0]) store.select({ kind: 'way', id: i.wayIds[0] })
  }

  const errCount = useMemo(() => issues.filter((i) => i.severity === 'error').length, [issues])
  const loaded = store.doc.nodes.size > 0

  return (
    <div className="app">
      <header>
        <b>Редактор УДС</b>
        <button onClick={open}>Открыть</button>
        <button onClick={loadExample}>Пример</button>
        <button onClick={save} disabled={!loaded}>Сохранить</button>
        <span className="sep" />
        <button onClick={() => store.undo()} disabled={!store.canUndo} title="Ctrl+Z">↶ Отменить</button>
        <button onClick={() => store.redo()} disabled={!store.canRedo} title="Ctrl+Shift+Z">↷ Вернуть</button>
        <span className="sep" />
        <label><input type="checkbox" checked={showPed} onChange={(e) => setShowPed(e.target.checked)} /> пешеходные</label>
        <label><input type="checkbox" checked={tiles} onChange={(e) => setTiles(e.target.checked)} /> подложка</label>
        <input className="tileurl" value={tileUrl} onChange={(e) => setTileUrl(e.target.value)} title="Шаблон URL тайлов {z}/{x}/{y}" />
        <span className="sep" />
        <span className="export">
          Экспорт:
          <label><input type="checkbox" checked={onlyRoads} onChange={(e) => setOnlyRoads(e.target.checked)} /> только дороги</label>
          <label><input type="checkbox" checked={withPed} disabled={!onlyRoads} onChange={(e) => setWithPed(e.target.checked)} /> + пешеходные</label>
          <label><input type="checkbox" checked={keepMeta} onChange={(e) => setKeepMeta(e.target.checked)} /> метаданные</label>
        </span>
      </header>

      <main>
        <MapView tileUrl={tiles ? tileUrl : ''} issues={issues} showPedestrian={showPed} focus={focus} />
        {!loaded && <div className="empty">Откройте файл .osm или нажмите «Пример»</div>}
        <aside>
          <nav>
            <button className={tab === 'attrs' ? 'active' : ''} onClick={() => setTab('attrs')}>Атрибуты</button>
            <button className={tab === 'issues' ? 'active' : ''} onClick={() => setTab('issues')}>
              Проблемы {issues.length ? `(${issues.length})` : ''}{errCount ? ' ●' : ''}
            </button>
          </nav>
          {tab === 'attrs' ? <AttributePanel /> : <IssuesPanel issues={issues} onFocus={focusIssue} />}
        </aside>
      </main>

      <footer>
        <span>{status}{store.dirty ? ' · есть несохранённые изменения' : ''}</span>
        <span className="keys">Ctrl+O открыть · Ctrl+S сохранить · Ctrl+Z / Ctrl+Shift+Z · R развернуть · Del удалить · Esc снять выделение</span>
      </footer>
    </div>
  )
}
