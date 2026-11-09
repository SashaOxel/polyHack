#!/usr/bin/env bash
# Проверка .osm через SUMO netconvert (то же, что делает симулятор при импорте).
# Использование: npm run check:sumo -- path/to/file.osm
# Где искать netconvert: в PATH, либо в $SUMO_HOME/bin, либо в ~/sumo-venv (pip install eclipse-sumo).
set -euo pipefail

FILE="${1:-data/example.osm}"

NETCONVERT="$(command -v netconvert || true)"
for c in "${SUMO_HOME:-/nonexistent}/bin/netconvert" \
         "$HOME/sumo-venv/lib/python3.9/site-packages/sumo/bin/netconvert"; do
  [ -z "$NETCONVERT" ] && [ -x "$c" ] && NETCONVERT="$c"
done
[ -z "$NETCONVERT" ] && { echo "netconvert не найден: pip install eclipse-sumo или задайте SUMO_HOME"; exit 2; }

OUT="$(mktemp -d)"
LOG="$OUT/netconvert.log"
"$NETCONVERT" --osm-files "$FILE" -o "$OUT/out.net.xml" >"$LOG" 2>&1 || { cat "$LOG"; echo "SUMO: ОШИБКА"; exit 1; }

echo "SUMO: OK  ($FILE)"
echo "рёбер: $(grep -c '<edge ' "$OUT/out.net.xml"), перекрёстков: $(grep -c '<junction ' "$OUT/out.net.xml")"
echo "предупреждений: $(grep -c '^Warning' "$LOG")  (лог: $LOG)"
