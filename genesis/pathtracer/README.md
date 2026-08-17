# Pipeline Gênesis — Etapa 4: Motor de Luz Puro (Mitsuba 3)

Render final por **path-tracing** em Python puro, **sem Blender**. Importa a malha
acoplada (`zane_com_guitarra.obj`), instancia câmera e luzes, e traça o caminho
da luz na CPU (variante LLVM) ou GPU (CUDA, se houver NVIDIA).

## Dependência

```bash
pip install mitsuba        # motor de render científico; funciona em Python 3.8+
```

Diferente do `bpy`, o `mitsuba` **não** exige Python 3.11 — o venv `.venv-genesis`
serve. O subpacote **importa sem `mitsuba`** (config e `describe_scene` são
inspecionáveis só com `numpy`); o motor é exigido apenas no render.

## Arquitetura em duas camadas

- **`describe_scene(config, center, dims)`** — pura (numpy): devolve a descrição
  numérica da cena (câmera por `d = (h/2)/tan(fov/2)`, luzes em coordenadas
  esféricas, filme). Testável sem o motor.
- **`MitsubaRenderer`** — converte a descrição no dicionário do Mitsuba e executa
  `mi.render`. Escolhe a variante: `llvm_ad_rgb` (CPU) → `scalar_rgb` → `cuda_ad_rgb`.

O centro/dimensões do sujeito são medidos com nossa própria engine
(`genesis.mesh.Mesh`), sem dependência escondida.

## Luz

Três-pontos quente (Key/Fill/Rim) como luzes pontuais; a intensidade radiante
(W/sr) vem de um alvo de irradiância por `I = E · d²`. Piso difuso opcional e uma
luz constante de fundo baixa para evitar preto puro.

## Uso

```bash
# Render vertical (Reels), 128 spp
python -m genesis.pathtracer.cli \
    --input exports/zane_com_guitarra.obj \
    --out renders/zane.png --samples 128

# Horizontal, com ajuste de exposição
python -m genesis.pathtracer.cli --input exports/zane.obj \
    --out renders/zane.png --orientation horizontal --exposure -1.0
```

## Fluxo completo (bare-metal, sem Blender)

```
IA → zane.obj  ─┐
                ├─ coupler → zane_com_guitarra.obj → pathtracer → zane.png
guitarra.obj  ──┘
```

## Testes

```bash
python -m genesis.tests.test_pathtracer   # 7 testes, sem mitsuba
```
