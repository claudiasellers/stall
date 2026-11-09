// STUB owned by the quotes & regrets lane: #/lore (Quote Wall; Canon, Superlatives later).
import { mount, route, shell, head, empty } from '../core.js';

route('/lore', async () => {
  mount(shell({ tab: 'lore' }, head('Lore', 'The record'), empty('📜', 'No lore yet', 'The Quote Wall lands here.')));
});
