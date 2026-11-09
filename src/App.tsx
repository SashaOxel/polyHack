import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { deleteNode, deleteWay, reverseWay, splitAtNode } from './core/ops'
import { parseOsm } from './core/parse'
import { serializeOsm } from './core/serialize'
import { store } from './core/store'
import { DRAW_TEMPLATES } from './core/templates'
import { hasErrors, validate, type Issue } from './validate'
import { applyAutoFixes, applyFix } from './validate/fixes'
import { AttributePanel } from './ui/AttributePanel'
import { IssuesPanel } from './ui/IssuesPanel'
import { MapView, type Tool } from './ui/MapView'
import { downloadText, pickOsmFile } from './ui/files'
import { Icon } from './ui/icons'
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
  const [allIssues, setIssues] = useState<Issue[]>([])
  const [ignored, setIgnored] = useState<Set<string>>(new Set())
  // скрытые пользователем проблемы не показываем и не считаем при сохранении
  const issues = useMemo(() => allIssues.filter((i) => !ignored.has(i.id)), [allIssues, ignored])
  const [focus, setFocus] = useState<{ lat: number; lon: number; n: number } | null>(null)
  const [status, setStatus] = useState('Откройте файл .osm или загрузите пример')
  const [tool, setTool] = useState<Tool>('select')
  const [tplIdx, setTplIdx] = useState(2)

  const load = useCallback((text: string, name: string) => {
    try {
      const t0 = performance.now()
      const doc = parseOsm(text)
      store.load(doc, name)
      setIgnored(new Set())
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
    const all = validate(store.doc)
    setIssues(all)
    const found = all.filter((i) => !ignored.has(i.id))
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
  }, [onlyRoads, withPed, keepMeta, ignored])

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
      else if (mod) return
      else if (e.key === 'Escape') store.select(null) // в режиме рисования Esc ещё и отменяет черновик (MapView)
      // выбор инструмента
      else if (key === 'v') setTool('select')
      else if (key === 'd') setTool('draw')
      else if (key === 'n') setTool('node')
      // действия над выбранным объектом (в режиме рисования Backspace убирает точку, а не удаляет)
      else if (sel?.kind === 'way' && key === 'r') reverseWay(store, sel.id)
      else if (sel?.kind === 'node' && key === 's') {
        const n = splitAtNode(store, sel.id)
        setStatus(n ? `Разрезано дорог: ${n}` : 'В этом узле нечего резать (узел на конце дороги)')
      }
      else if (e.key === 'Delete' || (e.key === 'Backspace' && tool !== 'draw')) {
        if (sel?.kind === 'way') { deleteWay(store, sel.id); store.select(null) }
        else if (sel?.kind === 'node') { deleteNode(store, sel.id); store.select(null) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save, open, tool])

  // меню «Вид» и «Экспорт» закрываются кликом вне их
  useEffect(() => {
    const h = (e: PointerEvent) => document.querySelectorAll('details.menu[open]').forEach((d) => {
      if (!d.contains(e.target as Node)) d.removeAttribute('open')
    })
    document.addEventListener('pointerdown', h)
    return () => document.removeEventListener('pointerdown', h)
  }, [])

  const focusIssue = (i: Issue) => {
    const wayFirst = i.wayIds?.[0] ? store.doc.ways.get(i.wayIds[0]) : undefined
    const p = i.at ?? (wayFirst ? store.doc.nodes.get(wayFirst.nodes[0]) : undefined)
    if (p) setFocus({ lat: p.lat, lon: p.lon, n: Date.now() })
    if (i.wayIds?.[0]) store.select({ kind: 'way', id: i.wayIds[0] })
  }

  const fixOne = (i: Issue) => {
    if (!i.fix) return
    if (i.fix.kind === 'delete-ways' && !window.confirm(`Удалить ${i.fix.ids.length} дорог(и) этого участка?`)) return
    applyFix(store, i.fix)
    setStatus('Исправлено. Ctrl+Z — отменить')
  }
  const fixAll = () => {
    const n = applyAutoFixes(store, issues)
    setStatus(`Исправлено автоматически: ${n}. Ctrl+Z — отменить одним шагом`)
  }
  const ignoreOne = (i: Issue) => setIgnored(new Set(ignored).add(i.id))

  const errCount = useMemo(() => issues.filter((i) => i.severity === 'error').length, [issues])
  const loaded = store.doc.nodes.size > 0

  const TOOLS: { id: Tool; icon: string; label: string; key: string }[] = [
    { id: 'select', icon: 'select', label: 'Выбрать', key: 'V' },
    { id: 'draw', icon: 'road', label: 'Дорога', key: 'D' },
    { id: 'node', icon: 'node', label: 'Узел', key: 'N' },
  ]

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={async (e) => {
        e.preventDefault()
        const f = e.dataTransfer.files[0]
        if (f) load(await f.text(), f.name)
      }}
    >
      <header className="topbar">
        <div className="brand"><Icon name="road" size={20} /> Редактор УДС</div>

        <div className="group">
          <button className="btn" onClick={open} title="Ctrl+O"><Icon name="open" /> Открыть</button>
          <button className="btn ghost" onClick={loadExample}>Пример</button>
          <button className="btn primary" onClick={save} disabled={!loaded} title="Ctrl+S"><Icon name="save" /> Сохранить</button>
        </div>

        <div className="group">
          <button className="btn icon" onClick={() => store.undo()} disabled={!store.canUndo} title="Отменить (Ctrl+Z)"><Icon name="undo" /></button>
          <button className="btn icon" onClick={() => store.redo()} disabled={!store.canRedo} title="Вернуть (Ctrl+Shift+Z)"><Icon name="redo" /></button>
        </div>

        <span className="spacer" />

        <details className="menu">
          <summary><Icon name="layers" /> Вид <Icon name="chevron" size={14} /></summary>
          <div className="popover">
            <label><input type="checkbox" checked={showPed} onChange={(e) => setShowPed(e.target.checked)} /> Пешеходные дорожки</label>
            <label><input type="checkbox" checked={tiles} onChange={(e) => setTiles(e.target.checked)} /> Подложка (карта)</label>
            <div className="field">
              <span>Адрес тайлов {'{z}/{x}/{y}'}</span>
              <input value={tileUrl} onChange={(e) => setTileUrl(e.target.value)} />
            </div>
          </div>
        </details>

        <details className="menu">
          <summary><Icon name="export" /> Экспорт <Icon name="chevron" size={14} /></summary>
          <div className="popover">
            <label><input type="checkbox" checked={onlyRoads} onChange={(e) => setOnlyRoads(e.target.checked)} /> Только дороги (без зданий и маршрутов)</label>
            <label><input type="checkbox" checked={withPed} disabled={!onlyRoads} onChange={(e) => setWithPed(e.target.checked)} /> Добавить пешеходные</label>
            <label><input type="checkbox" checked={keepMeta} onChange={(e) => setKeepMeta(e.target.checked)} /> Сохранить метаданные OSM</label>
          </div>
        </details>
      </header>

      <main>
        <div className="stage">
          <MapView
            tileUrl={tiles ? tileUrl : ''} issues={issues} showPedestrian={showPed} focus={focus}
            tool={tool} drawTags={DRAW_TEMPLATES[tplIdx].tags} onHint={setStatus}
          />

          <div className="palette">
            {TOOLS.map((t) => (
              <button key={t.id} className={tool === t.id ? 'active' : ''} onClick={() => setTool(t.id)} title={`${t.label} (${t.key})`}>
                <Icon name={t.icon} size={20} />
                <kbd>{t.key}</kbd>
              </button>
            ))}
          </div>

          {tool === 'draw' && (
            <div className="tool-card">
              <b>Новая дорога</b>
              <select value={tplIdx} onChange={(e) => setTplIdx(+e.target.value)} title="Тип новой дороги">
                {DRAW_TEMPLATES.map((t, i) => <option key={t.name} value={i}>{t.name}</option>)}
              </select>
              <span>Клик — точка · по узлу или дороге — присоединить · Enter — закончить · Esc — отмена</span>
            </div>
          )}
          {tool === 'node' && (
            <div className="tool-card"><b>Узел на дороге</b><span>Кликните по дороге, чтобы поставить на неё узел</span></div>
          )}

          {!loaded && (
            <div className="empty">
              <div className="card">
                <Icon name="road" size={36} />
                <h2>Откройте карту</h2>
                <p>Перетащите файл <code>.osm</code> в окно или выберите его кнопкой.</p>
                <div className="row">
                  <button className="btn primary" onClick={open}><Icon name="open" /> Открыть .osm</button>
                  <button className="btn" onClick={loadExample}>Загрузить пример</button>
                </div>
              </div>
            </div>
          )}
        </div>

        <aside>
          <nav>
            <button className={tab === 'attrs' ? 'active' : ''} onClick={() => setTab('attrs')}>Атрибуты</button>
            <button className={tab === 'issues' ? 'active' : ''} onClick={() => setTab('issues')}>
              Проблемы
              {issues.length > 0 && <span className={errCount ? 'badge err' : 'badge'}>{issues.length}</span>}
            </button>
          </nav>
          {tab === 'attrs' ? <AttributePanel /> : (
            <IssuesPanel
              issues={issues} hiddenCount={allIssues.length - issues.length}
              onFocus={focusIssue} onFix={fixOne} onIgnore={ignoreOne} onFixAll={fixAll}
              onShowHidden={() => setIgnored(new Set())}
            />
          )}
        </aside>
      </main>

      <footer>
        <span className="status">{status}{store.dirty && <em> · есть несохранённые изменения</em>}</span>
        <span className="keys">V выбрать · D дорога · N узел · S разрезать · R развернуть · Del удалить · Ctrl+Z · Ctrl+S</span>
      </footer>
    </div>
  )
}
