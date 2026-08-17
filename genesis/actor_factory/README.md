# Pipeline Gênesis — Fábrica de Atores (ingestão imagem→3D)

Pega o modelo 3D **bruto** que sai de um gerador imagem→3D (Tripo, Meshy, etc.) e
o deixa **pronto para o pipeline**: converte para Z-up, escala para a altura real,
apoia o pé no chão, centraliza e cura a malha (Módulo 2).

Núcleo em `numpy` (`genesis.mesh`). `trimesh` só é necessário para formatos
não-`.obj` (glTF/GLB/PLY/FBX).

## Por que este passo existe

Modelos de imagem→3D chegam com **escala, orientação e centro arbitrários** —
quase sempre **Y-up** (padrão glTF), fora de escala e flutuando. Sem normalizar,
o rig, o acoplador e a câmera do render erram tudo.

## Uso

```bash
# Modelo baixado do Tripo/Meshy (glTF) → ator pronto de 1.8 m
python -m genesis.actor_factory.cli \
    --input downloads/zane.glb --out exports/zane.obj --height 1.8

# Já é .obj Z-up? pule a conversão de eixo
python -m genesis.actor_factory.cli \
    --input raw/zane.obj --out exports/zane.obj --up z
```

Depois é só seguir o pipeline: acoplar a guitarra e renderizar.

```bash
python -m genesis.coupler.cli --character exports/zane.obj --prop exports/guitarra.obj \
    --hand 0.35 -0.10 1.05 --out exports/zane_com_guitarra.obj
python -m genesis.pathtracer.cli --input exports/zane_com_guitarra.obj --out renders/zane.png
```

## Imagem→3D em código bruto (Visual Hull) — sem terceiros

Para reconstruir sem rede neural nem serviço externo, use o **Shape-from-Silhouette**
(`hull_cli`): esculpe a malha das silhuetas (frente/lado/costas) por interseção de
cones de visão (voxel carving) — só `numpy` + `Pillow` (este último só lê pixels).

```bash
python -m genesis.actor_factory.hull_cli \
    --front img/zane_frente.png --side img/zane_lado.png --back img/zane_costas.png \
    --out exports/zane.obj --resolution 128
```

**Requisitos das imagens:** fundo **neutro/liso** (a silhueta é extraída por
distância de cor) e as vistas na **mesma altura de personagem**.

**Limite honesto:** o visual hull captura o *envelope* das silhuetas — não escava
concavidades (vão entre braço e tronco) nem detalha o rosto. Sai um manequim com
a proporção certa (ótimo como base de rig), **não** o render fotorealista.

### Alternativa polida (rede neural de terceiro)

Se quiser qualidade fotorealista, os geradores imagem→3D (Tripo/Meshy) usam redes
treinadas; suba as imagens no site deles, baixe o `.glb`/`.obj`, e passe pela
ingestão (`cli`, acima). Custo: depende de serviço externo — o oposto do
Visual Hull, que é 100% nosso.

## Testes

```bash
python -m genesis.tests.test_actor_factory   # 5 testes, sem trimesh/rede
```
