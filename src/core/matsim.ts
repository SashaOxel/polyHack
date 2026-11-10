import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

/**
 * Проверка .osm в MATSim через pt2matsim (официальный конвертер OSM → сеть MATSim).
 * Работает в Node (скрипт npm run check:matsim и тест), в браузере не используется.
 */

/** Где лежит pt2matsim: tools/pt2matsim/pt2matsim.jar или путь из PT2MATSIM_JAR. */
export function findPt2matsim(root = process.cwd()): string | undefined {
  return [process.env.PT2MATSIM_JAR, join(root, 'tools/pt2matsim/pt2matsim.jar')].filter(Boolean).find((p) => existsSync(p!))
}

/** UTM-зона (северное полушарие → EPSG:326xx, южное → 327xx) по средней долготе узлов файла. */
export function utmEpsg(osmXml: string): string {
  const lats = [...osmXml.matchAll(/ lat="(-?[\d.]+)"/g)].map((m) => +m[1])
  const lons = [...osmXml.matchAll(/ lon="(-?[\d.]+)"/g)].map((m) => +m[1])
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)
  const zone = Math.floor((avg(lons) + 180) / 6) + 1
  return `EPSG:${avg(lats) >= 0 ? 326 : 327}${String(zone).padStart(2, '0')}`
}

export interface MatsimResult { nodes: number; links: number; epsg: string; warnings: string[]; network: string }

/**
 * Сконвертировать .osm в сеть MATSim. Конфиг — стандартный, но:
 *  - добавлены внутриквартальные проезды (highway=service, в стандартном конфиге их нет);
 *  - keepPaths=true: геометрия улиц сохраняется (иначе цепочки узлов склеиваются в одну связь).
 */
export function runMatsim(osmFile: string, outDir: string, jar = findPt2matsim()): MatsimResult {
  if (!jar) throw new Error('pt2matsim не найден: tools/pt2matsim/pt2matsim.jar или PT2MATSIM_JAR')
  mkdirSync(outDir, { recursive: true })
  const osm = resolve(osmFile)
  const config = join(outDir, 'osm-config.xml'), network = join(outDir, 'network.xml.gz')
  execFileSync('java', ['-cp', jar, 'org.matsim.pt2matsim.run.CreateDefaultOsmConfig', config], { stdio: 'pipe' })
  const epsg = utmEpsg(readFileSync(osm, 'utf8'))
  let cfg = readFileSync(config, 'utf8')
  const set = (k: string, v: string) => { cfg = cfg.replace(new RegExp(`(<param name="${k}" value=")[^"]*(")`), `$1${v}$2`) }
  set('osmFile', osm)
  set('outputCoordinateSystem', epsg)
  set('outputNetworkFile', network)
  set('keepPaths', 'true')
  const service = `		<parameterset type="wayDefaultParams" >
			<param name="allowedTransportModes" value="car" />
			<param name="freespeed" value="5.555555555555555" />
			<param name="freespeedFactor" value="1.0" />
			<param name="laneCapacity" value="300.0" />
			<param name="lanes" value="1.0" />
			<param name="oneway" value="false" />
			<param name="osmKey" value="highway" />
			<param name="osmValue" value="service" />
		</parameterset>
`
  cfg = cfg.replace(/(\t\t<parameterset type="wayDefaultParams" >)/, service + '$1')
  writeFileSync(config, cfg)
  // pt2matsim пишет журнал и в stdout, и в stderr — собираем оба
  const run = spawnSync('java', ['-cp', jar, 'org.matsim.pt2matsim.run.Osm2MultimodalNetwork', config], { maxBuffer: 64 * 1024 * 1024 })
  const log = `${run.stdout ?? ''}${run.stderr ?? ''}`
  if (run.status !== 0) { writeFileSync(join(outDir, 'pt2matsim.log'), log); throw new Error(`pt2matsim завершился с кодом ${run.status}, журнал: ${join(outDir, 'pt2matsim.log')}`) }
  writeFileSync(join(outDir, 'pt2matsim.log'), log)
  const xml = gunzipSync(readFileSync(network)).toString('utf8')
  const warnings = log.split('\n').filter((l) => / WARN /.test(l) && !/DisallowedNextLinks|Module ".*" is removed/.test(l)).map((l) => l.replace(/^.*WARN\s+\S+\s+/, ''))
  return { nodes: (xml.match(/<node /g) ?? []).length, links: (xml.match(/<link /g) ?? []).length, epsg, warnings, network }
}
