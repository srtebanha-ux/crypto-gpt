/**
 * Root.tsx — registra a composição <BeatVideo/> com dimensões/fps/duração
 * derivados dinamicamente das inputProps (batidas da análise de áudio).
 */
import React from "react";
import { Composition } from "remotion";
import { BeatVideo } from "./BeatVideo.js";
import { beatVideoSchema, defaultBeatVideoProps } from "./schema.js";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="BeatVideo"
      component={BeatVideo}
      schema={beatVideoSchema}
      defaultProps={defaultBeatVideoProps}
      // dimensões/fps/duração vêm das props (a análise define tudo)
      width={defaultBeatVideoProps.width}
      height={defaultBeatVideoProps.height}
      fps={defaultBeatVideoProps.fps}
      durationInFrames={defaultBeatVideoProps.durationInFrames}
      calculateMetadata={({ props }) => ({
        width: props.width,
        height: props.height,
        fps: props.fps,
        durationInFrames: Math.max(1, props.durationInFrames),
      })}
    />
  );
};
