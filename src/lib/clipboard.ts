/** Write full-resolution pixels, converting JPEG/WebP to the clipboard's portable PNG format. */
export async function copyImage(url: string) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image copy is unavailable");
  }
  const png = (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Could not read image");
    const source = await response.blob();
    if (source.type === "image/png") return source;
    const bitmap = await createImageBitmap(source);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not decode image");
      context.drawImage(bitmap, 0, 0);
      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not encode image")), "image/png");
      });
    } finally {
      bitmap.close();
    }
  })();
  // Start the clipboard write during the click gesture, before asynchronous decoding.
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

export async function copyText(content: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(content);
      return;
    } catch {
      // Fall through for webviews or browser contexts that expose the API but deny permission.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = content;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Copy is unavailable");
}
