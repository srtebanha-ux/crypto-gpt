#!/usr/bin/env bash
# Exemplo de uso do beatsync.
# Requer: FFmpeg instalado + `pip install -r requirements.txt`
set -euo pipefail

AUDIO="${1:-musica.mp3}"
CLIPS_DIR="${2:-./clipes}"
OUT="${3:-clipe_final.mp4}"

echo "== 1) Dry-run: inspecionar batidas e plano de cortes =="
python -m beatsync -a "$AUDIO" -c "$CLIPS_DIR" --preset hype --dry-run

echo
echo "== 2) Render completo (preset 'hype', cortes agressivos no ritmo) =="
python -m beatsync -a "$AUDIO" -c "$CLIPS_DIR" -o "$OUT" \
    --preset hype --seed 42

echo
echo "Pronto: $OUT"
