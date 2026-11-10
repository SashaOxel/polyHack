import { store } from '../core/store'
import { TrafficSim } from '../core/traffic'

/**
 * Управление демо-движением: один экземпляр на приложение.
 * Карта и 3D подписываются на кадры (onFrame) и перерисовываются, React получает сводку не чаще 2 раз в секунду.
 */
class TrafficController {
  sim: TrafficSim | undefined
  running = false
  speed = 5
  count = 300
  private docVersion = -1
  private raf = 0
  private last = 0
  private frameListeners = new Set<() => void>()
  private stateListeners = new Set<() => void>()
  private stateVersion = 0
  private lastStats = 0

  constructor() {
    // правка дороги во время движения — пересобираем модель на новом графе
    store.subscribe(() => {
      if (this.sim && store.docVersion !== this.docVersion) this.rebuild()
    })
  }

  onFrame = (fn: () => void) => { this.frameListeners.add(fn); return () => { this.frameListeners.delete(fn) } }
  subscribe = (fn: () => void) => { this.stateListeners.add(fn); return () => { this.stateListeners.delete(fn) } }
  getVersion = () => this.stateVersion
  private changed() { this.stateVersion++; this.stateListeners.forEach((l) => l()) }

  rebuild() {
    this.docVersion = store.docVersion
    this.sim = store.doc.nodes.size ? new TrafficSim(store.doc, this.count, Date.now() % 100000) : undefined
    this.frameListeners.forEach((l) => l())
    this.changed()
  }

  start() {
    if (!store.doc.nodes.size) return
    if (!this.sim || this.docVersion !== store.docVersion) this.rebuild()
    this.running = true
    this.last = performance.now()
    cancelAnimationFrame(this.raf)
    this.raf = requestAnimationFrame(this.tick)
    this.changed()
  }

  pause() {
    this.running = false
    cancelAnimationFrame(this.raf)
    this.changed()
  }

  /** Убрать машины совсем. */
  stop() {
    this.pause()
    this.sim = undefined
    this.frameListeners.forEach((l) => l())
    this.changed()
  }

  setSpeed(x: number) { this.speed = x; this.changed() }
  setCount(n: number) { this.count = n; if (this.sim) this.rebuild() }

  private tick = (now: number) => {
    if (!this.running || !this.sim) return
    // реальное время × ускорение, шагами не длиннее 0.25 с (чтобы машины не «перепрыгивали»)
    let dt = Math.min(0.1, (now - this.last) / 1000) * this.speed
    this.last = now
    while (dt > 0) { const h = Math.min(0.25, dt); this.sim.step(h); dt -= h }
    this.frameListeners.forEach((l) => l())
    if (now - this.lastStats > 500) { this.lastStats = now; this.changed() }
    this.raf = requestAnimationFrame(this.tick)
  }
}

export const traffic = new TrafficController()
