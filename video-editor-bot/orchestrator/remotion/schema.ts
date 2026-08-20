/**
 * schema.ts — reexporta o schema Zod compartilhado como contrato de props da
 * composição Remotion. Mantém uma única fonte de verdade entre o orquestrador
 * (src/types.ts) e o Studio do Remotion.
 */
export { beatVideoSchema } from "../src/types.js";
export type { BeatVideoProps, Segment, BeatEvent } from "../src/types.js";

/** Props default (usadas no Remotion Studio quando não há inputProps). */
import type { BeatVideoProps } from "../src/types.js";

export const defaultBeatVideoProps: BeatVideoProps = {
  width: 1920,
  height: 1080,
  fps: 30,
  audioSrc: "",
  durationInFrames: 150,
  segments: [
    {
      index: 0, start: 0, end: 1, startFrame: 0, endFrame: 30,
      durationInFrames: 30, energy: 0.8, transition: "zoompunch",
    },
    {
      index: 1, start: 1, end: 2, startFrame: 30, endFrame: 60,
      durationInFrames: 30, energy: 0.4, transition: "fade",
    },
  ],
  beats: [
    { time: 0, frame: 0, strength: 1 },
    { time: 0.5, frame: 15, strength: 0.6 },
    { time: 1.0, frame: 30, strength: 0.9 },
  ],
  rmsEnvelope: [],
  style: { punchZoom: 0.08, transitionFrames: 4, grade: "cinematic", beatFlash: true },
};
