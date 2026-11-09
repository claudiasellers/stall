// Module registry. One line per module, in dependency order (events before anything
// that references events(id)). See docs/COORDINATION.md for owners.
import type { StallModule } from './types.ts';
import { module as events } from './events/index.ts';
import { module as postsModule } from './posts/index.ts';

export const MODULES: StallModule[] = [
  events, // events lane
  postsModule, // posts (quotes & regrets lane)
];
