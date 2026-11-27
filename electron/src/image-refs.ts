/** Task text references a stored image as `![alt](pinote:sha256-<hex>)`; the backend keeps the bytes. */
export const IMAGE_REF = /!\[([^\]\n]*)\]\(pinote:sha256-([0-9a-f]{64})\)/g;
export const imageRef = (hash: string, alt = 'image') => `![${alt}](pinote:sha256-${hash})`;
/** Every hash the text mentions in any form, as the backend retains them; a superset of displayed images. */
export const imageHashes = (text: string): string[] => Array.from(text.matchAll(/pinote:sha256-([0-9a-f]{64})/g), match => match[1]);
/** The stored image's URL relative to pinote-app://ui/, or null for any other source. */
export function imageSource(src: string): string | null {
  const match = /^pinote:sha256-([0-9a-f]{64})$/.exec(src);
  return match ? `images/${match[1]}` : null;
}
/** A stored image in a stable wrapper; only the wrapper's contents change to a placeholder if it fails to load. */
export function imageElement(src: string, alt: string, className: string): HTMLElement {
  const wrapper = document.createElement('span'), image = document.createElement('img');
  wrapper.className = className; image.src = src; image.alt = alt; image.title = alt; image.draggable = false;
  image.addEventListener('error', () => {
    wrapper.classList.add('image-missing'); wrapper.title = 'This image was deleted or cannot be loaded.';
    image.replaceWith('Image unavailable');
  }, { once: true });
  wrapper.append(image);
  return wrapper;
}
