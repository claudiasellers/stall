// Admin moderation (#/admin/moderation): remove any post, photo, debrief or vetting; lock a thread;
// see vetoes. Each lane owns its own hard delete; this screen only calls those endpoints.
import { api, h, toast, route, go, shell, state, empty, ago, head, mount, setRefresh } from '../core.js';

const tryApi = async (path) => {
  try {
    return await api(path);
  } catch {
    return null;
  }
};
async function act(fn, ok) {
  try {
    const out = await fn();
    if (ok) toast(ok);
    return out;
  } catch (e) {
    toast(e.message);
    throw e;
  }
}
const KIND = { quote: '💬', regret: '🫠', lost_item: '🧥', irish_goodbye: '👋', hot_take: '🌶️', canon: '📖', prophecy: '🔮' };
const snippet = (s) => (s && s.length > 140 ? s.slice(0, 140) + '…' : s || '');

function row(icon, title, sub, actions) {
  return h('li', { class: 'mod-row' }, h('span', { class: 'mod-ic' }, icon), h('div', {}, h('div', {}, title), h('div', { class: 'small' }, sub)), h('div', { class: 'row-wrap' }, actions));
}
const del = (path, what, reload) =>
  h('button', { class: 'btn ghost sm danger', onclick: async () => confirm(`Delete this ${what} for everyone? This can’t be undone.`) && (await act(() => api(path, { method: 'DELETE' }), 'Deleted'), reload()) }, 'Delete');

route('/admin/moderation', async () => {
  if (!state.user?.isAdmin) return go('/tonight');
  const reload = () => go('/admin/moderation');
  setRefresh(reload);
  const [posts, photos, vetoes, dating] = await Promise.all([tryApi('/posts?limit=50'), tryApi('/admin/photos?limit=50'), tryApi('/admin/vetoes?limit=50'), tryApi('/dating')]);
  const postList = posts?.posts || [];
  mount(
    shell(
      { title: 'Moderation', tab: 'admin', back: '/admin' },
      head('Admin', '🧹 Moderation', 'Remove anything, lock a thread, see what got vetoed. Deletes are permanent.'),
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'kicker' }, 'Posts'),
        postList.length
          ? h(
              'ul',
              { class: 'mod' },
              postList.map((p) =>
                row(
                  KIND[p.kind] || '📝',
                  snippet(p.body || p.text || p.title),
                  `${p.kind}${p.anonymous ? ' · anonymous' : p.author ? ` · ${p.author}` : ''} · ${ago(p.createdAt)}${p.locked ? ' · 🔒 locked' : ''}`,
                  [
                    h(
                      'button',
                      { class: 'btn ghost sm', onclick: async () => (await act(() => api(`/posts/${p.id}/lock`, { method: 'POST', body: { locked: !p.locked } }), p.locked ? 'Unlocked' : '🔒 Locked'), reload()) },
                      p.locked ? 'Unlock' : 'Lock',
                    ),
                    del(`/posts/${p.id}`, 'post', reload),
                  ],
                ),
              ),
            )
          : empty('🧼', 'No posts'),
      ),
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'kicker' }, 'Photos'),
        photos
          ? (photos.photos || []).length
            ? h('ul', { class: 'mod' }, photos.photos.map((p) => row('📷', `#${p.id}${p.title ? ` · ${p.title}` : ''}`, `${p.uploader || ''} · ${ago(p.takenAt || p.createdAt)}`, [del(`/photos/${p.id}`, 'photo', reload)])))
            : empty('📷', 'No photos')
          : h('p', { class: 'small' }, 'Photo moderation needs the photos module’s admin list (GET /api/v1/admin/photos).'),
      ),
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'kicker' }, 'Vetoes'),
        vetoes
          ? (vetoes.vetoes || []).length
            ? h('ul', { class: 'mod' }, vetoes.vetoes.map((v) => row('🙅', `${v.by || v.name || 'Someone'} vetoed a photo`, `${v.event ? `${v.event} · ` : ''}${ago(v.createdAt || v.at)}`, [])))
            : empty('🙅', 'No vetoes')
          : h('p', { class: 'small' }, 'Veto history needs the photos module’s admin list (GET /api/v1/admin/vetoes).'),
      ),
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'kicker' }, 'Dating'),
        dating && (dating.vets.length || dating.debriefs.length)
          ? h('ul', { class: 'mod' }, [
              ...dating.vets.map((v) => row('🕵️', `Vetting “${v.alias}” by ${v.by}`, `${v.comments.length} comments · ${ago(v.createdAt)}`, [del(`/dating/vets/${v.id}`, 'vetting', reload)])),
              ...dating.debriefs.map((d) => row('📝', `Debrief “${d.alias}” by ${d.by}`, `${d.rating}/10 · ${ago(d.createdAt)}`, [del(`/dating/debriefs/${d.id}`, 'debrief', reload)])),
            ])
          : empty('💘', 'Nothing to moderate'),
      ),
    ),
  );
});
