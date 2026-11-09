// STUB owned by the night-of lane: the Tonight tab (#/tonight) and nightPanel(event).
import { h, mount, route, shell, head, empty } from '../core.js';

/** Night-of tools for one event (Home Safe, Where We At, Cooked Meter, Next Move, The Tab). */
export function nightPanel(_event) {
  return null;
}

route('/tonight', async () => {
  mount(shell({ tab: 'tonight' }, head('Tonight', 'What’s the move?'), empty('🌙', 'Nothing tonight yet', 'Plan something in Events.')));
});
void h;
