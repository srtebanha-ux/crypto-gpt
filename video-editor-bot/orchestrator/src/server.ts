/**
 * server.ts — Gatilho de automação: webhook HTTP para n8n (ou qualquer fluxo).
 *
 * POST /render   { audioPath, clipsDir?, mood?, fetchScenes?, engine?, ... }
 *   → dispara o pipeline em background e retorna um jobId.
 * GET  /jobs/:id → status/progresso do job.
 * GET  /jobs/:id/file → baixa o MP4 quando pronto.
 * GET  /health   → readiness + ferramentas detectadas.
 *
 * Mantém o estado dos jobs em memória (suficiente para n8n; troque por Redis/DB
 * se precisar de durabilidade entre reinícios).
 */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import express from "express";

import { log } from "./logger.js";
import { runPipeline } from "./pipeline.js";
import { which } from "./proc.js";
import type { RenderJobRequest } from "./types.js";

interface Job {
  id: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  stage: string;
  outPath?: string;
  error?: string;
  createdAt: string;
  result?: unknown;
}

const jobs = new Map<string, Job>();

function startJob(req: RenderJobRequest): Job {
  const job: Job = {
    id: randomUUID(),
    status: "queued",
    progress: 0,
    stage: "na fila",
    createdAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);

  (async () => {
    job.status = "running";
    try {
      const result = await runPipeline(req, (stage, pct) => {
        job.stage = stage;
        job.progress = Math.round(pct);
      });
      job.status = "done";
      job.progress = 100;
      job.stage = "concluído";
      job.outPath = result.outPath;
      job.result = {
        tempo: result.tempo,
        cuts: result.cuts,
        clipsUsed: result.clipsUsed,
        scenesFetched: result.scenesFetched,
        engine: result.engine,
      };
      log.ok(`job ${job.id} concluído: ${result.outPath}`);
    } catch (e) {
      job.status = "error";
      job.error = (e as Error).message;
      log.err(`job ${job.id} falhou: ${job.error}`);
    }
  })();

  return job;
}

export function createServer() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", async (_req, res) => {
    res.json({
      ok: true,
      tools: {
        python: (await which("python3")) || (await which("python")),
        ytdlp: await which("yt-dlp"),
        autoEditor: await which("auto-editor"),
        ffmpeg: await which("ffmpeg"),
      },
      jobs: jobs.size,
    });
  });

  // gatilho principal (n8n → HTTP Request node)
  app.post("/render", (req, res) => {
    const body = req.body as RenderJobRequest;
    if (!body?.audioPath) {
      return res.status(422).json({ error: "audioPath é obrigatório" });
    }
    const job = startJob(body);
    res.status(202).json({ jobId: job.id, status: job.status });
  });

  app.get("/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "job não encontrado" });
    const { outPath, ...safe } = job; // não vaza path absoluto por padrão
    res.json(safe);
  });

  app.get("/jobs/:id/file", async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.status !== "done" || !job.outPath) {
      return res.status(404).json({ error: "arquivo indisponível" });
    }
    try {
      await stat(job.outPath);
    } catch {
      return res.status(404).json({ error: "arquivo removido" });
    }
    res.setHeader("Content-Type", "video/mp4");
    createReadStream(job.outPath).pipe(res);
  });

  return app;
}

// executado diretamente: sobe o servidor
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8787);
  createServer().listen(port, () => {
    log.ok(`webhook do orquestrador ouvindo em http://127.0.0.1:${port}`);
    log.info(`POST /render  ·  GET /jobs/:id  ·  GET /jobs/:id/file  ·  GET /health`);
  });
}
