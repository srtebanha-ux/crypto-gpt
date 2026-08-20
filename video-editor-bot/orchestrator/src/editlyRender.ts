/**
 * editlyRender.ts — Renderizador ALTERNATIVO via mifi/editly (Node.js).
 *
 * Converte a linha do tempo planejada num "editSpec" do editly e chama a lib.
 * Útil quando não se quer o pipeline React do Remotion. Mapeia cada segmento
 * para um clip do editly com um layer de vídeo (recortado no ponto de entrada)
 * e uma transição por corte.
 */
import path from "node:path";

import { log } from "./logger.js";
import type { BeatVideoProps } from "./types.js";

/** Mapeia nossas transições para as do editly. */
function editlyTransition(t: string): { name: string; duration: number } {
  const map: Record<string, string> = {
    hardcut: "directional-left",
    fade: "fade",
    wipe: "directionalWipe",
    slide: "directional-right",
    flash: "colorphase",
    zoompunch: "crosszoom",
  };
  return { name: map[t] ?? "fade", duration: t === "hardcut" ? 0 : 0.18 };
}

export interface EditlyOptions {
  props: BeatVideoProps;
  outPath: string;
}

export async function renderWithEditly(opts: EditlyOptions): Promise<string> {
  // import dinâmico: editly é pesado (depende de gl nativo) e opcional
  let editly: (spec: unknown) => Promise<void>;
  try {
    const mod: any = await import("editly");
    editly = (mod.default ?? mod) as (spec: unknown) => Promise<void>;
  } catch (e) {
    throw new Error(
      "editly não está instalado ou falhou ao carregar (requer libs nativas). " +
        "Instale com: npm i editly  — ou use engine=remotion.\n" +
        (e as Error).message,
    );
  }

  const { props } = opts;
  const clips = props.segments.map((seg) => {
    const dur = Math.max(0.2, seg.end - seg.start);
    const transition = editlyTransition(seg.transition);
    return {
      duration: dur,
      transition,
      layers: [
        seg.clip
          ? {
              type: "video",
              path: seg.clip.path,
              cutFrom: seg.clip.inSeconds ?? 0,
              cutTo: (seg.clip.inSeconds ?? 0) + dur,
              resizeMode: "cover",
            }
          : { type: "fill-color", color: "#000000" },
      ],
    };
  });

  const editSpec = {
    outPath: opts.outPath,
    width: props.width,
    height: props.height,
    fps: props.fps,
    audioFilePath: props.audioSrc || undefined,
    keepSourceAudio: false,
    defaults: { transition: { duration: 0.15, name: "fade" } },
    clips,
  };

  log.step(`editly: renderizando ${clips.length} cortes → ${path.basename(opts.outPath)}`);
  await editly(editSpec);
  log.ok(`editly: render concluído → ${opts.outPath}`);
  return opts.outPath;
}
