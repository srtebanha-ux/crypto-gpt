# Pipeline Gênesis — Módulo 3: Esqueletização Autônoma (Rigging / IK)

Injeta o esqueleto digital na malha curada pelo Módulo 2 e a articula com
**Cinemática Inversa**: quando a mão do Zane se move para um traste, o cotovelo
dobra automaticamente com comprimentos de osso preservados. Subpacote
**autônomo** — depende só de `numpy`, não importa nenhum outro módulo do pipeline.

## Componentes

| Arquivo | Papel |
|---------|-------|
| `quaternion.py` | Quatérnions + **dual quatérnions** (a álgebra de SE(3)) |
| `skeleton.py`   | Hierarquia de juntas + Cinemática Direta (FK) |
| `ik.py`         | Solvers de IK + restrição de dobradiça |
| `skinning.py`   | LBS vs **DQS** (Dual Quaternion Skinning) |
| `presets.py`    | Braço/dedo dos membros da MoonSilver |
| `cli.py`        | CLI com `--selftest` |

## Solvers de IK

- **`solve_two_bone`** — analítico (lei dos cossenos) para braço/perna. Exato em
  uma passada; `θ = arccos((a²+b²−c²)/(2ab))` dá o ângulo do cotovelo, e o *pole
  vector* escolhe a direção anatômica da dobra.
- **`solve_fabrik`** — FABRIK para cadeias longas (dedos no braço do violão).
  Duas passadas por iteração, sem inverter Jacobiano, sem singularidades.
- **`solve_ccd`** — Cyclic Coordinate Descent, com limite angular por junta.

## Por que Dual Quaternions

O Linear Blend Skinning interpola matrizes linearmente e **colapsa o volume** em
juntas dobradas (o "candy-wrapper"). O DQS interpola sobre movimentos rígidos
(dual quatérnion `q̂ = q_r + ε q_d`), mantendo a espessura do membro. No
`--selftest`, dobrando 90° uma junta: **LBS perde ~14% do raio da seção; DQS
preserva ~100%.**

## Uso

```bash
python -m genesis.rig.cli --selftest            # 3 demos (IK 2-ossos, FABRIK, DQS)
python -m genesis.rig.cli --reach 0.6 0.2 0.3   # resolve o braço de Zane p/ um alvo
```

```python
from genesis.rig import humanoid_arm, solve_two_bone, arm_rest_points
import numpy as np

arm = humanoid_arm()
p = arm_rest_points(arm)
res = solve_two_bone(p[0], p[1], p[2], np.array([0.6, 0.2, 0.3]), pole=[0, 0, 1])
print(np.degrees(res.interior_angle), "graus no cotovelo")
```

## Testes

```bash
python -m genesis.tests.test_rig     # 11 testes, sem pytest
pytest genesis/tests/test_rig.py
```
