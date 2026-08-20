/**
 * BeatVideo.tsx — Composição principal do Remotion.
 *
 * Mapeia os timestamps da análise de áudio (segments/beats) para uma pilha de
 * <Sequence/>, cada uma renderizando um clipe com corte seco/transição
 * sincronizada à batida. Adiciona a trilha de áudio e um overlay de flash
 * global reativo às batidas.
 *
 * Recebe TUDO via inputProps (validadas pelo beatVideoSchema), preenchidas
 * pelo orquestrador Node a partir do yt-dlp + beatsync + auto-editor.
 */
import React from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { BeatVideoProps } from "../src/types.js";
import { ClipSequence } from "./components/ClipSequence.js";
import { beatFlash } from "./components/effects.js";

const audioSrc = (p: string) =>
  /^https?:\/\//.test(p) || p.startsWith("data:") ? p : staticFile(p);

export const BeatVideo: React.FC<BeatVideoProps> = ({
  audioSrc: audio,
  segments,
  beats,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const flash = style.beatFlash ? beatFlash(frame, beats, fps) : 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* trilha de áudio (define o ritmo) */}
      {audio ? <Audio src={audioSrc(audio)} /> : null}

      {/* uma Sequence por corte, posicionada no frame exato da batida */}
      {segments.map((seg) => (
        <Sequence
          key={seg.index}
          from={seg.startFrame}
          durationInFrames={seg.durationInFrames}
          name={`cut-${seg.index}-${seg.transition}`}
        >
          <ClipSequence
            segment={seg}
            punchZoom={style.punchZoom}
            transitionFrames={style.transitionFrames}
            grade={style.grade}
          />
        </Sequence>
      ))}

      {/* flash global na batida (por cima de tudo) */}
      {flash > 0 && (
        <AbsoluteFill
          style={{ backgroundColor: "#fff", opacity: flash, mixBlendMode: "screen" }}
        />
      )}
    </AbsoluteFill>
  );
};
