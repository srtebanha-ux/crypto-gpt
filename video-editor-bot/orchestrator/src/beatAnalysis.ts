/**
 * beatAnalysis.ts — Ponte para o analisador de batidas (Python beatsync).
 *
 * Invoca `python -m beatsync.export_analysis` (que usa librosa) e devolve o
 * payload já validado pelo schema Zod. É a fonte de timestamps MUSICAIS
 * (BPM, batidas, downbeats, picos, cortes) — complementar ao auto-editor,
 * que é orientado a conteúdo (silêncio/movimento).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { log } from "./logger.js";
import { run } from "./proc.js";
import { analysisSchema, type Analysis } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Raiz do pacote python (…/video-editor-bot), onde `import beatsync` resolve. */
const PY_ROOT = path.resolve(__dirname, "..", "..");

export interface BeatOptions {
  audioPath: string;
  fps?: number;
  cutMode?: "beat" | "downbeat" | "onset" | "hybrid";
  subdivision?: number;
  pythonBin?: string;
}

export async function analyzeBeats(opts: BeatOptions): Promise<Analysis> {
  const py = opts.pythonBin ?? process.env.PYTHON_BIN ?? "python3";
  const args = [
    "-m", "beatsync.export_analysis",
    opts.audioPath,
    "--out", "-",
    "--fps", String(opts.fps ?? 30),
    "--cut-mode", opts.cutMode ?? "hybrid",
    "--subdivision", String(opts.subdivision ?? 1),
  ];
  log.step(`beatsync: analisando batidas (${path.basename(opts.audioPath)})`);
  const r = await run(py, args, { cwd: PY_ROOT, env: { PYTHONPATH: PY_ROOT } });
  if (r.code !== 0) {
    throw new Error(
      `análise de áudio falhou (python beatsync). ` +
        `Instale as deps: pip install -r requirements.txt\n${r.stderr.slice(-600)}`,
    );
  }
  const json = JSON.parse(r.stdout);
  const parsed = analysisSchema.parse(json);
  log.ok(
    `beatsync: BPM≈${parsed.tempo.toFixed(0)}, ` +
      `${parsed.counts.cuts ?? parsed.cuts.length} cortes, ` +
      `${parsed.segments.length} segmentos`,
  );
  return parsed;
}
