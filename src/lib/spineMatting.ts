/** Remove an edge-connected solid background and unmix a narrow green fringe.
 * The input buffer and enclosed artwork are preserved.
 */
export function matteSpineSolidBackground(
  pixels: Uint8ClampedArray, width: number, height: number, tolerance: number,
) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || pixels.length !== width * height * 4 || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 255)
    throw new Error("Invalid background removal image or tolerance.");
  const corners = [0, width - 1, (height - 1) * width, height * width - 1];
  const background = [0, 1, 2].map((channel) =>
    corners.reduce((total, i) => total + pixels[i * 4 + channel], 0) / corners.length);
  const distance = (i: number) => Math.hypot(
    pixels[i * 4] - background[0], pixels[i * 4 + 1] - background[1], pixels[i * 4 + 2] - background[2]);
  if (corners.some((i) => distance(i) > tolerance))
    throw new Error("Corner colors differ too much for solid-background removal.");
  const count = width * height;
  const visited = new Uint8Array(count);
  const queue = new Int32Array(count);
  let head = 0, tail = 0;
  const enqueue = (i: number) => {
    if (visited[i] || (pixels[i * 4 + 3] >= 8 && distance(i) > tolerance)) return;
    visited[i] = 1;
    queue[tail++] = i;
  };
  for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
  const neighbors = (i: number, visit: (index: number) => void) => {
    const x = i % width;
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i < width * (height - 1)) visit(i + width);
  };
  while (head < tail) neighbors(queue[head++], enqueue);
  if (tail < Math.min(count, width + height))
    throw new Error("No solid background was found at the image edge.");

  const result = new Uint8ClampedArray(pixels);
  for (let i = 0; i < count; i++) if (visited[i]) result[i * 4 + 3] = 0;
  // Green-screen antialias pixels mix foreground and screen color. Estimate the
  // foreground from a nearby non-green pixel, then solve C = aF + (1-a)B.
  // Limit this to a narrow connected fringe; never globally desaturate artwork.
  let feathered = 0;
  if (background[1] > 160 && background[1] - Math.max(background[0], background[2]) > 100) {
    const excess = (i: number) => pixels[i * 4 + 1] - Math.max(pixels[i * 4], pixels[i * 4 + 2]);
    const fringe = new Uint8Array(count);
    let frontier: number[] = [];
    for (let i = 0; i < count; i++) {
      if (visited[i] || pixels[i * 4 + 3] < 8 || excess(i) <= 8) continue;
      let touchesBackground = false;
      neighbors(i, (n) => { touchesBackground ||= visited[n] === 1; });
      if (touchesBackground) { fringe[i] = 1; frontier.push(i); }
    }
    const candidates = [...frontier];
    for (let depth = 1; depth < 3; depth++) {
      const next: number[] = [];
      for (const i of frontier) neighbors(i, (n) => {
        if (!visited[n] && !fringe[n] && pixels[n * 4 + 3] >= 8 && excess(n) > 8) {
          fringe[n] = 1; next.push(n); candidates.push(n);
        }
      });
      frontier = next;
    }
    for (const i of candidates) {
      const x = i % width, y = Math.floor(i / width);
      let nearest = -1, nearestDistance = Infinity;
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const nx = x + dx, ny = y + dy, d = dx * dx + dy * dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || d >= nearestDistance) continue;
        const n = ny * width + nx;
        if (!visited[n] && pixels[n * 4 + 3] >= 240 && excess(n) <= 8) {
          nearest = n; nearestDistance = d;
        }
      }
      if (nearest < 0) continue;
      let numerator = 0, denominator = 0;
      for (let c = 0; c < 3; c++) {
        const foreground = pixels[nearest * 4 + c] - background[c];
        numerator += (pixels[i * 4 + c] - background[c]) * foreground;
        denominator += foreground * foreground;
      }
      if (denominator < 1) continue;
      const alpha = Math.max(0, Math.min(1, numerator / denominator));
      // A real green detail may also touch the silhouette. Only unmix colors
      // consistent with this local foreground/screen pair.
      let residual = 0;
      for (let c = 0; c < 3; c++) {
        const predicted = alpha * pixels[nearest * 4 + c] + (1 - alpha) * background[c];
        residual += (pixels[i * 4 + c] - predicted) ** 2;
      }
      if (residual > 72 ** 2) continue;
      result[i * 4 + 3] = Math.round(pixels[i * 4 + 3] * alpha);
      if (alpha > 0.01) for (let c = 0; c < 3; c++)
        result[i * 4 + c] = (pixels[i * 4 + c] - (1 - alpha) * background[c]) / alpha;
      feathered++;
    }
  }
  return { pixels: result, removed: tail, feathered };
}
