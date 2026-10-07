const supportedExtensions = new Set(['nd2', 'tif', 'tiff', 'jp2', 'j2k', 'jpx']);
const naturalPathOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Filter a browser FileList (or file-like array) and order nested paths naturally.
 * @template {{ name: string, webkitRelativePath?: string }} T
 * @param {Iterable<T> | ArrayLike<T>} files
 * @returns {T[]}
 */
export function prepareMicroscopyFiles(files) {
  return Array.from(files)
    .filter((file) => supportedExtensions.has(file.name.toLowerCase().split('.').pop() ?? ''))
    .sort((left, right) => naturalPathOrder.compare(
      left.webkitRelativePath || left.name,
      right.webkitRelativePath || right.name,
    ));
}

/**
 * Show one RGB component in its own color in an existing working buffer.
 * @param {Uint8ClampedArray} pixels
 * @param {'composite' | 'red' | 'green' | 'blue'} channel
 */
export function applyChannelViewInPlace(pixels, channel) {
  if (channel === 'composite') return pixels;
  const component = { red: 0, green: 1, blue: 2 }[channel];
  if (component === undefined) throw new Error(`Unknown image channel: ${channel}`);

  for (let offset = 0; offset < pixels.length; offset += 4) {
    const value = pixels[offset + component];
    pixels[offset] = component === 0 ? value : 0;
    pixels[offset + 1] = component === 1 ? value : 0;
    pixels[offset + 2] = component === 2 ? value : 0;
  }
  return pixels;
}
