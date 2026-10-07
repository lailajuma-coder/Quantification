import test from 'node:test';
import assert from 'node:assert/strict';
import {
  companionRequired,
  companionPixelDimensions,
  forwardedCompanionHeaders,
  parseCompanionError,
  parseCompanionMetadata,
} from './decode-metadata.mjs';

const VALID_SHA256 = 'a'.repeat(64);

function validMetadataHeaders(overrides = {}) {
  return new Headers({
    'X-KidneyQuant-Source-Format': 'ND2',
    'X-KidneyQuant-Original-Bit-Depth': '16',
    'X-KidneyQuant-Original-Shape': '3x2x32x32',
    'X-KidneyQuant-Original-Axes': 'T,C,Y,X',
    'X-KidneyQuant-Selected-Shape': '32x32x2',
    'X-KidneyQuant-Selected-Axes': 'Y,X,C',
    'X-KidneyQuant-Channel-Count': '2',
    'X-KidneyQuant-Plane-Selection': '{"T":0,"C":"all","Y":"all","X":"all"}',
    'X-KidneyQuant-Processing': 'linear-16bit-to-8bit',
    'X-KidneyQuant-Quantitative-Status': 'experimental',
    'X-KidneyQuant-Source-SHA256': VALID_SHA256,
    ...overrides,
  });
}

test('JP2-family and ND2 files use the private companion while TIFF remains browser-local', () => {
  assert.equal(companionRequired('sample.nd2'), true);
  assert.equal(companionRequired('sample.jp2'), true);
  assert.equal(companionRequired('sample.J2K'), true);
  assert.equal(companionRequired('sample.jpx'), true);
  assert.equal(companionRequired('sample.tif'), false);
  assert.equal(companionRequired('sample.tiff'), false);
});

test('companion metadata preserves source bit depth, axes, selection, digest, and processing disclosure', () => {
  const metadata = parseCompanionMetadata(validMetadataHeaders());
  assert.deepEqual(metadata, {
    sourceFormat: 'ND2',
    originalBitDepth: 16,
    originalShape: '3x2x32x32',
    originalAxes: ['T', 'C', 'Y', 'X'],
    selectedShape: '32x32x2',
    selectedAxes: ['Y', 'X', 'C'],
    channelCount: 2,
    planeSelection: { T: 0, C: 'all', Y: 'all', X: 'all' },
    processing: 'linear-16bit-to-8bit',
    quantitativeStatus: 'experimental',
    processingLocation: 'private companion',
    sourceSha256: VALID_SHA256,
  });
  assert.deepEqual(companionPixelDimensions(metadata), { width: 32, height: 32 });
});

test('successful companion responses fail closed when required provenance is missing, malformed, or contradictory', () => {
  assert.throws(() => parseCompanionMetadata(new Headers()), /missing required companion metadata/i);
  assert.throws(
    () => parseCompanionMetadata(validMetadataHeaders({ 'X-KidneyQuant-Source-SHA256': 'not-a-hash' })),
    /SHA-256/i,
  );
  assert.throws(
    () => parseCompanionMetadata(validMetadataHeaders({ 'X-KidneyQuant-Original-Bit-Depth': '0' })),
    /positive integer/i,
  );
  assert.throws(
    () => parseCompanionMetadata(validMetadataHeaders({ 'X-KidneyQuant-Channel-Count': '3' })),
    /channel count.*selected shape/i,
  );
  assert.throws(
    () => parseCompanionMetadata(validMetadataHeaders({ 'X-KidneyQuant-Selected-Axes': 'Y,Y,C' })),
    /unique.*Y.*X/i,
  );
  assert.throws(
    () => parseCompanionMetadata(validMetadataHeaders({ 'X-KidneyQuant-Selected-Axes': 'Y,X,S' })),
    /selected axes.*original axes/i,
  );
  assert.throws(
    () => parseCompanionMetadata(validMetadataHeaders({ 'X-KidneyQuant-Selected-Shape': '32x64x2' })),
    /selected spatial dimensions.*original/i,
  );
  assert.throws(
    () => parseCompanionMetadata(validMetadataHeaders({ 'X-KidneyQuant-Plane-Selection': '{"T":{"index":0}}' })),
    /scalar axis selections/i,
  );
  assert.throws(
    () => parseCompanionMetadata(validMetadataHeaders({ 'X-KidneyQuant-Plane-Selection': '{"C":"all","Y":"all","X":"all"}' })),
    /dropped axis T.*integer/i,
  );
  assert.throws(
    () => parseCompanionMetadata(validMetadataHeaders({ 'X-KidneyQuant-Plane-Selection': '{"T":"all","C":"all","Y":"all","X":"all"}' })),
    /dropped axis T.*integer/i,
  );
  assert.throws(
    () => parseCompanionMetadata(validMetadataHeaders({ 'X-KidneyQuant-Plane-Selection': '{"T":0,"C":0,"Y":"all","X":"all"}' })),
    /retained axis C.*all/i,
  );
});

test('companion errors accept FastAPI detail and normalized error fields', () => {
  assert.equal(parseCompanionError({ detail: 'Malformed ND2.' }), 'Malformed ND2.');
  assert.equal(parseCompanionError({ error: 'Companion unavailable.' }), 'Companion unavailable.');
  assert.equal(parseCompanionError(null), null);
});

test('API proxy forwards only required decode metadata and no-store headers', () => {
  const source = validMetadataHeaders({
    'Content-Type': 'image/png',
    'X-Internal-Only': 'do-not-forward',
  });
  const forwarded = forwardedCompanionHeaders(source);

  assert.equal(forwarded['content-type'], 'image/png');
  assert.equal(forwarded['cache-control'], 'no-store');
  assert.equal(forwarded['X-KidneyQuant-Original-Bit-Depth'], '16');
  assert.equal(forwarded['X-KidneyQuant-Original-Axes'], 'T,C,Y,X');
  assert.equal(forwarded['X-KidneyQuant-Source-SHA256'], VALID_SHA256);
  assert.equal('X-Internal-Only' in forwarded, false);
});

test('channel mapping is validated and forwarded without losing source channel identity', () => {
  const mapping={method:'source-order',sourceIndices:[0,1],sourceNames:['dapi','GFP']};
  const headers=validMetadataHeaders({'X-KidneyQuant-Channel-Mapping':JSON.stringify(mapping)});
  assert.deepEqual(parseCompanionMetadata(headers).channelMapping,mapping);
  assert.equal(forwardedCompanionHeaders(headers)['X-KidneyQuant-Channel-Mapping'],JSON.stringify(mapping));
  for(const invalid of [{...mapping,sourceIndices:[0,0]},{...mapping,sourceIndices:[1,0]},{...mapping,sourceNames:['only one']},{...mapping,method:'nd2-color-metadata'}]) {
    assert.throws(()=>parseCompanionMetadata(validMetadataHeaders({'X-KidneyQuant-Channel-Mapping':JSON.stringify(invalid)})),/channel mapping/i);
  }
});
