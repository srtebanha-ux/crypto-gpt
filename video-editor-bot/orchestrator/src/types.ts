/**
 * types.ts — contrato de dados compartilhado entre a análise (Python beatsync /
 * auto-editor), o orquestrador Node e a composição Remotion.
 *
 * O schema Zod (beatVideoSchema) é reutilizado como inputProps do Remotion,
 * garantindo validação de ponta a ponta (CLI, webhook n8n e Remotion Studio).
 */
import { z } from "zod";

/** Um evento pontual (batida/downbeat/onset), em segundos e em frames. */
export const beatEventSchema = z.object({
  time: z.number(),
  frame: z.number().int(),
  strength: z.number().min(0).max(1).default(1),
});
export type BeatEvent = z.infer<typeof beatEventSchema>;

/** Um segmento de corte = uma Sequence no Remotion. */
export const segmentSchema = z.object({
  index: z.number().int(),
  start: z.number(),
  end: z.number(),
  startFrame: z.number().int(),
  endFrame: z.number().int(),
  durationInFrames: z.number().int().min(1),
  energy: z.number().min(0).max(1).default(0.5),
  /** clipe atribuído a este slot (preenchido pelo orquestrador). */
  clip: z
    .object({
      path: z.string(),
      inSeconds: z.number().default(0),
      source: z.enum(["local", "ytdlp"]).default("local"),
    })
    .optional(),
  /** transição de entrada escolhida para este corte. */
  transition: z
    .enum(["hardcut", "fade", "wipe", "zoompunch", "flash", "slide"])
    .default("hardcut"),
});
export type Segment = z.infer<typeof segmentSchema>;

/** Payload completo da análise de áudio (saída de beatsync.export_analysis). */
export const analysisSchema = z.object({
  audioPath: z.string(),
  fps: z.number().int().default(30),
  tempo: z.number().default(120),
  duration: z.number().default(0),
  durationInFrames: z.number().int().default(0),
  cutMode: z.string().default("hybrid"),
  subdivision: z.number().int().default(1),
  counts: z
    .object({
      beats: z.number().int(),
      downbeats: z.number().int(),
      onsets: z.number().int(),
      cuts: z.number().int(),
      segments: z.number().int(),
    })
    .partial()
    .default({}),
  beats: z.array(beatEventSchema).default([]),
  downbeats: z.array(beatEventSchema).default([]),
  onsets: z.array(beatEventSchema).default([]),
  cuts: z.array(z.number()).default([]),
  cutFrames: z.array(z.number().int()).default([]),
  segments: z.array(segmentSchema).default([]),
  rmsEnvelope: z.array(z.number()).default([]),
});
export type Analysis = z.infer<typeof analysisSchema>;

/** Props de entrada da composição Remotion <BeatVideo/>. */
export const beatVideoSchema = z.object({
  width: z.number().int().default(1920),
  height: z.number().int().default(1080),
  fps: z.number().int().default(30),
  audioSrc: z.string().describe("caminho/URL do áudio (staticFile ou http)"),
  durationInFrames: z.number().int().default(300),
  segments: z.array(segmentSchema).default([]),
  beats: z.array(beatEventSchema).default([]),
  rmsEnvelope: z.array(z.number()).default([]),
  style: z
    .object({
      punchZoom: z.number().min(0).max(0.3).default(0.08),
      transitionFrames: z.number().int().min(0).max(30).default(4),
      grade: z.enum(["none", "cinematic", "vibrant", "noir"]).default("cinematic"),
      beatFlash: z.boolean().default(true),
    })
    .default({}),
});
export type BeatVideoProps = z.infer<typeof beatVideoSchema>;

/** Descritor de um clipe catalogado (local ou baixado via yt-dlp). */
export interface CatalogClip {
  id: string;
  path: string;
  source: "local" | "ytdlp";
  title?: string;
  duration?: number;
  width?: number;
  height?: number;
  keywords?: string[];
  sourceUrl?: string;
}

/** Contrato do trabalho recebido via CLI/JSON/webhook (n8n). */
export interface RenderJobRequest {
  audioPath: string;
  clipsDir?: string;
  outPath?: string;
  mood?: string[]; // palavras-chave para o buscador de cenas
  fetchScenes?: number; // quantos clipes externos baixar (0 = nenhum)
  width?: number;
  height?: number;
  fps?: number;
  cutMode?: "beat" | "downbeat" | "onset" | "hybrid";
  subdivision?: number;
  engine?: "remotion" | "editly";
  grade?: "none" | "cinematic" | "vibrant" | "noir";
  useAutoEditor?: boolean; // pré-filtra clipes com auto-editor antes de compor
}
