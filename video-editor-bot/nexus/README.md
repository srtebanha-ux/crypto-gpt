# 🧠 NEXUS-ÔMEGA — Cognitive Semantic Editor

Pipeline de edição **cognitiva**: o sistema "ouve/lê" a letra da música e
"assiste" aos vídeos, casando o **significado da letra** com o **conteúdo da
cena** (visão computacional) e cortando no **ritmo exato do BPM**.

## Pipeline

```
STEP 1  audio_brain.py   Whisper (word timestamps) + Librosa (BPM/beats/drops)
STEP 2  vision_brain.py  PySceneDetect (fatia cenas) + CLIP (embedding visual)
STEP 3  nexus_editor.py  cosine similarity  letra(texto CLIP) ↔ cena(imagem CLIP)
STEP 4  nexus_editor.py  MoviePy/FFmpeg → .mp4 com áudio original
```

O CLIP fornece um **espaço multimodal compartilhado**: o embedding de TEXTO da
frase cantada e o embedding de IMAGEM da cena são diretamente comparáveis por
similaridade do cosseno. Para cada janela da música (delimitada pelas batidas do
librosa), escolhe-se a cena de maior similaridade e alinha-se o corte ao BPM.

## Instalação

```bash
pip install -r nexus/requirements.txt      # whisper, transformers, torch, clip, librosa, scenedetect, moviepy
# + FFmpeg no sistema. GPU (torch+CUDA) acelera Whisper e CLIP.
```

## Uso

```bash
# Pipeline completo (Step 1→4)
python nexus/nexus_editor.py --audio musica.mp3 --videos a.mp4 b.mp4 longo.mp4 \
    --out videoclipe_final.mp4 --whisper small --beats-per-cut 2

# Etapas isoladas (debug / cache)
python nexus/audio_brain.py  musica.mp3 --model small --out audio_brain.json
python nexus/vision_brain.py a.mp4 b.mp4 --out vision_brain.npz
```

Parâmetros úteis: `--beats-per-cut` (densidade de cortes), `--scene-threshold`
(sensibilidade do PySceneDetect), `--width/--height/--fps`.

## Arquivos

| Arquivo | Step | Tecnologias |
|---------|------|-------------|
| `audio_brain.py` | 1 | `openai-whisper` (word-level), `librosa` (beat_track, onsets/drops) |
| `vision_brain.py` | 2 | `scenedetect` (ContentDetector), `opencv` (frames), `transformers` CLIP |
| `nexus_editor.py` | 3+4 | cosine similarity (numpy), `moviepy` (timeline + export) |

## Notas técnicas

- **Matching** (`match_timeline`): a letra é buscada pelo MEIO de cada janela
  (evita artefato de fronteira de frase); a repetição da mesma cena só é evitada
  quando o 2º lugar é competitivo (não sacrifica o casamento semântico).
- **Drops**: picos abruptos (onset + Δ RMS) viram fronteiras de corte forçadas.
- **MoviePy**: import lazy e compatível com v2 (`from moviepy import …`) e v1
  (`moviepy.editor`); enquadramento por crop central (`cover`).
- Testes: `tests/test_nexus.py` valida o Step 3 com encoder/cenas sintéticos
  (sem baixar modelos), incluindo casamento semântico e alinhamento ao BPM.
