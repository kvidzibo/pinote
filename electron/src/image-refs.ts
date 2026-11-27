/** Task text references a stored image as `![alt](pinote:sha256-<hex>)`; the backend keeps the bytes. */
export const IMAGE_REF = /!\[([^\]\n]*)\]\(pinote:sha256-([0-9a-f]{64})\)/g;
export const imageRef = (hash: string, alt = 'image') => `![${alt}](pinote:sha256-${hash})`;
export const imageHashes = (text: string): string[] => Array.from(text.matchAll(IMAGE_REF), match => match[2]);
/** The stored image's URL relative to pinote-app://ui/, or null for any other source. */
export function imageSource(src: string): string | null {
  const match = /^pinote:sha256-([0-9a-f]{64})$/.exec(src);
  return match ? `images/${match[1]}` : null;
}
/** A stored image, or a placeholder once it has been deleted or fails to load. */
export function imageElement(src: string, alt: string, className: string): HTMLElement {
  const image = document.createElement('img');
  image.className = className; image.src = src; image.alt = alt; image.title = alt; image.draggable = false;
  image.addEventListener('error', () => {
    const missing = document.createElement('span');
    missing.className = `${className} image-missing`; missing.textContent = 'Image unavailable';
    missing.title = 'This image was deleted or cannot be loaded.';
    image.replaceWith(missing);
  }, { once: true });
  return image;
}
