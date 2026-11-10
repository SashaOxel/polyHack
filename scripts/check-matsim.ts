// Проверка .osm в MATSim (через pt2matsim):  npm run check:matsim -- файл.osm [папка-результата]
import { runMatsim } from '../src/core/matsim'

const [input, out = 'out/matsim'] = process.argv.slice(2)
if (!input) { console.error('Использование: npm run check:matsim -- файл.osm [папка]'); process.exit(2) }
try {
  const r = runMatsim(input, out)
  console.log(`MATSim: OK  (${input})`)
  console.log(`сеть: ${r.nodes} узлов, ${r.links} связей, система координат ${r.epsg}`)
  console.log(`файл сети: ${r.network}`)
  const uniq = [...new Set(r.warnings)]
  console.log(`предупреждений: ${r.warnings.length}${uniq.length ? ' — например: ' + uniq.slice(0, 3).join(' | ') : ''}`)
} catch (e) {
  console.error('MATSim: ОШИБКА — ' + (e as Error).message)
  process.exit(1)
}
