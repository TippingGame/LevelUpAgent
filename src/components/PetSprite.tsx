import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { PetProfile } from "../lib/types";
import { petAssetUrl } from "../lib/bridge";
import {
  animationDuration,
  animationFrameAtTime,
  PET_ANIMATIONS,
  type PetSpriteState,
} from "../lib/petAnimation";
import "./PetSprite.css";

export type { PetSpriteState } from "../lib/petAnimation";

const PET_SPRITE_WIDTH = 192;
const PET_SPRITE_HEIGHT = 208;
const PET_SPRITE_COLUMNS = 8;
const PET_SPRITE_ROWS = 9;

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
    let frameId = 0;
    const cycleDuration = animationDuration(animation.frameDurations);
    const startedAt = performance.now();
    const advanceFrame = (now: number) => {
      if (cancelled) return;
      const elapsed = Math.max(0, now - startedAt);
      if (!loop && elapsed >= cycleDuration) {
        completionRef.current?.(state);
        return;
      }
      const nextFrame = animationFrameAtTime(animation.frameDurations, elapsed);
      if (nextFrame !== currentFrame) {
        currentFrame = nextFrame;
        setFrame(nextFrame);
      }
      frameId = window.requestAnimationFrame(advanceFrame);
    };
    frameId = window.requestAnimationFrame(advanceFrame);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
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
  return animationDuration(PET_ANIMATIONS[state].frameDurations);
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
