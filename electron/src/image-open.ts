/** Shows a stored image over this window's content; a click or Escape closes it. */
function showOverlay(src: string, alt: string): void {
  const prior = document.activeElement as HTMLElement | null;
  const overlay = document.createElement('div'), image = document.createElement('img');
  overlay.className = 'image-overlay'; overlay.tabIndex = -1; overlay.title = 'Click or press Escape to close';
  overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', 'Image');
  image.src = src; image.alt = alt; image.draggable = false;
  // Capturing on the window: Escape closes only the image, not the dialog or window under it.
  const key = (event: KeyboardEvent) => {
    // Tab stays on the image: the controls under it are covered.
    if (event.key !== 'Escape' && event.key !== 'Tab') return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === 'Escape') close();
  };
  const close = () => { window.removeEventListener('keydown', key, true); overlay.remove(); if (prior?.isConnected) prior.focus(); };
  overlay.addEventListener('click', event => { event.stopPropagation(); close(); });
  window.addEventListener('keydown', key, true);
  overlay.append(image); document.body.append(overlay); overlay.focus();
}
/**
 * Opens stored images: a click in rendered text, a double click in an editor (where one click places the cursor).
 * `view` resolves true when the Window settings show images inside the asking window.
 */
export function openImagesOnClick(view: (hash: string) => Promise<boolean>, report: (error: unknown) => void): void {
  const open = (event: MouseEvent) => {
    const image = event.target instanceof HTMLImageElement ? event.target : null;
    const hash = image && /\/images\/([0-9a-f]{64})$/.exec(image.src)?.[1];
    // An image inside a link opens the link.
    if (!image || !hash || event.button !== 0 || image.closest('a[href], .image-overlay')) return;
    if (!!image.closest('.cm-image') !== (event.type === 'dblclick')) return;
    event.preventDefault();
    // The list may redraw before the answer arrives: keep what the clicked image showed.
    const { src, alt } = image;
    void view(hash).then(here => { if (here) showOverlay(src, alt); }, report);
  };
  document.addEventListener('click', open); document.addEventListener('dblclick', open);
}
