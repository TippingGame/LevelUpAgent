# Animation Rows

The Codex app reads one fixed atlas: 8 columns, 9 rows, 192x208 pixels per cell.

| Row | State | Used columns | Durations |
| --- | --- | ---: | --- |
| 0 | idle | 0-5 | 280, 110, 110, 140, 140, 320 ms |
| 1 | running-right | 0-7 | 90 ms each (720 ms loop) |
| 2 | running-left | 0-7 | 90 ms each (720 ms loop) |
| 3 | waving | 0-3 | 140 ms each, final 280 ms |
| 4 | jumping | 0-4 | 140 ms each, final 280 ms |
| 5 | failed | 0-7 | 140 ms each, final 240 ms |
| 6 | waiting | 0-5 | 150 ms each, final 260 ms |
| 7 | running | 0-5 | 120 ms each, final 220 ms |
| 8 | review | 0-5 | 150 ms each, final 280 ms |

Unused cells after each row's final used column must be fully transparent.

## Temporal Frame Contract

Every row is a time strip, not an unordered pose sheet. The first visible pose in
column 0 is the start of the action. Columns 1 through the final used column are
the consecutive later phases, and the player always samples them in numeric order
(`0, 1, 2, ...`) before looping back to column 0. Never sort poses by visual
similarity, mirror an entire strip, or place a late/resting pose in column 0.

- Directional running rows: column 0 is the first contact/take-off phase, the
  middle columns form one continuous gait, and the final column leads naturally
  back to column 0. A mirrored left row mirrors each column in place and keeps
  this exact column order.
- Gesture, jump, failure, waiting, working, and review rows: column 0 is the
  neutral or anticipation pose; middle columns unfold the action; the final
  column settles or connects cleanly to the next loop.

The runtime does not infer, reorder, or repair timing from the artwork. A strip
whose columns are out of temporal order is invalid even when its geometry passes.

## Row Purposes

- `idle`: calm, low-distraction breathing/blinking loop; use as the reduced-motion first frame. Keep motion subtle and persona-preserving.
- `running-right`: locomotion to the right; 8-frame loop should read directionally.
- `running-left`: mirrored or redrawn locomotion to the left; do not simply reuse right-facing frames unless the design is symmetric.
- `waving`: greeting or attention gesture; clear start, raised gesture, return.
- `jumping`: anticipation, lift, peak, descent, settle.
- `failed`: error/sad/deflated reaction; readable but not visually noisy.
- `waiting`: patient idle variant; glance, small bounce, or prop motion.
- `running`: active working/in-progress loop, as if the pet is busy running a task. This row is not foot-running; avoid jogging, sprinting, treadmill poses, raised knees, long steps, pumping arms, or directional travel.
- `review`: focused/inspecting/thinking loop suitable for review state.
