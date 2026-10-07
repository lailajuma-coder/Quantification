import { decodeMicroscopyFile, type DecodedImage } from './image-analysis';

// Image parsing and RGBA conversion must not block scrolling and loading feedback.
// Each request owns its worker so switching files immediately releases stale work.
export function loadMicroscopyFile(file: File, signal: AbortSignal): Promise<DecodedImage> {
  signal.throwIfAborted();
  if (typeof Worker === 'undefined') {
    return decodeMicroscopyFile(file, signal);
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./image-decoder.worker.ts', import.meta.url), { type: 'module' });
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(new DOMException('Image loading cancelled.', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ image?: DecodedImage; error?: string }>) => {
      cleanup();
      if (event.data.image) resolve(event.data.image);
      else reject(new Error(event.data.error || 'The image could not be decoded.'));
    };
    worker.onerror = () => {
      cleanup();
      reject(new Error('The image decoder could not start. Reload the page and try again.'));
    };
    worker.postMessage(file);
  });
}
