import { analyzeImage, stainScore, thresholdMaximum, type AnalysisOptions, type DecodedImage } from './image-analysis.ts';

export type Channel = AnalysisOptions['signalChannel'];
export type ChannelSettings = { minimum: number; maximum: number; brightness: number; displayMinimum?: number; displayMaximum?: number };

// Fluorescent marker names share intensity units; keep each color's edits across marker selection.
export function channelSettingsKey(stain: string, channel: Channel) {
  return `${stain.includes('(IF)') ? 'fluorescence' : stain}:${channel}`;
}

export function samplePreview(image: DecodedImage, maxSide = 480): DecodedImage {
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const rgba = new Uint8ClampedArray(width * height * 4);
  const samples = image.samples instanceof Uint16Array ? new Uint16Array(width * height * image.channelCount)
    : image.samples ? new Uint8Array(width * height * image.channelCount) : undefined;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = Math.floor(y * image.height / height) * image.width + Math.floor(x * image.width / width);
    const to = y * width + x;
    rgba.set(image.rgba.subarray(from * 4, from * 4 + 4), to * 4);
    if (samples && image.samples) samples.set(image.samples.subarray(from * image.channelCount, (from + 1) * image.channelCount), to * image.channelCount);
  }
  return { ...image, width, height, rgba, samples };
}

export function components(image: DecodedImage, i: number): [number, number, number] {
  if (!image.samples) return [image.rgba[i * 4], image.rgba[i * 4 + 1], image.rgba[i * 4 + 2]];
  const p = i * image.channelCount;
  const r = image.samples[p];
  return [r, image.channelCount === 1 ? r : image.samples[p + 1], image.channelCount === 1 ? r : image.channelCount === 2 ? 0 : image.samples[p + 2]];
}

export function automaticSettings(image: DecodedImage, stain: string, channel: Channel): ChannelSettings {
  if(image.analysisWorkflow === 'sirius-magenta') return {minimum:0.35,maximum:1,brightness:1};
  const maximum = thresholdMaximum(image);
  const histogram = new Uint32Array(maximum + 1);
  let sum = 0;
  const count = image.width * image.height;
  for (let i = 0; i < count; i++) {
    const [r, g, b] = components(image, i);
    const score = stainScore(r, g, b, stain, channel, maximum);
    histogram[score]++; sum += score;
  }
  let weight = 0, partial = 0, best = -1, threshold = 0;
  for (let i = 0; i < maximum; i++) {
    weight += histogram[i]; partial += i * histogram[i];
    if (!weight || weight === count) continue;
    const distance = partial / weight - (sum - partial) / (count - weight);
    const variance = weight * (count - weight) * distance * distance;
    if (variance > best) { best = variance; threshold = i; }
  }
  // Uniform nonzero images have no split; keep that intensity. Black stays negative.
  const minimum = best < 0 ? Math.max(1, Math.round(sum / count)) : threshold + 1;
  return { minimum, maximum, brightness: 1 };
}

export function displayRanges(image: DecodedImage): [number, number, number] {
  const max = image.analysisBitDepth === 16 ? 65535 : 255;
  const histograms = [new Uint32Array(max + 1), new Uint32Array(max + 1), new Uint32Array(max + 1)];
  const count = image.width * image.height;
  for (let i = 0; i < count; i++) components(image, i).forEach((value, channel) => histograms[channel][value]++);
  return histograms.map((histogram) => {
    let total = 0;
    for (let value = 0; value <= max; value++) {
      total += histogram[value];
      if (total >= count) return Math.max(1, value);
    }
    return max;
  }) as [number, number, number];
}

export function renderPreview(image: DecodedImage, channel: Channel | 'composite' | 'magenta', ranges: number[], brightness: number[], options: AnalysisOptions, view: 'original' | 'overlay' | 'mask', displayMinimum: number[] = [0, 0, 0]) {
  const pixels = new Uint8ClampedArray(image.rgba.length);
  let result = null;
  if (view !== 'original') {
    try { result = analyzeImage(image, options); } catch { /* Empty preview ROI: show the source. Full analysis reports the error. */ }
  }
  const component = { red: 0, green: 1, blue: 2, grayscale: -1, composite: -1, magenta: -2 }[channel];
  for (let i = 0; i < image.width * image.height; i++) {
    const values = components(image, i);
    for (let c = 0; c < 3; c++) pixels[i * 4 + c] = component < 0 || component === c ? Math.round(Math.max(0, Math.min(1, (values[c] - displayMinimum[c]) / Math.max(1, ranges[c] - displayMinimum[c]))) * 255 * brightness[c]) : 0;
    if(channel==='magenta') {const high=Math.max(...values);const value=high ? Math.round((high-values[1])/high*255*brightness[0]):0;pixels[i*4]=pixels[i*4+2]=value;pixels[i*4+1]=0;}
    pixels[i * 4 + 3] = 255;
    if (result && view === 'mask') {
      const value = result.positiveMask[i] ? 255 : 0;
      pixels[i * 4] = pixels[i * 4 + 1] = pixels[i * 4 + 2] = value;
    } else if (result?.positiveMask[i]) {
      [214, 52, 112].forEach((value, c) => { pixels[i * 4 + c] = Math.round(pixels[i * 4 + c] * .35 + value * .65); });
    } else if (result && !result.tissueMask[i]) {
      for (let c = 0; c < 3; c++) pixels[i * 4 + c] = Math.round(pixels[i * 4 + c] * .28);
    }
  }
  return pixels;
}
