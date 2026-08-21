/**
 * planner.ts — Monta a linha do tempo final: atribui um clipe (e um ponto de
 * entrada) a cada segmento de corte da análise, mesclando o catálogo local com
 * as cenas baixadas via yt-dlp, e respeitando os trechos "úteis" apontados pelo
 * auto-editor. Também escolhe a transição de cada corte conforme a batida.
 */
import type { AutoEditResult } from "./autoEditor.js";
import type { Analysis, BeatVideoProps, CatalogClip, Segment } from "./types.js";

export interface PlanOptions {
  analysis: Analysis;
  clips: CatalogClip[];
  autoEdits?: Map<string, AutoEditResult>; // por path
  width: number;
  height: number;
  grade?: BeatVideoProps["style"]["grade"];
  seed?: number;
}

/** PRNG determinístico (mulberry32) para escolhas reprodutíveis. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Escolhe o instante de entrada dentro do clipe, preferindo trechos úteis. */
function pickIn(
  clip: CatalogClip,
  need: number,
  auto: AutoEditResult | undefined,
  rand: () => number,
): number {
  const dur = clip.duration ?? need;
  const ranges = auto?.keep?.filter((k) => k.end - k.start >= need) ?? [];
  if (ranges.length) {
    const r = ranges[Math.floor(rand() * ranges.length)];
    return r.start + rand() * Math.max(0, r.end - r.start - need);
  }
  return Math.max(0, rand() * Math.max(0, dur - need));
}

/** Transição em função da energia/força da batida do corte. */
function pickTransition(energy: number, rand: () => number): Segment["transition"] {
  if (energy > 0.75) return rand() > 0.5 ? "zoompunch" : "flash";
  if (energy > 0.5) return rand() > 0.5 ? "hardcut" : "slide";
  if (energy > 0.3) return "wipe";
  return "fade";
}

export function planTimeline(opts: PlanOptions): BeatVideoProps {
  const { analysis, clips } = opts;
  const rand = rng(opts.seed ?? 1337);
  if (clips.length === 0) {
    throw new Error("nenhum clipe disponível (local ou yt-dlp) para compor.");
  }

  // ordem embaralhada + cursor por clipe, para distribuir o uso sem repetir
  const order = [...clips].sort(() => rand() - 0.5);
  let cursor = 0;

  const segments: Segment[] = analysis.segments.map((seg) => {
    const clip = order[cursor % order.length];
    cursor++;
    const need = Math.max(0.3, seg.end - seg.start);
    const auto = opts.autoEdits?.get(clip.path);
    const inSeconds = pickIn(clip, need, auto, rand);
    return {
      ...seg,
      clip: { path: clip.path, inSeconds, source: clip.source },
      transition: pickTransition(seg.energy ?? 0.5, rand),
    };
  });

  return {
    width: opts.width,
    height: opts.height,
    fps: analysis.fps,
    audioSrc: analysis.audioPath,
    durationInFrames: Math.max(1, analysis.durationInFrames),
    segments,
    beats: analysis.beats,
    rmsEnvelope: analysis.rmsEnvelope,
    style: {
      punchZoom: 0.08,
      transitionFrames: Math.round(analysis.fps * 0.13),
      grade: opts.grade ?? "cinematic",
      beatFlash: true,
    },
  };
}
