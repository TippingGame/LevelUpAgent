#!/usr/bin/env python3
"""Render Codex pet state videos from an atlas using ffmpeg."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

CELL_WIDTH = 192
CELL_HEIGHT = 208
STATES = {
    "idle": (0, [280, 110, 110, 140, 140, 320]),
    "running-right": (1, [120, 120, 120, 120, 120, 120, 120, 220]),
    "running-left": (2, [120, 120, 120, 120, 120, 120, 120, 220]),
    "waving": (3, [140, 140, 140, 280]),
    "jumping": (4, [140, 140, 140, 140, 280]),
    "failed": (5, [140, 140, 140, 140, 140, 140, 140, 240]),
    "waiting": (6, [150, 150, 150, 150, 150, 260]),
    "running": (7, [120, 120, 120, 120, 120, 220]),
    "review": (8, [150, 150, 150, 150, 150, 280]),
}


def resolve_ffmpeg(requested: str) -> str:
    """Resolve an explicit ffmpeg path or a small set of Windows installs."""
    value = requested.strip()
    if value:
        expanded = Path(os.path.expandvars(value)).expanduser()
        if expanded.is_file():
            return str(expanded)
        if Path(value).name.lower() == value.lower() or shutil.which(value):
            return value
        raise SystemExit(f"ffmpeg executable was not found: {value}")

    on_path = shutil.which("ffmpeg")
    if on_path:
        return on_path

    local_app_data = os.environ.get("LOCALAPPDATA")
    program_files = os.environ.get("ProgramFiles")
    program_files_x86 = os.environ.get("ProgramFiles(x86)")
    candidates = []
    if local_app_data:
        candidates.extend(
            [
                Path(local_app_data) / "Programs" / "ffmpeg" / "bin" / "ffmpeg.exe",
                Path(local_app_data)
                / "Programs"
                / "Ultimate Vocal Remover"
                / "ffmpeg.exe",
            ]
        )
    for root in (program_files, program_files_x86):
        if root:
            candidates.append(Path(root) / "ffmpeg" / "bin" / "ffmpeg.exe")
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return "ffmpeg"


def checker(size: tuple[int, int], square: int = 16) -> Image.Image:
    image = Image.new("RGB", size, "#ffffff")
    draw = ImageDraw.Draw(image)
    for y in range(0, size[1], square):
        for x in range(0, size[0], square):
            if (x // square + y // square) % 2:
                draw.rectangle((x, y, x + square - 1, y + square - 1), fill="#e8e8e8")
    return image


def shell_quote_for_concat(path: Path) -> str:
    return "'" + str(path).replace("'", "'\\''") + "'"


def render_state(
    atlas: Image.Image,
    state: str,
    row: int,
    durations: list[int],
    output_dir: Path,
    loops: int,
    scale: int,
    ffmpeg: str,
) -> None:
    with tempfile.TemporaryDirectory(prefix=f"codex-pet-{state}-") as temp_raw:
        temp = Path(temp_raw)
        frame_paths: list[Path] = []
        for column in range(len(durations)):
            crop = atlas.crop(
                (
                    column * CELL_WIDTH,
                    row * CELL_HEIGHT,
                    (column + 1) * CELL_WIDTH,
                    (row + 1) * CELL_HEIGHT,
                )
            ).convert("RGBA")
            bg = checker((CELL_WIDTH, CELL_HEIGHT))
            bg.paste(crop, (0, 0), crop)
            frame_path = temp / f"{state}-{column:02d}.png"
            bg.save(frame_path)
            frame_paths.append(frame_path)

        concat_path = temp / f"{state}.ffconcat"
        lines = ["ffconcat version 1.0"]
        sequence: list[tuple[Path, int]] = []
        for _ in range(loops):
            sequence.extend(zip(frame_paths, durations, strict=True))
        for frame_path, duration_ms in sequence:
            lines.append(f"file {shell_quote_for_concat(frame_path)}")
            lines.append(f"duration {duration_ms / 1000:.3f}")
        lines.append(f"file {shell_quote_for_concat(sequence[-1][0])}")
        concat_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

        output = output_dir / f"{state}.mp4"
        command = [
            ffmpeg,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_path),
            "-vf",
            f"scale={CELL_WIDTH * scale}:{CELL_HEIGHT * scale}:flags=lanczos,format=yuv420p",
            "-movflags",
            "+faststart",
            str(output),
        ]
        subprocess.run(command, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("atlas")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--loops", type=int, default=4)
    parser.add_argument("--scale", type=int, default=2)
    parser.add_argument(
        "--ffmpeg",
        default="",
        help="Optional ffmpeg executable; otherwise PATH and common Windows installs are checked.",
    )
    args = parser.parse_args()
    ffmpeg = resolve_ffmpeg(args.ffmpeg)

    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    with Image.open(Path(args.atlas).expanduser().resolve()) as opened:
        atlas = opened.convert("RGBA")

    for state, (row, durations) in STATES.items():
        render_state(
            atlas,
            state,
            row,
            durations,
            output_dir,
            args.loops,
            args.scale,
            ffmpeg,
        )
    print(f"wrote videos to {output_dir}")


if __name__ == "__main__":
    main()
