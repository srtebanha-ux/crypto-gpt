/**
 * remotionRender.ts — Render de alta fidelidade via Remotion (@remotion/bundler
 * + @remotion/renderer). Empacota a composição, seleciona <BeatVideo/>,
 * injeta as inputProps (linha do tempo sincronizada) e renderiza o MP4.
 *
 * Para clipes locais, o Remotion serve arquivos de `public/` via staticFile().
 * O planner grava caminhos relativos a `public/`, então aqui symlinkamos os
 * clipes/áudio para dentro de `public/` antes de renderizar.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

import { log } from "./logger.js";
import type { BeatVideoProps } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCH_ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ORCH_ROOT, "remotion", "index.ts");
const PUBLIC_DIR = path.join(ORCH_ROOT, "public");

export interface RemotionOptions {
  props: BeatVideoProps;
  outPath: string;
  concurrency?: number;
  crf?: number;
  onProgress?: (p: number) => void;
}

/** Copia um arquivo para public/ e devolve o caminho relativo (para staticFile). */
async function stageToPublic(absPath: string): Promise<string> {
  if (/^https?:\/\//.test(absPath)) return absPath; // URLs passam direto
  await fs.mkdir(PUBLIC_DIR, { recursive: true });
  const rel = path.join("staged", path.basename(absPath));
  const dest = path.join(PUBLIC_DIR, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.copyFile(absPath, dest);
  } catch (e) {
    log.warn(`não consegui copiar ${absPath} para public/: ${(e as Error).message}`);
  }
  return rel.split(path.sep).join("/");
}

/** Reescreve os caminhos das props para caminhos relativos a public/. */
async function stageProps(props: BeatVideoProps): Promise<BeatVideoProps> {
  const audioSrc = props.audioSrc ? await stageToPublic(props.audioSrc) : "";
  const segments = await Promise.all(
    props.segments.map(async (seg) => {
      if (!seg.clip) return seg;
      const staged = await stageToPublic(seg.clip.path);
      return { ...seg, clip: { ...seg.clip, path: staged } };
    }),
  );
  return { ...props, audioSrc, segments };
}

export async function renderWithRemotion(opts: RemotionOptions): Promise<string> {
  log.step("Remotion: empacotando composição");
  const serveUrl = await bundle({
    entryPoint: ENTRY,
    publicDir: PUBLIC_DIR,
    // webpack override opcional pode ir aqui
  });

  const inputProps = await stageProps(opts.props);

  const composition = await selectComposition({
    serveUrl,
    id: "BeatVideo",
    inputProps,
  });

  await fs.mkdir(path.dirname(path.resolve(opts.outPath)), { recursive: true });

  log.step(
    `Remotion: renderizando ${composition.width}×${composition.height} ` +
      `@${composition.fps}fps, ${composition.durationInFrames} frames`,
  );
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: opts.outPath,
    inputProps,
    concurrency: opts.concurrency,
    crf: opts.crf ?? 18,
    onProgress: ({ progress }) => opts.onProgress?.(progress),
  });

  log.ok(`Remotion: render concluído → ${opts.outPath}`);
  return opts.outPath;
}
