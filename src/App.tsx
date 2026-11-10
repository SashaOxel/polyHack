import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { deleteNode, deleteWay, reverseWay, splitAtNode } from './core/ops'
import { parseOsm } from './core/parse'
import { serializeOsm } from './core/serialize'
import { store } from './core/store'
import { DRAW_TEMPLATES, LEVEL_TAGS, isFootTemplate, isRailTemplate } from './core/templates'
import { PARKING_TYPES } from './core/roads'
import { hasErrors, validate, type Issue } from './validate'
import { applyAutoFixes, applyFix } from './validate/fixes'
import { AttributePanel } from './ui/AttributePanel'
import { IssuesPanel } from './ui/IssuesPanel'
import { MapView, type Tool } from './ui/MapView'
import { downloadText, pickOsmFile } from './ui/files'
import { Icon } from './ui/icons'
import { BASEMAPS, DEFAULT_TILE_URL } from './ui/tiles'
import { SIGNS, type SignKind } from './core/signs'
import { DEFAULT_LAYERS, LAYER_LIST, type Layers } from './ui/layers'
import { loadTheme, saveTheme, type Theme } from './ui/theme'
import { TrafficPanel } from './ui/TrafficPanel'
import { Dashboard } from './ui/Dashboard'
import { RoutesPanel } from './ui/RoutesPanel'
import { routeUi } from './ui/routeUi'
import { CommandPalette, type Command } from './ui/CommandPalette'
import { traffic } from './ui/trafficController'
import type { SearchHit } from './core/search'

// 3D грузится отдельным куском (three.js тяжёлый) — только когда откроют вкладку 3D
const View3D = lazy(() => import('./ui/View3D'))

export function App() {
  const version = useSyncExternalStore(store.subscribe, store.getVersion)
  const [tab, setTab] = useState<'attrs' | 'issues' | 'overview' | 'routes'>('attrs')
  useSyncExternalStore(routeUi.subscribe, routeUi.getVersion)
  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS)
  const setLayer = (key: keyof Layers, on: boolean) => setLayers((l) => ({ ...l, [key]: on }))
  const [layersOpen, setLayersOpen] = useState(false)
  const [theme, setTheme] = useState<Theme>(loadTheme)
  useEffect(() => { document.documentElement.dataset.theme = theme; saveTheme(theme) }, [theme])
  const [tileUrl, setTileUrl] = useState(DEFAULT_TILE_URL)
  const showPed = layers.pedestrian
  const [onlyRoads, setOnlyRoads] = useState(true)
  const [withPed, setWithPed] = useState(false)
  const [keepMeta, setKeepMeta] = useState(false)
  const [allIssues, setIssues] = useState<Issue[]>([])
  const [ignored, setIgnored] = useState<Set<string>>(new Set())
  // скрытые пользователем проблемы не показываем и не считаем при сохранении
  const issues = useMemo(() => allIssues.filter((i) => !ignored.has(i.id)), [allIssues, ignored])
  const [focus, setFocus] = useState<{ lat: number; lon: number; n: number; scale?: number } | null>(null)
  const [status, setStatus] = useState('Откройте файл .osm или загрузите пример')
  const [tool, setTool] = useState<Tool>('select')
  const [mode, setMode] = useState<'2d' | '3d'>('2d')
  // 3D: ночь и облёт — здесь, чтобы ими управляли режим презентации и командная палитра
  const [night3d, setNight3d] = useState(() => loadTheme() === 'dark')
  const [flying3d, setFlying3d] = useState(false)
  const [signKind, setSignKind] = useState<SignKind>('giveway')
  const [presenting, setPresenting] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const beforePresent = useRef<'2d' | '3d'>('2d')
  useSyncExternalStore(traffic.subscribe, traffic.getVersion)
  const [tplIdx, setTplIdx] = useState(2)
  // уровень новой дороги (на земле / мост / тоннель) и тип новой парковки
  const [drawLevel, setDrawLevel] = useState<'ground' | 'bridge' | 'tunnel'>('ground')
  const [parkType, setParkType] = useState('surface')
  const drawTags = tool === 'parking'
    ? { amenity: 'parking', parking: parkType }
    : { ...DRAW_TEMPLATES[tplIdx].tags, ...(DRAW_TEMPLATES[tplIdx].tags.bridge || DRAW_TEMPLATES[tplIdx].tags.tunnel ? {} : LEVEL_TAGS[drawLevel]) }

  const load = useCallback((text: string, name: string) => {
    try {
      const t0 = performance.now()
      const doc = parseOsm(text)
      store.load(doc, name)
      setIgnored(new Set())
      const segments = [...store.doc.ways.values()].filter(way => way.tags.highway && way.tags.area !== 'yes').length
      setStatus(`${name}: ${store.doc.nodes.size} узлов, ${segments} отрезков дорог (${Math.round(performance.now() - t0)} мс)`)
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
  }, [store.docVersion])

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
      else if (mod && key === 'k') { e.preventDefault(); setPaletteOpen(true) }
      else if (mod) return
      else if (e.key === 'Escape' && presenting) stopPresentation()
      else if (e.key === 'Escape') { if (routeUi.picking) routeUi.setPicking(false); else store.select(null) } // в режиме рисования Esc ещё и отменяет черновик (MapView)
      // выбор инструмента
      else if (key === '2') setMode('2d')
      else if (key === '3') { setMode('3d'); setTool('select') }
      else if (key === 'v') setTool('select')
      else if (key === 'd' && mode === '2d') setTool('draw')
      else if (key === 'b' && mode === '2d') setTool('stop')
      else if (key === 'n' && mode === '2d') setTool('node')
      else if (key === 't' && mode === '2d') setTool('signal')
      else if (key === 'c' && mode === '2d') setTool('crossing')
      else if (key === 'g' && mode === '2d') setTool('sign')
      else if (key === 'p' && mode === '2d') setTool('parking')
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
  }, [save, open, tool, mode, presenting])

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

  // пешеходная дорога должна быть видна сразу и попасть в экспорт: включаем показ и «Добавить пешеходные»
  const pickTemplate = (i: number) => {
    setTplIdx(i)
    if (isRailTemplate(DRAW_TEMPLATES[i])) setLayer('tram', true)
    if (isFootTemplate(DRAW_TEMPLATES[i])) {
      setLayer('pedestrian', true)
      setWithPed(true)
      setStatus('Пешеходные дороги включены в показ и в экспорт (меню «Вид» и «Экспорт»)')
    }
  }

  const errCount = useMemo(() => issues.filter((i) => i.severity === 'error').length, [issues])
  const loaded = store.doc.nodes.size > 0

  // ---------- режим презентации ----------
  function startPresentation() {
    if (!store.doc.nodes.size) return
    beforePresent.current = mode
    setMode('3d'); setTool('select'); setNight3d(true)
    if (!traffic.running) traffic.start()
    setFlying3d(true)
    setPresenting(true)
    document.documentElement.requestFullscreen?.().catch(() => { /* полноэкранный режим не разрешён — работаем в окне */ })
  }
  function stopPresentation() {
    setPresenting(false)
    setFlying3d(false)
    setMode(beforePresent.current)
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  }
  // вышли из полноэкранного режима сами (Esc браузера) — выходим и из презентации
  useEffect(() => {
    const onFs = () => { if (!document.fullscreenElement && presenting) stopPresentation() }
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- командная палитра ----------
  const goTo = (hit: SearchHit) => {
    setMode('2d')
    setFocus({ lat: hit.lat, lon: hit.lon, n: Date.now(), scale: hit.kind === 'node' ? 5 : hit.kind === 'route' ? 1.2 : 2.2 })
    if (hit.routeId !== undefined) { routeUi.select(hit.routeId); setTab('routes') }
    else if (hit.ref) { store.select(hit.ref); setTab('attrs') }
    setStatus(`Найдено: ${hit.label}`)
  }
  const tool2d = (t: Tool) => () => { setMode('2d'); setTool(t) }
  const commands: Command[] = [
    { id: 'present', label: 'Режим презентации', icon: '▶', keywords: 'презентация показ демо presentation', run: startPresentation },
    { id: 'sim', label: traffic.running ? 'Пауза движения' : 'Запустить движение машин', icon: traffic.running ? '⏸' : '🚗', keywords: 'движение машины трафик симуляция traffic', run: () => (traffic.running ? traffic.pause() : traffic.start()) },
    { id: 'sim-stop', label: 'Убрать машины', icon: '■', keywords: 'движение стоп машины', run: () => traffic.stop() },
    { id: 'heat', label: layers.heat ? 'Скрыть загруженность' : 'Показать загруженность (пробки)', icon: '🌡', keywords: 'пробки загруженность тепловая heat', run: () => setLayer('heat', !layers.heat) },
    { id: '3d', label: 'Перейти в 3D', hint: '3', icon: '🧊', keywords: '3d три объём', run: () => { setMode('3d'); setTool('select') } },
    { id: '2d', label: 'Перейти в 2D', hint: '2', icon: '🗺', keywords: '2d карта план', run: () => setMode('2d') },
    { id: 'night', label: 'Ночь в 3D', icon: '☾', keywords: 'ночь night темно фонари', run: () => { setMode('3d'); setNight3d(true) } },
    { id: 'day', label: 'День в 3D', icon: '☀', keywords: 'день day светло', run: () => { setMode('3d'); setNight3d(false) } },
    { id: 'fly', label: 'Облёт камеры (3D)', icon: '🎥', keywords: 'облёт облет камера полёт fly', run: () => { setMode('3d'); setFlying3d(true) } },
    { id: 'sat', label: 'Подложка: спутник', icon: '🛰', keywords: 'спутник снимки подложка satellite', run: () => { setMode('2d'); setTileUrl(BASEMAPS[1].url); setLayer('tiles', true) } },
    { id: 'scheme', label: 'Подложка: схема OpenStreetMap', icon: '🗺', keywords: 'схема подложка osm', run: () => { setMode('2d'); setTileUrl(BASEMAPS[0].url); setLayer('tiles', true) } },
    { id: 'theme', label: theme === 'dark' ? 'Светлая тема' : 'Тёмная тема', icon: theme === 'dark' ? '☀' : '☾', keywords: 'тема оформление theme', run: () => setTheme(theme === 'dark' ? 'light' : 'dark') },
    { id: 't-select', label: 'Инструмент: выбор', hint: 'V', icon: '↖', keywords: 'выбрать select', run: tool2d('select') },
    { id: 't-draw', label: 'Инструмент: нарисовать дорогу', hint: 'D', icon: '✎', keywords: 'дорога улица рисовать мост тоннель трамвай пешеходная', run: tool2d('draw') },
    { id: 't-node', label: 'Инструмент: узел на дороге', hint: 'N', icon: '•', keywords: 'узел node', run: tool2d('node') },
    { id: 't-signal', label: 'Инструмент: светофор', hint: 'T', icon: '🚦', keywords: 'светофор signal', run: tool2d('signal') },
    { id: 't-crossing', label: 'Инструмент: пешеходный переход', hint: 'C', icon: '🚸', keywords: 'переход зебра crossing', run: tool2d('crossing') },
    { id: 't-stop', label: 'Инструмент: автобусная остановка', hint: 'B', icon: '🚏', keywords: 'остановка stop', run: tool2d('stop') },
    { id: 't-sign', label: 'Инструмент: знак приоритета (главная / уступи)', hint: 'G', icon: '◆', keywords: 'знак пдд главная второстепенная уступи стоп приоритет sign', run: tool2d('sign') },
    ...(Object.keys(SIGNS) as SignKind[]).map((k) => ({ id: `sign-${k}`, label: `Знак ${SIGNS[k].code}: ${SIGNS[k].label}`, icon: '◆', keywords: 'знак пдд приоритет', run: () => { setSignKind(k); tool2d('sign')() } })),
    { id: 't-parking', label: 'Инструмент: парковка', hint: 'P', icon: '🅿', keywords: 'парковка стоянка parking', run: tool2d('parking') },
    { id: 'reach', label: layers.reach ? 'Скрыть недостижимые участки' : 'Показать недостижимые для машин участки', icon: '⛔', keywords: 'связность достижимость ловушка тупик остров oneway', run: () => { setLayer('reach', !layers.reach); setMode('2d'); setTab('overview') } },
    { id: 'routes', label: 'Маршруты общественного транспорта', icon: '🚌', keywords: 'маршрут автобус трамвай routes', run: () => setTab('routes') },
    { id: 'overview', label: 'Обзор сети', icon: '📊', keywords: 'обзор дашборд статистика', run: () => setTab('overview') },
    { id: 'issues', label: 'Проблемы', icon: '⚠', keywords: 'проблемы ошибки валидатор', run: () => setTab('issues') },
    { id: 'fix', label: 'Исправить автоматически', icon: '🛠', keywords: 'исправить ошибки автоисправление', run: () => { fixAll(); setTab('issues') } },
    { id: 'save', label: 'Сохранить .osm', hint: 'Ctrl+S', icon: '💾', keywords: 'сохранить экспорт save', run: save },
    { id: 'open', label: 'Открыть файл', hint: 'Ctrl+O', icon: '📂', keywords: 'открыть open', run: open },
    { id: 'example', label: 'Загрузить пример', icon: '📍', keywords: 'пример example', run: loadExample },
    { id: 'undo', label: 'Отменить', hint: 'Ctrl+Z', icon: '↶', keywords: 'отмена undo', run: () => store.undo() },
    { id: 'redo', label: 'Вернуть', hint: 'Ctrl+Shift+Z', icon: '↷', keywords: 'вернуть redo', run: () => store.redo() },
    ...LAYER_LIST.map((l) => ({ id: `layer-${l.key}`, label: `Слой «${l.label}»: ${layers[l.key] ? 'скрыть' : 'показать'}`, icon: '◫', keywords: 'слой', run: () => setLayer(l.key, !layers[l.key]) })),
  ]

  const TOOLS: { id: Tool; icon: string; label: string; short: string; key: string }[] = [
    { id: 'select', icon: 'select', label: 'Выбрать и двигать', short: 'Выбор', key: 'V' },
    { id: 'draw', icon: 'road', label: 'Нарисовать дорогу, дорожку или трамвайные пути', short: 'Дорога', key: 'D' },
    { id: 'node', icon: 'node', label: 'Узел на дороге', short: 'Узел', key: 'N' },
    { id: 'signal', icon: 'signal', label: 'Светофор', short: 'Светофор', key: 'T' },
    { id: 'stop', icon: 'bus', label: 'Автобусная остановка', short: 'Остановка', key: 'B' },
    { id: 'crossing', icon: 'crossing', label: 'Пешеходный переход на узле дороги', short: 'Переход', key: 'C' },
    { id: 'sign', icon: 'sign', label: 'Знак приоритета: главная дорога, уступи, стоп', short: 'Знаки', key: 'G' },
    { id: 'parking', icon: 'parking', label: 'Парковка: обвести площадь', short: 'Парковка', key: 'P' },
  ]

  return (
    <div
      className={presenting ? 'app presenting' : 'app'}
      onDragOver={(e) => e.preventDefault()}
      onDrop={async (e) => {
        e.preventDefault()
        const f = e.dataTransfer.files[0]
        if (f) load(await f.text(), f.name)
      }}
    >
      <header className="topbar">
        <div className="brand"><span className="logo"><Icon name="road" size={18} /></span> Редактор УДС <span className="brand-sub">центр управления</span></div>

        <div className="group">
          <button className="btn" onClick={open} title="Ctrl+O"><Icon name="open" /> Открыть</button>
          <button className="btn ghost" onClick={loadExample}>Пример</button>
          <button className="btn primary" onClick={save} disabled={!loaded} title="Ctrl+S"><Icon name="save" /> Сохранить</button>
        </div>

        <div className="group">
          <button className="btn" onClick={() => store.undo()} disabled={!store.canUndo} title="Ctrl+Z"><Icon name="undo" /> Отменить</button>
          <button className="btn" onClick={() => store.redo()} disabled={!store.canRedo} title="Ctrl+Shift+Z"><Icon name="redo" /> Вернуть</button>
        </div>

        <div className="seg" role="tablist" aria-label="Режим просмотра">
          <button role="tab" aria-selected={mode === '2d'} className={mode === '2d' ? 'active' : ''} onClick={() => setMode('2d')} title="2D (2)">2D</button>
          <button role="tab" aria-selected={mode === '3d'} className={mode === '3d' ? 'active' : ''}
            onClick={() => { setMode('3d'); setTool('select') }} title="3D (3)">3D</button>
        </div>

        <button className={tab === 'routes' ? 'btn routes-btn on' : 'btn routes-btn'} onClick={() => setTab('routes')}
          title="Маршруты автобусов и трамваев">🚌 Маршруты</button>
        <button className="btn present-btn" onClick={startPresentation} disabled={!loaded}
          title="Ночное 3D, движение машин и облёт камеры — для начала выступления (Esc — выйти)">▶ Презентация</button>
        <button className="btn ghost cmdk-btn" onClick={() => setPaletteOpen(true)} title="Командная палитра">⌘K Поиск</button>

        <span className="spacer" />

        <button className="btn icon theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'} aria-label="Переключить тему">
          {theme === 'dark' ? '☀' : '☾'}
        </button>

        <details className="menu">
          <summary><Icon name="layers" /> Вид <Icon name="chevron" size={14} /></summary>
          <div className="popover">
            <div className="field"><span>Какие объекты показывать — кнопка «Слои» на карте справа внизу</span></div>
            <div className="field">
              <span>Подложка</span>
              <select value={BASEMAPS.find((b) => b.url === tileUrl)?.id ?? 'custom'}
                onChange={(e) => { const b = BASEMAPS.find((x) => x.id === e.target.value); if (b) { setTileUrl(b.url); setLayer('tiles', true) } }}>
                {BASEMAPS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
                <option value="custom">Свой адрес…</option>
              </select>
            </div>
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
          <div className="layer" style={{ display: mode === '2d' ? 'block' : 'none' }}>
            <MapView
              tileUrl={layers.tiles ? tileUrl : ''} issues={issues} layers={layers} theme={theme} focus={focus}
              tool={tool} drawTags={drawTags} onHint={setStatus} signKind={signKind}
              onStopCreated={() => setTool('select')}
            />
          </div>
          {mode === '3d' && loaded && (
            <Suspense fallback={<div className="loading3d">Загрузка 3D…</div>}>
              <View3D showPedestrian={showPed} showTram={layers.tram} showLanes={layers.lanes} theme={theme} onHint={setStatus}
                night={night3d} setNight={setNight3d} flying={flying3d} setFlying={setFlying3d} />
            </Suspense>
          )}

          <TrafficPanel />
          {presenting && (
            <div className="present-overlay">
              <div className="present-title">
                <b>Редактор УДС</b>
                <span>{store.fileName.replace(/\.osm$/i, '')} · {traffic.sim ? `${traffic.sim.stats().count} машин · ${Math.round(traffic.sim.stats().avgKmh)} км/ч` : ''}</span>
              </div>
              <button className="present-exit" onClick={stopPresentation}>Выйти · Esc</button>
            </div>
          )}

          {mode === '2d' && <div className="palette">
            {TOOLS.map((t) => (
              <button key={t.id} aria-label={t.label} aria-pressed={tool === t.id} className={tool === t.id ? 'active' : ''} onClick={() => setTool(t.id)} title={`${t.label} (${t.key})`}>
                <Icon name={t.icon} size={20} />
                <span className="lbl">{t.short}</span>
                <kbd>{t.key}</kbd>
              </button>
            ))}
          </div>}

          {mode === '2d' && (
            <div className={layersOpen ? 'layers open' : 'layers'}>
              <button className="layers-toggle" onClick={() => setLayersOpen(!layersOpen)} title="Какие объекты показывать на карте">
                <Icon name="layers" /> Слои
              </button>
              {layersOpen && (
                <div className="layers-list">
                  {LAYER_LIST.map((l) => (
                    <button key={l.key} className={layers[l.key] ? 'chip on' : 'chip'} aria-pressed={layers[l.key]} onClick={() => setLayer(l.key, !layers[l.key])}>
                      {l.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {mode === '2d' && routeUi.picking && routeUi.draft && (
            <div className="tool-card route-card" style={{ borderColor: routeUi.draft.colour }}>
              <b>{routeUi.draft.kind === 'tram' ? '🚋' : '🚌'} Маршрут {routeUi.draft.ref || 'без номера'}</b>
              <span>Кликайте по остановкам по порядку ({routeUi.draft.stops.length} выбрано) · Esc — закончить выбор</span>
            </div>
          )}

          {mode === '2d' && tool === 'draw' && (
            <div className="tool-card">
              <b>Новая дорога</b>
              <select value={tplIdx} onChange={(e) => pickTemplate(+e.target.value)} title="Тип новой дороги">
                <optgroup label="Автомобильные">
                  {DRAW_TEMPLATES.map((t, i) => (isFootTemplate(t) || isRailTemplate(t) ? null : <option key={t.name} value={i}>{t.name}</option>))}
                </optgroup>
                <optgroup label="Пешеходные">
                  {DRAW_TEMPLATES.map((t, i) => (isFootTemplate(t) ? <option key={t.name} value={i}>{t.name}</option> : null))}
                </optgroup>
                <optgroup label="Рельсовые">
                  {DRAW_TEMPLATES.map((t, i) => (isRailTemplate(t) ? <option key={t.name} value={i}>{t.name}</option> : null))}
                </optgroup>
              </select>
              {!(DRAW_TEMPLATES[tplIdx].tags.bridge || DRAW_TEMPLATES[tplIdx].tags.tunnel) && (
                <div className="seg" role="radiogroup" aria-label="Уровень дороги">
                  {([['ground', 'На земле'], ['bridge', '🌉 Мост'], ['tunnel', '🕳 Тоннель']] as const).map(([k, l]) => (
                    <button key={k} role="radio" aria-checked={drawLevel === k} className={drawLevel === k ? 'active' : ''} onClick={() => setDrawLevel(k)}>{l}</button>
                  ))}
                </div>
              )}
              <span>Клик — точка · по узлу или дороге — присоединить · Enter — закончить · Esc — отмена{isFootTemplate(DRAW_TEMPLATES[tplIdx]) ? ' · пешеходная дорога попадёт в .osm при включённой галочке «Добавить пешеходные»' : ''}</span>
            </div>
          )}
          {mode === '2d' && tool === 'parking' && (
            <div className="tool-card">
              <b>🅿 Парковка</b>
              <div className="seg" role="radiogroup" aria-label="Тип парковки">
                {PARKING_TYPES.map((t) => (
                  <button key={t.key} role="radio" aria-checked={parkType === t.key} className={parkType === t.key ? 'active' : ''} onClick={() => setParkType(t.key)}>{t.label}</button>
                ))}
              </div>
              <span>Обведите площадь кликами · клик по последней точке или Enter — закончить · Esc — отмена · сохраняется в .osm (amenity=parking)</span>
            </div>
          )}
          {mode === '2d' && (tool === 'signal' || tool === 'crossing') && (
            <div className="tool-card">
              <b>{tool === 'signal' ? 'Светофор' : 'Пешеходный переход'}</b>
              <span>Клик по дороге: на ней появится узел с тегом {tool === 'signal' ? 'highway=traffic_signals' : 'highway=crossing'} — это попадёт в .osm</span>
            </div>
          )}
          {mode === '2d' && tool === 'sign' && (
            <div className="tool-card">
              <b>Знак приоритета</b>
              <div className="seg">
                {(Object.keys(SIGNS) as SignKind[]).map((k) => (
                  <button key={k} className={signKind === k ? 'active' : ''} onClick={() => setSignKind(k)} title={SIGNS[k].label}>{SIGNS[k].code} {SIGNS[k].short}</button>
                ))}
              </div>
              <span>Кликните по дороге <b>перед перекрёстком</b>: знак смотрит на ближайший перекрёсток и действует для движения к нему. Второстепенная — «Уступи» или «Стоп», главная — 2.1. В .osm: {Object.entries(SIGNS[signKind].tags).map(([k, v]) => `${k}=${v}`).join(', ')}</span>
            </div>
          )}
          {mode === '2d' && tool === 'stop' && (
            <div className="tool-card"><b>Автобусная остановка</b><span>1. Кликните по дороге — возьмётся ближайший её узел (новый не создаётся). 2. Кликните по существующей остановке «А» или по месту посадки рядом. Esc — отмена.</span></div>
          )}
          {mode === '2d' && tool === 'node' && (
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
            <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Обзор</button>
            <button className={tab === 'routes' ? 'active' : ''} onClick={() => setTab('routes')}>Маршруты</button>
            <button className={tab === 'attrs' ? 'active' : ''} onClick={() => setTab('attrs')}>Атрибуты</button>
            <button className={tab === 'issues' ? 'active' : ''} onClick={() => setTab('issues')}>
              Проблемы
              {issues.length > 0 && <span className={errCount ? 'badge err' : 'badge'}>{issues.length}</span>}
            </button>
          </nav>
          {tab === 'overview' ? <Dashboard issues={issues} onShowReach={() => { setLayer('reach', true); setMode('2d') }}
            onGoReach={(g) => { setLayer('reach', true); setMode('2d'); setFocus({ lat: g.at.lat, lon: g.at.lon, n: Date.now(), scale: 1.2 }) }} /> : tab === 'routes' ? <RoutesPanel onHint={setStatus} /> : tab === 'attrs' ? <AttributePanel /> : (
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
        <span className="keys">2/3 режим · V выбрать · D дорога · N узел · T светофор · C переход · S разрезать · R развернуть · Del удалить · Ctrl+Z · Ctrl+S</span>
      </footer>
      {layers.tiles && BASEMAPS.find((b) => b.url === tileUrl) && <div className="attribution">{BASEMAPS.find((b) => b.url === tileUrl)!.attribution}</div>}
      {paletteOpen && <CommandPalette commands={commands} onPick={goTo} onClose={() => setPaletteOpen(false)} />}
    </div>
  )
}
