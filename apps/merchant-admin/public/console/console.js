/*
 * YouPI operations console (vanilla ES module, no framework).
 *
 * Security notes:
 *  - All server data is rendered with textContent via h(); never innerHTML.
 *  - Auth is an HttpOnly session cookie; writes echo the youpi_staff_csrf cookie in X-CSRF-Token.
 *  - The UI only hides what a role cannot do; the API enforces every permission and merchant scope.
 */

// ------------------------------------------------------------------------------------------
// DOM helpers
// ------------------------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

/** Null-safe append: skips null/undefined/false (native Element.append would print "null"). */
function append(el, ...children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  overview: 'M3 13h8V3H3zM13 21h8V11h-8zM13 3v6h8V3zM3 21h8v-6H3z',
  payments: 'M3 7h18M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM7 15h4',
  operations: 'M22 12h-4l-3 9L9 3l-3 9H2',
  webhooks: 'M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5',
  support: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  team: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  audit: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  system: 'M2 3h20v6H2zM2 15h20v6H2zM6 6h.01M6 18h.01',
  merchants: 'M3 21h18M5 21V7l7-4 7 4v14M9 9h1M9 13h1M14 9h1M14 13h1M10 21v-4h4v4',
  account: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  menu: 'M3 6h18M3 12h18M3 18h18',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
  close: 'M18 6 6 18M6 6l12 12',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  copy: 'M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3'
};

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', ICONS[name] || ICONS.info);
  svg.append(p);
  return svg;
}

// ------------------------------------------------------------------------------------------
// Formatting (all times shown in IST, explicitly labelled)
// ------------------------------------------------------------------------------------------
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
const intFmt = new Intl.NumberFormat('en-IN');
const dtFmt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
const timeFmt = new Intl.DateTimeFormat('en-IN', { timeStyle: 'medium', timeZone: 'Asia/Kolkata' });

const money = (paise) => inr.format(Number(paise || 0) / 100);
const num = (n) => intFmt.format(Number(n || 0));
const when = (iso) => (iso ? `${dtFmt.format(new Date(iso))} IST` : '—');
const pct = (v) => `${(v * 100).toFixed(1)}%`;

function duration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function relative(iso) {
  if (!iso) return 'never';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}

const STATUS = {
  INITIATED: ['Created', ''],
  QUEUED: ['Queued', 'info'],
  ACTIVE: ['Awaiting payment', 'brand'],
  PROCESSING: ['Verifying', 'warning'],
  SUCCESS: ['Paid', 'success'],
  FAILED: ['Failed', 'danger'],
  EXPIRED: ['Expired', 'warning'],
  CANCELLED: ['Cancelled', '']
};

function statusBadge(status, method) {
  if (status === 'SUCCESS' && method === 'COD') return h('span', { class: 'ui-badge ui-badge--info' }, 'COD order placed');
  const [label, tone] = STATUS[status] || [status, ''];
  return h('span', { class: `ui-badge${tone ? ` ui-badge--${tone}` : ''}` }, label);
}

const METHOD_LABEL = { UPI: 'UPI', COD: 'Cash on delivery', CASH_COUNTER: 'Cash at counter', CARD_COUNTER: 'Card at counter' };

// ------------------------------------------------------------------------------------------
// API client
// ------------------------------------------------------------------------------------------
function readCookie(name) {
  const m = document.cookie.split('; ').find(c => c.startsWith(`${name}=`));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Request failed (${status})`);
    this.status = status;
    this.code = body?.code;
    this.body = body;
  }
}

async function api(method, path, body, { scoped = true, raw = false } = {}) {
  let url = path;
  if (scoped && state.merchantId && state.user && !state.user.merchantId) {
    url += `${url.includes('?') ? '&' : '?'}merchantId=${encodeURIComponent(state.merchantId)}`;
  }
  const headers = { Accept: raw ? 'text/csv' : 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = readCookie('youpi_staff_csrf');
  let res;
  try {
    res = await fetch(url, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, { error: 'Cannot reach the gateway. Check your connection and try again.', code: 'NETWORK' });
  }
  if (raw && res.ok) return res;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/v1/staff/auth/me' && path !== '/api/v1/staff/auth/login') {
    showSignin('Your session ended. Sign in again to continue.');
    throw new ApiError(401, data);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// ------------------------------------------------------------------------------------------
// App state, toasts, dialogs
// ------------------------------------------------------------------------------------------
const state = {
  user: null,
  roleLabel: '',
  permissions: new Set(),
  merchant: null,
  merchantId: null,
  merchants: [],
  timers: new Set()
};
const can = (p) => state.permissions.has(p);

function toast(message, tone = '') {
  const el = h('div', { class: `ui-toast${tone ? ` ui-toast--${tone}` : ''}` }, message);
  append($('#toasts'), el);
  setTimeout(() => el.remove(), tone === 'danger' ? 7000 : 4000);
}

function errorAlert(err) {
  return h('div', { class: 'ui-alert ui-alert--danger', role: 'alert' }, icon('alert'), h('div', {}, err.message || 'Something went wrong.'));
}

/** Modal dialog built on <dialog>. Resolves with the submit result or null. */
function openDialog({ title, description, body, submitLabel = 'Save', tone = 'primary', onSubmit, cancelLabel = 'Cancel', hideSubmit = false }) {
  return new Promise((resolve) => {
    const errorBox = h('div', { class: 'ui-alert ui-alert--danger', role: 'alert', hidden: true });
    const submit = h('button', { class: `ui-btn ui-btn--${tone}`, type: 'submit' }, submitLabel);
    const form = h('form', { method: 'dialog' },
      h('div', { class: 'ui-dialog__header' }, h('h2', { id: 'dlgTitle' }, title), description ? h('p', { class: 'ui-muted' }, description) : null),
      h('div', { class: 'ui-dialog__body' }, errorBox, body),
      h('div', { class: 'ui-dialog__footer' },
        h('button', { class: 'ui-btn', type: 'button', onclick: () => close(null) }, cancelLabel),
        hideSubmit ? null : submit)
    );
    const dlg = h('dialog', { class: 'ui-dialog', 'aria-labelledby': 'dlgTitle' }, form);
    function close(result) {
      dlg.close();
      dlg.remove();
      resolve(result);
    }
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!onSubmit) return close(true);
      submit.setAttribute('aria-busy', 'true');
      submit.disabled = true;
      errorBox.hidden = true;
      try {
        const result = await onSubmit(new FormData(form));
        close(result ?? true);
      } catch (err) {
        append(clear(errorBox), err.message || 'Could not save.');
        errorBox.hidden = false;
      } finally {
        submit.removeAttribute('aria-busy');
        submit.disabled = false;
      }
    });
    document.body.append(dlg);
    dlg.showModal();
    const first = dlg.querySelector('input, select, textarea');
    (first || submit).focus();
  });
}

function field({ label, name, type = 'text', value = '', hint, required, options, autocomplete, rows, maxlength }) {
  const id = `f_${name}_${Math.random().toString(36).slice(2, 7)}`;
  let control;
  if (options) {
    control = h('select', { class: 'ui-select', id, name, required }, options.map(o => h('option', { value: o.value, selected: o.value === value }, o.label)));
  } else if (type === 'textarea') {
    control = h('textarea', { class: 'ui-textarea', id, name, required, rows: rows || 4, maxlength }, value);
  } else {
    control = h('input', { class: 'ui-input', id, name, type, value, required, autocomplete, maxlength });
  }
  return h('div', { class: 'ui-field' }, h('label', { class: 'ui-label', for: id }, label), control, hint ? h('span', { class: 'ui-hint' }, hint) : null);
}

function copyButton(text, label = 'Copy') {
  return h('button', {
    class: 'ui-btn ui-btn--sm', type: 'button',
    onclick: async (e) => {
      try {
        await navigator.clipboard.writeText(text);
        e.currentTarget.textContent = 'Copied';
      } catch {
        toast('Copy failed. Select the text and copy it manually.', 'danger');
      }
    }
  }, icon('copy'), label);
}

/** Interval that stops when the page changes or the tab is hidden. */
function every(ms, fn) {
  const id = setInterval(() => { if (!document.hidden) fn(); }, ms);
  state.timers.add(id);
  return id;
}

function clearTimers() {
  for (const id of state.timers) clearInterval(id);
  state.timers.clear();
}

// ------------------------------------------------------------------------------------------
// Theme
// ------------------------------------------------------------------------------------------
function currentTheme() {
  const set = document.documentElement.getAttribute('data-theme');
  if (set) return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function renderThemeButton() {
  const btn = $('#themeBtn');
  append(clear(btn), icon(currentTheme() === 'dark' ? 'sun' : 'moon'));
  btn.setAttribute('aria-label', currentTheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
}

$('#themeBtn').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('youpi-console-theme', next); } catch {}
  renderThemeButton();
});

// ------------------------------------------------------------------------------------------
// Navigation & routing
// ------------------------------------------------------------------------------------------
const ROUTES = [
  { id: 'overview', label: 'Overview', group: 'Business', perm: 'dashboard:view', title: 'Overview', render: renderOverview },
  { id: 'payments', label: 'Payments', group: 'Business', perm: 'payments:view', title: 'Payments', render: renderPayments },
  { id: 'operations', label: 'Live operations', group: 'Business', perm: 'operations:view', title: 'Live operations', render: renderOperations },
  { id: 'support', label: 'Support', group: 'Business', perm: 'support:view', title: 'Support tickets', render: renderSupport },
  { id: 'webhooks', label: 'Webhooks', group: 'Developers', perm: 'webhooks:view', title: 'Webhook deliveries', render: renderWebhooks },
  { id: 'settings', label: 'Settings', group: 'Developers', perm: 'settings:view', title: 'Merchant settings', render: renderSettings },
  { id: 'team', label: 'Team', group: 'Administration', perm: 'team:view', title: 'Team & access', render: renderTeam },
  { id: 'audit', label: 'Audit log', group: 'Administration', perm: 'audit:view', title: 'Audit log', render: renderAudit },
  { id: 'merchants', label: 'Merchants', group: 'Platform', perm: 'merchants:manage', title: 'Merchants', render: renderMerchants },
  { id: 'system', label: 'System health', group: 'Platform', perm: 'system:view', title: 'System health', render: renderSystem },
  { id: 'account', label: 'Account', group: null, perm: null, title: 'Your account', render: renderAccount }
];

function allowedRoutes() {
  return ROUTES.filter(r => !r.perm || can(r.perm));
}

function renderNav() {
  const nav = clear($('#nav'));
  let group = null;
  for (const r of allowedRoutes()) {
    if (!r.group) continue;
    if (r.group !== group) {
      group = r.group;
      append(nav, h('div', { class: 'c-nav__group' }, group));
    }
    append(nav, h('a', { class: 'c-nav__item', href: `#/${r.id}`, dataset: { route: r.id } }, icon(r.id), h('span', {}, r.label)));
  }
  const acct = clear($('#accountLink'));
  append(acct, icon('account'), h('span', { class: 'c-nav__user' }, h('strong', {}, state.user.fullName || 'Admin token'), h('span', {}, state.roleLabel)));
}

function renderMerchantBox() {
  const box = clear($('#merchantBox'));
  if (state.user.merchantId) {
    append(box, h('span', { class: 'c-merchant__label' }, 'Merchant'), h('div', { class: 'c-merchant__name', title: state.merchant?.businessName || '' }, state.merchant?.businessName || '—'));
    return;
  }
  if (state.merchants.length) {
    const select = h('select', { 'aria-label': 'Merchant', onchange: (e) => {
      state.merchantId = e.target.value;
      try { sessionStorage.setItem('youpi-console-merchant', state.merchantId); } catch {}
      route();
    } }, state.merchants.map(m => h('option', { value: m.id, selected: m.id === state.merchantId }, m.businessName)));
    append(box, h('label', { class: 'c-merchant__label' }, 'Viewing merchant'), select);
  }
}

function currentRouteId() {
  const id = (location.hash.replace(/^#\/?/, '').split('?')[0] || '').trim();
  return id;
}

function hashParams() {
  const q = location.hash.split('?')[1] || '';
  return new URLSearchParams(q);
}

function setHashParams(params) {
  const id = currentRouteId();
  const q = params.toString();
  history.replaceState(null, '', `#/${id}${q ? `?${q}` : ''}`);
}

async function route() {
  clearTimers();
  const routes = allowedRoutes();
  let r = routes.find(x => x.id === currentRouteId());
  if (!r) {
    r = routes.find(x => x.id !== 'account') || routes[0];
    history.replaceState(null, '', `#/${r.id}`);
  }
  for (const a of document.querySelectorAll('.c-nav__item')) {
    if (a.dataset.route === r.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  $('#pageTitle').textContent = r.title;
  $('#pageSubtitle').textContent = '';
  document.title = `${r.title} · YouPI Console`;
  closeSidebar();
  const main = clear($('#main'));
  try {
    await r.render(main);
  } catch (err) {
    if (err.status !== 401) append(main, errorAlert(err));
  }
  main.focus({ preventScroll: true });
}

window.addEventListener('hashchange', () => { if (state.user) route(); });

function openSidebar() {
  $('#sidebar').classList.add('is-open');
  $('#scrim').hidden = false;
  $('#menuBtn').setAttribute('aria-expanded', 'true');
}
function closeSidebar() {
  $('#sidebar').classList.remove('is-open');
  $('#scrim').hidden = true;
  $('#menuBtn').setAttribute('aria-expanded', 'false');
}
append($('#menuBtn'), icon('menu'));
$('#menuBtn').addEventListener('click', openSidebar);
$('#scrim').addEventListener('click', closeSidebar);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });

// ------------------------------------------------------------------------------------------
// Session
// ------------------------------------------------------------------------------------------
function showSignin(message, setupRequired = false) {
  clearTimers();
  state.user = null;
  $('#boot').hidden = true;
  $('#app').hidden = true;
  $('#signin').hidden = false;
  $('#signinSetup').hidden = !setupRequired;
  const err = $('#signinError');
  err.hidden = !message;
  err.textContent = message || '';
  document.title = 'Sign in · YouPI Console';
  setTimeout(() => $('#signinEmail').focus(), 0);
}

$('#signinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#signinEmail').value.trim();
  const password = $('#signinPassword').value;
  const err = $('#signinError');
  if (!email || !password) {
    err.textContent = 'Enter your email and password.';
    err.hidden = false;
    return;
  }
  const btn = $('#signinSubmit');
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  try {
    await api('POST', '/api/v1/staff/auth/login', { email, password }, { scoped: false });
    $('#signinPassword').value = '';
    await start();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
    $('#signinPassword').select();
  } finally {
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
  }
});

$('#signoutBtn').addEventListener('click', signOut);

async function signOut() {
  try { await api('POST', '/api/v1/staff/auth/logout', {}, { scoped: false }); } catch {}
  showSignin('You have signed out.');
}

async function start() {
  let me;
  try {
    me = await api('GET', '/api/v1/staff/auth/me', undefined, { scoped: false });
  } catch (err) {
    if (err.status === 401) return showSignin('', Boolean(err.body?.setupRequired));
    $('#boot').textContent = err.message;
    return;
  }
  state.user = me.user;
  state.roleLabel = me.roleLabel;
  state.permissions = new Set(me.permissions || []);
  state.merchant = me.merchant;
  state.merchantId = me.user.merchantId || me.defaultMerchantId;
  state.merchants = [];
  if (can('merchants:manage')) {
    try {
      state.merchants = (await api('GET', '/api/v1/console/merchants', undefined, { scoped: false })).merchants;
      let saved = null;
      try { saved = sessionStorage.getItem('youpi-console-merchant'); } catch {}
      if (saved && state.merchants.some(m => m.id === saved)) state.merchantId = saved;
    } catch {}
  }
  $('#boot').hidden = true;
  $('#signin').hidden = true;
  $('#app').hidden = false;
  renderNav();
  renderMerchantBox();
  renderThemeButton();
  route();
}

// ------------------------------------------------------------------------------------------
// Shared view pieces
// ------------------------------------------------------------------------------------------
function card(title, actions, ...body) {
  return h('section', { class: 'ui-card' },
    title ? h('header', { class: 'ui-card__header' }, h('h2', {}, title), actions || null) : null,
    h('div', { class: 'ui-card__body' }, body));
}

function stat(label, value, meta) {
  return h('div', { class: 'ui-card ui-stat' }, h('span', { class: 'ui-stat__label' }, label), h('span', { class: 'ui-stat__value' }, value), meta ? h('span', { class: 'ui-stat__meta' }, meta) : null);
}

function skeletonRows(n = 5) {
  return h('div', { class: 'ui-stack', 'aria-hidden': 'true' }, Array.from({ length: n }, () => h('span', { class: 'ui-skeleton' })));
}

function emptyState(title, text) {
  return h('div', { class: 'ui-empty' }, h('h3', {}, title), text ? h('p', {}, text) : null);
}

function table(columns, rows, { onRowClick, caption } = {}) {
  return h('div', { class: 'ui-table-wrap' },
    h('table', { class: 'ui-table' },
      caption ? h('caption', { class: 'ui-visually-hidden' }, caption) : null,
      h('thead', {}, h('tr', {}, columns.map(c => h('th', { scope: 'col', class: c.num ? 'is-num' : '' }, c.label)))),
      h('tbody', {}, rows.map(row => {
        const tr = h('tr', { class: onRowClick ? 'is-clickable' : '' }, columns.map(c => h('td', { class: [c.num ? 'is-num' : '', c.nowrap ? 'is-nowrap' : ''].join(' ').trim() || null }, c.render(row))));
        if (onRowClick) {
          tr.tabIndex = 0;
          tr.addEventListener('click', () => onRowClick(row));
          tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row); } });
        }
        return tr;
      }))));
}

function pagination(page, pageSize, total, go) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  return h('div', { class: 'ui-pagination' },
    h('span', { class: 'ui-num' }, `${num(from)}–${num(to)} of ${num(total)}`),
    h('div', { class: 'ui-pagination__buttons' },
      h('button', { class: 'ui-btn ui-btn--sm', disabled: page <= 1, onclick: () => go(page - 1) }, 'Previous'),
      h('button', { class: 'ui-btn ui-btn--sm', disabled: page >= pages, onclick: () => go(page + 1) }, 'Next')));
}

function openDrawer(title, subtitle) {
  const body = h('div', { class: 'ui-drawer__body' }, skeletonRows(6));
  const dlg = h('dialog', { class: 'ui-drawer', 'aria-label': title },
    h('header', { class: 'ui-drawer__header' },
      h('div', {}, h('h2', {}, title), subtitle ? h('p', { class: 'ui-subtle ui-mono' }, subtitle) : null),
      h('button', { class: 'ui-btn ui-btn--ghost ui-btn--icon', 'aria-label': 'Close', onclick: () => close() }, icon('close'))),
    body);
  function close() { dlg.close(); dlg.remove(); }
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  document.body.append(dlg);
  dlg.showModal();
  return { body, close, dialog: dlg };
}

// ------------------------------------------------------------------------------------------
// Overview
// ------------------------------------------------------------------------------------------
async function renderOverview(main) {
  const params = hashParams();
  const range = ['24h', '7d', '30d', '90d'].includes(params.get('range')) ? params.get('range') : '7d';
  const seg = h('div', { class: 'ui-segmented', role: 'group', 'aria-label': 'Time range' },
    [['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days']].map(([v, l]) =>
      h('button', { type: 'button', 'aria-pressed': String(v === range), onclick: () => { params.set('range', v); setHashParams(params); route(); } }, l)));
  const updated = h('span', { class: 'c-updated' });
  append(main, h('div', { class: 'c-section-head' }, h('div', {}, h('p', { class: 'ui-muted' }, 'Figures are computed from the payment database when you open this page.')), h('div', { class: 'ui-row' }, updated, seg)));
  const body = h('div', { class: 'ui-stack' }, skeletonRows(8));
  append(main, body);

  const d = await api('GET', `/api/v1/console/overview?range=${range}`);
  updated.textContent = `Updated ${timeFmt.format(new Date(d.generatedAt))} IST`;
  clear(body);

  const rate = d.upiSuccessRate;
  append(body, h('div', { class: 'ui-grid ui-grid--stats' },
    stat('Collected', money(d.totals.collectedPaise), 'Verified UPI and counter payments'),
    stat('Payments created', num(d.totals.payments), d.totals.codPlacedCount ? `${num(d.totals.codPlacedCount)} COD orders placed (not yet paid)` : null),
    stat('UPI success rate', rate ? pct(rate.value) : '—', rate ? `${num(rate.numerator)} of ${num(rate.denominator)} finished UPI sessions` : 'No finished UPI sessions in this range'),
    stat('Avg. time to verify', duration(d.averageVerificationSeconds), 'From QR shown to bank confirmation'),
  ));

  const live = d.live;
  const attention = [];
  if (d.webhooks.failed) attention.push(h('li', {}, h('a', { href: '#/webhooks?state=failed' }, `${num(d.webhooks.failed)} webhook deliveries failed`), ' — your server did not acknowledge them.'));
  if (d.unmatchedEvidence) attention.push(h('li', {}, h('a', { href: '#/operations' }, `${num(d.unmatchedEvidence)} bank notifications not matched`), ' to any payment. Check for underpayments or late payments.'));

  const chartCard = card('Payments over time', h('div', { class: 'c-legend', 'aria-hidden': 'true' }, h('span', {}, h('i', { class: 'is-total' }), 'Created'), h('span', {}, h('i', { class: 'is-success' }), 'Paid')),
    barChart(d.series, d.range),
    h('details', {}, h('summary', { class: 'ui-subtle' }, 'View as table'),
      table([
        { label: d.range === '24h' ? 'Hour (UTC)' : 'Day (UTC)', render: r => r.bucket.replace('T', ' ') + (d.range === '24h' ? ':00' : '') },
        { label: 'Created', num: true, render: r => num(r.total) },
        { label: 'Paid', num: true, render: r => num(r.succeeded) },
        { label: 'Collected', num: true, render: r => money(r.collectedPaise) }
      ], d.series.filter(s => s.total > 0), { caption: 'Payments per period' })));

  const liveCard = card('Right now', h('a', { href: '#/operations', class: 'ui-btn ui-btn--sm' }, 'Open live operations'),
    h('div', { class: 'ui-stack' },
      h('div', { class: 'c-kv' }, h('span', {}, 'Awaiting payment'), h('strong', { class: 'ui-num' }, num(live.active))),
      h('div', { class: 'c-kv' }, h('span', {}, 'Verifying with bank'), h('strong', { class: 'ui-num' }, num(live.processing))),
      h('div', { class: 'c-kv' }, h('span', {}, 'Waiting in queue'), h('strong', { class: 'ui-num' }, num(live.queued))),
      attention.length
        ? h('div', { class: 'ui-alert ui-alert--warning' }, icon('alert'), h('ul', { class: 'c-attention' }, attention))
        : h('div', { class: 'ui-alert ui-alert--success' }, icon('info'), h('div', {}, 'No failed webhooks or unmatched bank notifications in this range.'))));

  const total = Object.values(d.statusCounts).reduce((a, b) => a + b, 0);
  const statusCard = card('Outcomes', null,
    total ? h('ul', { class: 'c-breakdown' }, Object.entries(d.statusCounts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([s, n]) => {
      const tone = s === 'SUCCESS' ? 'c-meter-success' : (s === 'FAILED' ? 'c-meter-danger' : (s === 'EXPIRED' ? 'c-meter-warning' : ''));
      const bar = h('span');
      bar.style.width = `${Math.max(2, (n / total) * 100)}%`;
      return h('li', {}, statusBadge(s), h('div', { class: `ui-meter ${tone}`, role: 'img', 'aria-label': `${STATUS[s]?.[0] || s}: ${n} of ${total}` }, bar), h('span', { class: 'ui-num' }, num(n)));
    })) : emptyState('No payments yet', 'Payments created in this range will appear here.'));

  const evidenceCard = card('How payments were verified', null,
    d.verificationEvidence.length
      ? h('div', { class: 'ui-stack' },
          d.verificationEvidence.map(e => h('div', { class: 'c-kv' }, h('span', {}, e.tag), h('strong', { class: 'ui-num' }, num(e.count)))),
          h('p', { class: 'c-note' }, 'A bank SMS and the same bank’s email describe one transaction; "Dual" means two channels reported it, not two independent payments.'))
      : emptyState('No verified UPI payments', null));

  append(body, h('div', { class: 'ui-grid ui-grid--2' }, chartCard, liveCard), h('div', { class: 'ui-grid ui-grid--2' }, statusCard, evidenceCard));
}

function barChart(series, range) {
  const W = 720, H = 220, padL = 36, padB = 24, padT = 8;
  const max = Math.max(1, ...series.map(s => s.total));
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'c-chart');
  svg.setAttribute('role', 'img');
  const totalAll = series.reduce((a, s) => a + s.total, 0);
  const paidAll = series.reduce((a, s) => a + s.succeeded, 0);
  svg.setAttribute('aria-label', `${num(totalAll)} payments created, ${num(paidAll)} paid in this range`);
  const mk = (tag, attrs) => { const e = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  for (let i = 0; i <= 4; i++) {
    const y = padT + ((H - padT - padB) * i) / 4;
    svg.append(mk('line', { x1: padL, x2: W, y1: y, y2: y, class: 'grid' }));
    const t = mk('text', { x: padL - 6, y: y + 4, 'text-anchor': 'end' });
    t.textContent = num(Math.round(max * (1 - i / 4)));
    svg.append(t);
  }
  const n = series.length || 1;
  const slot = (W - padL) / n;
  const bw = Math.max(2, slot * 0.62);
  series.forEach((s, i) => {
    const x = padL + i * slot + (slot - bw) / 2;
    const scale = (v) => ((H - padT - padB) * v) / max;
    const ht = scale(s.total);
    const hs = scale(s.succeeded);
    svg.append(mk('rect', { x, y: H - padB - ht, width: bw, height: ht, rx: 2, class: 'bar-total' }));
    svg.append(mk('rect', { x, y: H - padB - hs, width: bw, height: hs, rx: 2, class: 'bar-success' }));
    const labelEvery = Math.ceil(n / 8);
    if (i % labelEvery === 0) {
      const t = mk('text', { x: x + bw / 2, y: H - 6, 'text-anchor': 'middle' });
      t.textContent = range === '24h' ? `${s.bucket.slice(11, 13)}:00` : s.bucket.slice(5).replace('-', '/');
      svg.append(t);
    }
  });
  return svg;
}

// ------------------------------------------------------------------------------------------
// Payments
// ------------------------------------------------------------------------------------------
async function renderPayments(main) {
  const params = hashParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const filters = {
    q: params.get('q') || '',
    status: params.get('status') || '',
    method: params.get('method') || '',
    from: params.get('from') || '',
    to: params.get('to') || ''
  };

  const form = h('form', { class: 'ui-toolbar', role: 'search', onsubmit: (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const next = new URLSearchParams();
    for (const [k, v] of fd.entries()) if (String(v).trim()) next.set(k, String(v).trim());
    setHashParams(next);
    route();
  } },
    h('div', { class: 'ui-field ui-field--grow' }, h('label', { class: 'ui-label', for: 'pq' }, 'Search'), h('input', { class: 'ui-input', id: 'pq', name: 'q', value: filters.q, placeholder: 'Order ID, payment ID or full UTR' })),
    field({ label: 'Status', name: 'status', value: filters.status, options: [{ value: '', label: 'All statuses' }, ...Object.entries(STATUS).map(([v, [l]]) => ({ value: v, label: l }))] }),
    field({ label: 'Method', name: 'method', value: filters.method, options: [{ value: '', label: 'All methods' }, ...Object.entries(METHOD_LABEL).map(([v, l]) => ({ value: v, label: l }))] }),
    field({ label: 'From', name: 'from', type: 'date', value: filters.from }),
    field({ label: 'To (exclusive)', name: 'to', type: 'date', value: filters.to }),
    h('div', { class: 'ui-row' },
      h('button', { class: 'ui-btn ui-btn--primary', type: 'submit' }, 'Apply'),
      h('button', { class: 'ui-btn', type: 'button', onclick: () => { setHashParams(new URLSearchParams()); route(); } }, 'Reset')));

  const exportBtn = can('payments:export') ? h('button', { class: 'ui-btn ui-btn--sm', type: 'button', onclick: () => exportCsv(filters) }, icon('download'), 'Export CSV') : null;
  const listCard = h('section', { class: 'ui-card' },
    h('header', { class: 'ui-card__header' }, h('h2', {}, 'Transactions'), exportBtn),
    h('div', { class: 'ui-card__body' }, skeletonRows(8)));
  append(main, card(null, null, form), listCard);

  const qs = new URLSearchParams({ page: String(page), pageSize: '25' });
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, k === 'from' || k === 'to' ? new Date(`${v}T00:00:00+05:30`).toISOString() : v);
  const d = await api('GET', `/api/v1/console/payments?${qs}`);
  const bodyEl = listCard.querySelector('.ui-card__body');
  bodyEl.remove();
  if (!d.payments.length) {
    append(listCard, h('div', { class: 'ui-card__body' }, emptyState('No payments match', 'Try a wider date range or clear the filters.')));
    return;
  }
  append(listCard, 
    table([
      { label: 'Created', nowrap: true, render: p => when(p.createdAt) },
      { label: 'Order', nowrap: true, render: p => h('span', { class: 'ui-mono' }, p.orderId) },
      { label: 'Customer', render: p => p.customer ? h('div', {}, h('div', { class: 'is-nowrap' }, p.customer.name || '—'), p.customer.mobile ? h('div', { class: 'ui-subtle ui-num' }, p.customer.mobile) : null) : h('span', { class: 'ui-subtle' }, 'Guest') },
      { label: 'Method', render: p => METHOD_LABEL[p.method] || p.method },
      { label: 'Status', render: p => statusBadge(p.status, p.method) },
      { label: 'Amount', num: true, render: p => money(p.amountPaise) }
    ], d.payments, { onRowClick: (p) => openPayment(p.id), caption: 'Payments' }),
    pagination(d.page, d.pageSize, d.total, (p) => { params.set('page', String(p)); setHashParams(params); route(); }));
}

async function exportCsv(filters) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, k === 'from' || k === 'to' ? new Date(`${v}T00:00:00+05:30`).toISOString() : v);
  try {
    const res = await api('GET', `/api/v1/console/payments/export.csv?${qs}`, undefined, { raw: true });
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'payments.csv';
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast(res.headers.get('x-export-truncated') === 'true' ? 'Exported the newest 10,000 rows. Narrow the dates to export the rest.' : 'Export downloaded. This export was recorded in the audit log.');
  } catch (err) {
    toast(err.message, 'danger');
  }
}

async function openPayment(id) {
  const drawer = openDrawer('Payment', id);
  try {
    const d = await api('GET', `/api/v1/console/payments/${encodeURIComponent(id)}`);
    const p = d.payment;
    const body = clear(drawer.body);
    append(body, 
      h('div', { class: 'ui-row' }, h('span', { class: 'c-slot__amount' }, money(p.amountPaise)), statusBadge(p.status, p.method), h('span', { class: 'ui-badge ui-badge--plain' }, p.verificationTag)),
      h('dl', { class: 'ui-dl' },
        h('dt', {}, 'Order ID'), h('dd', { class: 'ui-mono' }, p.orderId),
        h('dt', {}, 'Method'), h('dd', {}, METHOD_LABEL[p.method] || p.method),
        h('dt', {}, 'Customer'), h('dd', {}, p.customer ? `${p.customer.name || '—'}${p.customer.mobile ? ` · ${p.customer.mobile}` : ''}` : 'Guest'),
        h('dt', {}, 'Paid to'), h('dd', {}, p.receivingAccount ? `${p.receivingAccount.payeeName} (${p.receivingAccount.upiId})` : '—'),
        h('dt', {}, 'Created'), h('dd', {}, when(p.createdAt)),
        h('dt', {}, 'QR shown'), h('dd', {}, when(p.slotAcquiredAt)),
        h('dt', {}, 'Completed'), h('dd', {}, when(p.completedAt))),
      p.method === 'COD' && p.status === 'SUCCESS' ? h('div', { class: 'ui-alert ui-alert--warning' }, icon('alert'), h('div', {}, 'Cash on delivery: the order was placed, but no money has been received yet.')) : null
    );

    append(body, h('section', { class: 'ui-stack' }, h('h3', {}, 'Bank evidence'),
      d.observations.length
        ? table([
          { label: 'Source', render: o => o.source },
          { label: 'Amount', num: true, render: o => h('span', {}, o.amount, o.amountMatches ? null : h('span', { class: 'ui-badge ui-badge--danger' }, 'Mismatch')) },
          { label: 'UTR', render: o => h('span', { class: 'ui-mono' }, o.bankReference || '—') },
          { label: 'Payer', render: o => o.payerVpa || '—' },
          { label: 'Received', nowrap: true, render: o => when(o.ingestedAt) }
        ], d.observations, { caption: 'Bank evidence' })
        : h('p', { class: 'ui-muted' }, 'No bank notification has been matched to this payment.'),
      h('p', { class: 'c-note' }, 'UTRs and payer VPAs are partly hidden. Raw bank messages are never shown in the console.')));

    append(body, h('section', { class: 'ui-stack' }, h('h3', {}, 'Webhook deliveries'),
      d.webhooks.length
        ? table([
          { label: 'Event', render: w => w.event },
          { label: 'State', render: w => h('span', { class: `ui-badge ui-badge--${w.state === 'DELIVERED' ? 'success' : (w.state === 'FAILED' ? 'danger' : 'warning')}` }, w.state === 'DELIVERED' ? 'Delivered' : (w.state === 'FAILED' ? 'Failed' : 'Retrying')) },
          { label: 'HTTP', num: true, render: w => w.responseStatus ?? '—' },
          { label: 'Attempts', num: true, render: w => w.attempts },
          { label: 'Sent', nowrap: true, render: w => when(w.createdAt) }
        ], d.webhooks, { caption: 'Webhook deliveries' })
        : h('p', { class: 'ui-muted' }, 'No webhook has been sent for this payment.')));

    append(body, h('section', { class: 'ui-stack' }, h('h3', {}, 'Timeline'),
      d.timeline.length
        ? h('ol', { class: 'ui-timeline' }, d.timeline.map(t => h('li', {}, h('strong', {}, humanAction(t.action)), h('div', { class: 'ui-subtle' }, `${when(t.at)} · ${t.actorType.toLowerCase()}`))))
        : h('p', { class: 'ui-muted' }, 'No recorded events.')));

    if (d.cancellable && can('payments:cancel')) {
      append(body, h('div', { class: 'c-inline-actions' }, h('button', { class: 'ui-btn ui-btn--danger', onclick: async () => {
        const ok = await openDialog({
          title: 'Cancel this payment?',
          description: 'The customer will see the payment as cancelled and the receiving slot is released. This cannot be undone.',
          tone: 'danger',
          submitLabel: 'Cancel payment',
          cancelLabel: 'Keep payment',
          body: field({ label: 'Reason (recorded in the audit log)', name: 'reason', type: 'textarea', required: true, maxlength: 300, rows: 3 }),
          onSubmit: (fd) => api('POST', `/api/v1/console/payments/${encodeURIComponent(id)}/cancel`, { reason: fd.get('reason') })
        });
        if (ok) {
          toast('Payment cancelled.');
          drawer.close();
          route();
        }
      } }, 'Cancel payment')));
    }
  } catch (err) {
    if (err.status !== 401) append(clear(drawer.body), errorAlert(err));
  }
}

function humanAction(action) {
  return String(action || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

// ------------------------------------------------------------------------------------------
// Live operations
// ------------------------------------------------------------------------------------------
async function renderOperations(main) {
  const updated = h('span', { class: 'c-updated', 'aria-live': 'polite' });
  append(main, h('div', { class: 'c-section-head' },
    h('p', { class: 'ui-muted' }, 'Refreshes every 10 seconds while this tab is visible. A payment is only marked paid when bank evidence matches it.'),
    h('div', { class: 'ui-row' }, updated, h('button', { class: 'ui-btn ui-btn--sm', onclick: () => load() }, icon('refresh'), 'Refresh'))));
  const body = h('div', { class: 'ui-stack' }, skeletonRows(6));
  append(main, body);
  let countdowns = [];

  async function load() {
    let d;
    try {
      d = await api('GET', '/api/v1/console/operations');
    } catch (err) {
      if (err.status !== 401) append(clear(body), errorAlert(err));
      return;
    }
    updated.textContent = `Updated ${timeFmt.format(new Date(d.generatedAt))} IST`;
    countdowns = [];
    clear(body);

    if (!d.accounts.length) append(body, card('Receiving accounts', null, emptyState('No receiving account', 'Add a UPI receiving account before taking payments.')));
    for (const a of d.accounts) {
      const head = h('div', { class: 'c-account__head' },
        h('h3', {}, a.payeeName), h('span', { class: 'ui-mono ui-subtle' }, a.upiId),
        a.isActive ? h('span', { class: 'ui-badge ui-badge--success' }, 'Active') : h('span', { class: 'ui-badge' }, 'Inactive'),
        a.isMerchantEnabled ? null : h('span', { class: 'ui-badge ui-badge--warning' }, 'Disabled by merchant'));
      let slot;
      if (a.current) {
        const c = a.current;
        const cd = h('span', { class: 'ui-num' });
        countdowns.push({ el: cd, until: Date.now() + (c.secondsRemaining || 0) * 1000 });
        slot = h('div', { class: 'c-slot' },
          h('div', {}, h('div', { class: 'ui-row' }, statusBadge(c.status), h('span', { class: 'ui-mono' }, c.orderId)),
            h('div', { class: 'c-slot__amount' }, money(c.amountPaise)),
            h('div', { class: 'ui-subtle' }, c.customer ? `${c.customer.name || 'Customer'} · ${c.customer.mobile || ''}` : 'Guest')),
          h('div', { class: 'c-countdown' }, cd, h('small', {}, c.status === 'PROCESSING' ? 'verification window left' : 'payment window left')),
          h('div', { class: 'c-inline-actions' }, h('button', { class: 'ui-btn ui-btn--sm', onclick: () => openPayment(c.id) }, 'Details')));
      } else {
        slot = h('div', { class: 'c-slot' }, h('div', {}, h('strong', {}, 'Slot free'), h('div', { class: 'ui-subtle' }, 'The next customer will get the QR immediately.')));
      }
      const queue = a.queue.length
        ? table([
          { label: '#', num: true, render: q => q.position },
          { label: 'Order', render: q => h('span', { class: 'ui-mono' }, q.orderId) },
          { label: 'Amount', num: true, render: q => money(q.amountPaise) },
          { label: 'Waiting', num: true, render: q => duration(q.waitingSeconds) },
          { label: 'Est. start (upper bound)', num: true, render: q => q.estimatedWaitSeconds === null ? '—' : `≤ ${duration(q.estimatedWaitSeconds)}` }
        ], a.queue, { onRowClick: (q) => openPayment(q.id), caption: 'Queue' })
        : h('p', { class: 'ui-muted' }, 'Nobody is waiting.');
      append(body, h('section', { class: 'ui-card' }, h('div', { class: 'ui-card__body c-account' }, head, slot, h('h4', {}, `Queue (${a.queue.length})`), queue)));
    }

    append(body, h('div', { class: 'ui-grid ui-grid--2' },
      card('Android observers', null, d.devices.length
        ? table([
          { label: 'Device', render: x => h('span', {}, x.name, x.model ? h('span', { class: 'ui-subtle' }, ` · ${x.model}`) : null) },
          { label: 'Connection', render: x => h('span', { class: `ui-badge ui-badge--${x.connection === 'ONLINE' ? 'success' : (x.connection === 'REVOKED' ? '' : 'danger')}` }, x.connection === 'ONLINE' ? 'Online' : (x.connection === 'REVOKED' ? 'Revoked' : 'Offline')) },
          { label: 'Last heartbeat', render: x => relative(x.lastHeartbeatAt) }
        ], d.devices, { caption: 'Android observers' })
        : emptyState('No Android observer paired', 'Pair a phone from the legacy admin hub to receive bank SMS.')),
      card('Counter payments to confirm', null, d.pendingCounter.length
        ? table([
          { label: 'Order', render: p => h('span', { class: 'ui-mono' }, p.orderId) },
          { label: 'Method', render: p => METHOD_LABEL[p.method] || p.method },
          { label: 'Amount', num: true, render: p => money(p.amountPaise) }
        ], d.pendingCounter, { onRowClick: (p) => openPayment(p.id), caption: 'Counter payments' })
        : emptyState('Nothing pending', null))));

    append(body, card('Unmatched bank notifications (last 7 days)', null, d.exceptions.length
      ? h('div', { class: 'ui-stack' },
          table([
            { label: 'Received', nowrap: true, render: o => when(o.ingestedAt) },
            { label: 'Source', render: o => o.source },
            { label: 'Amount', num: true, render: o => `₹${o.amount}` },
            { label: 'UTR', render: o => h('span', { class: 'ui-mono' }, o.bankReference || '—') },
            { label: 'Why', render: o => o.status === 'LATE_UNMATCHED' ? 'Arrived after the payment ended' : 'No open payment with this amount' }
          ], d.exceptions, { caption: 'Unmatched bank notifications' }),
          h('p', { class: 'c-note' }, 'These are never applied automatically. Reconcile them with the customer and the bank statement.'))
      : emptyState('All bank notifications matched', null)));
    tick();
  }

  function tick() {
    for (const c of countdowns) c.el.textContent = duration((c.until - Date.now()) / 1000);
  }

  await load();
  every(10000, load);
  every(1000, tick);
}

// ------------------------------------------------------------------------------------------
// Webhooks
// ------------------------------------------------------------------------------------------
async function renderWebhooks(main) {
  const params = hashParams();
  const st = ['failed', 'retrying', 'delivered'].includes(params.get('state')) ? params.get('state') : '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const seg = h('div', { class: 'ui-segmented', role: 'group', 'aria-label': 'Delivery state' },
    [['', 'All'], ['failed', 'Failed'], ['retrying', 'Retrying'], ['delivered', 'Delivered']].map(([v, l]) =>
      h('button', { type: 'button', 'aria-pressed': String(v === st), onclick: () => { const p = new URLSearchParams(); if (v) p.set('state', v); setHashParams(p); route(); } }, l)));
  const listCard = h('section', { class: 'ui-card' }, h('header', { class: 'ui-card__header' }, h('h2', {}, 'Deliveries'), seg), h('div', { class: 'ui-card__body' }, skeletonRows(6)));
  const intro = h('div', { class: 'ui-card' }, h('div', { class: 'ui-card__body ui-stack' }, skeletonRows(2)));
  append(main, intro, listCard);

  const qs = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (st) qs.set('state', st);
  const d = await api('GET', `/api/v1/console/webhooks?${qs}`);
  append(clear(intro.querySelector('.ui-card__body')),
    h('div', { class: 'c-kv' }, h('span', {}, 'Endpoint'), h('strong', { class: 'ui-mono' }, d.endpoint || 'Not configured')),
    h('p', { class: 'c-note' }, `Each delivery is HMAC-SHA256 signed over the raw body (X-Gateway-Signature) and retried with backoff up to ${d.maxAttempts || 5} attempts. A manual retry re-sends the original payload with the same delivery ID, so your handler must be idempotent.`));
  listCard.querySelector('.ui-card__body').remove();
  if (!d.deliveries.length) {
    append(listCard, h('div', { class: 'ui-card__body' }, emptyState('No deliveries', st ? 'Nothing in this state.' : 'Webhooks appear here after the first payment outcome.')));
    return;
  }
  append(listCard, table([
    { label: 'Sent', nowrap: true, render: w => when(w.createdAt) },
    { label: 'Order', render: w => h('span', { class: 'ui-mono' }, w.orderId || '—') },
    { label: 'Event', render: w => w.event },
    { label: 'State', render: w => h('span', { class: `ui-badge ui-badge--${w.state === 'DELIVERED' ? 'success' : (w.state === 'FAILED' ? 'danger' : 'warning')}` }, w.state === 'DELIVERED' ? 'Delivered' : (w.state === 'FAILED' ? 'Failed' : `Retrying ${when(w.nextRetryAt)}`)) },
    { label: 'HTTP', num: true, render: w => w.responseStatus ?? '—' },
    { label: 'Attempts', num: true, render: w => w.attempts },
    { label: '', render: w => w.state !== 'DELIVERED' && can('webhooks:retry')
      ? h('button', { class: 'ui-btn ui-btn--sm', onclick: async (e) => {
          e.stopPropagation();
          const b = e.currentTarget;
          b.setAttribute('aria-busy', 'true');
          try {
            const r = await api('POST', `/api/v1/console/webhooks/${encodeURIComponent(w.id)}/retry`, {});
            toast(r.state === 'DELIVERED' ? 'Delivered.' : `Still failing (HTTP ${r.responseStatus ?? 'no response'}).`, r.state === 'DELIVERED' ? 'success' : 'danger');
            route();
          } catch (err) {
            toast(err.message, 'danger');
            b.removeAttribute('aria-busy');
          }
        } }, 'Retry now')
      : null }
  ], d.deliveries, { caption: 'Webhook deliveries' }), pagination(d.page, d.pageSize, d.total, (p) => { params.set('page', String(p)); setHashParams(params); route(); }));
}

// ------------------------------------------------------------------------------------------
// Support
// ------------------------------------------------------------------------------------------
const TICKET = { OPEN: ['Open', 'danger'], IN_PROGRESS: ['In progress', 'warning'], RESOLVED: ['Resolved', 'success'], CLOSED: ['Closed', ''] };
const ticketBadge = (s) => h('span', { class: `ui-badge${TICKET[s]?.[1] ? ` ui-badge--${TICKET[s][1]}` : ''}` }, TICKET[s]?.[0] || s);

async function renderSupport(main) {
  const params = hashParams();
  const st = Object.keys(TICKET).includes(params.get('status')) ? params.get('status') : '';
  const seg = h('div', { class: 'ui-segmented', role: 'group', 'aria-label': 'Ticket status' },
    [['', 'All'], ...Object.entries(TICKET).map(([v, [l]]) => [v, l])].map(([v, l]) =>
      h('button', { type: 'button', 'aria-pressed': String(v === st), onclick: () => { const p = new URLSearchParams(); if (v) p.set('status', v); setHashParams(p); route(); } }, l)));
  const listCard = h('section', { class: 'ui-card' }, h('header', { class: 'ui-card__header' }, h('h2', {}, 'Tickets'), seg), h('div', { class: 'ui-card__body' }, skeletonRows(6)));
  append(main, listCard);
  const d = await api('GET', `/api/v1/console/tickets${st ? `?status=${st}` : ''}`);
  listCard.querySelector('.ui-card__body').remove();
  if (!d.tickets.length) {
    append(listCard, h('div', { class: 'ui-card__body' }, emptyState('No tickets', 'Customer questions and late-payment investigations appear here.')));
    return;
  }
  append(listCard, table([
    { label: 'Updated', nowrap: true, render: t => when(t.updatedAt) },
    { label: 'Subject', render: t => t.subject },
    { label: 'Customer', render: t => `${t.customer.name || '—'}${t.customer.mobile ? ` · ${t.customer.mobile}` : ''}` },
    { label: 'Order', render: t => h('span', { class: 'ui-mono' }, t.orderId || '—') },
    { label: 'Status', render: t => ticketBadge(t.status) },
    { label: 'Messages', num: true, render: t => t.messageCount }
  ], d.tickets, { onRowClick: (t) => openTicket(t.id), caption: 'Support tickets' }));
}

async function openTicket(id) {
  const drawer = openDrawer('Support ticket');
  async function load() {
    try {
      const d = await api('GET', `/api/v1/console/tickets/${encodeURIComponent(id)}`);
      const t = d.ticket;
      const body = clear(drawer.body);
      append(body, h('div', { class: 'ui-stack' }, h('h3', {}, t.subject), h('div', { class: 'ui-row' }, ticketBadge(t.status), t.paymentId ? h('button', { class: 'ui-btn ui-btn--sm', onclick: () => openPayment(t.paymentId) }, 'Open payment') : null)));
      append(body, h('div', { class: 'c-messages' }, d.messages.map(m => h('div', { class: `c-msg${m.senderType === 'ADMIN' ? ' c-msg--staff' : ''}` },
        h('div', { class: 'c-msg__meta' }, `${m.senderType === 'ADMIN' ? 'Staff' : 'Customer'} · ${when(m.createdAt)}`),
        h('div', { class: 'c-msg__body' }, m.message)))));
      if (can('support:respond')) {
        const reply = h('form', { class: 'ui-stack', onsubmit: async (e) => {
          e.preventDefault();
          const msg = new FormData(e.currentTarget).get('message');
          if (!String(msg).trim()) return;
          const b = e.currentTarget.querySelector('button[type=submit]');
          b.setAttribute('aria-busy', 'true');
          try {
            await api('POST', `/api/v1/console/tickets/${encodeURIComponent(id)}/reply`, { message: msg });
            toast('Reply sent.');
            load();
          } catch (err) {
            toast(err.message, 'danger');
            b.removeAttribute('aria-busy');
          }
        } },
          field({ label: 'Reply to customer', name: 'message', type: 'textarea', rows: 4, maxlength: 4000 }),
          h('div', { class: 'ui-row' },
            field({ label: 'Status', name: 'status', value: t.status, options: Object.entries(TICKET).map(([v, [l]]) => ({ value: v, label: l })) }),
            h('span', { class: 'ui-spacer' }),
            h('button', { class: 'ui-btn ui-btn--primary', type: 'submit' }, 'Send reply')));
        reply.querySelector('select').addEventListener('change', async (e) => {
          try {
            await api('POST', `/api/v1/console/tickets/${encodeURIComponent(id)}/status`, { status: e.target.value });
            toast('Status updated.');
          } catch (err) { toast(err.message, 'danger'); }
        });
        append(body, reply);
      }
    } catch (err) {
      if (err.status !== 401) append(clear(drawer.body), errorAlert(err));
    }
  }
  load();
}

// ------------------------------------------------------------------------------------------
// Team
// ------------------------------------------------------------------------------------------
async function renderTeam(main) {
  const d = await api('GET', '/api/v1/staff/users', undefined, { scoped: false });
  const roleLabel = Object.fromEntries(d.roles.map(r => [r.id, r.label]));
  const addBtn = can('team:manage') && d.assignableRoles.length
    ? h('button', { class: 'ui-btn ui-btn--primary ui-btn--sm', onclick: () => addMember(d) }, 'Add team member')
    : null;
  append(main, h('section', { class: 'ui-card' },
    h('header', { class: 'ui-card__header' }, h('h2', {}, `People (${d.users.length})`), addBtn),
    d.users.length ? table([
      { label: 'Name', render: u => h('span', {}, h('strong', {}, u.fullName), h('div', { class: 'ui-subtle' }, u.email)) },
      { label: 'Role', render: u => roleLabel[u.role] || u.role },
      { label: 'Status', render: u => u.status === 'ACTIVE' ? (u.lockedUntil ? h('span', { class: 'ui-badge ui-badge--warning' }, 'Locked') : h('span', { class: 'ui-badge ui-badge--success' }, 'Active')) : h('span', { class: 'ui-badge' }, 'Disabled') },
      { label: 'Last sign-in', render: u => u.lastLoginAt ? relative(u.lastLoginAt) : 'Never' },
      { label: '', render: u => can('team:manage') && u.id !== state.user.id ? h('button', { class: 'ui-btn ui-btn--sm', onclick: () => manageMember(u, d) }, 'Manage') : null }
    ], d.users, { caption: 'Team members' }) : h('div', { class: 'ui-card__body' }, emptyState('No team members yet', null))),
    card('What each role can do', null, h('div', { class: 'ui-stack' },
      h('div', { class: 'c-kv' }, h('span', {}, 'Merchant administrator'), h('span', { class: 'ui-subtle' }, 'Everything for this merchant, including exports and team')),
      h('div', { class: 'c-kv' }, h('span', {}, 'Cashier'), h('span', { class: 'ui-subtle' }, 'Live operations, payments, cancel with a reason')),
      h('div', { class: 'c-kv' }, h('span', {}, 'Support'), h('span', { class: 'ui-subtle' }, 'Payments (read), tickets, audit log')),
      h('div', { class: 'c-kv' }, h('span', {}, 'Developer'), h('span', { class: 'ui-subtle' }, 'Payments (read), webhooks, settings (read)')),
      h('div', { class: 'c-kv' }, h('span', {}, 'Viewer'), h('span', { class: 'ui-subtle' }, 'Dashboards and payments (read)')),
      h('p', { class: 'c-note' }, 'No role can mark a payment as paid. Payments are confirmed only by matching bank evidence.'))));
}

function showTemporaryPassword(email, password) {
  return openDialog({
    title: 'Temporary password',
    description: `Share this with ${email} through a private channel. It is shown only once; they should change it after signing in.`,
    body: h('div', { class: 'c-secret' }, h('span', {}, password), h('span', { class: 'ui-spacer' }), copyButton(password)),
    hideSubmit: true,
    cancelLabel: 'Done'
  });
}

async function addMember(d) {
  const roleLabel = Object.fromEntries(d.roles.map(r => [r.id, r.label]));
  const created = await openDialog({
    title: 'Add team member',
    submitLabel: 'Create account',
    body: h('div', { class: 'ui-stack' },
      field({ label: 'Full name', name: 'fullName', required: true, maxlength: 120, autocomplete: 'off' }),
      field({ label: 'Work email', name: 'email', type: 'email', required: true, autocomplete: 'off' }),
      field({ label: 'Role', name: 'role', value: 'cashier', options: d.assignableRoles.map(r => ({ value: r, label: roleLabel[r] || r })) }),
      state.user.merchantId ? null : h('p', { class: 'c-note' }, `Merchant-scoped roles are added to the merchant selected in the sidebar.`)),
    onSubmit: (fd) => api('POST', '/api/v1/staff/users', { fullName: fd.get('fullName'), email: fd.get('email'), role: fd.get('role'), merchantId: state.merchantId }, { scoped: false })
  });
  if (created && created.temporaryPassword) {
    await showTemporaryPassword(created.user.email, created.temporaryPassword);
    route();
  }
}

async function manageMember(u, d) {
  const roleLabel = Object.fromEntries(d.roles.map(r => [r.id, r.label]));
  const roleOptions = d.assignableRoles.filter(r => (r === 'platform_admin') === (u.role === 'platform_admin')).map(r => ({ value: r, label: roleLabel[r] || r }));
  let action = 'save';
  const body = h('div', { class: 'ui-stack' },
    h('p', {}, h('strong', {}, u.fullName), h('span', { class: 'ui-subtle' }, ` · ${u.email}`)),
    field({ label: 'Role', name: 'role', value: u.role, options: roleOptions }),
    field({ label: 'Access', name: 'status', value: u.status, options: [{ value: 'ACTIVE', label: 'Active' }, { value: 'DISABLED', label: 'Disabled (signs them out everywhere)' }] }),
    // type="button": pressing Enter must only ever trigger "Save changes" (the footer submit).
    h('div', { class: 'ui-row' },
      h('button', { class: 'ui-btn ui-btn--sm', type: 'button', onclick: (e) => { action = 'reset'; e.currentTarget.form.requestSubmit(); } }, 'Reset password'),
      h('button', { class: 'ui-btn ui-btn--sm', type: 'button', onclick: (e) => { action = 'revoke'; e.currentTarget.form.requestSubmit(); } }, 'Sign out all sessions')));
  const result = await openDialog({
    title: 'Manage access',
    submitLabel: 'Save changes',
    body,
    onSubmit: async (fd) => {
      const chosen = action;
      action = 'save';
      if (chosen === 'reset') return { reset: await api('POST', `/api/v1/staff/users/${u.id}/reset-password`, {}, { scoped: false }) };
      if (chosen === 'revoke') return { revoked: await api('POST', `/api/v1/staff/users/${u.id}/revoke-sessions`, {}, { scoped: false }) };
      return { saved: await api('POST', `/api/v1/staff/users/${u.id}`, { role: fd.get('role'), status: fd.get('status') }, { scoped: false }) };
    }
  });
  if (!result) return;
  if (result.reset) await showTemporaryPassword(u.email, result.reset.temporaryPassword);
  if (result.revoked) toast(`Signed out ${result.revoked.sessionsRevoked} session(s).`);
  if (result.saved) toast('Access updated.');
  route();
}

// ------------------------------------------------------------------------------------------
// Audit log
// ------------------------------------------------------------------------------------------
async function renderAudit(main) {
  const params = hashParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const qs = new URLSearchParams({ page: String(page), pageSize: '50' });
  for (const k of ['action', 'actorType', 'scope']) if (params.get(k)) qs.set(k, params.get(k));
  const d = await api('GET', `/api/v1/console/audit?${qs}`);
  const form = h('form', { class: 'ui-toolbar', onsubmit: (e) => {
    e.preventDefault();
    const next = new URLSearchParams();
    for (const [k, v] of new FormData(e.currentTarget).entries()) if (v) next.set(k, String(v));
    setHashParams(next);
    route();
  } },
    field({ label: 'Action', name: 'action', value: params.get('action') || '', options: [{ value: '', label: 'All actions' }, ...d.actions.map(a => ({ value: a, label: humanAction(a) }))] }),
    field({ label: 'Actor', name: 'actorType', value: params.get('actorType') || '', options: [{ value: '', label: 'Anyone' }, ...['STAFF', 'SYSTEM', 'CUSTOMER', 'OBSERVER', 'ANONYMOUS'].map(v => ({ value: v, label: v.charAt(0) + v.slice(1).toLowerCase() }))] }),
    state.user.role === 'platform_admin' ? field({ label: 'Scope', name: 'scope', value: params.get('scope') || '', options: [{ value: '', label: 'This merchant' }, { value: 'platform', label: 'Include platform events' }] }) : null,
    h('button', { class: 'ui-btn ui-btn--primary', type: 'submit' }, 'Apply'));
  append(main, card(null, null, form));
  const list = h('section', { class: 'ui-card' }, h('header', { class: 'ui-card__header' }, h('h2', {}, 'Events'), h('span', { class: 'ui-subtle' }, 'Newest first · append-only')));
  if (!d.entries.length) append(list, h('div', { class: 'ui-card__body' }, emptyState('No events', null)));
  else append(list, table([
    { label: 'When', nowrap: true, render: e => when(e.at) },
    { label: 'Action', render: e => humanAction(e.action) },
    { label: 'Actor', render: e => h('span', {}, e.actorType.toLowerCase(), e.actorId ? h('div', { class: 'ui-subtle ui-mono' }, e.actorId.slice(0, 18)) : null) },
    { label: 'Entity', render: e => h('span', { class: 'ui-mono ui-subtle' }, `${e.entityType}:${String(e.entityId).slice(0, 12)}`) },
    { label: 'IP', render: e => e.ipAddress || '—' },
    { label: 'Details', render: e => Object.keys(e.details || {}).length ? h('details', {}, h('summary', {}, 'View'), h('pre', { class: 'c-json' }, JSON.stringify(e.details, null, 2))) : '—' }
  ], d.entries, { caption: 'Audit events' }), pagination(d.page, d.pageSize, d.total, (p) => { params.set('page', String(p)); setHashParams(params); route(); }));
  append(main, list);
}

// ------------------------------------------------------------------------------------------
// Settings (read-only)
// ------------------------------------------------------------------------------------------
async function renderSettings(main) {
  const d = await api('GET', '/api/v1/console/settings');
  const m = d.merchant;
  const swatch = h('span', { class: 'ui-badge ui-badge--plain' });
  if (/^#[0-9a-f]{6}$/i.test(m.branding.primaryColor || '')) { swatch.style.background = m.branding.primaryColor; swatch.style.width = '22px'; }
  append(main, 
    h('div', { class: 'ui-alert' }, icon('info'), h('div', {}, 'Settings are read-only here. ', state.user.role === 'platform_admin' ? h('a', { href: '/', target: '_blank', rel: 'noopener' }, 'Edit them in the legacy admin hub') : 'Ask a platform administrator to change them.', '.')),
    h('div', { class: 'ui-grid ui-grid--2' },
      card('Business', null, h('dl', { class: 'ui-dl' },
        h('dt', {}, 'Name'), h('dd', {}, m.businessName),
        h('dt', {}, 'Merchant ID'), h('dd', { class: 'ui-mono' }, m.id),
        h('dt', {}, 'Contact email'), h('dd', {}, m.contactEmail),
        h('dt', {}, 'Support email'), h('dd', {}, m.branding.supportEmail || '—'),
        h('dt', {}, 'Support phone'), h('dd', {}, m.branding.supportPhone || '—'))),
      card('Integration', null, h('dl', { class: 'ui-dl' },
        h('dt', {}, 'Webhook URL'), h('dd', { class: 'ui-mono' }, m.webhookUrl || 'Not set'),
        h('dt', {}, 'Webhook secret'), h('dd', {}, m.webhookSecretConfigured ? h('span', { class: 'ui-badge ui-badge--success' }, 'Configured') : h('span', { class: 'ui-badge ui-badge--danger' }, 'Missing')),
        h('dt', {}, 'API key'), h('dd', {}, m.apiKeyConfigured ? h('span', { class: 'ui-badge ui-badge--success' }, 'Configured') : h('span', { class: 'ui-badge ui-badge--warning' }, 'Not set')))),
      card('Checkout branding', null, h('dl', { class: 'ui-dl' },
        h('dt', {}, 'Display name'), h('dd', {}, m.branding.appName || '—'),
        h('dt', {}, 'Brand colour'), h('dd', {}, h('span', { class: 'ui-row' }, swatch, m.branding.primaryColor || '—')),
        h('dt', {}, 'Logo'), h('dd', {}, m.branding.logoUrl ? 'Set' : 'Not set'))),
      card('Receiving accounts', null, d.receivingAccounts.length ? h('div', { class: 'ui-stack' }, d.receivingAccounts.map(a =>
        h('div', { class: 'c-kv' }, h('span', {}, a.payeeName, h('span', { class: 'ui-subtle ui-mono' }, ` ${a.upiId}`)), a.isActive ? h('span', { class: 'ui-badge ui-badge--success' }, 'Active') : h('span', { class: 'ui-badge' }, 'Inactive'))))
        : emptyState('No receiving account', null))));
}

// ------------------------------------------------------------------------------------------
// Merchants & system (platform)
// ------------------------------------------------------------------------------------------
async function renderMerchants(main) {
  const d = await api('GET', '/api/v1/console/merchants', undefined, { scoped: false });
  append(main, h('section', { class: 'ui-card' }, h('header', { class: 'ui-card__header' }, h('h2', {}, `Merchants (${d.merchants.length})`)),
    table([
      { label: 'Business', render: m => h('span', {}, h('strong', {}, m.businessName), h('div', { class: 'ui-subtle' }, m.contactEmail)) },
      { label: 'Slug', render: m => h('span', { class: 'ui-mono' }, m.slug) },
      { label: 'Payments', num: true, render: m => num(m.payments) },
      { label: 'Last payment', render: m => m.lastPaymentAt ? relative(m.lastPaymentAt) : 'Never' },
      { label: '', render: m => h('button', { class: 'ui-btn ui-btn--sm', onclick: () => {
        state.merchantId = m.id;
        try { sessionStorage.setItem('youpi-console-merchant', m.id); } catch {}
        renderMerchantBox();
        location.hash = '#/overview';
      } }, m.id === state.merchantId ? 'Viewing' : 'View') }
    ], d.merchants, { caption: 'Merchants' })));
}

async function renderSystem(main) {
  const d = await api('GET', '/api/v1/console/system', undefined, { scoped: false });
  const tone = { critical: 'danger', warning: 'warning', info: '' };
  if (d.warnings.length) {
    append(main, h('div', { class: 'ui-stack' }, d.warnings.map(w => h('div', { class: `ui-alert${tone[w.level] ? ` ui-alert--${tone[w.level]}` : ''}`, role: w.level === 'critical' ? 'alert' : null }, icon(w.level === 'info' ? 'info' : 'alert'), h('div', {}, h('strong', {}, w.level === 'critical' ? 'Critical: ' : (w.level === 'warning' ? 'Warning: ' : '')), w.message)))));
  }
  const supervisorById = Object.fromEntries((d.supervisor || []).map(s => [s.id, s]));
  append(main, h('div', { class: 'ui-grid ui-grid--2' },
    card('Services', h('span', { class: 'ui-subtle' }, `Probed ${timeFmt.format(new Date(d.generatedAt))} IST`), table([
      { label: 'Service', render: s => h('span', {}, s.name, h('div', { class: 'ui-subtle' }, `port ${s.port}`)) },
      { label: 'Health', render: s => s.ok ? h('span', { class: 'ui-badge ui-badge--success' }, 'Healthy') : h('span', { class: 'ui-badge ui-badge--danger' }, s.error === 'timeout' ? 'Timed out' : (s.status ? `HTTP ${s.status}` : 'Unreachable')) },
      { label: 'Latency', num: true, render: s => s.latencyMs === null ? '—' : `${s.latencyMs} ms` },
      { label: 'Supervisor', render: s => supervisorById[s.id] ? supervisorById[s.id].status : '—' }
    ], d.services, { caption: 'Services' })),
    card('Database', null, h('dl', { class: 'ui-dl' },
      h('dt', {}, 'Engine'), h('dd', {}, d.database.engine),
      h('dt', {}, 'Integrity'), h('dd', {}, d.database.integrity === 'ok' ? h('span', { class: 'ui-badge ui-badge--success' }, 'OK') : h('span', { class: 'ui-badge ui-badge--danger' }, d.database.integrity || 'unknown')),
      h('dt', {}, 'Schema version'), h('dd', {}, `${d.database.schemaVersion ?? '—'} (expected ${d.database.expectedSchemaVersion})`),
      h('dt', {}, 'Size'), h('dd', {}, `${(d.database.sizeBytes / 1024 / 1024).toFixed(1)} MB · ${d.database.journalMode} journal`),
      h('dt', {}, 'Payments'), h('dd', { class: 'ui-num' }, num(d.database.rowCounts.payment_sessions)),
      h('dt', {}, 'Latest backup'), h('dd', {}, d.backups.latest ? `${relative(d.backups.latest.at)} · ${d.backups.latest.file}` : h('span', { class: 'ui-badge ui-badge--warning' }, 'None found')))),
    card('Customer verification codes', null, d.otp ? h('div', { class: 'ui-stack' },
      h('div', { class: 'c-kv' }, h('span', {}, 'Channel order'), h('strong', {}, d.otp.channels.join(' → '))),
      h('div', { class: 'c-kv' }, h('span', {}, 'Fallback'), h('strong', {}, d.otp.allowFallback ? 'On' : 'Off')),
      d.otp.providers.map(p => h('div', { class: 'c-kv' }, h('span', {}, p.name, p.official ? null : h('span', { class: 'ui-badge ui-badge--warning' }, 'Unofficial')), p.configured ? h('span', { class: 'ui-badge ui-badge--success' }, 'Configured') : h('span', { class: 'ui-badge' }, 'Not configured'))))
      : emptyState('Unavailable', null)),
    card('Runtime', null, h('dl', { class: 'ui-dl' },
      h('dt', {}, 'Node.js'), h('dd', {}, d.runtime.node),
      h('dt', {}, 'Mode'), h('dd', {}, `${d.runtime.nodeEnv || '—'} · ${d.runtime.mode || '—'}`),
      h('dt', {}, 'API uptime'), h('dd', {}, duration(d.runtime.uptimeSeconds)),
      h('dt', {}, 'Memory (RSS)'), h('dd', {}, `${Math.round(d.runtime.rssBytes / 1024 / 1024)} MB`),
      h('dt', {}, 'Webhook backlog'), h('dd', {}, `${num(d.webhookBacklog.retrying)} retrying · ${num(d.webhookBacklog.failed)} failed`)))));
  append(main, card('Applied migrations', null, table([
    { label: 'Version', num: true, render: m => m.version },
    { label: 'Name', render: m => h('span', { class: 'ui-mono' }, m.name) },
    { label: 'Applied', render: m => when(m.appliedAt) }
  ], d.database.migrations, { caption: 'Migrations' })));
}

// ------------------------------------------------------------------------------------------
// Account
// ------------------------------------------------------------------------------------------
async function renderAccount(main) {
  const u = state.user;
  append(main, card('Profile', null, h('dl', { class: 'ui-dl' },
    h('dt', {}, 'Name'), h('dd', {}, u.fullName || '—'),
    h('dt', {}, 'Email'), h('dd', {}, u.email || '—'),
    h('dt', {}, 'Role'), h('dd', {}, state.roleLabel),
    h('dt', {}, 'Merchant'), h('dd', {}, state.merchant?.businessName || 'All merchants (platform)'))));
  if (!u.email) {
    append(main, h('div', { class: 'ui-alert ui-alert--warning' }, icon('alert'), h('div', {}, 'You are signed in with the admin API token. Create a personal staff account with npm run staff:create so actions are attributed to you.')));
    return;
  }
  const form = h('form', { class: 'ui-stack', onsubmit: async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    if (fd.get('newPassword') !== fd.get('confirmPassword')) {
      toast('The new passwords do not match.', 'danger');
      return;
    }
    const b = e.currentTarget.querySelector('button[type=submit]');
    b.setAttribute('aria-busy', 'true');
    try {
      await api('POST', '/api/v1/staff/auth/change-password', { currentPassword: fd.get('currentPassword'), newPassword: fd.get('newPassword') }, { scoped: false });
      e.currentTarget.reset();
      toast('Password changed. Your other sessions were signed out.', 'success');
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      b.removeAttribute('aria-busy');
    }
  } },
    field({ label: 'Current password', name: 'currentPassword', type: 'password', required: true, autocomplete: 'current-password' }),
    field({ label: 'New password', name: 'newPassword', type: 'password', required: true, autocomplete: 'new-password', hint: 'At least 12 characters. A short sentence is easy to remember and hard to guess.' }),
    field({ label: 'Confirm new password', name: 'confirmPassword', type: 'password', required: true, autocomplete: 'new-password' }),
    h('div', {}, h('button', { class: 'ui-btn ui-btn--primary', type: 'submit' }, 'Change password')));
  append(main, card('Change password', null, form), h('div', {}, h('button', { class: 'ui-btn', onclick: signOut }, 'Sign out')));
}

start();
