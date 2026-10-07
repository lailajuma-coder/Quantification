import test from 'node:test';
import assert from 'node:assert/strict';
import { applyChannelViewInPlace, prepareMicroscopyFiles } from './viewer-utils.mjs';

test('folder files are filtered and naturally sorted by relative path', () => {
  const files = [
    { name: 'tile10.tif', webkitRelativePath: 'kidney/tile10.tif' },
    { name: 'notes.csv', webkitRelativePath: 'kidney/notes.csv' },
    { name: 'tile2.ND2', webkitRelativePath: 'kidney/sub/tile2.ND2' },
    { name: 'tile1.jp2', webkitRelativePath: 'kidney/sub/tile1.jp2' },
  ];

  assert.deepEqual(
    prepareMicroscopyFiles(files).map((file) => file.webkitRelativePath),
    ['kidney/sub/tile1.jp2', 'kidney/sub/tile2.ND2', 'kidney/tile10.tif'],
  );
});

test('RGB channel views preserve the selected intensity and alpha in the matching color', () => {
  const source = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 128]);
  const expected = {
    red: [10, 0, 0, 255, 40, 0, 0, 128],
    green: [0, 20, 0, 255, 0, 50, 0, 128],
    blue: [0, 0, 30, 255, 0, 0, 60, 128],
    composite: Array.from(source),
  };
  for (const [channel, values] of Object.entries(expected)) {
    const pixels = new Uint8ClampedArray(source);
    assert.equal(applyChannelViewInPlace(pixels, channel), pixels);
    assert.deepEqual(Array.from(pixels), values);
  }
  assert.deepEqual(Array.from(source), [10, 20, 30, 255, 40, 50, 60, 128]);
});
