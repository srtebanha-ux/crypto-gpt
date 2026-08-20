# 🎬 beatsync — Studio de Edição de Vídeo Sincronizada com a Batida

Agente de edição de vídeo **automatizado**, com **CLI** e um **Studio web**
(o "IDE"): interface bonita e elegante, **banco de dados completo** e render em
background. Você entrega uma **música** e um **diretório de clipes brutos**; ele
analisa o áudio (BPM, picos de batida, cadência da letra) e monta um
**videoclipe com cortes sincronizados no ritmo**, pronto para render em MP4.

## 🖥️ Studio web (interface visual)

```bash
pip install -r video-editor-bot/requirements.txt   # + FFmpeg no sistema
cd video-editor-bot
beatsync-studio            # abre em http://127.0.0.1:8000
# ou: python -m beatsync.server
```

No Studio você: cria **projetos**, arrasta a **música** e os **clipes**, roda a
**análise** (com visualização das batidas/downbeats/picos/cortes numa timeline),
escolhe o **preset**, dispara o **render** com barra de progresso ao vivo e
**baixa** o MP4 — tudo pelo navegador. Estado persistido em **banco de dados**
(SQLite por padrão; configurável via `DATABASE_URL`).

**Camadas:**

| Camada | Arquivo | Tecnologia |
|--------|---------|-----------|
| Banco de dados | `beatsync/db.py` | SQLAlchemy 2.0 — `projects`, `assets`, `analyses`, `render_jobs`, `presets` |
| Regras de negócio | `beatsync/service.py` | armazenamento de mídia, análise, fila de render em background (progresso) |
| API web | `beatsync/server/app.py` | FastAPI (REST + upload multipart + download) |
| Frontend | `beatsync/server/static/` | SPA vanilla (HTML/CSS/JS), tema escuro, timeline de batidas em canvas |

Variáveis de ambiente: `DATABASE_URL`, `BEATSYNC_STORAGE` (mídia/renders),
`BEATSYNC_HOST`, `BEATSYNC_PORT`, `BEATSYNC_WORKERS`.

---

## 🎛️ Orquestrador cinematográfico (Node.js/TypeScript + Remotion)

Além do núcleo Python, há uma camada de **orquestração de nível Premiere** em
[`orchestrator/`](orchestrator/README.md) que **integra repositórios OSS de
ponta** (não reimplementa motores):

- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — captação dinâmica de cenas
  (b-roll/filmes) a partir do "mood" da música.
- **[auto-editor](https://github.com/WyattBlue/auto-editor)** — trechos úteis de
  cada clipe (remove silêncio/partes paradas).
- **`beatsync` (librosa)** — timestamps musicais (BPM/batidas), exportados por
  `python -m beatsync.export_analysis`.
- **[Remotion](https://github.com/remotion-dev/remotion)** (React/TS, primário)
  ou **[editly](https://github.com/mifi/editly)** (alternativo) — composição/render.
- **Node.js** — pipeline + **webhook para n8n** (`POST /render`).

```bash
cd orchestrator && npm install
npm run dev -- render --audio musica.mp3 --clips ./clips --fetch 6 \
    --mood "neon,city,night" --engine remotion --auto-editor
npm run serve         # webhook n8n em :8787
```

Detalhes, fluxo e o componente Remotion (`Composition`/`Sequence`) em
[`orchestrator/README.md`](orchestrator/README.md).

---

## ⌨️ Uso via CLI (sem interface)

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
│   ├── db.py        # banco de dados do Studio (SQLAlchemy)
│   ├── service.py   # regras de negócio: mídia, análise, fila de render
│   ├── server/
│   │   ├── app.py       # API web (FastAPI)
│   │   ├── __main__.py  # `python -m beatsync.server`
│   │   └── static/      # frontend do Studio (index.html, style.css, app.js)
│   └── __main__.py  # `python -m beatsync` (CLI)
├── tests/
│   ├── test_audio.py     # núcleo de áudio (sinal sintético)
│   └── test_studio.py    # DB + serviço + API web (FastAPI TestClient)
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
