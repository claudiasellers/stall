// Stall web app entry. Each view module registers its own routes. One line per module.
import { boot } from './js/core.js';
import './js/views/auth.js';
import './js/views/night.js';
import './js/views/dating.js';
import './js/views/moderation.js';
import './js/views/events.js';
import './js/views/season.js';
import './js/views/feed.js';
import './js/views/lore.js';
import './js/views/photos.js';
import './js/views/wrapped.js';
import './js/views/loremap.js';
import './js/views/you.js';
import './js/views/admin.js';

boot();
