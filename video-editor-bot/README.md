# 🎬 beatsync — Bot de Edição de Vídeo Sincronizada com a Batida

Agente de edição de vídeo **automatizado**. Você entrega uma **música** e um
**diretório de clipes brutos**; ele analisa o áudio (BPM, picos de batida,
cadência da letra) e monta um **videoclipe com cortes sincronizados no ritmo**,
pronto para render em MP4.

- **Análise de áudio** com [`librosa`](https://librosa.org): tempo (BPM), beat
  tracking, downbeats (compassos 4/4), onsets/transientes e envelope de energia RMS.
- **Cadência da letra** (opcional) com [Whisper](https://github.com/openai/whisper)
  / [faster-whisper](https://github.com/SYSTRAN/faster-whisper): cortes caem no
  início de palavras/frases.
- **Motor de corte** com [MoviePy 2.x](https://zulko.github.io/moviepy/) + **FFmpeg**:
  seleção inteligente de trechos, normalização de resolução (crop central),
  transições (crossfade/fade), "zoom punch" na batida, speed-ramp por energia.
- **Presets** prontos: `reels` (vertical), `cinematic`, `hype`, `clean`.
- **CLI** com `--dry-run` para inspecionar o plano de cortes antes de renderizar.

---

## Instalação

```bash
# 1) FFmpeg (obrigatório — engine de encode/decode)
#   Ubuntu/Debian:  sudo apt-get install -y ffmpeg
#   macOS (brew):   brew install ffmpeg

# 2) Dependências Python
cd video-editor-bot
pip install -r requirements.txt
# ou, como pacote (habilita o comando `beatsync`):
pip install -e .

# 3) (opcional) análise de letra
pip install faster-whisper        # recomendado (leve/rápido)
# ou: pip install openai-whisper
```

## Uso rápido (CLI)

```bash
# Preset vertical para redes sociais, cortes em cada batida
beatsync -a musica.mp3 -c ./clipes -o clipe_final.mp4 --preset reels

# Videoclipe cinematográfico: cortes só nos compassos + crossfade
beatsync -a musica.mp3 -c ./clipes -o out.mp4 --preset cinematic

# Máxima energia: híbrido (downbeats + picos), meias-batidas, speed-ramp
beatsync -a musica.mp3 -c ./clipes -o out.mp4 --preset hype

# Reforçar cortes na cadência da letra (Whisper)
beatsync -a musica.mp3 -c ./clipes -o out.mp4 --preset clean --lyrics

# Só inspecionar o plano (BPM + lista de cortes), sem renderizar
beatsync -a musica.mp3 -c ./clipes --dry-run
```

Sem instalar o pacote, use `python -m beatsync ...` no diretório `video-editor-bot`.

## Uso programático (Python)

```python
from beatsync import make_video, get_preset

cfg = get_preset("hype")
cfg.use_lyrics = True          # opcional
cfg.seed = 42                  # escolha reprodutível de clipes

make_video(
    audio_path="musica.mp3",
    clips_dir="./clipes",
    output_path="clipe_final.mp4",
    config=cfg,
    log=print,
)
```

## Como funciona (pipeline)

```
 música ──► analyze_audio() ──► BPM, beats, downbeats, onsets, RMS
                    │
   (opcional) transcribe() ──► timestamps de palavras/frases (Whisper)
                    │
                    ▼
        resolve_cut_points()  ── escolhe os instantes de corte segundo o modo
                    │           (beat / downbeat / onset / hybrid) + letra
                    ▼
          build_timeline()   ── distribui trechos dos clipes brutos entre os
                    │           slots, sem repetir o mesmo pedaço; ajusta veloc.
                    ▼
             render()        ── normaliza resolução (crop central), aplica
                                transições/zoom, casa a trilha e escreve o MP4
```

### Estratégias de corte (`--cut-mode`)

| Modo       | Comportamento                                                       |
|------------|--------------------------------------------------------------------|
| `beat`     | Corta em **cada batida** — ritmo constante, dançante.              |
| `downbeat` | Corta só no **início dos compassos** — cortes mais longos.        |
| `onset`    | Corta nos **transientes de energia** — agressivo, imprevisível.   |
| `hybrid`   | **Downbeats + picos fortes** — equilíbrio impactante (padrão).    |

`--subdivision 2` (ou 4) dobra/quadruplica a densidade (meias-batidas,
semicolcheias). `--min-cut` garante duração mínima por corte.

## Estrutura

```
video-editor-bot/
├── beatsync/
│   ├── audio.py     # análise de áudio (librosa): BPM, beats, onsets, RMS
│   ├── lyrics.py    # transcrição/timestamps de letra (Whisper) — opcional
│   ├── video.py     # descoberta/sondagem de clipes, subclipes, render (MoviePy/FFmpeg)
│   ├── editor.py    # motor de corte: junta tudo e monta a timeline
│   ├── config.py    # RenderConfig + presets
│   ├── cli.py       # interface de linha de comando
│   └── __main__.py  # `python -m beatsync`
├── tests/test_audio.py   # testes do núcleo de áudio (sinal sintético)
├── examples/run_example.sh
├── requirements.txt
└── pyproject.toml
```

## Testes

```bash
pip install pytest
cd video-editor-bot
pytest -q          # usa um WAV sintético de clicks; não precisa de FFmpeg
```

## Notas

- Os clipes brutos são normalizados para a resolução alvo com **crop central**
  (preserva o enquadramento sem distorcer). Ajuste com `--width/--height`.
- O vídeo final é **cortado no fim da música** (com fade de áudio), então
  garanta clipes suficientes para cobrir a duração da faixa.
- Formatos de clipe suportados: `.mp4 .mov .mkv .avi .webm .m4v .mpg .mpeg`.

## Licença

MIT.
