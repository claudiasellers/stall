// Module registry. One line per module, in dependency order (events before anything
// that references events(id)). See docs/COORDINATION.md for owners.
import type { StallModule } from './types.ts';
import { module as events } from './events/index.ts';
import { module as postsModule } from './posts/index.ts';
import { module as photos } from './photos/index.ts';
import { module as night } from './night/index.ts';
import { module as wrapped } from './wrapped/index.ts';
import { module as season } from './season/index.ts';

export const MODULES: StallModule[] = [
  events, // events lane
  postsModule, // posts (quotes & regrets lane)
  photos, // photo drop lane
  night, // night-of lane
  wrapped, // Wrapped + Hall of Fame/Shame (photo lane); read-only, keep last
  season, // events lane: trips, football, templates (after night: kitty writes to the Tab)
];
