/** Decode tightly packed Y,X[,C] unsigned samples without display quantization. */
export function nativePixels(buffer: ArrayBuffer, width: number, height: number, channels: number, bits: number) {
  if (!Number.isInteger(bits) || bits < 1 || bits > 16 || ![1, 2, 3].includes(channels)
    || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 8_000_000) {
    throw new Error('Unsupported native pixel dimensions, channels, or bit depth.');
  }
  const bytes = bits <= 8 ? 1 : 2;
  const count = width * height * channels;
  if (buffer.byteLength !== count * bytes) throw new Error('Native pixel payload length does not match metadata.');
  const samples = bytes === 1 ? new Uint8Array(buffer) : new Uint16Array(count);
  if (bytes === 2) {
    const view = new DataView(buffer);
    for (let i = 0; i < count; i++) samples[i] = view.getUint16(i * 2, true);
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  const displayMax = 2 ** bits - 1;
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    rgba[i * 4] = Math.round(samples[p] * 255 / displayMax);
    rgba[i * 4 + 1] = Math.round(samples[p + (channels === 1 ? 0 : 1)] * 255 / displayMax);
    rgba[i * 4 + 2] = channels === 2 ? 0 : Math.round(samples[p + (channels === 1 ? 0 : 2)] * 255 / displayMax);
    rgba[i * 4 + 3] = 255;
  }
  return { samples, rgba, analysisBitDepth: bytes * 8 };
}
