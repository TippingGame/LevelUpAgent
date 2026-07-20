import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { PetProfile } from "../lib/types";
import { petAssetUrl } from "../lib/bridge";
import "./PetSprite.css";

export type PetSpriteState =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

interface PetAnimationDefinition {
  row: number;
  frameDurations: readonly number[];
}

const PET_SPRITE_WIDTH = 192;
const PET_SPRITE_HEIGHT = 208;
const PET_SPRITE_COLUMNS = 8;
const PET_SPRITE_ROWS = 9;

export const PET_ANIMATIONS: Record<PetSpriteState, PetAnimationDefinition> = {
  idle: { row: 0, frameDurations: [280, 110, 110, 140, 140, 320] },
  "running-right": { row: 1, frameDurations: [120, 120, 120, 120, 120, 120, 120, 220] },
  "running-left": { row: 2, frameDurations: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, frameDurations: [140, 140, 140, 280] },
  jumping: { row: 4, frameDurations: [140, 140, 140, 140, 280] },
  failed: { row: 5, frameDurations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, frameDurations: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, frameDurations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, frameDurations: [150, 150, 150, 150, 150, 280] },
};

type SpriteStyle = CSSProperties & Record<`--${string}`, string | number>;

export function PetSprite({
  profile,
  state = "idle",
  className = "",
  scale = 1,
  loop = true,
  onComplete,
}: {
  profile: PetProfile;
  state?: PetSpriteState;
  className?: string;
  scale?: number;
  loop?: boolean;
  onComplete?: (state: PetSpriteState) => void;
}) {
  const [frame, setFrame] = useState(0);
  const completionRef = useRef(onComplete);
  completionRef.current = onComplete;
  const animation = PET_ANIMATIONS[state];

  useEffect(() => {
    setFrame(0);
    let cancelled = false;
    let currentFrame = 0;
    let timer = 0;
    const cycleDuration = animation.frameDurations.reduce((total, duration) => total + duration, 0);
    let nextFrameAt = performance.now() + animation.frameDurations[0];
    const advanceFrame = () => {
      if (cancelled) return;
      const now = performance.now();
      if (loop && now - nextFrameAt > cycleDuration) {
        nextFrameAt += Math.floor((now - nextFrameAt) / cycleDuration) * cycleDuration;
      }
      let advanced = false;
      while (now >= nextFrameAt) {
        if (currentFrame + 1 >= animation.frameDurations.length) {
          if (!loop) {
            completionRef.current?.(state);
            return;
          }
          currentFrame = 0;
        } else {
          currentFrame += 1;
        }
        advanced = true;
        nextFrameAt += animation.frameDurations[currentFrame];
      }
      if (advanced) setFrame(currentFrame);
      timer = window.setTimeout(advanceFrame, Math.max(0, nextFrameAt - performance.now()));
    };
    timer = window.setTimeout(advanceFrame, animation.frameDurations[0]);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [animation, loop, profile.id, state]);

  const size = getPixelAlignedPetSize(scale);
  const style: SpriteStyle = {
    "--pet-spritesheet": `url("${petAssetUrl(profile.spritesheetPath)}")`,
    "--pet-sprite-width": `${size.width}px`,
    "--pet-sprite-height": `${size.height}px`,
    "--pet-spritesheet-width": `${size.width * PET_SPRITE_COLUMNS}px`,
    "--pet-spritesheet-height": `${size.height * PET_SPRITE_ROWS}px`,
    "--pet-sprite-x": `${-frame * size.width}px`,
    "--pet-sprite-y": `${-animation.row * size.height}px`,
  };
  return (
    <div
      className={`pet-sprite ${className}`.trim()}
      data-state={state}
      data-frame={frame}
      data-row={animation.row}
      style={style}
      role="img"
      aria-label={profile.displayName}
    />
  );
}

export function petAnimationDuration(state: PetSpriteState) {
  return PET_ANIMATIONS[state].frameDurations.reduce((total, duration) => total + duration, 0);
}

export function getPixelAlignedPetSize(scale = 1) {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const pixelRatio = typeof window === "undefined" || !Number.isFinite(window.devicePixelRatio)
    ? 1
    : Math.max(0.5, window.devicePixelRatio);
  return {
    width: Math.round(PET_SPRITE_WIDTH * safeScale * pixelRatio) / pixelRatio,
    height: Math.round(PET_SPRITE_HEIGHT * safeScale * pixelRatio) / pixelRatio,
  };
}

export function PetAvatar({ profile, className = "" }: { profile: PetProfile; className?: string }) {
  return (
    <span
      className={`pet-avatar ${className}`.trim()}
      style={{ backgroundImage: `url("${petAssetUrl(profile.spritesheetPath)}")` }}
      aria-hidden="true"
    />
  );
}
