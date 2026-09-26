/**
 * Session-scoped try-on screenshots — client-side ONLY. Blobs live in this
 * module-level Map: no backend calls, no D1/R2 writes, no localStorage,
 * no sessionStorage, no IndexedDB. The Map dies with the page's JS
 * context, which is exactly what makes "deleted when you close the tab"
 * literally true rather than a cleanup routine that could fail to run.
 * Nothing imports this yet — the future try-on feature calls it.
 */

export interface TryOnShot {
  productId: string;
  imageBlob: Blob;
}

const shots = new Map<string, { blob: Blob; objectUrl: string }>();

/** Render a video frame (or copy a canvas) into a JPEG Blob. */
export function captureShot(source: HTMLCanvasElement | HTMLVideoElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let canvas: HTMLCanvasElement;
    if (source instanceof HTMLCanvasElement) {
      canvas = source;
    } else {
      if (!source.videoWidth || !source.videoHeight) {
        reject(new Error("Video has no frames yet — capture after it starts playing."));
        return;
      }
      canvas = document.createElement("canvas");
      canvas.width = source.videoWidth;
      canvas.height = source.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("2d canvas context unavailable."));
        return;
      }
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    }
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Capture produced no image data."))),
      "image/jpeg",
      0.85,
    );
  });
}

/**
 * Store (or replace) one product's shot. Replaces revoke the previous
 * object URL first, so flipping through looks in a long session can't
 * leak blob URLs one per capture.
 */
export function saveTryOnShot(productId: string, imageBlob: Blob): void {
  const prev = shots.get(productId);
  if (prev) URL.revokeObjectURL(prev.objectUrl);
  shots.set(productId, { blob: imageBlob, objectUrl: URL.createObjectURL(imageBlob) });
}

export function getTryOnShots(): TryOnShot[] {
  return [...shots.entries()].map(([productId, { blob }]) => ({ productId, imageBlob: blob }));
}

/** Revoke every object URL and drop every Blob (call on session end/unmount). */
export function clearTryOnShots(): void {
  for (const { objectUrl } of shots.values()) URL.revokeObjectURL(objectUrl);
  shots.clear();
}
