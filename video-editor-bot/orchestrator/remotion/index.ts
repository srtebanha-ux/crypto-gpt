/**
 * remotion/index.ts — ponto de entrada do Remotion (registerRoot).
 * Usado por `remotion studio`, `remotion render` e pelo @remotion/bundler.
 */
import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root.js";

registerRoot(RemotionRoot);
