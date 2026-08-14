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

## Como conseguir o modelo bruto (a partir das imagens 2D)

Os geradores imagem→3D reconstroem melhor com **fundo neutro** e **múltiplas
vistas** (frente, lado, costas). Suba as imagens do personagem no Tripo/Meshy
(web, com plano gratuito), baixe o `.glb`/`.obj`, e passe pela Fábrica.

> A integração automática por **API** (a "Fábrica" hands-off) exige uma chave paga
> do provedor; este módulo já cobre a parte de ingestão/normalização, que é a
> mesma independentemente de como o modelo bruto foi obtido.

## Testes

```bash
python -m genesis.tests.test_actor_factory   # 5 testes, sem trimesh/rede
```
