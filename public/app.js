// Meridian Hire pipeline board. Plain JavaScript, no build step. Everything it
// shows comes from the public API with a sandbox key, so the board is an
// honest demo of what any client could build on top.
'use strict';

const STORE_KEY = 'meridian-hire.sandbox';
const STAGES = [
  ['applied', 'Applied'],
  ['screen', 'Screen'],
  ['interview', 'Interview'],
  ['offer', 'Offer'],
  ['hired', 'Hired'],
  ['rejected', 'Rejected'],
];
const STAGE_LABEL = Object.fromEntries(STAGES);
const ACTIVE = ['applied', 'screen', 'interview', 'offer'];

// Mirrors the server's rules (src/routes/applications.ts) so the drawer can
// grey out moves that would be refused. The server still has the final say.
function allowedMoves(from) {
  if (!ACTIVE.includes(from)) return [];
  return [...ACTIVE.filter((s) => s !== from), ...(from === 'offer' ? ['hired'] : []), 'rejected'];
}

const $ = (id) => document.getElementById(id);
const state = { sandbox: null, jobs: [], apps: [], filters: { job: '', q: '' }, selected: null, webhookId: null };

// Small DOM helper. All text goes through textContent, never innerHTML,
// because sandbox data is typed in by strangers.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// Storage can be blocked (private windows), so every access is guarded.
const store = {
  get() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      return v && new Date(v.expires_at) > new Date() ? v : null;
    } catch {
      return null;
    }
  },
  set(v) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(v));
    } catch {}
  },
  clear() {
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {}
  },
};

class ApiError extends Error {
  constructor(status, body) {
    super(body?.detail || `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${state.sandbox.api_key}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, { detail: 'The network request failed. Check your connection.' });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

async function listAll(path) {
  const out = [];
  let cursor = null;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const page = await api(`${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...page.data);
    cursor = page.next_cursor;
  } while (cursor && out.length < 1000);
  return out;
}

// URL state: #board?job=…&q=…&app=…  Reload, back and shared links land on the same view.
function readHash() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  state.filters.job = params.get('job') || '';
  state.filters.q = params.get('q') || '';
  state.selected = params.get('app') || null;
}
function writeHash(replace = false) {
  const params = new URLSearchParams();
  if (state.filters.job) params.set('job', state.filters.job);
  if (state.filters.q) params.set('q', state.filters.q);
  if (state.selected) params.set('app', state.selected);
  const next = `#board${params.toString() ? `?${params}` : ''}`;
  if (next === location.hash) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', next);
}

let toastTimer;
function toast(message, kind = '') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), kind === 'error' ? 6000 : 3500);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
function daysSince(iso) {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? 'today' : `${d}d`;
}

// Guide: four things to try, ticked off as the visitor does them. Progress is
// kept per sandbox in this browser only.
const GUIDE_KEY = 'meridian-hire.guide';
const GUIDE_STEPS = [
  ['add', 'Add a candidate', 'the way they would apply, with a résumé if you have one to hand.'],
  ['move', 'Move someone forward', 'drag a card to another column, or open it and pick a stage.'],
  [
    'webhook',
    'Watch the webhook arrive',
    'in “What the API recorded”: each change is signed and sent to the firm’s own software.',
  ],
  ['erase', 'Erase a candidate', 'open one and remove them with their files, as a privacy request requires.'],
];
const guide = {
  read() {
    try {
      const v = JSON.parse(localStorage.getItem(GUIDE_KEY) || 'null');
      if (v && v.company === state.sandbox?.company?.id) return v;
    } catch {}
    return { company: state.sandbox?.company?.id, done: [], hidden: false };
  },
  write(v) {
    try {
      localStorage.setItem(GUIDE_KEY, JSON.stringify(v));
    } catch {}
  },
  tick(step) {
    const v = this.read();
    if (v.done.includes(step)) return;
    v.done.push(step);
    this.write(v);
    renderGuide();
  },
  setHidden(hidden) {
    this.write({ ...this.read(), hidden });
    renderGuide();
  },
};

function renderGuide() {
  const v = guide.read();
  $('guide').hidden = v.hidden;
  $('guide-show').hidden = !v.hidden;
  $('guide-steps').replaceChildren(
    ...GUIDE_STEPS.map(([id, title, detail]) => {
      const done = v.done.includes(id);
      return h(
        'li',
        { class: done ? 'done' : '' },
        h('span', { class: 'tick', 'aria-hidden': 'true' }, done ? '✓' : ''),
        h('span', {}, h('strong', {}, title), ` ${detail}`, done ? h('span', { class: 'sr-only' }, ' (done)') : ''),
      );
    }),
  );
}

// Views ----------------------------------------------------------------------------

function show(view) {
  for (const id of ['welcome', 'board-view', 'fatal']) $(id).hidden = id !== view;
  $('sample-pill').hidden = view !== 'board-view';
  $('restart').hidden = view !== 'board-view';
}

function showFatal(err, retry) {
  show('fatal');
  $('fatal-title').textContent = err.status === 429 ? 'Slow down a moment' : "Couldn't reach the API";
  $('fatal-detail').textContent = err.message;
  $('retry').onclick = retry;
}

async function createSandbox() {
  const btn = $('start');
  btn.disabled = true;
  btn.textContent = 'Setting up your sandbox…';
  try {
    const sb = await api('/v1/sandbox', { method: 'POST', auth: false });
    state.sandbox = sb;
    store.set(sb);
    state.filters = { job: '', q: '' };
    state.selected = null;
    writeHash(true);
    await loadBoard();
  } catch (err) {
    $('welcome-note').textContent = err.message;
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Open a demo board';
  }
}

function renderSkeleton() {
  $('kpis').replaceChildren(...[0, 1, 2, 3].map(() => h('div', { class: 'kpi' }, h('div', { class: 'skel tall' }))));
  $('board').replaceChildren(
    ...STAGES.map(([, label]) =>
      h(
        'div',
        { class: 'col' },
        h('div', { class: 'col-head' }, label),
        h('div', { class: 'cards' }, h('div', { class: 'skel' }), h('div', { class: 'skel' })),
      ),
    ),
  );
}

async function loadBoard() {
  show('board-view');
  renderSkeleton();
  const { job, q } = state.filters;
  const qs = new URLSearchParams();
  if (job) qs.set('job_id', job);
  if (q) qs.set('q', q);
  try {
    const [me, jobs, apps] = await Promise.all([
      api('/v1/me'),
      listAll('/v1/jobs?status=open'),
      listAll(`/v1/applications${qs.toString() ? `?${qs}` : ''}`),
    ]);
    state.jobs = jobs;
    state.apps = apps;
    $('company-name').textContent = me.company.name.replace(/ \(sandbox\)$/, '');
    const hours = Math.max(0, Math.round((new Date(me.company.expires_at) - Date.now()) / 3600000));
    $('expires').textContent = `sandbox · deleted in ${hours} h`;
    renderFilters();
    renderKpis();
    renderBoard();
    renderGuide();
    loadActivity();
    if (state.selected) openDrawer(state.selected, { push: false });
  } catch (err) {
    if (err.status === 401) {
      store.clear();
      state.sandbox = null;
      show('welcome');
      $('welcome-note').textContent = 'Your last sandbox has expired. Open a new one to keep exploring.';
      return;
    }
    showFatal(err, loadBoard);
  }
}

function renderFilters() {
  const sel = $('job-filter');
  sel.replaceChildren(
    h('option', { value: '' }, 'All open jobs'),
    ...state.jobs.map((j) => h('option', { value: j.id }, j.title)),
  );
  sel.value = state.jobs.some((j) => j.id === state.filters.job) ? state.filters.job : '';
  if ($('search').value !== state.filters.q) $('search').value = state.filters.q;
  const filtered = Boolean(state.filters.job || state.filters.q);
  $('clear').disabled = !filtered;
  $('clear').title = filtered ? '' : 'No filters are set';
  $('export').disabled = state.apps.length === 0;
  $('export').title = state.apps.length ? '' : 'Nothing to export under these filters';
  const jobTitle = state.jobs.find((j) => j.id === state.filters.job)?.title;
  $('readout').textContent =
    `Showing ${state.apps.length} application${state.apps.length === 1 ? '' : 's'}${jobTitle ? ` for ${jobTitle}` : ''}${state.filters.q ? ` matching “${state.filters.q}”` : ''}`;
}

function renderKpis() {
  const count = (stages) => state.apps.filter((a) => stages.includes(a.stage)).length;
  const scope = state.filters.job || state.filters.q ? 'under current filters' : 'across all jobs';
  const tiles = [
    ['In progress', count(ACTIVE), `applied to offer, ${scope}`],
    ['Interviewing', count(['interview']), 'in the interview stage'],
    ['Offers out', count(['offer']), 'waiting on an answer'],
    ['Hired', count(['hired']), 'offers accepted'],
  ];
  $('kpis').replaceChildren(
    ...tiles.map(([label, value, note]) =>
      h(
        'div',
        { class: 'kpi' },
        h('div', { class: 'label' }, label),
        h('div', { class: 'value' }, value.toLocaleString()),
        h('div', { class: 'note' }, note),
      ),
    ),
  );
}

let dragging = null;

function renderBoard() {
  const byStage = Object.fromEntries(STAGES.map(([s]) => [s, []]));
  for (const a of state.apps) byStage[a.stage].push(a);
  const anyFilter = state.filters.job || state.filters.q;
  if (state.apps.length === 0) {
    $('board').replaceChildren(
      h(
        'div',
        { class: 'state span-all' },
        h('strong', {}, anyFilter ? 'No applications match these filters' : 'No applications yet'),
        anyFilter
          ? 'Try another job or a different search.'
          : 'Add one with “Add candidate”, or with POST /v1/applications in the API docs.',
        h('br'),
        anyFilter
          ? h('button', { class: 'btn', type: 'button', onclick: clearFilters }, 'Clear filters')
          : h('a', { class: 'btn', href: '/docs' }, 'Open the API docs'),
      ),
    );
    return;
  }
  $('board').replaceChildren(
    ...STAGES.map(([stage, label]) => {
      const items = byStage[stage].sort((a, b) => new Date(b.stage_changed_at) - new Date(a.stage_changed_at));
      const col = h(
        'section',
        { class: 'col', 'data-stage': stage, 'aria-label': `${label}, ${items.length}` },
        h('div', { class: 'col-head' }, h('span', {}, label), h('span', { class: 'count' }, items.length)),
        h(
          'div',
          { class: 'cards' },
          items.length
            ? items.map((a) =>
                h(
                  'button',
                  {
                    class: 'card',
                    type: 'button',
                    draggable: 'true',
                    'data-id': a.id,
                    'aria-current': a.id === state.selected ? 'true' : false,
                    'aria-label': `${a.candidate.first_name} ${a.candidate.last_name}, ${a.job.title}, ${label}. Open details`,
                    onclick: () => openDrawer(a.id),
                    ondragstart: (e) => {
                      dragging = a;
                      e.dataTransfer.effectAllowed = 'move';
                      e.currentTarget.classList.add('dragging');
                    },
                    ondragend: (e) => {
                      dragging = null;
                      e.currentTarget.classList.remove('dragging');
                      clearDropHints();
                    },
                  },
                  h('div', { class: 'name' }, `${a.candidate.first_name} ${a.candidate.last_name}`),
                  h('div', { class: 'job' }, a.job.title),
                  h(
                    'div',
                    { class: 'meta' },
                    h('span', {}, `in stage ${daysSince(a.stage_changed_at)}`),
                    h('span', {}, dateFmt.format(new Date(a.created_at))),
                  ),
                ),
              )
            : h('div', { class: 'col-empty' }, 'Nobody here'),
        ),
      );
      col.addEventListener('dragover', (e) => {
        if (!dragging || dragging.stage === stage) return;
        e.preventDefault();
        col.classList.toggle('drop', allowedMoves(dragging.stage).includes(stage));
      });
      col.addEventListener('dragleave', () => col.classList.remove('drop'));
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        clearDropHints();
        if (dragging && dragging.stage !== stage) moveStage(dragging, stage);
      });
      return col;
    }),
  );
}

function clearDropHints() {
  for (const c of document.querySelectorAll('.col.drop')) c.classList.remove('drop');
}

async function moveStage(app, to, note) {
  try {
    const updated = await api(`/v1/applications/${app.id}/stage`, {
      method: 'POST',
      body: { to, ...(note ? { note } : {}) },
    });
    const i = state.apps.findIndex((a) => a.id === app.id);
    if (i >= 0) state.apps[i] = updated;
    renderKpis();
    renderBoard();
    toast(`${updated.candidate.first_name} moved to ${STAGE_LABEL[to]}. Saved to history and sent to the webhook.`);
    guide.tick('move');
    setTimeout(loadActivity, 800);
    if (state.selected === app.id) openDrawer(app.id, { push: false });
    return true;
  } catch (err) {
    // The API explains refusals in plain words (e.g. "Can't move from applied to hired").
    toast(err.message, 'error');
    return false;
  }
}

// Activity feed: audit log plus webhook delivery results.
const ACTIONS = {
  'sandbox.created': () => 'Sandbox created with sample data',
  'job.created': (e) => `Job posted${e.metadata.title ? `: ${e.metadata.title}` : ''}`,
  'job.updated': () => 'Job updated',
  'job.deleted': () => 'Job deleted',
  'candidate.created': () => 'Candidate added',
  'candidate.updated': () => 'Candidate details changed',
  'candidate.erased': (e) =>
    `Candidate erased with ${plural(e.metadata.applications_deleted, 'application')} and ${plural(e.metadata.resumes_deleted, 'file')}`,
  'application.created': () => 'New application',
  'application.stage_changed': (e) =>
    `Application moved from ${STAGE_LABEL[e.metadata.from]} to ${STAGE_LABEL[e.metadata.to]}`,
  'resume.uploaded': () => 'Résumé uploaded',
  'resume.downloaded': () => 'Résumé opened (private 5-minute link)',
  'resume.deleted': () => 'Résumé deleted',
  'webhook.created': () => 'Webhook endpoint added',
  'webhook.updated': () => 'Webhook endpoint changed',
  'webhook.deleted': () => 'Webhook endpoint removed',
  'webhook.tested': () => 'Test webhook sent',
  'api_key.created': () => 'API key created',
  'api_key.revoked': () => 'API key revoked',
};

async function loadActivity() {
  const feed = $('feed');
  if (!feed.children.length) feed.replaceChildren(...[0, 1, 2].map(() => h('li', {}, h('div', { class: 'skel row' }))));
  try {
    if (!state.webhookId) {
      const hooks = await api('/v1/webhooks');
      state.webhookId = hooks.data[0]?.id ?? null;
    }
    const [log, deliveries] = await Promise.all([
      api('/v1/audit-log?limit=12'),
      state.webhookId ? api(`/v1/webhooks/${state.webhookId}/deliveries?limit=8`) : { data: [] },
    ]);
    if (deliveries.data.some((d) => d.status === 'succeeded' && d.event_type !== 'ping')) guide.tick('webhook');
    const items = [
      ...log.data.map((e) => ({
        at: e.created_at,
        what: (ACTIONS[e.action] || (() => e.action))(e),
        who: e.actor.startsWith('system') ? 'system' : 'your key',
      })),
      ...deliveries.data.map((d) => ({
        at: d.last_attempt_at || d.created_at,
        what: `Webhook sent to the demo receiver: ${{ 'application.created': 'new application', 'application.stage_changed': 'stage change', ping: 'test ping' }[d.event_type] || d.event_type}`,
        badge:
          d.status === 'succeeded'
            ? ['ok', `delivered · ${d.last_status_code}`]
            : d.status === 'failed'
              ? ['bad', 'failed']
              : ['wait', `retrying · attempt ${d.attempts}`],
      })),
    ]
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, 14);
    feed.replaceChildren(
      ...(items.length
        ? items.map((i) =>
            h(
              'li',
              {},
              h('span', { class: 'what' }, i.what),
              h(
                'span',
                { class: 'when' },
                timeFmt.format(new Date(i.at)),
                i.who ? ` · ${i.who}` : '',
                i.badge ? ' · ' : '',
                i.badge ? h('span', { class: `badge ${i.badge[0]}` }, i.badge[1]) : '',
              ),
            ),
          )
        : [h('li', { class: 'muted' }, 'Nothing recorded yet.')]),
    );
  } catch (err) {
    feed.replaceChildren(
      h(
        'li',
        {},
        h('span', { class: 'what' }, "Couldn't load activity"),
        h('span', { class: 'when' }, err.message),
        h('button', { class: 'btn small', type: 'button', onclick: loadActivity }, 'Retry'),
      ),
    );
  }
}

// Drawer ------------------------------------------------------------------------------

let lastFocus = null;

async function openDrawer(id, { push = true } = {}) {
  const app = state.apps.find((a) => a.id === id);
  if (!app) {
    state.selected = null;
    writeHash(true);
    return;
  }
  if ($('drawer').hidden) lastFocus = document.activeElement;
  state.selected = id;
  if (push) writeHash();
  for (const c of document.querySelectorAll('.card'))
    c.setAttribute('aria-current', c.dataset.id === id ? 'true' : 'false');
  const drawer = $('drawer');
  const name = `${app.candidate.first_name} ${app.candidate.last_name}`;
  drawer.replaceChildren(
    h(
      'div',
      { class: 'drawer-head' },
      h(
        'div',
        {},
        h('h2', { id: 'drawer-title' }, name),
        h('div', { class: 'muted' }, `${app.job.title} · ${STAGE_LABEL[app.stage]}`),
      ),
      h('button', { class: 'btn small', type: 'button', onclick: closeDrawer }, 'Close'),
    ),
    h('div', { class: 'skel block' }),
  );
  drawer.hidden = false;
  $('scrim').hidden = false;
  drawer.querySelector('button').focus();

  try {
    const [candidate, history, resumes] = await Promise.all([
      api(`/v1/candidates/${app.candidate_id}`),
      api(`/v1/applications/${id}/history`),
      api(`/v1/candidates/${app.candidate_id}/resumes`),
    ]);
    if (state.selected !== id) return;
    const current = state.apps.find((a) => a.id === id) || app;
    const allowed = allowedMoves(current.stage);
    const noteInput = h('input', {
      class: 'field full',
      id: 'move-note',
      type: 'text',
      maxlength: '1000',
      placeholder: 'Add a note to the history (optional)',
    });
    drawer.replaceChildren(
      ...[
        drawer.firstChild,
        h(
          'dl',
          { class: 'dl' },
          h('dt', {}, 'Email'),
          h('dd', {}, candidate.email),
          h('dt', {}, 'Phone'),
          h('dd', { class: 'mono' }, candidate.phone || '—'),
          h('dt', {}, 'Location'),
          h('dd', {}, candidate.location || '—'),
          h('dt', {}, 'Source'),
          h('dd', {}, (candidate.source || '—').replace(/_/g, ' ')),
          h('dt', {}, 'Applied'),
          h('dd', { class: 'mono' }, current.created_at.slice(0, 10)),
        ),
        h('div', { class: 'section-title' }, 'Move to'),
        allowed.length
          ? [
              noteInput,
              h(
                'div',
                { class: 'moves' },
                STAGES.filter(([s]) => s !== current.stage).map(([s, label]) =>
                  h(
                    'button',
                    {
                      class: 'btn small',
                      type: 'button',
                      disabled: !allowed.includes(s),
                      title: allowed.includes(s)
                        ? ''
                        : s === 'hired'
                          ? 'Only an offer can become a hire'
                          : 'Not allowed from this stage',
                      onclick: async (e) => {
                        e.currentTarget.disabled = true;
                        await moveStage(current, s, noteInput.value.trim());
                      },
                    },
                    label,
                  ),
                ),
              ),
            ]
          : h(
              'p',
              { class: 'muted' },
              `${STAGE_LABEL[current.stage]} is a final stage, so this application can't move any more.`,
            ),
        h('div', { class: 'section-title' }, 'Résumé'),
        h(
          'div',
          { class: 'moves' },
          resumes.data.map((r) =>
            h('button', { class: 'btn small', type: 'button', onclick: () => openResume(r.id) }, `Open ${r.file_name}`),
          ),
          resumeUploader(candidate.id, id),
        ),
        ...(resumes.data.length
          ? []
          : [h('p', { class: 'muted' }, 'None yet. Upload a PDF or Word file, up to 1 MB in a sandbox.')]),
        h('div', { class: 'section-title' }, 'Stage history'),
        h(
          'ol',
          { class: 'timeline' },
          history.data.map((e) =>
            h(
              'li',
              {},
              h('div', {}, e.from_stage ? `${STAGE_LABEL[e.from_stage]} → ${STAGE_LABEL[e.to_stage]}` : `Applied`),
              h(
                'div',
                { class: 'when' },
                `${timeFmt.format(new Date(e.changed_at))} · ${e.changed_by.startsWith('system') ? 'sample data' : 'your key'}`,
              ),
              e.note ? h('div', { class: 'note' }, e.note) : null,
            ),
          ),
        ),
        h('div', { class: 'section-title' }, 'Privacy'),
        eraseControl(candidate),
      ].flat(),
    );
  } catch (err) {
    drawer.replaceChildren(
      drawer.firstChild,
      h(
        'div',
        { class: 'state' },
        h('strong', {}, "Couldn't load this application"),
        err.message,
        h('br'),
        h('button', { class: 'btn', type: 'button', onclick: () => openDrawer(id, { push: false }) }, 'Retry'),
      ),
    );
  }
}

async function openResume(id) {
  // Open the tab first so pop-up blockers allow it, then point it at the private link.
  const tab = window.open('about:blank', '_blank');
  if (tab) tab.opener = null;
  try {
    const link = await api(`/v1/resumes/${id}/download`);
    if (tab) tab.location = link.url;
    else location.href = link.url;
    setTimeout(loadActivity, 500);
  } catch (err) {
    tab?.close();
    toast(err.message, 'error');
  }
}

const RESUME_TYPES =
  '.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const SANDBOX_RESUME_BYTES = 1024 * 1024;

async function uploadResume(candidateId, file) {
  if (file.size > SANDBOX_RESUME_BYTES) throw new ApiError(413, { detail: 'Sandbox résumés can be up to 1 MB.' });
  const form = new FormData();
  form.append('file', file);
  let res;
  try {
    res = await fetch(`/v1/candidates/${candidateId}/resumes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.sandbox.api_key}` },
      body: form,
    });
  } catch {
    throw new ApiError(0, { detail: 'The upload failed. Check your connection.' });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

function resumeUploader(candidateId, appId) {
  const input = h('input', {
    type: 'file',
    accept: RESUME_TYPES,
    class: 'sr-only',
    tabindex: '-1',
    'aria-hidden': 'true',
  });
  const btn = h('button', { class: 'btn small', type: 'button', onclick: () => input.click() }, 'Upload résumé');
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    try {
      await uploadResume(candidateId, file);
      toast(`${file.name} stored privately. It only opens through a link that expires in 5 minutes.`);
      setTimeout(loadActivity, 300);
      if (state.selected === appId) openDrawer(appId, { push: false });
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Upload résumé';
    }
  });
  return [input, btn];
}

// Erasure takes two clicks: the first explains what goes, the second does it.
function eraseControl(candidate) {
  const name = `${candidate.first_name} ${candidate.last_name}`;
  const box = h('div', { class: 'erase' });
  const idle = () =>
    box.replaceChildren(
      h('p', { class: 'muted' }, 'For privacy requests: removes this person, their applications and their files.'),
      h('button', { class: 'btn small danger-outline', type: 'button', onclick: ask }, 'Erase candidate…'),
    );
  const ask = () => {
    box.replaceChildren(
      h('p', {}, `Erase ${name}? Every application they made and their résumé files go too. This can't be undone.`),
      h(
        'div',
        { class: 'moves' },
        h(
          'button',
          { class: 'btn small danger', type: 'button', onclick: erase },
          `Yes, erase ${candidate.first_name}`,
        ),
        h('button', { class: 'btn small', type: 'button', onclick: idle }, 'Cancel'),
      ),
    );
    box.querySelector('.danger').focus();
  };
  async function erase(e) {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api(`/v1/candidates/${candidate.id}`, { method: 'DELETE' });
      const gone = state.apps.filter((a) => a.candidate_id === candidate.id).length;
      state.apps = state.apps.filter((a) => a.candidate_id !== candidate.id);
      closeDrawer();
      renderFilters();
      renderKpis();
      renderBoard();
      toast(
        `${name} erased, with ${gone} application${gone === 1 ? '' : 's'} and their files. The erasure is in the audit log.`,
      );
      guide.tick('erase');
      setTimeout(loadActivity, 300);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  }
  idle();
  return box;
}

// Add a candidate: the same request a careers page or job board would send.
const SOURCES = [
  ['', 'Not recorded'],
  ['careers_page', 'Careers page'],
  ['referral', 'Referral'],
  ['linkedin', 'LinkedIn'],
  ['job_board', 'Job board'],
  ['agency', 'Agency'],
];
const FIELD_LABEL = {
  job_id: 'Job',
  'candidate.first_name': 'First name',
  'candidate.last_name': 'Last name',
  'candidate.email': 'Email',
  note: 'Note',
};

function openAddForm() {
  if ($('drawer').hidden) lastFocus = document.activeElement;
  state.selected = null;
  writeHash();
  const drawer = $('drawer');
  const head = h(
    'div',
    { class: 'drawer-head' },
    h('div', {}, h('h2', { id: 'drawer-title' }, 'Add a candidate'), h('div', { class: 'muted' }, 'A new application')),
    h('button', { class: 'btn small', type: 'button', onclick: closeDrawer }, 'Close'),
  );
  const row = (label, input, hint) =>
    h(
      'label',
      { class: 'form-row' },
      h('span', { class: 'form-label' }, label),
      input,
      hint ? h('span', { class: 'form-hint' }, hint) : null,
    );
  const text = (name, attrs = {}) =>
    h('input', { class: 'field full', name, type: 'text', maxlength: '100', autocomplete: 'off', ...attrs });
  const first = text('first_name', { required: true });
  const last = text('last_name', { required: true });
  const email = text('email', { type: 'email', maxlength: '254', required: true });
  const job = h(
    'select',
    { class: 'field full', name: 'job_id', required: true },
    state.jobs.map((j) => h('option', { value: j.id }, j.title)),
  );
  if (state.jobs.some((j) => j.id === state.filters.job)) job.value = state.filters.job;
  const source = h(
    'select',
    { class: 'field full', name: 'source' },
    SOURCES.map(([v, l]) => h('option', { value: v }, l)),
  );
  const file = h('input', { class: 'field full file', name: 'resume', type: 'file', accept: RESUME_TYPES });
  const note = h('textarea', { class: 'field full', name: 'note', maxlength: '1000', rows: '2' });
  const errors = h('div', { class: 'form-errors', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Add application');

  if (!state.jobs.length) {
    drawer.replaceChildren(head, h('p', { class: 'muted' }, 'There are no open jobs to apply to in this sandbox.'));
  } else {
    const form = h(
      'form',
      { class: 'form', novalidate: true },
      h(
        'p',
        { class: 'muted' },
        'This is what a careers page or job board sends when someone applies. It lands in Applied, is saved to the history, and a webhook goes out.',
      ),
      row('First name', first),
      row('Last name', last),
      row('Email', email, 'An email that has applied before is matched to the same person.'),
      row('Job', job),
      row('Where they came from', source),
      row('Résumé (optional)', file, 'PDF or Word, up to 1 MB here. It is stored privately.'),
      row('Note (optional)', note),
      errors,
      h('div', { class: 'moves' }, submit),
    );
    const fields = { 'candidate.first_name': first, 'candidate.last_name': last, 'candidate.email': email };
    const showErrors = (title, items) => {
      for (const el of Object.values(fields)) el.removeAttribute('aria-invalid');
      for (const [path] of items) fields[path]?.setAttribute('aria-invalid', 'true');
      errors.replaceChildren(
        h('strong', {}, title),
        ...(items.length
          ? [
              h(
                'ul',
                {},
                items.map(([, text]) => h('li', {}, text)),
              ),
            ]
          : []),
      );
      errors.hidden = false;
      (items.length ? fields[items[0][0]] : null)?.focus();
    };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errors.hidden = true;
      const resume = file.files?.[0];
      const candidate = {
        first_name: first.value.trim(),
        last_name: last.value.trim(),
        email: email.value.trim(),
        ...(source.value ? { source: source.value } : {}),
      };
      // The API checks all of this too; checking here first gives plain-English messages.
      const missing = [];
      if (!candidate.first_name) missing.push(['candidate.first_name', 'Enter a first name.']);
      if (!candidate.last_name) missing.push(['candidate.last_name', 'Enter a last name.']);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate.email))
        missing.push(['candidate.email', 'Enter a valid email address, like name@company.com.']);
      if (missing.length) return showErrors('Please fix these before adding the application:', missing);
      if (resume && resume.size > SANDBOX_RESUME_BYTES)
        return showErrors('That résumé is over 1 MB, the sandbox limit. Try a smaller file.', []);
      submit.disabled = true;
      submit.textContent = 'Adding…';
      try {
        const app = await api('/v1/applications', {
          method: 'POST',
          body: { job_id: job.value, candidate, ...(note.value.trim() ? { note: note.value.trim() } : {}) },
        });
        let problem = '';
        if (resume) {
          try {
            await uploadResume(app.candidate_id, resume);
          } catch (err) {
            problem = ` The résumé wasn't stored: ${err.message}`;
          }
        }
        guide.tick('add');
        state.filters = { job: '', q: '' };
        state.selected = app.id;
        writeHash();
        await loadBoard();
        toast(
          `${candidate.first_name} applied for ${app.job.title}. They're on the board, in the audit log, and a webhook went out.${problem}`,
          problem ? 'error' : '',
        );
      } catch (err) {
        const list = err.body?.errors || [];
        if (err.status === 422 && list.length) {
          showErrors(
            'Please fix these before adding the application:',
            list.map((x) => [x.path, `${FIELD_LABEL[x.path] || 'A field'}: ${x.message}`]),
          );
        } else {
          showErrors(err.message, []);
        }
        submit.disabled = false;
        submit.textContent = 'Add application';
      }
    });
    drawer.replaceChildren(head, form);
  }
  drawer.hidden = false;
  $('scrim').hidden = false;
  (drawer.querySelector('input') || drawer.querySelector('button')).focus();
}

function closeDrawer() {
  $('drawer').hidden = true;
  $('scrim').hidden = true;
  state.selected = null;
  writeHash();
  for (const c of document.querySelectorAll('.card[aria-current="true"]')) c.setAttribute('aria-current', 'false');
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  else if (!$('board-view').hidden) $('add').focus();
}

// Keep focus inside the open drawer.
document.addEventListener('keydown', (e) => {
  if ($('drawer').hidden) return;
  if (e.key === 'Escape') closeDrawer();
  if (e.key !== 'Tab') return;
  const items = [...$('drawer').querySelectorAll('button:not([disabled]), input, select, textarea, a[href]')];
  if (!items.length) return;
  const [first, last] = [items[0], items[items.length - 1]];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

// Export exactly what is on screen.
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheets running formulas
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function exportCsv() {
  const rows = [['Candidate', 'Email', 'Job', 'Stage', 'Applied', 'In stage since']];
  const order = Object.fromEntries(STAGES.map(([s], i) => [s, i]));
  for (const a of [...state.apps].sort(
    (x, y) => order[x.stage] - order[y.stage] || new Date(y.stage_changed_at) - new Date(x.stage_changed_at),
  )) {
    rows.push([
      `${a.candidate.first_name} ${a.candidate.last_name}`,
      a.candidate.email,
      a.job.title,
      STAGE_LABEL[a.stage],
      a.created_at.slice(0, 10),
      a.stage_changed_at.slice(0, 10),
    ]);
  }
  const csv = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const job = state.jobs.find((j) => j.id === state.filters.job);
  const slug = job
    ? job.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
    : 'all-jobs';
  const a = h('a', {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })),
    download: `meridian-hire-applications_${slug}_${new Date().toISOString().slice(0, 10)}.csv`,
  });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${state.apps.length} application${state.apps.length === 1 ? '' : 's'}.`);
}

function clearFilters() {
  state.filters = { job: '', q: '' };
  writeHash();
  loadBoard();
}

// Wiring -------------------------------------------------------------------------------

let searchTimer;
document.addEventListener('DOMContentLoaded', () => {
  $('start').addEventListener('click', createSandbox);
  $('restart').addEventListener('click', () => {
    store.clear();
    state.sandbox = null;
    state.webhookId = null;
    closeDrawer();
    show('welcome');
    $('welcome-note').textContent = 'Open a fresh sandbox. The old one is deleted automatically within 24 hours.';
    $('start').focus();
  });
  $('scrim').addEventListener('click', closeDrawer);
  $('add').addEventListener('click', openAddForm);
  $('guide-hide').addEventListener('click', () => guide.setHidden(true));
  $('guide-show').addEventListener('click', () => guide.setHidden(false));
  $('job-filter').addEventListener('change', (e) => {
    state.filters.job = e.target.value;
    writeHash();
    loadBoard();
  });
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.q = e.target.value.trim();
      writeHash(true);
      loadBoard();
    }, 300);
  });
  $('clear').addEventListener('click', clearFilters);
  $('export').addEventListener('click', exportCsv);
  $('refresh-activity').addEventListener('click', loadActivity);

  window.addEventListener('popstate', () => {
    const before = JSON.stringify(state.filters);
    readHash();
    if (!state.sandbox) return;
    if (JSON.stringify(state.filters) !== before) loadBoard();
    else if (state.selected) openDrawer(state.selected, { push: false });
    else if (!$('drawer').hidden) closeDrawer();
  });

  readHash();
  state.sandbox = store.get();
  if (state.sandbox) loadBoard();
  else show('welcome');
});
