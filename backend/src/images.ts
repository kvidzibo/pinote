import { NoteError } from './compat.ts';

/** Stored image limits. Electron converts pastes to fit; other bytes are refused, never converted. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024, MAX_IMAGE_SIDE = 4096;
/** Task text references a stored image as `![alt](pinote:sha256-<hex>)`. */
export const imageHashes = (text: string): string[] => Array.from(text.matchAll(/\]\(pinote:sha256-([0-9a-f]{64})\)/g), match => match[1]);
export const validImageHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export type ImageInfo = { mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; width: number; height: number };

// Type and size come from the bytes' own headers, never from a caller's label. SVG and other types are refused.
function dimensions(b: Uint8Array): ImageInfo | null {
  const ascii = (at: number, text: string) => text.split('').every((c, i) => b[at + i] === c.charCodeAt(0));
  const be16 = (at: number) => b[at] << 8 | b[at + 1], le16 = (at: number) => b[at] | b[at + 1] << 8;
  const le24 = (at: number) => b[at] | b[at + 1] << 8 | b[at + 2] << 16;
  if (b.length >= 24 && ascii(0, '\x89PNG\r\n\x1a\n') && ascii(12, 'IHDR'))
    return { mime: 'image/png', width: (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, height: (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0 };
  if (b.length >= 10 && (ascii(0, 'GIF87a') || ascii(0, 'GIF89a'))) return { mime: 'image/gif', width: le16(6), height: le16(8) };
  if (b.length >= 30 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    if (ascii(12, 'VP8X')) return { mime: 'image/webp', width: le24(24) + 1, height: le24(27) + 1 };
    if (ascii(12, 'VP8L') && b[20] === 0x2f) { const bits = (b[21] | b[22] << 8 | b[23] << 16 | b[24] << 24) >>> 0; return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: (bits >>> 14 & 0x3fff) + 1 }; }
    if (ascii(12, 'VP8 ') && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { mime: 'image/webp', width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    // Walk JPEG segments to the first start-of-frame marker.
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { mime: 'image/jpeg', width: be16(i + 7), height: be16(i + 5) };
      if (marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7) { i += 2; continue; }
      i += 2 + be16(i + 2);
    }
  }
  return null;
}
export function imageInfo(bytes: Uint8Array): ImageInfo {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new NoteError(`Images must be between 1 byte and ${MAX_IMAGE_BYTES / 1024 / 1024} MiB.`);
  const info = dimensions(bytes);
  if (!info) throw new NoteError('Only PNG, JPEG, GIF and WebP images are supported.');
  if (info.width < 1 || info.height < 1 || info.width > MAX_IMAGE_SIDE || info.height > MAX_IMAGE_SIDE) throw new NoteError(`Image sides must be between 1 and ${MAX_IMAGE_SIDE} pixels.`);
  return info;
}
/** Strict standard base64, as Electron sends it. */
export function decodeImage(data: unknown): Uint8Array {
  if (typeof data !== 'string' || data.length % 4 || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new NoteError('Image data must be base64.');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) throw new NoteError('Image data must be base64.');
  return bytes;
}
