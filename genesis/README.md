# Pipeline Gênesis

Infraestrutura de animação 3D da banda virtual **MoonSilver** (Zane, Vance, Leo).
Cada módulo é **autônomo** (só `numpy` obrigatório) e não importa os demais.

| Módulo | O quê | Onde |
|--------|-------|------|
| **2 — Retopologia Genética** | cura a malha bruta → water-tight/manifold | este diretório |
| **3 — Esqueletização (Rigging/IK)** | injeta esqueleto e articula com IK | [`rig/`](rig/README.md) |

---

## Módulo 2: Retopologia Genética

Módulo **autônomo** de cura de malhas 3D (`.obj`). Cura a geometria caótica que
motores generativos produzem — vértices duplicados, faces degeneradas, buracos —
transformando-a em uma malha **water-tight** e **manifold**, pronta para rigging.

## Autonomia e dependências

- **Não importa nenhum outro módulo do pipeline** — roda sozinho.
- **Dependência obrigatória:** `numpy` (única).
- **Aceleradores opcionais** (degradam com elegância se ausentes):
  - `scipy` → KD-tree (`cKDTree`) para vizinhança exata em `spatial.py`.
  - `open3d` → Reconstrução de Superfície de Poisson (`poisson_reconstruct`).

## Uso (CLI)

```bash
# Autoteste: gera malha suja procedural, cura e compara antes/depois (sem assets)
python -m genesis.cli --selftest

# Cura um asset e grava o resultado
python -m genesis.cli entrada.obj -o saida.obj --smooth 8 --weld-tol 1e-4

# Apenas diagnóstico topológico
python -m genesis.cli entrada.obj --report
```

## Uso (API)

```python
from genesis import Mesh, heal, HealConfig

mesh = Mesh.load_obj("zane_raw.obj")
result = heal(mesh, HealConfig(weld_tolerance=1e-4, smooth_iterations=8))
print(result.after.summary())
result.mesh.save_obj("zane_healed.obj")
```

## O que a cura faz (e por quê)

| Passo | Função | Porquê matemático |
|-------|--------|-------------------|
| Solda de vértices | `weld_vertices` | Hashing de grade `O(V log V)`; refunde cópias coincidentes que reconstruções deixam soltas |
| Faces degeneradas | `remove_degenerate_faces` | Área `= ½‖(v₁−v₀)×(v₂−v₀)‖ ≈ 0` ⇒ normal indefinida |
| Faces duplicadas | `remove_duplicate_faces` | Deduplicação por canto ordenado (ignora orientação) |
| Vértices órfãos | `remove_unreferenced_vertices` | Mantém a numeração densa para os pesos de rigging |
| Suavização | `laplacian_smooth` | Taubin (λ, μ<0): passa-banda que suaviza sem encolher volume |

A topologia é auditada via relação **aresta → faces incidentes**: água-estanque
⇔ sem arestas de borda nem não-manifold; a característica de Euler
`χ = V − E + F = 2 − 2g` estima o gênero da superfície.

## Testes

```bash
python -m genesis.tests.test_retopology   # sem pytest
pytest genesis/tests                       # com pytest
```
