import type { Issue } from '../validate'
import { fixLabel } from '../validate/fixes'

interface Props {
  issues: Issue[]
  /** сколько проблем скрыто пользователем */
  hiddenCount: number
  onFocus: (i: Issue) => void
  onFix: (i: Issue) => void
  onIgnore: (i: Issue) => void
  onFixAll: () => void
  onShowHidden: () => void
}

export function IssuesPanel({ issues, hiddenCount, onFocus, onFix, onIgnore, onFixAll, onShowHidden }: Props) {
  const errors = issues.filter((i) => i.severity === 'error').length
  const autoCount = issues.filter((i) => i.auto && i.fix).length

  if (!issues.length) {
    return (
      <div className="hint">
        Проблем не найдено{hiddenCount ? '.' : ' (или файл ещё не открыт).'}
        {hiddenCount > 0 && <> Скрыто: {hiddenCount}. <button onClick={onShowHidden}>Показать</button></>}
      </div>
    )
  }

  return (
    <div className="panel-body">
      <div className="sub">Ошибок: {errors} · Предупреждений: {issues.length - errors}</div>
      <div className="row wrap">
        <button disabled={!autoCount} onClick={onFixAll} title="Удалить битые запреты поворотов, склеить дубли узлов. Один шаг отмены">
          Исправить автоматически ({autoCount})
        </button>
        {hiddenCount > 0 && <button onClick={onShowHidden}>Скрыто: {hiddenCount} — показать</button>}
      </div>
      <ul className="issues">
        {issues.slice(0, 300).map((i) => (
          <li key={i.id} className={i.severity} onClick={() => onFocus(i)}>
            <div><b>{i.severity === 'error' ? '●' : '○'}</b> {i.message}</div>
            <div className="actions" onClick={(e) => e.stopPropagation()}>
              {i.fix && <button onClick={() => onFix(i)}>{fixLabel(i.fix)}</button>}
              <button onClick={() => onIgnore(i)} title="Не считать это проблемой (до перезагрузки файла)">Скрыть</button>
            </div>
          </li>
        ))}
      </ul>
      {issues.length > 300 && <div className="hint">показаны первые 300</div>}
    </div>
  )
}
