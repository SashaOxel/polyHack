import type { Issue } from '../validate'

interface Props {
  issues: Issue[]
  onFocus: (i: Issue) => void
}

export function IssuesPanel({ issues, onFocus }: Props) {
  if (!issues.length) return <div className="hint">Проблем не найдено (или проверка ещё не запускалась).</div>
  const errors = issues.filter((i) => i.severity === 'error').length
  return (
    <div className="panel-body">
      <div className="sub">Ошибок: {errors} · Предупреждений: {issues.length - errors}</div>
      <ul className="issues">
        {issues.slice(0, 300).map((i) => (
          <li key={i.id} className={i.severity} onClick={() => onFocus(i)}>
            <b>{i.severity === 'error' ? '●' : '○'}</b> {i.message}
          </li>
        ))}
      </ul>
      {issues.length > 300 && <div className="hint">показаны первые 300</div>}
    </div>
  )
}
