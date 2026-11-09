// Module registry. One line per module, in dependency order (events before anything
// that references events(id)). See docs/COORDINATION.md for owners.
import type { StallModule } from './types.ts';
import { module as photos } from './photos/index.ts';

export const MODULES: StallModule[] = [
  // events (events lane)
  // posts (quotes & regrets lane)
  photos, // photo drop lane
  // night (night-of lane)
];
