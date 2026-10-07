const companionExtensions = new Set(['nd2', 'jp2', 'j2k', 'jpx']);
const metadataHeaderNames = [
  'X-KidneyQuant-Source-Format',
  'X-KidneyQuant-Original-Bit-Depth',
  'X-KidneyQuant-Original-Shape',
  'X-KidneyQuant-Original-Axes',
  'X-KidneyQuant-Selected-Shape',
  'X-KidneyQuant-Selected-Axes',
  'X-KidneyQuant-Channel-Count',
  'X-KidneyQuant-Channel-Mapping',
  'X-KidneyQuant-Plane-Selection',
  'X-KidneyQuant-Processing',
  'X-KidneyQuant-Quantitative-Status',
  'X-KidneyQuant-Source-SHA256',
];

export function companionRequired(fileName) {
  const extension = fileName.toLowerCase().split('.').pop() ?? '';
  return companionExtensions.has(extension);
}

function requiredHeader(headers, name) {
  const value = headers.get(name)?.trim();
  if (!value) throw new Error(`Missing required companion metadata: ${name}.`);
  return value;
}

function positiveIntegerHeader(headers, name) {
  const raw = requiredHeader(headers, name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function shapeHeader(headers, name) {
  const value = requiredHeader(headers, name);
  if (!/^\d+(?:x\d+)*$/.test(value) || value.split('x').some((part) => Number(part) < 1)) {
    throw new Error(`${name} is not a valid positive shape.`);
  }
  return value;
}

function axesHeader(headers, name, shape) {
  const axes = requiredHeader(headers, name).split(',').map((axis) => axis.trim());
  if (axes.length !== shape.split('x').length || axes.some((axis) => !/^[A-Z]$/.test(axis))) {
    throw new Error(`${name} does not match its shape metadata.`);
  }
  if (new Set(axes).size !== axes.length || axes.filter((axis) => axis === 'Y').length !== 1 || axes.filter((axis) => axis === 'X').length !== 1) {
    throw new Error(`${name} must contain unique axes with exactly one Y and one X axis.`);
  }
  return axes;
}

function planeSelectionHeader(headers, name, originalAxes, selectedAxes) {
  const raw = requiredHeader(headers, name);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not a valid JSON object.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} is not a valid JSON object.`);
  }
  for (const [axis, value] of Object.entries(parsed)) {
    if (!originalAxes.includes(axis) || !(value === 'all' || (Number.isSafeInteger(value) && value >= 0))) {
      throw new Error(`${name} must contain only non-negative integer or "all" scalar axis selections.`);
    }
  }

  const droppedAxes = originalAxes.filter((axis) => !selectedAxes.includes(axis));
  if (droppedAxes.length) {
    for (const axis of originalAxes) {
      const value = parsed[axis];
      if (droppedAxes.includes(axis)) {
        if (!(Number.isSafeInteger(value) && value >= 0)) {
          throw new Error(`${name} dropped axis ${axis} must record a non-negative integer index.`);
        }
      } else if (value !== 'all') {
        throw new Error(`${name} retained axis ${axis} must be recorded as "all".`);
      }
    }
  } else {
    for (const axis of originalAxes) {
      if (axis in parsed && parsed[axis] !== 'all') {
        throw new Error(`${name} retained axis ${axis} must be recorded as "all".`);
      }
    }
  }
  return parsed;
}

function channelMappingHeader(headers, count) {
  const raw = headers.get('X-KidneyQuant-Channel-Mapping');
  if (!raw) return undefined;
  let mapping;
  try { mapping = JSON.parse(raw); } catch { throw new Error('Invalid channel mapping metadata.'); }
  if (!mapping || !['nd2-color-metadata', 'source-order'].includes(mapping.method)
    || !Array.isArray(mapping.sourceIndices) || mapping.sourceIndices.length !== count
    || new Set(mapping.sourceIndices).size !== count
    || mapping.sourceIndices.some(index => !Number.isInteger(index) || index < 0 || index >= count)
    || !Array.isArray(mapping.sourceNames) || mapping.sourceNames.length !== count
    || mapping.sourceNames.some(name => typeof name !== 'string' || name.length > 200)
    || (mapping.method === 'nd2-color-metadata' && count !== 3)
    || (mapping.method === 'source-order' && mapping.sourceIndices.some((index, position) => index !== position))) {
    throw new Error('Invalid channel mapping metadata.');
  }
  if(mapping.pixelSizeMicrons !== undefined && (!Array.isArray(mapping.pixelSizeMicrons) || mapping.pixelSizeMicrons.length!==2 || mapping.pixelSizeMicrons.some(v=>!Number.isFinite(v)||v<=0))) throw new Error('Invalid spatial calibration.');
  return mapping;
}

/**
 * @param {Headers} headers
 * @returns {{
 *   sourceFormat: string,
 *   originalBitDepth: number,
 *   originalShape: string,
 *   originalAxes: string[],
 *   selectedShape: string,
 *   selectedAxes: string[],
 *   channelCount: number,
 *   channelMapping?: {method: string, sourceIndices: number[], sourceNames: string[], pixelSizeMicrons?: number[]},
 *   planeSelection: Record<string, number | string>,
 *   processing: string,
 *   quantitativeStatus: 'experimental' | 'demonstration',
 *   processingLocation: 'private companion',
 *   sourceSha256: string,
 * }}
 */
export function parseCompanionMetadata(headers) {
  const originalShape = shapeHeader(headers, 'X-KidneyQuant-Original-Shape');
  const selectedShape = shapeHeader(headers, 'X-KidneyQuant-Selected-Shape');
  const originalAxes = axesHeader(headers, 'X-KidneyQuant-Original-Axes', originalShape);
  const selectedAxes = axesHeader(headers, 'X-KidneyQuant-Selected-Axes', selectedShape);
  if (selectedAxes.some((axis) => !originalAxes.includes(axis))) {
    throw new Error('Companion selected axes must be retained from the original axes metadata.');
  }
  if (selectedAxes.some((axis) => !['Y', 'X', 'C', 'S'].includes(axis)) || selectedAxes.length > 3) {
    throw new Error('Selected axes must be Y,X with at most one C or S channel axis.');
  }
  const selectedDimensions = selectedShape.split('x').map(Number);
  const originalDimensions = originalShape.split('x').map(Number);
  for (const axis of selectedAxes) {
    const selectedSize = selectedDimensions[selectedAxes.indexOf(axis)];
    const originalSize = originalDimensions[originalAxes.indexOf(axis)];
    if (selectedSize !== originalSize) {
      throw new Error('Companion selected spatial dimensions and retained channel dimensions must match the original metadata.');
    }
  }
  const expectedChannelCount = selectedAxes.reduce(
    (count, axis, index) => axis === 'Y' || axis === 'X' ? count : count * selectedDimensions[index],
    1,
  );
  const channelCount = positiveIntegerHeader(headers, 'X-KidneyQuant-Channel-Count');
  if (channelCount !== expectedChannelCount) {
    throw new Error('Companion channel count contradicts the selected shape and axes metadata.');
  }
  const sourceSha256 = requiredHeader(headers, 'X-KidneyQuant-Source-SHA256').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error('Companion source SHA-256 must contain exactly 64 hexadecimal characters.');
  const status = requiredHeader(headers, 'X-KidneyQuant-Quantitative-Status');
  if (status !== 'experimental' && status !== 'demonstration') throw new Error('Companion quantitative status is invalid.');

  return {
    sourceFormat: requiredHeader(headers, 'X-KidneyQuant-Source-Format'),
    originalBitDepth: positiveIntegerHeader(headers, 'X-KidneyQuant-Original-Bit-Depth'),
    originalShape,
    originalAxes,
    selectedShape,
    selectedAxes,
    channelCount,
    ...(channelMappingHeader(headers, channelCount) ? { channelMapping: channelMappingHeader(headers, channelCount) } : {}),
    planeSelection: planeSelectionHeader(headers, 'X-KidneyQuant-Plane-Selection', originalAxes, selectedAxes),
    processing: requiredHeader(headers, 'X-KidneyQuant-Processing'),
    quantitativeStatus: status,
    processingLocation: 'private companion',
    sourceSha256,
  };
}

export function companionPixelDimensions(metadata) {
  const dimensions = metadata.selectedShape.split('x').map(Number);
  return {
    width: dimensions[metadata.selectedAxes.indexOf('X')],
    height: dimensions[metadata.selectedAxes.indexOf('Y')],
  };
}

export function parseCompanionError(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
  if (typeof payload.detail === 'string' && payload.detail.trim()) return payload.detail;
  return null;
}

/** @param {Headers} headers @returns {Record<string, string>} */
export function forwardedCompanionHeaders(headers) {
  const forwarded = {
    'content-type': headers.get('content-type') || 'application/json',
    'cache-control': 'no-store',
  };
  for (const name of metadataHeaderNames) {
    const value = headers.get(name);
    if (value) forwarded[name] = value;
  }
  return forwarded;
}
