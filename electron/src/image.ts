// Pinote's image window: one stored image, named by the URL fragment. A click or Escape closes it.
const image = document.querySelector('img')!;
const hash = /^#([0-9a-f]{64})$/.exec(location.hash)?.[1];
// The main process reads the natural size to size the window; null when the image cannot load.
(window as unknown as { pinoteImageSize: Promise<[number, number] | null> }).pinoteImageSize = new Promise(resolve => {
  image.addEventListener('load', () => resolve([image.naturalWidth, image.naturalHeight]));
  image.addEventListener('error', () => resolve(null));
  if (hash) image.src = `images/${hash}`; else resolve(null);
});
document.addEventListener('click', () => window.close());
document.addEventListener('keydown', event => { if (event.key === 'Escape') window.close(); });
