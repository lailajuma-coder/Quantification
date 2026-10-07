export type StainChannel = 'red' | 'green' | 'blue' | 'grayscale';
export type StainAssignment = {
  id: string;
  marker: string;
  custom?: boolean;
  channel: StainChannel;
  reagent: string;
};
export type StainingPanel = {
  coStained: 'unspecified' | 'no' | 'yes';
  assignments: StainAssignment[];
  activeId: string | null;
};

export function channelAvailable(channel: StainChannel, channelCount: number) {
  if (channelCount === 1) return channel === 'grayscale';
  return channel !== 'blue' || channelCount >= 3;
}

export function activeAssignment(panel: StainingPanel, channelCount: number) {
  return panel.assignments.find((assignment) => assignment.id === panel.activeId
    && assignment.marker.trim() && channelAvailable(assignment.channel, channelCount)) ?? null;
}

export function setCoStained(panel: StainingPanel, coStained: StainingPanel['coStained']): StainingPanel {
  let assignments = panel.assignments;
  if (coStained === 'yes' && assignments.length < 2) {
    assignments = [...assignments, { id: `co-${assignments[0].id}`, marker: '', channel: 'blue', reagent: '' }];
  } else if (coStained !== 'yes') {
    // Keep the selected marker when returning to a single stain.
    assignments = [assignments.find(({ id }) => id === panel.activeId) ?? assignments[0]];
  }
  return { ...panel, coStained, assignments };
}
