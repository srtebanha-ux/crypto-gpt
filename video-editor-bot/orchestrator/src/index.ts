/**
 * index.ts — CLI do orquestrador.
 *
 *   tsx src/index.ts render --audio musica.mp3 --clips ./clips --out out/clip.mp4 \
 *        --fetch 6 --mood "neon,city,night" --engine remotion --grade cinematic
 *
 *   tsx src/index.ts render --json job.json      # recebe o job via arquivo JSON
 *   echo '{...}' | tsx src/index.ts render --json -   # ou via stdin (n8n/pipe)
 *
 *   tsx src/index.ts fetch --mood "sunset,aerial" --count 5 --out ./fetched
 *   tsx src/index.ts serve                        # sobe o webhook
 */
import { promises as fs } from "node:fs";

import { log } from "./logger.js";
import { runPipeline } from "./pipeline.js";
import { fetchScenes } from "./sceneFetcher.js";
import type { RenderJobRequest } from "./types.js";

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

async function readJsonArg(val: string): Promise<RenderJobRequest> {
  const text =
    val === "-"
      ? await new Promise<string>((resolve) => {
          let data = "";
          process.stdin.on("data", (d) => (data += d));
          process.stdin.on("end", () => resolve(data));
        })
      : await fs.readFile(val, "utf-8");
  return JSON.parse(text) as RenderJobRequest;
}

async function cmdRender(flags: Record<string, string | boolean>) {
  let req: RenderJobRequest;
  if (flags.json) {
    req = await readJsonArg(String(flags.json));
  } else {
    req = {
      audioPath: String(flags.audio ?? ""),
      clipsDir: flags.clips ? String(flags.clips) : undefined,
      outPath: flags.out ? String(flags.out) : undefined,
      mood: flags.mood ? String(flags.mood).split(",").map((s) => s.trim()) : undefined,
      fetchScenes: flags.fetch ? Number(flags.fetch) : 0,
      width: flags.width ? Number(flags.width) : undefined,
      height: flags.height ? Number(flags.height) : undefined,
      fps: flags.fps ? Number(flags.fps) : undefined,
      cutMode: flags["cut-mode"] ? (String(flags["cut-mode"]) as any) : undefined,
      subdivision: flags.subdivision ? Number(flags.subdivision) : undefined,
      engine: flags.engine ? (String(flags.engine) as any) : undefined,
      grade: flags.grade ? (String(flags.grade) as any) : undefined,
      useAutoEditor: Boolean(flags["auto-editor"]),
    };
  }
  if (!req.audioPath) {
    log.err("informe --audio <arquivo> (ou --json <arquivo|->)");
    process.exit(1);
  }
  const result = await runPipeline(req, (stage, pct) =>
    log.info(`[${pct.toString().padStart(3)}%] ${stage}`),
  );
  log.ok(
    `pronto: ${result.outPath}\n` +
      `  BPM≈${result.tempo.toFixed(0)} · ${result.cuts} cortes · ` +
      `${result.clipsUsed} clipes (${result.scenesFetched} via yt-dlp) · ${result.engine}`,
  );
}

async function cmdFetch(flags: Record<string, string | boolean>) {
  const mood = String(flags.mood ?? "cinematic,landscape").split(",").map((s) => s.trim());
  const catalog = await fetchScenes({
    keywords: mood,
    count: Number(flags.count ?? 5),
    outDir: String(flags.out ?? "./fetched"),
    maxHeight: Number(flags.height ?? 1080),
  });
  log.ok(`${catalog.length} cena(s) baixada(s).`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case "render":
      return cmdRender(flags);
    case "fetch":
      return cmdFetch(flags);
    case "serve": {
      const { createServer } = await import("./server.js");
      const port = Number(process.env.PORT ?? 8787);
      createServer().listen(port, () =>
        log.ok(`webhook ouvindo em http://127.0.0.1:${port}`),
      );
      return;
    }
    default:
      console.log(
        [
          "beatsync-orchestrator — orquestra yt-dlp + auto-editor/beatsync + Remotion/editly",
          "",
          "Comandos:",
          "  render   compõe o videoclipe final (--audio, --clips, --fetch, --engine …)",
          "  fetch    só baixa cenas via yt-dlp (--mood, --count, --out)",
          "  serve    sobe o webhook para n8n (POST /render)",
          "",
          "Ex.: tsx src/index.ts render --audio musica.mp3 --clips ./clips --fetch 6 \\",
          '       --mood "neon,city,night" --engine remotion --auto-editor',
        ].join("\n"),
      );
  }
}

main().catch((e) => {
  log.err((e as Error).message);
  process.exit(1);
});
