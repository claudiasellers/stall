// STUB owned by the events lane: #/events, #/events/:id, eventCard(e).
import { h, mount, route, shell, head, empty } from '../core.js';

export function eventCard(e) {
  return h('a', { class: 'card', href: `#/events/${e.id}` }, h('strong', {}, e.title));
}

route('/events', async () => {
  mount(shell({ tab: 'events' }, head('Events', 'Plans'), empty('📅', 'No plans yet', 'Events are on the way.')));
});
