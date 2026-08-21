/**
 * proc.ts — utilitários para orquestrar binários externos (yt-dlp, auto-editor,
 * python beatsync, remotion). Não reimplementa nada: apenas invoca as
 * ferramentas OSS e coleta stdout/stderr.
 */
import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  input?: string;
}

/** Executa um comando e resolve com código + saídas capturadas. */
export function run(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      opts.onStdout?.(s);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      opts.onStderr?.(s);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (opts.input) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/** Igual a run(), mas rejeita se o código de saída for diferente de 0. */
export async function runOrThrow(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    throw new Error(
      `comando falhou (${cmd} ${args.join(" ")}) code=${r.code}\n${r.stderr.slice(-800)}`,
    );
  }
  return r;
}

/** Verifica se um binário está no PATH. */
export async function which(bin: string): Promise<boolean> {
  const finder = process.platform === "win32" ? "where" : "which";
  const r = await run(finder, [bin]).catch(() => ({ code: 1 }) as RunResult);
  return r.code === 0;
}
