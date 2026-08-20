/**
 * ClipSequence.tsx — renderiza UM segmento de corte: um <OffthreadVideo/>
 * (clipe local ou baixado via yt-dlp) enquadrado para preencher o frame, com
 * transição de entrada dinâmica e "punch" de zoom sincronizado à batida.
 */
import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { Segment } from "../../src/types.js";
import { gradeFilter, punchScale } from "./effects.js";

/** Resolve o src: http(s) direto, senão staticFile() (public/). */
function resolveSrc(p: string): string {
  if (/^https?:\/\//.test(p) || p.startsWith("data:")) return p;
  return staticFile(p);
}

interface Props {
  segment: Segment;
  punchZoom: number;
  transitionFrames: number;
  grade: string;
}

export const ClipSequence: React.FC<Props> = ({
  segment,
  punchZoom,
  transitionFrames,
  grade,
}) => {
  const frame = useCurrentFrame(); // relativo à Sequence (from=startFrame)
  const { fps } = useVideoConfig();
  const clip = segment.clip;

  // --- transição de ENTRADA ------------------------------------------------
  const t = transitionFrames;
  let opacity = 1;
  let translateX = 0;
  let extraScale = 1;
  let flash = 0;

  switch (segment.transition) {
    case "fade":
      opacity = interpolate(frame, [0, t], [0, 1], { extrapolateRight: "clamp" });
      break;
    case "wipe":
      translateX = interpolate(frame, [0, t], [12, 0], {
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic),
      });
      break;
    case "slide":
      translateX = interpolate(frame, [0, t], [100, 0], {
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic),
      });
      break;
    case "flash":
      flash = interpolate(frame, [0, t * 1.5], [0.9, 0], { extrapolateRight: "clamp" });
      break;
    case "zoompunch":
      extraScale = interpolate(frame, [0, t * 2], [1.14, 1], {
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic),
      });
      break;
    // hardcut: nada (corte seco)
  }

  const scale = punchScale(frame, fps, punchZoom) * extraScale;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000", overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          transform: `translateX(${translateX}%) scale(${scale})`,
          opacity,
          filter: gradeFilter(grade, segment.energy),
        }}
      >
        {clip ? (
          <OffthreadVideo
            src={resolveSrc(clip.path)}
            startFrom={Math.round((clip.inSeconds ?? 0) * fps)}
            muted
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <AbsoluteFill
            style={{
              background:
                "linear-gradient(135deg,#1b2130,#0b0d12)",
              color: "#5c667a",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 40,
            }}
          >
            (sem clipe)
          </AbsoluteFill>
        )}
      </AbsoluteFill>

      {flash > 0 && (
        <AbsoluteFill style={{ backgroundColor: "#fff", opacity: flash }} />
      )}
    </AbsoluteFill>
  );
};
