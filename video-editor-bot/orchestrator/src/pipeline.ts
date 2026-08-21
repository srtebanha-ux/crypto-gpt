/**
 * pipeline.ts — Orquestração de ponta a ponta:
 *
 *   1. beatsync (librosa)     → BPM + timestamps de batidas/cortes
 *   2. yt-dlp (opcional)      → baixa cenas de "mood" e cataloga
 *   3. auto-editor (opcional) → trechos úteis de cada clipe
 *   4. planner                → atribui clipes aos cortes + transições
 *   5. Remotion | editly      → render final MP4
 *
 * Não implementa nenhum motor: apenas coordena as ferramentas OSS.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { analyzeBeats } from "./beatAnalysis.js";
import { analyzeClip, type AutoEditResult } from "./autoEditor.js";
import { renderWithEditly } from "./editlyRender.js";
import { renderWithRemotion } from "./remotionRender.js";
import { log } from "./logger.js";
import { planTimeline } from "./planner.js";
import {
  catalogLocal,
  fetchScenes,
  moodFromTempo,
} from "./sceneFetcher.js";
import type { BeatVideoProps, CatalogClip, RenderJobRequest } from "./types.js";

export interface PipelineResult {
  outPath: string;
  props: BeatVideoProps;
  clipsUsed: number;
  scenesFetched: number;
  tempo: number;
  cuts: number;
  engine: string;
}

export async function runPipeline(
  req: RenderJobRequest,
  onProgress?: (stage: string, pct: number) => void,
): Promise<PipelineResult> {
  const fps = req.fps ?? 30;
  const width = req.width ?? 1920;
  const height = req.height ?? 1080;
  const engine = req.engine ?? "remotion";
  const outPath = req.outPath ?? path.resolve("out", `beatsync-${Date.now()}.mp4`);

  if (!req.audioPath) throw new Error("audioPath é obrigatório");
  await fs.access(req.audioPath).catch(() => {
    throw new Error(`áudio não encontrado: ${req.audioPath}`);
  });

  // 1) análise de batidas -------------------------------------------------
  onProgress?.("analisando áudio", 8);
  const analysis = await analyzeBeats({
    audioPath: req.audioPath,
    fps,
    cutMode: req.cutMode ?? "hybrid",
    subdivision: req.subdivision ?? 1,
  });

  // 2) catálogo local + captação yt-dlp ----------------------------------
  onProgress?.("catalogando clipes", 20);
  let clips: CatalogClip[] = req.clipsDir ? await catalogLocal(req.clipsDir) : [];
  log.info(`clipes locais: ${clips.length}`);

  let scenesFetched = 0;
  const wantFetch = (req.fetchScenes ?? 0) > 0;
  if (wantFetch) {
    onProgress?.("baixando cenas (yt-dlp)", 30);
    const mood = req.mood?.length ? req.mood : moodFromTempo(analysis.tempo);
    const fetchDir = path.join(path.dirname(outPath), "fetched");
    const fetched = await fetchScenes({
      keywords: mood,
      count: req.fetchScenes ?? 0,
      outDir: fetchDir,
      maxHeight: height,
      maxDuration: 30,
    });
    scenesFetched = fetched.length;
    clips = clips.concat(fetched);
  }
  if (clips.length === 0) {
    throw new Error(
      "nenhum clipe disponível: informe clipsDir com vídeos ou use fetchScenes>0 (yt-dlp).",
    );
  }

  // 3) auto-editor: trechos úteis por clipe (opcional) -------------------
  const autoEdits = new Map<string, AutoEditResult>();
  if (req.useAutoEditor) {
    onProgress?.("filtrando com auto-editor", 45);
    for (const c of clips) {
      autoEdits.set(c.path, await analyzeClip(c.path));
    }
  }

  // 4) planejamento da timeline ------------------------------------------
  onProgress?.("planejando timeline", 55);
  const props = planTimeline({
    analysis,
    clips,
    autoEdits,
    width,
    height,
    grade: req.grade ?? "cinematic",
  });
  log.ok(
    `timeline: ${props.segments.length} cortes sobre ${clips.length} clipes ` +
      `(${scenesFetched} via yt-dlp)`,
  );

  // 5) render -------------------------------------------------------------
  onProgress?.(`renderizando (${engine})`, 65);
  if (engine === "editly") {
    await renderWithEditly({ props, outPath });
  } else {
    await renderWithRemotion({
      props,
      outPath,
      onProgress: (p) => onProgress?.("renderizando (remotion)", 65 + p * 34),
    });
  }
  onProgress?.("concluído", 100);

  return {
    outPath,
    props,
    clipsUsed: clips.length,
    scenesFetched,
    tempo: analysis.tempo,
    cuts: props.segments.length,
    engine,
  };
}
