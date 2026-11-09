// The You tab: profile, alerts, install, Suggest a feature, notifications, sign out.
import {
  state, api, fill, h, ago, toast, mount, route, go, query, shell, updateBell, head, empty, installHint, isIos, isStandalone,
  b64ToBytes, setRefresh, formOf,
} from '../core.js';

route('/you(?:\\?.*)?', async () => {
  const pushBox = h('div', { class: 'stack' });
  const renderPush = async () => {
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (!state.config?.pushPublicKey) return fill(pushBox, h('p', { class: 'muted small' }, 'Phone alerts are not switched on yet.'));
    if (!supported) {
      return fill(pushBox, h('p', { class: 'muted small' }, isIos() && !isStandalone() ? 'On iPhone, add Stall to your Home Screen first, then open it from there to turn on alerts.' : 'This browser can’t show alerts.'));
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    const btn = h('button', {
      class: `btn sm ${sub ? 'ghost' : 'hot'}`,
      onclick: async () => {
        btn.disabled = true;
        try {
          if (sub) {
            await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
            await sub.unsubscribe();
            toast('Alerts off');
          } else {
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') throw new Error('Alerts were not allowed. You can change this in your phone settings.');
            const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(state.config.pushPublicKey) });
            await api('/push/subscribe', { method: 'POST', body: { subscription: s.toJSON() } });
            toast('Alerts on 🔔');
          }
        } catch (e) {
          toast(e.message);
        }
        renderPush();
      },
    }, sub ? 'Turn off' : 'Turn on');
    fill(pushBox, h('div', { class: 'row-between' }, h('div', {}, h('strong', {}, '🔔 Phone alerts'), h('p', { class: 'muted small' }, 'Home Safe check-ins, the photo drop, plans changing.')), btn));
  };

  const { form } = formOf(
    [h('div', { class: 'row' },
      h('label', { class: 'field emoji-field' }, 'Emoji', h('input', { name: 'emoji', maxlength: 8, value: state.user.emoji || '', class: 'emoji-in' })),
      h('label', { class: 'field grow' }, 'Display name', h('input', { name: 'displayName', maxlength: 40, value: state.user.name || '' })))],
    'Save',
    async (fd) => {
      const { user } = await api('/me', { method: 'PATCH', body: { displayName: fd.get('displayName'), emoji: fd.get('emoji') } });
      state.user = { ...state.user, ...user };
      toast('Saved');
    },
  );

  mount(shell({ tab: 'you' },
    head(state.user.isAdmin ? '👑 Admin' : '👋 You', `${state.user.emoji || ''} ${state.user.name}`, `@${state.user.username}`),
    h('div', { class: 'list' },
      h('div', { class: 'card' }, form),
      installHint(true),
      h('div', { class: 'card' }, pushBox),
      h('a', { class: 'card tile', href: '#/new' }, h('div', { class: 'e' }, '💡'), h('div', {}, h('strong', {}, 'Suggest a feature'), h('p', { class: 'small muted' }, 'Want a hangover bodega order thing? Ask. The group votes and Claude builds it.'))),
      h('a', { class: 'card tile', href: '#/ideas' }, h('div', { class: 'e' }, '🗳️'), h('div', {}, h('strong', {}, 'Suggestion Box'), h('p', { class: 'small muted' }, 'Vote on what gets built next.'))),
      h('a', { class: 'card tile', href: '#/you/suggestions' }, h('div', { class: 'e' }, '📬'), h('div', {}, h('strong', {}, 'My suggestions'), h('p', { class: 'small muted' }, 'Where yours are at, and Claude’s questions for you.'))),
      h('button', {
        class: 'btn block ghost',
        onclick: async () => {
          await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
          state.user = null;
          state.csrf = null;
          state.events?.close();
          go('/login');
        },
      }, 'Sign out'))));
  renderPush();
  if (query().get('alerts')) pushBox.scrollIntoView({ block: 'center' });
});

route('/notifications', async (_p, alive) => {
  const listEl = h('div', { class: 'list' });
  const load = async () => {
    const { notifications } = await api('/notifications');
    if (!alive()) return;
    fill(listEl,
      ...(notifications.length
        ? notifications.map((n) =>
            h('a', { class: `card notif ${n.read_at ? '' : 'unread'}`, href: n.link ? `#${n.link}` : n.request_id ? `#/requests/${n.request_id}` : '#/notifications' },
              h('span', { class: 'u' }), h('div', {}, h('div', {}, n.body), h('div', { class: 'when' }, ago(n.created_at)))))
        : [empty('🔕', 'All quiet', 'Plans, photo drops and Home Safe alerts show up here.')]));
  };
  await load();
  if (!alive()) return;
  setRefresh(load);
  const markAll = h('button', {
    class: 'btn sm ghost',
    onclick: async () => {
      const { unread } = await api('/notifications/read', { method: 'POST', body: {} });
      state.unread = unread;
      updateBell();
      load();
    },
  }, 'Mark all seen');
  mount(shell({ title: 'Updates', tab: null, back: '/tonight' }, h('div', { class: 'page-head row-between' }, h('h1', {}, 'Updates'), markAll), listEl));
});
