/**
 * autoEditor.ts — Integração com WyattBlue/auto-editor (binário OSS).
 *
 * auto-editor analisa um clipe e produz um "edit list" (trechos a manter,
 * removendo silêncio/partes paradas). Usamos isso para PRÉ-FILTRAR os clipes
 * brutos — descartando trechos mortos — antes de alimentar o compositor.
 * Assim, os segmentos que o Remotion/editly recebem já apontam para os
 * momentos "com conteúdo" de cada clipe.
 *
 * Não reimplementa detecção de corte: apenas invoca o auto-editor e lê o JSON.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { log } from "./logger.js";
import { run, which } from "./proc.js";

export interface KeepRange {
  start: number; // segundos
  end: number;
}

export interface AutoEditResult {
  path: string;
  keep: KeepRange[]; // trechos "com conteúdo"
  totalKept: number; // soma das durações mantidas (s)
}

/**
 * Roda `auto-editor --export json` para obter os trechos a manter.
 * Se o binário não existir, degrada para "manter o clipe inteiro".
 */
export async function analyzeClip(
  clipPath: string,
  opts: { bin?: string; threshold?: string; margin?: string } = {},
): Promise<AutoEditResult> {
  const bin = opts.bin ?? "auto-editor";
  if (!(await which(bin))) {
    return fallback(clipPath, "auto-editor ausente");
  }
  const tmp = path.join(os.tmpdir(), `ae-${Date.now()}-${path.basename(clipPath)}.json`);
  const args = [
    clipPath,
    "--edit", `audio:threshold=${opts.threshold ?? "4%"}`,
    "--margin", opts.margin ?? "0.2s",
    "--export", "json",
    "--output", tmp,
  ];
  const r = await run(bin, args);
  if (r.code !== 0) return fallback(clipPath, `auto-editor code=${r.code}`);

  try {
    const raw = JSON.parse(await fs.readFile(tmp, "utf-8"));
    await fs.unlink(tmp).catch(() => {});
    const keep = parseTimeline(raw);
    const totalKept = keep.reduce((a, k) => a + (k.end - k.start), 0);
    log.ok(
      `auto-editor: ${path.basename(clipPath)} → ${keep.length} trecho(s), ` +
        `${totalKept.toFixed(1)}s úteis`,
    );
    return { path: clipPath, keep, totalKept };
  } catch (e) {
    return fallback(clipPath, `parse falhou: ${(e as Error).message}`);
  }
}

/**
 * O formato do JSON do auto-editor evoluiu entre versões. Este parser é
 * tolerante: entende tanto o `v1`/`v3` timeline quanto listas de chunks.
 */
function parseTimeline(raw: any): KeepRange[] {
  // v3: { "v": 3, "timeline": { "v": [[{start,dur,offset,...}]] , "tb": fps } }
  const tb = raw?.timeline?.tb ?? raw?.tb ?? 30;
  const tracks = raw?.timeline?.v ?? raw?.v ?? null;
  const ranges: KeepRange[] = [];
  if (Array.isArray(tracks)) {
    for (const track of tracks) {
      if (!Array.isArray(track)) continue;
      for (const clip of track) {
        const start = (clip.start ?? clip.offset ?? 0) / tb;
        const dur = (clip.dur ?? clip.duration ?? 0) / tb;
        if (dur > 0) ranges.push({ start, end: start + dur });
      }
    }
  }
  // formato antigo: { chunks: [[startFrame, endFrame, speed], ...] }
  if (ranges.length === 0 && Array.isArray(raw?.chunks)) {
    for (const [s, e, speed] of raw.chunks) {
      if (speed !== 99999 && speed > 0) ranges.push({ start: s / tb, end: e / tb });
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function fallback(clipPath: string, reason: string): AutoEditResult {
  if (process.env.DEBUG) log.warn(`auto-editor fallback (${reason}) → clipe inteiro`);
  return { path: clipPath, keep: [], totalKept: 0 };
}
