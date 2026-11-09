// Sign in, join with an invite code, and the first-run "add to Home Screen" screen.
import { state, api, h, mount, route, go, query, installHint, refreshMe, connectEvents, isStandalone } from '../core.js';

function authPage(mode) {
  return async () => {
    const isLogin = mode === 'login';
    const bootstrap = !isLogin && state.config?.needsBootstrap;
    const err = h('p', { class: 'error', role: 'alert' });
    const submit = h('button', { class: 'btn block hot', type: 'submit' }, isLogin ? 'Let me in' : 'Get in the Stall');
    const field = (label, input, sub) => h('label', { class: 'field' }, label, sub ? h('small', {}, sub) : null, input);
    const form = h(
      'form',
      {
        class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          submit.disabled = true;
          const fd = new FormData(form);
          try {
            const body = Object.fromEntries(fd);
            const data = await api(isLogin ? '/auth/login' : '/auth/signup', { method: 'POST', body });
            state.user = data.user;
            state.csrf = data.csrf;
            await refreshMe();
            connectEvents();
            go(isLogin ? query().get('next') || '/tonight' : '/welcome');
          } catch (e2) {
            err.textContent = e2.message;
            submit.disabled = false;
          }
        },
      },
      !isLogin
        ? field(bootstrap ? 'Setup code' : 'Invite code', h('input', { name: 'code', required: true, autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', value: query().get('code') || '', placeholder: bootstrap ? 'From STALL_BOOTSTRAP_CODE' : 'STALL-XXXX-XXXX-XX' }),
            bootstrap ? 'First account: use the setup code from the server. You become the admin.' : 'Whoever invited you has it. It works once.')
        : null,
      field('Username', h('input', { type: 'text', name: 'username', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', required: true, minlength: 3, maxlength: 32, placeholder: 'yourname' })),
      !isLogin ? field('What should we call you?', h('input', { name: 'displayName', maxlength: 40, placeholder: 'A nickname is fine' }), 'No real names needed.') : null,
      !isLogin ? field('Your emoji', h('input', { name: 'emoji', maxlength: 8, placeholder: '🦊', class: 'emoji-in' })) : null,
      field('Password', h('input', { type: 'password', name: 'password', autocomplete: isLogin ? 'current-password' : 'new-password', required: true, minlength: isLogin ? 1 : 8 }), !isLogin ? 'At least 8 characters' : null),
      err,
      submit,
    );
    mount(
      h('div', { class: 'auth' },
        h('div', { class: 'box' },
          h('div', { class: 'brand' },
            h('img', { src: '/icons/icon-192.png', alt: '' }),
            h('h1', {}, 'Meet me in', h('br'), h('em', {}, 'the Stall.')),
            h('p', {}, 'Invite-only. What happens here stays here.')),
          form,
          isLogin
            ? h('p', { class: 'switch' }, 'Got an invite? ', h('a', { href: '#/join' }, 'Join'))
            : h('p', { class: 'switch' }, 'Already in? ', h('a', { href: '#/login' }, 'Sign in')))));
  };
}
route('/login(?:\\?.*)?', authPage('login'), { public: true });
route('/join(?:\\?.*)?', authPage('join'), { public: true });
route('/signup(?:\\?.*)?', () => go('/join'), { public: true });

// First screen after redeeming an invite: Home Safe and the photo drop need push,
// and iPhone push only works from the Home Screen app.
route('/welcome', async () => {
  if (isStandalone()) return go('/you?alerts=1');
  mount(h('div', { class: 'auth' }, h('div', { class: 'box stack' },
    h('div', { class: 'brand' }, h('h1', {}, `You’re in, ${state.user.emoji || ''} ${state.user.name}.`), h('p', {}, 'One thing first: put Stall on your Home Screen. Home Safe check-ins and the morning photo drop only reach you from there.')),
    installHint(true),
    h('a', { class: 'btn block ghost', href: '#/tonight' }, 'Later'))));
});
