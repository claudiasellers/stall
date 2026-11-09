// Suggestion Box (the self-building loop) and the Admin tab: members, invites, house rules.
import {
  state, api, fill, h, icon, pill, sticker, confetti, ago, toast, mount, route, go, render, query, shell, updateBell,
  head, voteControl, consensusBar, requestCard, empty, setRefresh, formOf, who,
} from '../core.js';

// ---------------------------------------------------------------- views: ideas (vote)
let voteScope = 'proposed';
route('/ideas', async (_p, alive) => {
  const scopes = [
    ['proposed', '🗳️ Vote now'],
    ['active', '🔨 Happening'],
    ['done', '🎉 Live'],
  ];
  const listEl = h('div', { class: 'list' });
  const seg = h(
    'div',
    { class: 'seg', role: 'tablist' },
    scopes.map(([k, label]) =>
      h('button', { role: 'tab', class: voteScope === k ? 'on' : '', 'aria-selected': String(voteScope === k), onclick: () => { voteScope = k; render(); } }, label),
    ),
  );
  const load = async () => {
    const { requests } = await api(`/requests?scope=${voteScope}`);
    if (!alive()) return;
    const c = state.config?.consensus;
    const emptyState = {
      proposed: empty('💡', 'No ideas yet', 'Tap New idea to suggest the first one.'),
      active: empty('🛋️', 'Nothing in the works', 'Ideas show up here once they get enough votes.'),
      done: empty('🌱', 'Nothing live yet', 'Finished ideas will show up here.'),
    }[voteScope];
    fill(listEl,
      voteScope === 'proposed' && c?.minUpvotes > 0 && requests.length
        ? h('p', { class: 'muted small' }, `An idea gets built once ${c.minUpvotes} people want it and most votes are yes. Admins can also give it the green light.`)
        : null,
      ...(requests.length ? requests.map((r) => requestCard(r, { onChange: load, showVotes: voteScope !== 'done' })) : [emptyState]),
    );
  };
  await load();
  if (!alive()) return;
  setRefresh(load);
  mount(shell({ title: 'Suggestion Box', tab: state.user.isAdmin ? 'admin' : 'you', back: state.user.isAdmin ? '/admin' : '/you', fab: { label: 'Suggest', onclick: () => go('/new') } }, head('Suggestion Box', 'What should Claude build next?', 'Vote on what the group wants. Winners get built into Stall, usually that week.'), seg, listEl));
});

// ---------------------------------------------------------------- views: new
route('/new', async () => {
  const err = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'btn block hot', type: 'submit' }, 'Share my idea');
  const draftKey = 'stall:draft';
  let draft = {};
  try { draft = JSON.parse(localStorage.getItem(draftKey) || '{}'); } catch {}
  const form = h(
    'form',
    {
      class: 'stack',
      oninput: () => { try { localStorage.setItem(draftKey, JSON.stringify(Object.fromEntries(new FormData(form)))); } catch {} },
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        submit.disabled = true;
        const fd = new FormData(form);
        try {
          const { request } = await api('/requests', { method: 'POST', body: { title: fd.get('title'), description: fd.get('description') } });
          try { localStorage.removeItem(draftKey); } catch {}
          toast(request.status === 'queued' ? 'Shared! Claude will start on it soon.' : 'Shared! Now get people to vote 🗳️');
          go(`/requests/${request.id}`);
        } catch (e2) {
          err.textContent = e2.message;
          submit.disabled = false;
        }
      },
    },
    h('label', { class: 'field' }, 'Give it a name', h('small', {}, 'Short and catchy, like a headline'), h('input', { type: 'text', name: 'title', required: true, minlength: 3, maxlength: 140, value: draft.title || '', placeholder: 'A dark mode for night owls' })),
    h(
      'label',
      { class: 'field' },
      'Tell us about it',
      h('small', {}, 'What would you like to be able to do? Who is it for? Describe it like you would to a friend. Claude may ask you questions later.'),
      h('textarea', { name: 'description', required: true, minlength: 10, maxlength: 10000, rows: 7, placeholder: 'I use the app late at night and the bright screen hurts my eyes. It would be great if…' }, draft.description || ''),
    ),
    err,
    submit,
  );
  mount(shell({ title: 'Suggest a feature', tab: 'you', back: '/you' }, head('Suggest a feature', 'What do you wish Stall did?', 'The group votes, and Claude builds the winners.'), form));
  form.querySelector('input').focus();
});

// ---------------------------------------------------------------- views: building (board)
route('/admin/building', async (_p, alive) => {
  const wrap = h('div');
  const load = async () => {
    const b = await api('/board');
    if (!alive()) return;
    const byLane = new Map(b.working.filter((r) => r.lane).map((r) => [String(r.lane), r]));
    const laneIds = b.lanes.length ? b.lanes.map((l) => l.id) : ['1', '2', '3', '4', 'integration'];
    const reported = new Map(b.lanes.map((l) => [l.id, l]));
    const lanes = h(
      'div',
      { class: 'lanes' },
      laneIds.map((id) => {
        const rep = reported.get(id);
        const r = byLane.get(id) || (rep?.requestId ? b.working.find((x) => x.id === rep.requestId) : null);
        const st = b.orchestrator === 'offline' ? 'offline' : r ? 'working' : 'idle';
        const cls = `card lane ${st} ${id === 'integration' ? 'integration' : ''}`;
        const inner = [
          h('div', { class: 'h' }, id === 'integration' ? '✨ Final check' : `🛠️ Builder ${id}`, h('span', { class: 's', 'aria-label': st })),
          r ? h('div', { class: 'w' }, r.title) : h('div', { class: 'w idle' }, st === 'offline' ? 'Taking a break' : id === 'integration' ? 'Nothing to check right now' : 'Free'),
        ];
        return r ? h('a', { class: cls, href: `#/requests/${r.id}` }, inner) : h('div', { class: cls }, inner);
      }),
    );
    const waiting = b.working.filter((r) => r.status === 'needs_info' || (r.status === 'integrating' && r.lane !== 'integration'));
    fill(wrap,
      b.orchestrator !== 'online'
        ? h('div', { class: 'callout quiet' }, h('strong', {}, '😴 The builders are taking a break'), h('p', { class: 'small muted' }, 'Ideas stay in line and they will pick them up as soon as they are back.'))
        : null,
      lanes,
      waiting.length ? h('div', { class: 'section-h' }, h('h2', {}, 'Waiting on something')) : null,
      waiting.length ? h('div', { class: 'list' }, waiting.map((r) => requestCard(r, { showVotes: false }))) : null,
      h('div', { class: 'section-h' }, h('h2', {}, 'Up next'), h('span', { class: 'muted small' }, b.queue.length === 1 ? '1 in line' : `${b.queue.length} in line`)),
      b.queue.length
        ? h('div', { class: 'list' }, b.queue.map((r, i) => requestCard(r, { prefix: h('div', { class: 'qpos' }, i + 1) })))
        : empty('🧘', 'Nothing in line', 'Ideas with enough votes show up here.'),
    );
  };
  await load();
  if (!alive()) return;
  setRefresh(load);
  mount(shell({ title: 'Building', tab: 'admin', back: '/admin' }, head('Admin · Building', 'Being built right now', 'Claude works on up to four ideas at once, and every one gets a final check before it goes live.'), wrap));
});

// ---------------------------------------------------------------- views: mine
route('/you/suggestions', async (_p, alive) => {
  const listEl = h('div', { class: 'list' });
  const load = async () => {
    const { requests } = await api('/requests?scope=mine');
    if (!alive()) return;
    const ask = requests.filter((r) => r.status === 'needs_info');
    const rest = requests.filter((r) => r.status !== 'needs_info');
    fill(listEl,
      ...ask.map((r) => h('a', { class: 'callout', href: `#/requests/${r.id}` }, h('strong', {}, '🙋 Claude has a question for you'), h('span', {}, r.title), h('span', { class: 'small' }, 'Tap to answer →'))),
      ...(rest.length || ask.length ? rest.map((r) => requestCard(r, { onChange: load })) : [empty('✏️', 'No suggestions yet', 'Tap Suggest to ask for a feature.')]),
    );
  };
  await load();
  if (!alive()) return;
  setRefresh(load);
  mount(shell({ title: 'My suggestions', tab: 'you', back: '/you', fab: { label: 'Suggest', onclick: () => go('/new') } }, head('You', 'My suggestions'), listEl));
});

// ---------------------------------------------------------------- views: detail
const celebrated = new Set();
route('/requests/:id', async ({ id }, alive) => {
  const wrap = h('div', { class: 'detail' });
  let draft = '';
  const load = async () => {
    const focused = document.activeElement?.tagName === 'TEXTAREA';
    if (focused) return; // don't yank the composer out from under someone typing
    const { request: r, messages, can, admin } = await api(`/requests/${id}`);
    if (!alive()) return;
    state.unread = (await api('/me')).unread ?? state.unread;
    updateBell();
    if (r.status === 'done' && !celebrated.has(r.id)) {
      celebrated.add(r.id);
      setTimeout(confetti, 250);
    }

    const act = (label, path, cls = 'ghost', confirmText) =>
      h('button', {
        class: `btn sm ${cls}`,
        onclick: async () => {
          if (confirmText && !confirm(confirmText)) return;
          try {
            await api(`/requests/${r.id}/${path}`, { method: 'POST', body: {} });
            if (path === 'approve') confetti();
            load();
          } catch (e) {
            toast(e.message);
          }
        },
      }, label);

    const where =
      r.status === 'queued' && r.queuePosition ? `Number ${r.queuePosition} in line`
      : r.status === 'in_progress' ? 'Claude is building this right now'
      : r.status === 'integrating' ? 'Built! Getting a final check before it goes live'
      : r.status === 'proposed' ? r.consensus || 'Waiting on votes'
      : null;

    const timeline = h(
      'div',
      { class: 'timeline' },
      messages.map((m) =>
        h(
          'div',
          { class: `msg ${m.author} ${m.kind} ${m.adminOnly ? 'admin' : ''}` },
          m.author !== 'system' ? h('div', { class: 'who' }, m.adminOnly ? '🔧 Admin only · ' : '', m.author === 'claude' ? (m.kind === 'question' ? 'Claude asks' : 'Claude') : m.username || 'You', ' · ', ago(m.createdAt)) : null,
          h('div', { class: 'bubble' }, m.body),
        ),
      ),
    );

    let composer = null;
    if (can.reply || can.comment) {
      const ta = h('textarea', { rows: 2, placeholder: can.reply ? 'Type your answer…' : 'Add a note…', 'aria-label': can.reply ? 'Your answer' : 'Note', oninput: (e) => (draft = e.target.value) }, draft);
      const send = h('button', { class: `btn sm ${can.reply ? 'hot' : ''}`, type: 'submit' }, can.reply ? 'Send' : 'Add note');
      composer = h(
        'form',
        {
          class: `composer ${can.reply ? 'sticky' : ''}`,
          onsubmit: async (e) => {
            e.preventDefault();
            if (!ta.value.trim()) return;
            send.disabled = true;
            try {
              await api(`/requests/${r.id}/${can.reply ? 'reply' : 'comment'}`, { method: 'POST', body: { body: ta.value } });
              draft = '';
              ta.blur();
              if (can.reply) toast('Thanks! Claude will pick it back up 🙌');
              load();
            } catch (e2) {
              toast(e2.message);
              send.disabled = false;
            }
          },
        },
        ta,
        h('div', { class: 'row' }, h('span', { class: 'hint' }, can.reply ? 'Claude keeps going once you answer' : 'Only you, admins and Claude see notes'), send),
      );
    }

    const adminBox = admin
      ? h('details', { class: 'card adminbox' },
          h('summary', {}, '🔧 Admin details'),
          h('dl', { class: 'facts' },
            admin.branch ? [h('dt', {}, 'Branch'), h('dd', {}, h('code', {}, admin.branch))] : null,
            admin.lane ? [h('dt', {}, 'Lane'), h('dd', {}, admin.lane)] : null,
            admin.commit ? [h('dt', {}, 'Commit'), h('dd', {}, admin.commitUrl ? h('a', { href: admin.commitUrl, target: '_blank', rel: 'noopener' }, h('code', {}, admin.commit.slice(0, 10))) : h('code', {}, admin.commit.slice(0, 10)))] : null,
            admin.failureReason ? [h('dt', {}, 'Problem'), h('dd', {}, admin.failureReason)] : null,
            [h('dt', {}, 'Votes'), h('dd', {}, `${r.upvotes} yes · ${r.downvotes} no`)],
          ))
      : null;

    fill(wrap,
      h('div', { class: 'hero' },
        h('div', { class: 'row' }, sticker(r, true), r.canVote ? voteControl(r, load) : null),
        h('h1', {}, r.title),
        h('div', { class: 'meta' }, pill(r.status), h('span', {}, `${r.mine ? 'Your idea' : `${r.submitter}'s idea`} · ${ago(r.createdAt)}`)),
        consensusBar(r),
        where ? h('p', { class: 'muted small' }, where) : null,
      ),
      h('p', { class: 'desc' }, r.description),
      r.status === 'needs_info' && r.mine ? h('div', { class: 'callout' }, h('strong', {}, '🙋 Claude needs your help to keep going'), h('p', { class: 'small' }, 'Answer the question below. Your idea jumps to the front of the line as soon as you do.')) : null,
      r.summary ? h('div', { class: 'callout info' }, h('strong', {}, '🎉 What changed'), h('p', {}, r.summary)) : null,
      r.status === 'failed' ? h('div', { class: 'callout quiet' }, h('strong', {}, '😵 Claude got stuck on this one'), h('p', { class: 'small muted' }, 'An admin has been told and can try again.')) : null,
      can.approve || can.reject || can.cancel || can.retry
        ? h('div', { class: 'actions' },
            can.approve ? act('✅ Build it', 'approve', 'hot') : null,
            can.retry ? act('🔁 Try again', 'retry', '') : null,
            can.reject ? act('Pass on this', 'reject', 'danger', 'Pass on this idea? It will not be built.') : null,
            can.cancel ? act('Cancel', 'cancel', 'danger', 'Cancel this idea? If Claude is working on it, it will stop.') : null)
        : null,
      adminBox,
      h('div', { class: 'section-h' }, h('h2', {}, 'What’s happened')),
      timeline,
      composer,
    );
    if (r.status === 'needs_info' && can.reply) wrap.querySelector('.composer textarea')?.scrollIntoView({ block: 'center' });
  };
  await load();
  if (!alive()) return;
  setRefresh(load);
  mount(shell({ title: 'Suggestion', tab: null, back: '/ideas' }, wrap));
});


// ---------------------------------------------------------------- admin home
route('/admin', async () => {
  if (!state.user.isAdmin) return go('/you');
  const tile = (href, emoji, title, sub) => h('a', { class: 'card tile', href: `#${href}` }, h('div', { class: 'e' }, emoji), h('div', {}, h('strong', {}, title), h('p', { class: 'small muted' }, sub)));
  mount(shell({ tab: 'admin' }, head('👑 Admin', 'Run the Stall'),
    h('div', { class: 'list' },
      tile('/ideas', '🗳️', 'Suggestion Box', 'Feature requests, votes, approve or pass.'),
      tile('/admin/building', '🔨', 'Building', 'What Claude is building now, and Claude’s questions.'),
      tile('/admin/members', '🪪', 'Members & invites', 'Invite codes, admins, removing someone.'),
      tile('/admin/moderation', '🧹', 'Moderation', 'Remove posts or photos, lock threads, see vetoes.'),
      tile('/admin/house', '🏠', 'House rules', 'Photo drop hour, regret self-destruct, plus-one timer.'))));
});

// ---------------------------------------------------------------- members & invites
route('/admin/members', async () => {
  if (!state.user.isAdmin) return go('/you');
  const [{ members }, { invites }] = await Promise.all([api('/members'), api('/admin/invites')]);
  const fresh = h('div');
  const { form } = formOf(
    [h('label', { class: 'field' }, 'Who is it for?', h('small', {}, 'Just a note for you, like “Max”'), h('input', { name: 'note', maxlength: 80, placeholder: 'Max' })),
     h('label', { class: 'field' }, 'Expires after', h('select', { name: 'ttlDays' }, h('option', { value: '1' }, '1 day'), h('option', { value: '7', selected: true }, '7 days'), h('option', { value: '30' }, '30 days')))],
    'Make an invite code',
    async (fd) => {
      const { invite } = await api('/admin/invites', { method: 'POST', body: { note: fd.get('note'), ttlDays: Number(fd.get('ttlDays')) } });
      const share = async () => {
        const text = `You're invited to the Stall. Code: ${invite.code}\n${invite.link}`;
        try {
          if (navigator.share) await navigator.share({ text });
          else { await navigator.clipboard.writeText(text); toast('Copied'); }
        } catch {}
      };
      fill(fresh, h('div', { class: 'callout' }, h('strong', {}, '🎟️ Single-use invite, shown once'), h('code', { class: 'code' }, invite.code),
        h('p', { class: 'small' }, `Works once, until ${new Date(invite.expiresAt).toLocaleDateString()}.`), h('button', { class: 'btn sm hot', type: 'button', onclick: share }, 'Share')));
    },
  );
  const removeBtn = (m) => h('button', {
    class: 'btn sm danger',
    onclick: async () => {
      const choice = prompt(`Remove ${m.name}? Type what happens to their posts and photos:\n\nkeep · anonymize · delete`, 'anonymize');
      if (!choice) return;
      try {
        await api(`/admin/members/${m.id}/remove`, { method: 'POST', body: { policy: choice.trim().toLowerCase() } });
        toast(`${m.name} is out`);
        render();
      } catch (e) { toast(e.message); }
    },
  }, 'Remove');
  const adminBtn = (m) => h('button', {
    class: `btn sm ${m.isAdmin ? 'ghost' : ''}`,
    onclick: async () => {
      try { await api(`/admin/users/${m.id}/admin`, { method: 'POST', body: { isAdmin: !m.isAdmin } }); render(); } catch (e) { toast(e.message); }
    },
  }, m.isAdmin ? '👑 Admin' : 'Make admin');
  mount(shell({ title: 'Members', tab: 'admin', back: '/admin' },
    head('Admin', 'Members & invites', 'Stall is invite-only. Each code works once and expires.'),
    h('div', { class: 'list' },
      h('div', { class: 'card stack' }, form, fresh),
      h('div', { class: 'section-h' }, h('h2', {}, `The group · ${members.length}`)),
      ...members.map((m) => h('div', { class: 'card row-between' }, h('span', {}, who(m), m.id === state.user.id ? h('span', { class: 'muted' }, ' (you)') : null),
        m.id === state.user.id ? null : h('div', { class: 'row' }, adminBtn(m), removeBtn(m)))),
      h('div', { class: 'section-h' }, h('h2', {}, 'Invites')),
      invites.length ? invites.map((i) => h('div', { class: 'card row-between' },
        h('div', {}, h('strong', {}, i.note || 'Invite'), h('p', { class: 'small muted' }, i.status === 'used' ? `Used by ${i.usedBy}` : `${i.status} · made by ${i.createdBy || '?'} · ${ago(i.createdAt)}`)),
        i.status === 'active' ? h('button', { class: 'btn sm ghost', onclick: async () => { await api(`/admin/invites/${i.id}/revoke`, { method: 'POST', body: {} }).catch((e) => toast(e.message)); render(); } }, 'Revoke') : null))
        : empty('🎟️', 'No invites yet', 'Make one above and send it to a friend.'))));
});

// ---------------------------------------------------------------- house rules
const HOUSE_FIELDS = [
  ['photoUnlockHour', 'Photo drop hour', 'Last night’s photos unlock at this hour (0–23).'],
  ['regretTtlHours', 'Regret self-destruct (hours)', 'Default for new regrets. 0 keeps them.'],
  ['plusOneVoteMinutes', 'Plus-one vote timer (minutes)', ''],
  ['plusOneMinYes', 'Plus-one: yes votes needed', ''],
  ['locationRevealHours', 'Address drop (hours before start)', '0 shows the address right away.'],
  ['spontaneousHours', '“Out right now” lifespan (hours)', ''],
  ['forgiveThreshold', '🙏 needed to forgive a regret', ''],
];
route('/admin/house', async () => {
  if (!state.user.isAdmin) return go('/you');
  const { house, tz } = await api('/house');
  const { form } = formOf(
    HOUSE_FIELDS.map(([k, label, sub]) => h('label', { class: 'field' }, label, sub ? h('small', {}, sub) : null, h('input', { name: k, type: 'number', inputmode: 'numeric', value: String(house[k]) }))),
    'Save house rules',
    async (fd) => {
      const body = Object.fromEntries(HOUSE_FIELDS.map(([k]) => [k, Number(fd.get(k))]));
      await api('/admin/house', { method: 'PATCH', body });
      toast('Saved');
    },
  );
  mount(shell({ title: 'House rules', tab: 'admin', back: '/admin' }, head('Admin', 'House rules', `Times are in ${tz}.`), h('div', { class: 'card' }, form)));
});
