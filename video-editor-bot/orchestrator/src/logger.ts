/** logger.ts — logging mínimo com timestamp e níveis coloridos. */
const c = {
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};
const ts = () => c.gray(new Date().toISOString().slice(11, 19));

export const log = {
  info: (...a: unknown[]) => console.log(ts(), c.cyan("ℹ"), ...a),
  ok: (...a: unknown[]) => console.log(ts(), c.green("✓"), ...a),
  warn: (...a: unknown[]) => console.warn(ts(), c.yellow("⚠"), ...a),
  err: (...a: unknown[]) => console.error(ts(), c.red("✗"), ...a),
  step: (n: string) => console.log(ts(), c.cyan("▸"), c.cyan(n)),
};
