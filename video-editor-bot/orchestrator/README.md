# 🎛️ beatsync-orchestrator (Node.js/TypeScript)

Camada de **orquestração de nível cinematográfico**. Não reimplementa motores —
**integra repositórios OSS de ponta**:

| Papel | Repositório OSS | Módulo |
|-------|-----------------|--------|
| Captação de cenas (b-roll/filmes) | [`yt-dlp/yt-dlp`](https://github.com/yt-dlp/yt-dlp) | `src/sceneFetcher.ts` |
| Timestamps de corte (conteúdo) | [`WyattBlue/auto-editor`](https://github.com/WyattBlue/auto-editor) | `src/autoEditor.ts` |
| Timestamps musicais (BPM/batidas) | `beatsync` (librosa) | `src/beatAnalysis.ts` |
| Composição/render (primário) | [`remotion-dev/remotion`](https://github.com/remotion-dev/remotion) | `remotion/` + `src/remotionRender.ts` |
| Composição/render (alternativo) | [`mifi/editly`](https://github.com/mifi/editly) | `src/editlyRender.ts` |
| Orquestração + webhook (n8n) | — | `src/pipeline.ts`, `src/server.ts`, `src/index.ts` |

## Instalação (comandos de dependência)

```bash
# 1) Ferramentas externas (binários no PATH)
pip install -U yt-dlp auto-editor            # captação + cortes por conteúdo
pip install -r ../requirements.txt           # beatsync (librosa) — análise de batidas
#   + FFmpeg no sistema (apt-get install ffmpeg / brew install ffmpeg)

# 2) Node
cd orchestrator
npm install                                   # remotion, @remotion/*, editly*, express, zod
#   * editly é opcional (libs nativas); se falhar, use --engine remotion

# 3) (Remotion) navegador headless para renderizar
npx remotion browser ensure
```

## Uso

```bash
# Render completo: analisa batidas, baixa 6 cenas do "mood", compõe no Remotion
npm run dev -- render --audio musica.mp3 --clips ./clips --out out/clip.mp4 \
    --fetch 6 --mood "neon,city,night" --engine remotion --grade cinematic --auto-editor

# Só baixar cenas (yt-dlp)
npm run dev -- fetch --mood "sunset,aerial,drone" --count 5 --out ./fetched

# Prévia interativa no Remotion Studio
npm run remotion:studio

# Webhook para n8n
npm run serve        # POST http://127.0.0.1:8787/render  (corpo: examples/n8n-render.json)
```

### Gatilho via n8n

Nó **HTTP Request** → `POST /render` com o JSON de `examples/n8n-render.json`.
Resposta `202 { jobId }`. Faça polling em `GET /jobs/:id` e baixe em
`GET /jobs/:id/file` quando `status=done`.

Recebendo o job por stdin (pipe/n8n Execute Command):

```bash
echo '{"audioPath":"m.mp3","clipsDir":"./clips","fetchScenes":4}' \
  | npm run dev -- render --json -
```

## Fluxo

```
 áudio ─► beatAnalysis (librosa) ─► BPM + segments/beats (frames)
 mood  ─► sceneFetcher (yt-dlp) ──► clipes de alta qualidade + catalog.json
 clips ─► autoEditor (auto-editor) ► trechos "úteis" (sem silêncio/parado)
                     │
                     ▼
              planner ─► atribui clipe+entrada a cada corte + transição por batida
                     │
                     ▼
      Remotion (<BeatVideo/> Sequences)  ── ou ──  editly (editSpec)  ─► MP4
```

## Componente Remotion

- `remotion/Root.tsx` — registra `<BeatVideo/>`; `calculateMetadata` deriva
  width/height/fps/duração das inputProps (a análise define tudo).
- `remotion/BeatVideo.tsx` — uma `<Sequence from={startFrame}/>` por corte +
  `<Audio/>` + flash global na batida.
- `remotion/components/ClipSequence.tsx` — `<OffthreadVideo/>` enquadrado
  (`objectFit: cover`), transição de entrada (hardcut/fade/wipe/slide/flash/
  zoompunch) e "punch" de zoom via `spring()` sincronizado à batida.
- `remotion/components/effects.ts` — grading, punch, beat-flash, respiração RMS.
- `remotion/schema.ts` — reexporta o schema Zod compartilhado (validação de
  ponta a ponta entre CLI, webhook e Remotion Studio).
