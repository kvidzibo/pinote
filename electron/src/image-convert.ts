// Pasted images are re-encoded before storage: smaller files, and no camera/GPS metadata.
export const MAX_IMAGE_SIDE = 2560, MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const accepted = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'];

/** WebP for everything but GIF (kept for animation): lossless for screenshots, quality 85 for photos. */
export async function convertImage(source: Blob): Promise<Blob> {
  if (!accepted.includes(source.type)) throw new Error('Only PNG, JPEG, WebP, GIF and BMP images can be pasted.');
  const bitmap = await createImageBitmap(source).catch(() => { throw new Error('This image cannot be read.'); });
  try {
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    if (source.type === 'image/gif') {
      if (scale < 1 || source.size > MAX_IMAGE_BYTES) throw new Error(`GIFs must be at most ${MAX_IMAGE_SIDE} pixels per side and 4 MiB.`);
      return source;
    }
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // Chromium encodes quality 1 as lossless WebP. Only a lossless result over 4 MiB falls back to quality 0.9.
    for (const quality of source.type === 'image/jpeg' ? [0.85] : [1, 0.9]) {
      const result = await canvas.convertToBlob({ type: 'image/webp', quality });
      if (result.type !== 'image/webp') throw new Error('This image cannot be converted.');
      if (result.size <= MAX_IMAGE_BYTES) return result;
    }
    throw new Error('This image is too large to store, even after conversion.');
  } finally { bitmap.close(); }
}
export function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
    reader.onerror = () => reject(new Error('This image cannot be read.'));
    reader.readAsDataURL(blob);
  });
}
