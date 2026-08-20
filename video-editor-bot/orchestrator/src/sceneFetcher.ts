/**
 * sceneFetcher.ts — Captação dinâmica de cenas via yt-dlp/yt-dlp (binário OSS).
 *
 * Recebe as palavras-chave de "mood" da música, pesquisa vídeos (ytsearch),
 * baixa clipes de alta qualidade e os cataloga para o compositor preencher
 * lacunas / mesclar com os vídeos locais.
 *
 * NÃO reimplementa download/mux: apenas orquestra o yt-dlp e o ffprobe.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { log } from "./logger.js";
import { run, runOrThrow, which } from "./proc.js";
import type { CatalogClip } from "./types.js";

export interface FetchOptions {
  keywords: string[];
  count: number; // quantos clipes baixar no total
  outDir: string;
  maxDuration?: number; // ignora vídeos maiores que isto (s)
  maxHeight?: number; // limita resolução (ex.: 1080)
  perQuery?: number; // resultados por termo de busca
  ytdlpBin?: string;
}

/** Constrói uma expressão ytsearchN: a partir das palavras-chave do mood. */
function buildQuery(keywords: string[], n: number): string {
  const terms = [...keywords, "cinematic b-roll 4k"].join(" ");
  return `ytsearch${n}:${terms}`;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48);

/** Sonda um arquivo baixado com ffprobe (duração/resolução). */
async function probe(file: string): Promise<Partial<CatalogClip>> {
  const r = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json",
    file,
  ]).catch(() => null);
  if (!r || r.code !== 0) return {};
  try {
    const j = JSON.parse(r.stdout);
    return {
      width: Number(j.streams?.[0]?.width) || undefined,
      height: Number(j.streams?.[0]?.height) || undefined,
      duration: Number(j.format?.duration) || undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Executa a captação: valida a presença do yt-dlp, baixa `count` clipes que
 * casem com o mood e retorna o catálogo. Falhas de rede são degradadas para
 * warnings (o pipeline segue com os clipes locais).
 */
export async function fetchScenes(opts: FetchOptions): Promise<CatalogClip[]> {
  const bin = opts.ytdlpBin ?? "yt-dlp";
  if (!(await which(bin))) {
    log.warn(
      `yt-dlp não encontrado no PATH — pulando captação de cenas. ` +
        `Instale com: pip install -U yt-dlp`,
    );
    return [];
  }
  await fs.mkdir(opts.outDir, { recursive: true });

  const maxHeight = opts.maxHeight ?? 1080;
  const maxDur = opts.maxDuration ?? 60;
  const query = buildQuery(opts.keywords, Math.max(opts.count, 1));

  log.step(`yt-dlp: buscando cenas (${opts.keywords.join(", ")})`);

  // Formato: melhor mp4 até maxHeight; corta trechos longos via download-sections
  const outTmpl = path.join(opts.outDir, "%(id)s.%(ext)s");
  const args = [
    query,
    "-f", `bv*[height<=${maxHeight}][ext=mp4]+ba/b[height<=${maxHeight}]/b`,
    "--merge-output-format", "mp4",
    "--no-playlist",
    "--match-filter", `duration < ${maxDur * 6}`,
    "--download-sections", `*0-${maxDur}`, // pega só os primeiros maxDur s
    "--force-keyframes-at-cuts",
    "-o", outTmpl,
    "--no-progress",
    "--print", "after_move:%(id)s\t%(title)s\t%(webpage_url)s\t%(filepath)s",
  ];

  const printed: string[] = [];
  const r = await run(bin, args, {
    onStdout: (s) => {
      for (const line of s.split("\n")) if (line.includes("\t")) printed.push(line.trim());
    },
    onStderr: (s) => process.env.DEBUG && process.stderr.write(s),
  });
  if (r.code !== 0 && printed.length === 0) {
    log.warn(`yt-dlp retornou código ${r.code}; seguindo sem cenas externas.`);
    return [];
  }

  const catalog: CatalogClip[] = [];
  for (const line of printed) {
    const [id, title, url, filepath] = line.split("\t");
    if (!filepath) continue;
    const meta = await probe(filepath);
    if (meta.duration && meta.duration > maxDur * 2) continue;
    catalog.push({
      id: id || createHash("md5").update(filepath).digest("hex").slice(0, 8),
      path: filepath,
      source: "ytdlp",
      title,
      sourceUrl: url,
      keywords: opts.keywords,
      ...meta,
    });
  }

  // grava um índice do catálogo (auditável / reutilizável pelo n8n)
  await fs.writeFile(
    path.join(opts.outDir, "catalog.json"),
    JSON.stringify(catalog, null, 2),
    "utf-8",
  );
  log.ok(`yt-dlp: ${catalog.length} cena(s) catalogada(s) em ${opts.outDir}`);
  return catalog;
}

/** Deriva palavras-chave de mood a partir do BPM quando o usuário não informa. */
export function moodFromTempo(tempo: number): string[] {
  if (tempo >= 140) return ["energetic", "fast motion", "city lights", "neon"];
  if (tempo >= 110) return ["uplifting", "travel", "aerial", "sunset"];
  if (tempo >= 90) return ["cinematic", "landscape", "slow motion"];
  return ["ambient", "moody", "fog", "dark cinematic"];
}

/** Catálogo dos clipes locais existentes (para mesclar com os do yt-dlp). */
export async function catalogLocal(dir: string): Promise<CatalogClip[]> {
  const exts = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"]);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: CatalogClip[] = [];
  for (const name of entries) {
    if (!exts.has(path.extname(name).toLowerCase())) continue;
    const full = path.join(dir, name);
    const meta = await probe(full);
    out.push({
      id: slug(name),
      path: full,
      source: "local",
      title: name,
      ...meta,
    });
  }
  return out;
}
