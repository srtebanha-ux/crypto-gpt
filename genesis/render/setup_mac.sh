#!/usr/bin/env bash
# Setup + primeiro render do Módulo 5 (Motor Fantasma) num MacBook Air (Apple Silicon).
#
# Cria um venv com Python 3.11 (exigido pelo wheel do bpy 4.x), instala bpy+numpy
# e dispara um render de validação usando um placeholder (Suzanne) — assim você
# confirma que o Cycles/Metal está funcionando ANTES de ter o asset real.
#
# Uso:
#   bash genesis/render/setup_mac.sh                 # render de validação (placeholder)
#   bash genesis/render/setup_mac.sh exports/zane.obj  # render com o asset real
set -euo pipefail

ASSET="${1:-exports/moonsilver_zane_purificado.obj}"
VENV=".venv-genesis"

echo "[setup] procurando Python 3.11 (necessário para o wheel do bpy)..."
# Procura o interpretador 3.11 em: variável PYTHON, no PATH, e nos caminhos
# padrão do Homebrew (Apple Silicon em /opt/homebrew, Intel em /usr/local).
CANDIDATES=(
  "${PYTHON:-}"
  "python3.11"
  "/opt/homebrew/opt/python@3.11/bin/python3.11"
  "/usr/local/opt/python@3.11/bin/python3.11"
)
if command -v brew >/dev/null 2>&1; then
  CANDIDATES+=("$(brew --prefix 2>/dev/null)/opt/python@3.11/bin/python3.11")
fi

PY=""
for cand in "${CANDIDATES[@]}"; do
  [[ -z "$cand" ]] && continue
  if command -v "$cand" >/dev/null 2>&1 \
     && "$cand" -c 'import sys; sys.exit(0 if sys.version_info[:2]==(3,11) else 1)' 2>/dev/null; then
    PY="$cand"
    break
  fi
done

if [[ -z "$PY" ]]; then
  echo "[setup] ERRO: Python 3.11 não encontrado (o bpy 4.x exige exatamente 3.11)."
  echo "        Instale com:  brew install python@3.11"
  echo "        Depois é só rodar de novo:  bash $0"
  echo "        (Ou aponte manualmente:  PYTHON=/caminho/para/python3.11 bash $0)"
  exit 1
fi
echo "[setup] usando: $PY  ($("$PY" --version 2>&1))"

echo "[setup] criando venv em $VENV ..."
"$PY" -m venv "$VENV"
# shellcheck disable=SC1091
source "$VENV/bin/activate"

echo "[setup] instalando dependências (bpy + numpy) ..."
python -m pip install --quiet --upgrade pip
python -m pip install --quiet "numpy>=1.24" "bpy>=4.0"

echo "[setup] confirmando bpy e backend Metal ..."
python - <<'PY'
import bpy
print(f"  bpy {bpy.app.version_string}")
prefs = bpy.context.preferences.addons["cycles"].preferences
prefs.compute_device_type = "METAL"
for fn in ("refresh_devices", "get_devices"):
    f = getattr(prefs, fn, None)
    if callable(f):
        try: f(); break
        except Exception: pass
metal = [d.name for d in prefs.devices if d.type == "METAL"]
print("  dispositivos Metal:", metal or "NENHUM (verifique o Blender/macOS)")
PY

mkdir -p renders exports
if [[ -f "$ASSET" ]]; then
  echo "[setup] renderizando asset real: $ASSET"
  python -m genesis.render.cli --input "$ASSET" --out renders/ --format PNG --samples 128
else
  echo "[setup] asset '$ASSET' ausente — render de VALIDAÇÃO com placeholder (Suzanne)"
  python -m genesis.render.cli --input "$ASSET" --out renders/ --format PNG \
    --samples 64 --placeholder
fi

echo "[setup] pronto. Veja os PNGs em: renders/"
