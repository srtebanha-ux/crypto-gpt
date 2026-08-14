# Pipeline Gênesis — Módulo 5: O Motor Fantasma (Renderizador Headless)

Renderiza os membros da MoonSilver (Zane, Vance, Leo) com **Blender/Cycles**
importado como biblioteca `bpy` — 100% headless, **sem subprocesso** abrindo o
executável do Blender.

## Hardware-alvo: MacBook Air (Apple Silicon)

O backend de compute é o **Metal** da Apple. O código **não** usa nem referencia
CUDA/OptiX (exclusivos NVIDIA). Denoise por **OpenImageDenoise**.

## Dependência

`bpy` (Blender como módulo Python):

```bash
pip install bpy    # wheel oficial do Blender; casa com a versão do Python
```

O subpacote **importa sem `bpy`** (dá para inspecionar `RenderConfig`, a
matemática de luz e a validação em qualquer Python); o Blender só é exigido no
momento do render, com mensagem de erro clara se ausente.

## Uso

```bash
# Frame único PNG (busto, vertical 1080x1920)
python -m genesis.render.cli \
    --input exports/moonsilver_zane_purificado.obj \
    --out renders/ --format PNG --samples 128

# Valida o pipeline sem o asset real (gera Suzanne como placeholder)
python -m genesis.render.cli --input exports/zane.obj --out renders/ --placeholder

# Sequência → MP4 vertical H.264
python -m genesis.render.cli --input exports/zane.obj --out renders/ \
    --format MP4 --frame-start 1 --frame-end 48 --fps 24
```

## Arquitetura (OO)

`HeadlessRenderEngine.run()` orquestra, com telemetria `[NEXUS-RENDER]` e
exceções blindadas em `RenderEngineError`:

1. **`configure_device`** — Cycles + `compute_device_type='METAL'`, GPU on.
2. **`reset_scene`** — deleta cubo/luz/câmera default e limpa órfãos.
3. **`import_subject`** — `.obj` via `wm.obj_import` (Blender 4.x), `.fbx` via
   `import_scene.fbx`; mede a bounding box mundial.
4. **`frame_subject_camera`** — matriz *look-at* ortonormal; distância de
   enquadramento `d = (h/2) / tan(θ/2)`.
5. **`build_three_point_lighting`** — Key/Fill/Rim em coordenadas esféricas →
   cartesianas; potência `P = E · 4π d²` (inverso do quadrado).
6. **`configure_render_settings`** — samples, denoise (OIDN), resolução, Filmic,
   PNG ou MP4/H.264.
7. **`render`** — `bpy.ops.render.render(...)`, frame único ou animação.

## Decisões matemáticas

- **Câmera** — Blender olha em `-Z` local; a base `[right, up, back]` é montada
  com `back = normalize(eye - target)`, garantindo uma matriz de rotação destra.
- **Luz** — potência derivada de um alvo de irradiância pela lei do inverso do
  quadrado; os defaults rendem Key ≈ 700 W, Fill ≈ 250 W, Rim ≈ 1.1 kW (razão de
  contraste Key:Fill ≈ 4:1), a faixa saudável do Cycles com Filmic.

## Testes

```bash
python -m genesis.tests.test_render     # partes independentes de bpy
pytest genesis/tests/test_render.py
```
