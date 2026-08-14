# Pipeline Gênesis — Cenário Procedural (Palco)

Gera um **palco de show** completo em `bpy` para a MoonSilver e renderiza pelo
motor do Módulo 5 (Cycles/Metal, headless). Responde à necessidade de "criar os
cenários" sem depender de um artista 3D.

## O que monta

- **Piso** escuro semi-reflexivo (madeira de palco encerada).
- **Backdrop** (cyclorama) atrás do sujeito.
- **Treliça frontal de spots** com mira calculada para o rosto/peito, em paleta
  quente de rock folk (âmbar + branco quente).
- **Contraluz (rim)** frio atrás, separando a silhueta do fundo.
- **Névoa volumétrica** opcional (`--volumetric`) para god-rays.
- **Câmera** 3/4 frontal (50 mm) à altura do peito.

Convenção de cena (igual ao Módulo 5): sujeito na origem olhando para −Y,
plateia/câmera em −Y, +Z para cima.

## Uso (no Mac, com `bpy`)

```bash
# Palco vazio (beauty shot da iluminação)
python -m genesis.stage.cli --out renders/ --orientation horizontal

# Palco COM o personagem no centro + god-rays
python -m genesis.stage.cli --subject exports/zane.obj --out renders/ --volumetric

# Sem asset real: coloca Suzanne no palco pra validar
python -m genesis.stage.cli --subject exports/zane.obj --placeholder
```

## Matemática (testável sem `bpy`)

- `truss_spot_positions(count, width, height, depth)` — spots uniformes ao longo
  de X, à frente e acima do sujeito.
- `rim_positions(...)` — contraluz atrás.
- `aim_directions(positions, target)` — vetores unitários de mira dos cones.

## Testes

```bash
python -m genesis.tests.test_stage    # 6 testes, sem pytest
pytest genesis/tests/test_stage.py
```

## Nota

Isto cria o **cenário**. O **personagem 3D** continua sendo um passo à parte
(imagem 2D → malha 3D) — este módulo aceita a malha via `--subject` quando ela
existir, ou um placeholder via `--placeholder`.
