# Pipeline Gênesis — Acoplador Matemático (Etapa 3)

"Parenting" de props **sem Blender, sem `bpy`**. Cola um prop rígido (a guitarra)
na mão do personagem por **álgebra de matrizes pura** e exporta a malha unida em
`.obj`, pronta para o render (Mitsuba 3). Dependência: só `numpy`.

## Como funciona

1. Carrega `zane.obj` e `guitarra.obj` na memória (via `genesis.mesh.Mesh`).
2. Monta uma **transformação afim 4×4** `[[s·R, t], [0,1]]`, com `R` de um
   **quatérnion** (a mesma álgebra do Módulo 3).
3. Aplica a matriz aos vértices do prop.
4. **Concatena** as duas malhas num só arquivo (dois componentes conexos).
5. Exporta `zane_com_guitarra.obj`.

**Ancoragem por empunhadura:** `t = mão − s·R·grip` leva o ponto de empunhadura
do prop (não a origem do arquivo) exatamente à posição da mão.

### Concatenação, não união booleana

Boolean/CSG funde volumes e **destrói** a geometria na interseção — a mão
"comeria" o braço da guitarra. Para acoplar um prop rígido, a operação correta é
concatenar preservando ambas as malhas. O acoplador faz isso e o resultado tem,
por construção, **2 componentes conexas** (verificado nos testes).

## Uso

```bash
python -m genesis.coupler.cli \
    --character exports/zane.obj --prop exports/guitarra.obj \
    --hand 0.35 -0.10 1.05 --axis-angle 0 0 1 25 \
    --grip 0 0 0 --scale 1.0 \
    --out exports/zane_com_guitarra.obj

# Autoteste (dois cubos procedurais, sem assets)
python -m genesis.coupler.cli --selftest
```

Rotação: `--quat W X Y Z` **ou** `--axis-angle AX AY AZ GRAUS`.

## API

```python
from genesis.coupler import couple
res = couple("zane.obj", "guitarra.obj",
             hand_position=(0.35, -0.10, 1.05),
             quat=(0.97, 0, 0, 0.22), grip_point=(0, 0, 0),
             scale=1.0, output_path="zane_com_guitarra.obj")
print(res.matrix)  # a matriz afim 4×4 aplicada
```

## Testes

```bash
python -m genesis.tests.test_coupler   # 6 testes, sem pytest
```
