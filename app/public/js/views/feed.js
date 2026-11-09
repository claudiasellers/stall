// STUB owned by the quotes & regrets lane: #/feed and eventPosts(event).
import { mount, route, shell, head, empty } from '../core.js';

/** That night's quotes and regrets, for the event page. */
export function eventPosts(_event) {
  return null;
}

route('/feed', async () => {
  mount(shell({ tab: 'feed' }, head('Feed', 'What happened'), empty('🗞️', 'Nothing yet', 'Quotes, regrets and plans show up here.')));
});
