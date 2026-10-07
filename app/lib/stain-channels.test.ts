import test from 'node:test';
import assert from 'node:assert/strict';
import { activeAssignment, channelAvailable, setCoStained, type StainingPanel } from './stain-channels.ts';

const panel: StainingPanel = {
  coStained: 'yes', activeId: 'dapi',
  assignments: [
    { id: 'apoj', marker: 'ApoJ / Clusterin', channel: 'red', reagent: 'AF2747 + red secondary' },
    { id: 'dapi', marker: 'DAPI', channel: 'blue', reagent: '' },
  ],
};

test('marker selection resolves the assigned channel and respects source channel availability', () => {
  assert.equal(activeAssignment(panel, 3)?.channel, 'blue');
  assert.equal(activeAssignment(panel, 2), null);
  assert.equal(activeAssignment({ ...panel, activeId: 'apoj' }, 2)?.channel, 'red');
  assert.equal(channelAvailable('red', 1), false);
  assert.equal(channelAvailable('grayscale', 1), true);
  assert.equal(activeAssignment({ ...panel, assignments: panel.assignments.map((item) => ({ ...item, marker: ' ' })) }, 3), null);
});

test('single-stain mode retains the selected marker and toggling back creates a unique second entry', () => {
  const single = setCoStained(panel, 'no');
  assert.equal(single.assignments.length, 1);
  assert.equal(activeAssignment(single, 3)?.marker, 'DAPI');
  const restored = setCoStained(single, 'yes');
  assert.equal(restored.assignments.length, 2);
  assert.equal(new Set(restored.assignments.map(({ id }) => id)).size, 2);
  assert.equal(panel.assignments.length, 2);
});
