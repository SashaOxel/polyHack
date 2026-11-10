import { useEffect, useMemo, useState } from 'react'
import { setSignalPlan } from '../core/ops'
import {
  checkPlan, corridorDistance, defaultPlan, GROUP_COLORS, greenTime, greenWaveOffset, readPlan, turnLabel, turnsAt, websterDelay,
  type SignalPlan,
} from '../core/signals'
import { store } from '../core/store'

const clone = (p: SignalPlan): SignalPlan => structuredClone(p)

/** Диаграмма цикла: по строке на группу — зелёный, жёлтый, красный; сверху шкала секунд. */
function Timeline({ plan }: { plan: SignalPlan }) {
  const C = plan.cycle, W = 300, rowH = 14, top = 14
  const x = (t: number) => (t / C) * W
  const bars = (start: number, len: number, color: string, key: string) => {
    const s = ((start % C) + C) % C
    const first = Math.min(len, C - s)
    return [
      <rect key={key + 'a'} x={x(s)} width={x(first)} height={rowH - 3} fill={color} />,
      len > first ? <rect key={key + 'b'} x={0} width={x(len - first)} height={rowH - 3} fill={color} /> : null,
    ]
  }
  const ticks = []
  for (let t = 0; t <= C; t += C > 90 ? 20 : 10) ticks.push(t)
  return (
    <svg className="timeline" viewBox={`0 0 ${W + 2} ${top + plan.groups.length * rowH + 2}`} role="img" aria-label="Диаграмма цикла светофора">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={top - 3} y2={top + plan.groups.length * rowH} stroke="#e2e5ea" />
          <text x={x(t)} y={9} fontSize={8} textAnchor={t === 0 ? 'start' : t === C ? 'end' : 'middle'} fill="#6b7482">{t}</text>
        </g>
      ))}
      {plan.groups.map((g, i) => (
        <g key={i} transform={`translate(0 ${top + i * rowH})`}>
          <rect width={W} height={rowH - 3} fill="#f3c6c3" />
          {bars(g.start, greenTime(g, C), '#22c55e', 'g')}
          {bars(g.end, plan.yellow, '#facc15', 'y')}
          <rect x={-0} y={0} width={3} height={rowH - 3} fill={GROUP_COLORS[i % GROUP_COLORS.length]} />
        </g>
      ))}
    </svg>
  )
}

/**
 * План светофорного регулирования узла (фиксированное время, по схеме Visum):
 * цикл, сдвиг, жёлтый, межзелёный; сигнальные группы с моментами включения/выключения зелёного и направлениями.
 * Изменения копятся в черновике и записываются кнопкой «Сохранить план» (один шаг отмены).
 */
export function SignalPlanEditor({ nodeId }: { nodeId: number }) {
  const node = store.doc.nodes.get(nodeId)
  const saved = node ? readPlan(node.tags) : undefined
  const turns = useMemo(() => turnsAt(store.doc, nodeId), [nodeId, store.docVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState<SignalPlan | undefined>(saved && clone(saved))
  const [newCycle, setNewCycle] = useState('60')
  const [refNode, setRefNode] = useState('')
  const [speed, setSpeed] = useState('40')
  const [waveNote, setWaveNote] = useState('')
  useEffect(() => { setDraft(saved && clone(saved)); setWaveNote('') }, [nodeId, store.docVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!node) return null
  if (!draft) {
    return (
      <div className="signal-box">
        <strong>Светофорное регулирование</strong>
        <div className="note">Плана нет. Будет создан план с фиксированным временем: подходы делятся на оси (попутные и встречные вместе),
          каждая ось — своя сигнальная группа, цикл делится поровну, между группами — межзелёный интервал.</div>
        {turns.length === 0 && <div className="error-text">Узел не лежит на дороге для машин — регулировать нечего.</div>}
        <div className="row">
          <label>Цикл, с<input type="number" min={20} max={240} value={newCycle} onChange={(e) => setNewCycle(e.target.value)} /></label>
          <button className="btn primary" disabled={!turns.length} onClick={() => setSignalPlan(store, nodeId, defaultPlan(store.doc, nodeId, Number(newCycle) || 60))}>Создать план</button>
        </div>
      </div>
    )
  }

  const C = draft.cycle
  const issues = checkPlan(draft, turns)
  const changed = JSON.stringify(draft) !== JSON.stringify(saved)
  const upd = (f: (p: SignalPlan) => void) => setDraft((d) => { const n = clone(d!); f(n); return n })
  const num = (v: string) => (v.trim() === '' ? 0 : Number(v))

  const applyWave = () => {
    const ref = Number(refNode)
    const refPlan = store.doc.nodes.get(ref) ? readPlan(store.doc.nodes.get(ref)!.tags) : undefined
    if (!refPlan) { setWaveNote(`У узла № ${refNode} нет плана светофора`); return }
    const v = Number(speed)
    if (!(v > 0)) { setWaveNote('Укажите скорость'); return }
    const d = corridorDistance(store.doc, ref, nodeId)
    const off = greenWaveOffset(refPlan, draft, d.meters, v)
    upd((p) => { p.offset = off })
    setWaveNote(`Расстояние ${Math.round(d.meters)} м ${d.byRoad ? 'по дорогам' : 'по прямой (пути по дорогам нет)'}, время в пути ${Math.round(d.meters / (v / 3.6))} с → сдвиг ${off} с` +
      (refPlan.cycle !== C ? `. Внимание: цикл опорного ${refPlan.cycle} с ≠ ${C} с — волна не будет устойчивой` : ''))
  }

  return (
    <div className="signal-box">
      <strong>Светофорное регулирование · фиксированное время</strong>
      <div className="row">
        <label>Цикл, с<input type="number" min={20} max={240} value={draft.cycle} onChange={(e) => upd((p) => { p.cycle = num(e.target.value) })} /></label>
        <label>Сдвиг, с<input type="number" min={0} value={draft.offset} onChange={(e) => upd((p) => { p.offset = num(e.target.value) })} /></label>
        <label>Жёлтый, с<input type="number" min={0} value={draft.yellow} onChange={(e) => upd((p) => { p.yellow = num(e.target.value) })} /></label>
        <label>Межзел., с<input type="number" min={0} value={draft.intergreen} onChange={(e) => upd((p) => { p.intergreen = num(e.target.value) })} /></label>
      </div>

      {C > 0 && <Timeline plan={draft} />}

      {draft.groups.map((g, gi) => {
        const gt = C > 0 ? greenTime(g, C) : 0
        return (
          <div className="sg" key={gi} style={{ borderLeftColor: GROUP_COLORS[gi % GROUP_COLORS.length] }}>
            <div className="row">
              <label className="grow">Сигнальная группа
                <input value={g.name} onChange={(e) => upd((p) => { p.groups[gi].name = e.target.value })} />
              </label>
              <label>Зелёный с<input type="number" value={g.start} onChange={(e) => upd((p) => { p.groups[gi].start = num(e.target.value) })} /></label>
              <label>по<input type="number" value={g.end} onChange={(e) => upd((p) => { p.groups[gi].end = num(e.target.value) })} /></label>
              <button title="Удалить группу" onClick={() => upd((p) => { p.groups.splice(gi, 1) })}>×</button>
            </div>
            <div className="note">Зелёный {gt} с · g/C = {C ? Math.round((gt / C) * 100) : 0}% · задержка ≈ {C ? Math.round(websterDelay(gt, C)) : 0} с/авт (по Вебстеру, при загрузке 0,8)</div>
            <div className="turns">
              {turns.map((t) => (
                <label key={t.key} className="turn">
                  <input type="checkbox" checked={g.turns.includes(t.key)}
                    onChange={(e) => upd((p) => {
                      const list = p.groups[gi].turns
                      p.groups[gi].turns = e.target.checked ? [...list, t.key] : list.filter((k) => k !== t.key)
                    })} />
                  {turnLabel(t)}
                </label>
              ))}
            </div>
          </div>
        )
      })}

      <div className="row wrap">
        <button onClick={() => upd((p) => { p.groups.push({ name: `Фаза ${p.groups.length + 1}`, start: 0, end: Math.min(10, p.cycle), turns: [] }) })}>+ группа</button>
        <button onClick={() => setDraft(defaultPlan(store.doc, nodeId, C || 60))}>По умолчанию</button>
        <button className="danger" onClick={() => setSignalPlan(store, nodeId, null)}>Удалить план</button>
      </div>

      {issues.length > 0 ? (
        <ul className="plan-issues">
          {issues.map((i, k) => <li key={k} className={i.level}>{i.level === 'error' ? '●' : '○'} {i.text}</li>)}
        </ul>
      ) : <div className="note strong">Конфликтов нет, межзелёные интервалы выдержаны.</div>}

      <div className="sub">Зелёная волна</div>
      <div className="row">
        <label className="grow">Опорный светофор, № узла<input inputMode="numeric" value={refNode} onChange={(e) => setRefNode(e.target.value)} /></label>
        <label>Скорость, км/ч<input type="number" value={speed} onChange={(e) => setSpeed(e.target.value)} /></label>
        <button onClick={applyWave}>Рассчитать сдвиг</button>
      </div>
      {waveNote && <div className="note">{waveNote}</div>}

      <div className="row">
        <button className="btn primary" disabled={!changed} onClick={() => setSignalPlan(store, nodeId, draft)}>Сохранить план</button>
        <button disabled={!changed} onClick={() => setDraft(saved && clone(saved))}>Отменить изменения</button>
      </div>
      <div className="note">План хранится тегами polyhack:signal:* на узле и сохраняется в .osm. Для SUMO: <code>npm run export:sumo -- файл.osm</code>.</div>
    </div>
  )
}
