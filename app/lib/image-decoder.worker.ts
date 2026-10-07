import { decodeMicroscopyFile } from './image-analysis';

self.onmessage = async (event: MessageEvent<File>) => {
  try {
    const image = await decodeMicroscopyFile(event.data);
    // Transfer ownership rather than copying a potentially 32 MB pixel buffer.
    const transfer = [image.rgba.buffer as ArrayBuffer];
    if (image.samples) transfer.push(image.samples.buffer as ArrayBuffer);
    self.postMessage({ image }, { transfer });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Image decoding failed.' });
  }
};
