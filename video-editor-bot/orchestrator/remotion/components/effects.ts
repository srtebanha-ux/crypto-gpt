/**
 * effects.ts — helpers de efeito reativos à batida e color grading.
 * Puros (sem JSX) para poder testar/reutilizar.
 */
import { interpolate, spring } from "remotion";
import type { BeatEvent } from "../../src/types.js";

/** Filtro CSS de color grading por preset. */
export function gradeFilter(grade: string, energy = 0.5): string {
  switch (grade) {
    case "cinematic":
      return `contrast(1.08) saturate(1.12) brightness(1.02) sepia(0.06)`;
    case "vibrant":
      return `contrast(1.12) saturate(${1.3 + energy * 0.3}) brightness(1.04)`;
    case "noir":
      return `grayscale(1) contrast(1.25) brightness(0.98)`;
    default:
      return "none";
  }
}

/**
 * "Punch" de zoom no início de cada corte: escala decai de (1+amount) → 1 nos
 * primeiros ~5 frames, dando impacto na batida de entrada.
 */
export function punchScale(
  frameInSeq: number,
  fps: number,
  amount: number,
): number {
  const s = spring({
    frame: frameInSeq,
    fps,
    config: { damping: 12, stiffness: 200, mass: 0.5 },
    durationInFrames: Math.round(fps * 0.35),
  });
  return 1 + amount * (1 - s);
}

/** Intensidade do flash na batida mais próxima do frame global. */
export function beatFlash(
  globalFrame: number,
  beats: BeatEvent[],
  fps: number,
): number {
  if (!beats.length) return 0;
  // busca a batida imediatamente anterior
  let nearest: BeatEvent | undefined;
  for (const b of beats) {
    if (b.frame <= globalFrame) nearest = b;
    else break;
  }
  if (!nearest) return 0;
  const since = globalFrame - nearest.frame;
  const decay = Math.round(fps * 0.12);
  if (since < 0 || since > decay) return 0;
  return interpolate(since, [0, decay], [0.28 * nearest.strength, 0], {
    extrapolateRight: "clamp",
  });
}

/** Escala reativa ao envelope RMS (respiração sutil com a energia). */
export function energyBreath(rms: number[], globalFrame: number, total: number): number {
  if (!rms.length || total <= 0) return 1;
  const idx = Math.min(rms.length - 1, Math.floor((globalFrame / total) * rms.length));
  return 1 + (rms[idx] ?? 0) * 0.03;
}
