// GardenBud: a small, private garden layout planner.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clone = o => JSON.parse(JSON.stringify(o));
const BASE = location.origin + location.pathname;

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + ' d ago';
  return new Date(iso).toLocaleDateString();
}
function hashParams() { return new URLSearchParams(location.hash.slice(1)); }
function setHash(h) { if (location.hash.slice(1) !== h) location.hash = h; else route(); }
function clearHash() { history.replaceState(null, '', location.pathname + location.search); }

async function shareLink(url, text) {
  try {
    if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
      await navigator.share({ title: 'GardenBud', text, url });
      return;
    }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); }
  catch (e) { toast('Copy the link from the box'); }
}
function download(filename, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const slug = s => (s || 'garden').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'garden';

// ---------------------------------------------------------------- units
const S = { me: null, members: {}, isAdmin: false, booted: false, ed: null };
const units = () => (S.members[S.me]?.units) || 'metric';
const unitLabel = () => (units() === 'imperial' ? 'in' : 'cm');
const toDisp = cm => (units() === 'imperial' ? Math.round(cm / 2.54 * 10) / 10 : Math.round(cm));
const fromDisp = v => (units() === 'imperial' ? (+v || 0) * 2.54 : (+v || 0));
function fmtLen(cm) {
  if (units() === 'imperial') {
    const inches = Math.round(cm / 2.54);
    const ft = Math.floor(inches / 12), inch = inches % 12;
    return ft ? `${ft}′ ${inch}″` : `${inch}″`;
  }
  return cm < 100 ? `${Math.round(cm)} cm` : `${(cm / 100).toFixed(2)} m`;
}
const nameOf = id => S.members[id]?.first_name || 'Someone';

// ---------------------------------------------------------------- categories + presets
const CATS = {
  veg: { label: 'Vegetable', color: '#5b9a4b' },
  herb: { label: 'Herb', color: '#3f9e8f' },
  fruit: { label: 'Fruit / shrub', color: '#8a5bb0' },
  flower: { label: 'Flower', color: '#d6609a' },
  other: { label: 'Other', color: '#a07850' },
  fixed: { label: 'Furniture', color: '#9aa0a6' },
};
const pc = (name, cat, d) => ({ name, cat, shape: 'circle', w: d, h: d });
const pr = (name, cat, w, h) => ({ name, cat, shape: 'rect', w, h });
const PRESETS = [
  ['Custom', null],
  ['Small pot (15 cm)', pc('Small pot', 'herb', 15)],
  ['Medium pot (25 cm)', pc('Pot', 'veg', 25)],
  ['Grow bag 5 gal / 19 L (30 cm)', pc('Grow bag 19 L', 'veg', 30)],
  ['Grow bag 10 gal / 38 L (38 cm)', pc('Grow bag 38 L', 'veg', 38)],
  ['Grow bag 20 gal / 75 L (50 cm)', pc('Grow bag 75 L', 'veg', 50)],
  ['Herb pot 30 L (40 cm)', pc('Herb pot', 'herb', 40)],
  ['Railing planter (27 x 21 cm)', pr('Railing planter', 'flower', 27, 21)],
  ['Long planter (68 x 21 cm)', pr('Long planter', 'flower', 68, 21)],
  ['Deep trough (80 x 30 cm)', pr('Deep trough', 'veg', 80, 30)],
  ['Raised bed (120 x 60 cm)', pr('Raised bed', 'veg', 120, 60)],
  ['Trellis / climbers (100 x 10 cm)', pr('Climbers', 'veg', 100, 10)],
  ['Birdhouse (15 cm)', pr('Birdhouse', 'other', 15, 15)],
  ['Chair (45 cm)', pr('Chair', 'fixed', 45, 45)],
  ['Small table (60 cm round)', pc('Table', 'fixed', 60)],
];

// ---------------------------------------------------------------- boot + auth
async function getSession() { return (await sb.auth.getSession()).data.session; }
async function ensureSession() {
  let s = await getSession();
  if (s) return s;
  const { data, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  return data.session;
}
async function myMemberId() {
  const s = await getSession();
  if (!s) return null;
  const { data } = await sb.from('member_devices').select('member_id').eq('user_id', s.user.id).maybeSingle();
  return data?.member_id || null;
}
async function loadMembers() {
  const { data, error } = await sb.from('members').select('id, first_name, units');
  if (error) throw error;
  S.members = Object.fromEntries(data.map(m => [m.id, m]));
  const { data: adm } = await sb.rpc('is_admin');
  S.isAdmin = !!adm;
}

async function boot() {
  try {
    const h = hashParams();
    if (h.get('device')) return showDeviceClaim(h.get('device'));
    S.me = await myMemberId();
    if (S.me) {
      if (h.get('join')) clearHash();
      await loadMembers();
      S.booted = true;
      return route();
    }
    if (h.get('join')) return showJoin(h.get('join'));
    showNoInvite();
  } catch (e) {
    console.error(e);
    welcome(`<h2>Can't reach GardenBud</h2><p class="muted">Check your connection and try again.</p>
      <button class="primary" onclick="location.reload()">Try again</button>`);
  }
}

function welcome(inner) {
  closeSheet(); closeModal();
  app.innerHTML = `<div class="welcome"><img src="icons/icon-full.png" alt="GardenBud">
    <h1>GardenBud</h1><div class="card">${inner}</div></div>`;
}

function pasteBox() {
  return `<form id="pasteForm" style="margin-top:14px">
    <label>Paste an invite link or a device link<input type="text" id="pasteIn" placeholder="https://…"></label>
    <button>Continue</button></form>`;
}
function wirePaste() {
  const f = $('#pasteForm'); if (!f) return;
  f.onsubmit = e => {
    e.preventDefault();
    const v = $('#pasteIn').value.trim();
    const m = v.match(/(join|device)=([A-Za-z0-9]+)/);
    if (!m) return toast("That doesn't look like a GardenBud link");
    location.hash = `${m[1]}=${m[2]}`;
    boot();
  };
}

function showNoInvite() {
  welcome(`<h2 style="margin-bottom:6px">Invite only</h2>
    <p class="muted">Open the GardenBud link you were sent. If you added GardenBud to your home screen, paste your link below.</p>
    ${pasteBox()}`);
  wirePaste();
}

function showJoin(code) {
  welcome(`<form id="joinForm">
      <h2>Welcome! 🌱</h2>
      <p class="muted" style="margin:0">You've been invited to plan gardens together. What's your first name?</p>
      <label>First name<input type="text" id="joinName" maxlength="40" autocomplete="given-name" required></label>
      <button class="primary" id="joinBtn">Join GardenBud</button>
    </form>
    <details style="margin-top:14px;text-align:left"><summary class="muted">Already using GardenBud on another device?</summary>
      <p class="muted" style="font-size:13px">On that device, open Settings → "Use on another device", then open or paste that link here.</p>
      ${pasteBox()}</details>`);
  wirePaste();
  $('#joinName').focus();
  $('#joinForm').onsubmit = async e => {
    e.preventDefault();
    const name = $('#joinName').value.trim();
    if (!name) return;
    $('#joinBtn').disabled = true;
    try {
      await ensureSession();
      const { data, error } = await sb.rpc('join_club', { p_code: code, p_name: name });
      if (error) throw error;
      S.me = data;
      clearHash();
      await loadMembers();
      S.booted = true;
      toast(`Welcome, ${name}!`);
      route();
    } catch (err) {
      console.error(err);
      $('#joinBtn').disabled = false;
      toast(/invalid invite/.test(err.message) ? 'This invite link is no longer valid. Ask for a new one.' : 'Something went wrong. Try again.');
    }
  };
}

function showDeviceClaim(code) {
  welcome(`<h2>Use GardenBud on this device</h2>
    <p class="muted">This signs this device in as you, so your gardens and editing rights come along.</p>
    <button class="primary" id="claimBtn">Continue</button>`);
  $('#claimBtn').onclick = async () => {
    $('#claimBtn').disabled = true;
    try {
      await ensureSession();
      const { data, error } = await sb.rpc('claim_device_link', { p_code: code });
      if (error) throw error;
      S.me = data;
      clearHash();
      await loadMembers();
      S.booted = true;
      toast(`You're in, ${nameOf(S.me)}!`);
      route();
    } catch (err) {
      console.error(err);
      $('#claimBtn').disabled = false;
      toast(/expired/.test(err.message) ? 'That link expired. Make a new one (they last 15 minutes).' : 'Something went wrong. Try again.');
    }
  };
}

function route() {
  if (!S.booted) return;
  const h = hashParams();
  if (h.get('d')) openDesign(h.get('d'));
  else renderHome();
}
window.addEventListener('hashchange', () => {
  const h = hashParams();
  if (h.get('join') || h.get('device')) return boot();
  if (S.ed && S.ed.dirty) flushSave();
  route();
});

// ---------------------------------------------------------------- sheet + modal
function openSheet(html) { const s = $('#sheet'); s.innerHTML = `<div class="inner">${html}</div>`; s.hidden = false; return s; }
function closeSheet() { const s = $('#sheet'); s.hidden = true; s.innerHTML = ''; }
function openModal(html) {
  const m = $('#modal'); m.innerHTML = `<div class="card">${html}</div>`; m.hidden = false;
  m.onclick = e => { if (e.target === m) closeModal(); };
  return m;
}
function closeModal() { const m = $('#modal'); m.hidden = true; m.innerHTML = ''; }

// ---------------------------------------------------------------- home
async function renderHome() {
  if (S.ed) { flushSave(); S.ed = null; }
  document.body.classList.remove('panel-open');
  closeSheet(); closeModal();
  sb.rpc('purge_trash').then(() => {}, () => {});
  const [{ data: designs, error }, { data: comments }, { data: reads }] = await Promise.all([
    sb.from('designs').select('id, name, owner_id, updated_at, updated_by, allow_edit, deleted_at, data').order('updated_at', { ascending: false }),
    sb.from('comments').select('design_id, created_at, author_id'),
    sb.from('comment_reads').select('design_id, last_read_at'),
  ]);
  if (error) { toast("Couldn't load gardens"); console.error(error); return; }
  const lastRead = Object.fromEntries((reads || []).map(r => [r.design_id, r.last_read_at]));
  const unread = {};
  for (const c of comments || []) {
    if (c.author_id === S.me) continue;
    if (!lastRead[c.design_id] || c.created_at > lastRead[c.design_id]) unread[c.design_id] = (unread[c.design_id] || 0) + 1;
  }
  const live = designs.filter(d => !d.deleted_at);
  const trash = designs.filter(d => d.deleted_at && d.owner_id === S.me);

  const card = d => `<div class="design-card" data-open="${d.id}">
      <div class="thumb">${thumbSvg(d.data)}</div>
      <div class="info"><h3>${esc(d.name)}${d.allow_edit ? '<span class="pill">shared editing</span>' : ''}</h3>
        <div class="meta">by ${esc(d.owner_id === S.me ? 'you' : nameOf(d.owner_id))} · edited ${ago(d.updated_at)}</div></div>
      ${unread[d.id] ? `<span class="badge" title="New comments">!</span>` : ''}
      <button class="small" data-dup="${d.id}" title="Duplicate">Duplicate</button>
    </div>`;

  app.innerHTML = `<div class="home">
    <header><img src="icons/icon-512.png" alt=""><div style="flex:1"><h1>GardenBud</h1>
      <div class="muted">Hi ${esc(nameOf(S.me))} 👋</div></div>
      <button class="icon" id="settingsBtn" title="Settings">⚙️</button></header>
    <div class="actions">
      <button class="primary" id="newBtn">+ New garden</button>
      <button id="inviteBtn">Invite a friend</button>
      <button id="importBtn">Import file</button>
      <input type="file" id="importIn" accept=".json,application/json" hidden>
    </div>
    <div class="designs">${live.length ? live.map(card).join('') : `<div class="empty">No gardens yet. Start one with <b>+ New garden</b>.</div>`}</div>
    ${trash.length ? `<div class="section-title">Trash (kept 30 days)</div><div class="designs">${trash.map(d => `
      <div class="design-card" style="cursor:default"><div class="info"><h3>${esc(d.name)}</h3>
        <div class="meta">deleted ${ago(d.deleted_at)}</div></div>
        <button class="small" data-restore="${d.id}">Restore</button>
        <button class="small danger" data-purge="${d.id}">Delete forever</button></div>`).join('')}</div>` : ''}
  </div>`;

  $$('[data-open]').forEach(el => el.onclick = e => { if (e.target.closest('button')) return; setHash('d=' + el.dataset.open); });
  $$('[data-dup]').forEach(b => b.onclick = () => duplicateDesign(designs.find(d => d.id === b.dataset.dup)));
  $$('[data-restore]').forEach(b => b.onclick = async () => {
    const { error } = await sb.from('designs').update({ deleted_at: null }).eq('id', b.dataset.restore);
    if (error) return toast("Couldn't restore");
    toast('Restored'); renderHome();
  });
  $$('[data-purge]').forEach(b => b.onclick = () => confirmModal('Delete forever?', 'This garden and its comments will be gone for good.', 'Delete forever', async () => {
    const { error } = await sb.from('designs').delete().eq('id', b.dataset.purge);
    if (error) return toast("Couldn't delete");
    renderHome();
  }));
  $('#newBtn').onclick = newGardenModal;
  $('#inviteBtn').onclick = inviteModal;
  $('#settingsBtn').onclick = settingsModal;
  $('#importBtn').onclick = () => $('#importIn').click();
  $('#importIn').onchange = importFile;
}

function confirmModal(title, text, okLabel, onOk) {
  openModal(`<h2>${esc(title)}</h2><p class="muted" style="margin:0">${esc(text)}</p>
    <div class="row"><span class="spacer"></span><button id="cmCancel">Cancel</button><button class="primary" id="cmOk">${esc(okLabel)}</button></div>`);
  $('#cmCancel').onclick = closeModal;
  $('#cmOk').onclick = () => { closeModal(); onOk(); };
}

async function duplicateDesign(d) {
  if (!d) return;
  let full = d;
  if (!('notes' in d)) {
    const { data } = await sb.from('designs').select('name, data, notes').eq('id', d.id).single();
    full = data || d;
  }
  const { data, error } = await sb.from('designs').insert({
    owner_id: S.me, name: ('Copy of ' + full.name).slice(0, 80), data: full.data, notes: full.notes || '',
  }).select('id').single();
  if (error) { console.error(error); return toast("Couldn't duplicate"); }
  toast('Duplicated. This copy is yours to edit.');
  setHash('d=' + data.id);
}

function newGardenModal() {
  const u = unitLabel();
  openModal(`<h2>New garden</h2>
    <label>Name<input type="text" id="ngName" maxlength="80" placeholder="e.g. Back patio"></label>
    <div class="row">
      <label>Starting shape<select id="ngShape"><option value="rect">Rectangle</option><option value="circle">Circle</option></select></label>
      <label>Width (${u})<input type="number" id="ngW" value="${toDisp(300)}" min="1"></label>
      <label id="ngHl">Length (${u})<input type="number" id="ngH" value="${toDisp(200)}" min="1"></label>
    </div>
    <p class="muted" style="margin:0;font-size:13px">Next you can add more rectangles and circles, which join together for L-shapes and odd spaces, plus cut-outs for trees, furniture or structures like a chicken coop. You can change the shape any time.</p>
    <div class="row"><span class="spacer"></span><button id="ngCancel">Cancel</button><button class="primary" id="ngOk">Create</button></div>`);
  $('#ngShape').onchange = () => { $('#ngHl').hidden = $('#ngShape').value === 'circle'; };
  $('#ngCancel').onclick = closeModal;
  $('#ngOk').onclick = async () => {
    const name = $('#ngName').value.trim() || 'My garden';
    const kind = $('#ngShape').value;
    const w = clamp(Math.round(fromDisp($('#ngW').value)), 20, 10000);
    const h = kind === 'circle' ? w : clamp(Math.round(fromDisp($('#ngH').value)), 20, 10000);
    const data = { v: 1, north: 0, shapes: [{ id: uid(), kind, cut: false, x: 40, y: 40, w, h }], labels: [], items: [] };
    const { data: row, error } = await sb.from('designs').insert({ owner_id: S.me, name, data }).select('id').single();
    if (error) { console.error(error); return toast("Couldn't create the garden"); }
    closeModal();
    S.nextMode = 'shape';
    setHash('d=' + row.id);
  };
  $('#ngName').focus();
}

async function inviteModal() {
  const { data: code } = await sb.rpc('get_invite_code');
  const url = `${BASE}#join=${code}`;
  openModal(`<h2>Invite a friend</h2>
    <p class="muted" style="margin:0">Anyone with this link can join and see every garden here. Send it by text.</p>
    <div class="linkbox">${esc(url)}</div>
    <div class="row"><button class="primary" id="invShare">Share link</button>
      ${S.isAdmin ? '<button id="invNew" class="danger">Make a new link</button>' : ''}
      <span class="spacer"></span><button id="invClose">Close</button></div>
    ${S.isAdmin ? '<p class="muted" style="margin:0;font-size:12px">Making a new link stops the old one from letting new people in. People already in keep their access.</p>' : ''}`);
  $('#invShare').onclick = () => shareLink(url, 'Join me on GardenBud to plan our gardens 🌱');
  $('#invClose').onclick = closeModal;
  if ($('#invNew')) $('#invNew').onclick = async () => {
    const { error } = await sb.rpc('regenerate_invite');
    if (error) return toast("Couldn't make a new link");
    toast('New invite link made'); inviteModal();
  };
}

function settingsModal() {
  const me = S.members[S.me];
  openModal(`<h2>Settings</h2>
    <label>Your first name<input type="text" id="stName" maxlength="40" value="${esc(me.first_name)}"></label>
    <label>Units<select id="stUnits"><option value="metric">Metric (cm, m)</option><option value="imperial">Imperial (in, ft)</option></select></label>
    <div class="row"><button class="primary" id="stSave">Save</button></div>
    <hr style="border:0;border-top:1px solid var(--line);width:100%">
    <div><b>Use GardenBud on another device</b>
      <p class="muted" style="margin:4px 0 8px;font-size:13px">Makes a one-time link (good for 15 minutes) that signs another phone or computer in as you. Also use this if you added GardenBud to your iPhone home screen.</p>
      <button id="stDevice">Make a device link</button><div id="stDeviceOut"></div></div>
    <div class="row"><span class="spacer"></span><button id="stClose">Close</button></div>`);
  $('#stUnits').value = me.units;
  $('#stClose').onclick = closeModal;
  $('#stSave').onclick = async () => {
    const first_name = $('#stName').value.trim();
    if (!first_name) return toast('Add your first name');
    const { error } = await sb.from('members').update({ first_name, units: $('#stUnits').value }).eq('id', S.me);
    if (error) return toast("Couldn't save");
    Object.assign(S.members[S.me], { first_name, units: $('#stUnits').value });
    closeModal(); toast('Saved'); route();
  };
  $('#stDevice').onclick = async () => {
    const { data: code, error } = await sb.rpc('create_device_link');
    if (error) return toast("Couldn't make a link");
    const url = `${BASE}#device=${code}`;
    $('#stDeviceOut').innerHTML = `<div class="linkbox" style="margin-top:8px">${esc(url)}</div>
      <div class="row" style="margin-top:6px"><button class="small primary" id="stDevShare">Copy / share</button></div>`;
    $('#stDevShare').onclick = () => shareLink(url, 'My GardenBud device link');
  };
}

async function importFile(e) {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (!j.gardenbud || !j.data) throw new Error('not a GardenBud file');
    const { data, error } = await sb.from('designs').insert({
      owner_id: S.me, name: String(j.name || 'Imported garden').slice(0, 80), data: j.data, notes: j.notes || '',
    }).select('id').single();
    if (error) throw error;
    toast('Imported');
    setHash('d=' + data.id);
  } catch (err) { console.error(err); toast("That file couldn't be imported"); }
}

// ---------------------------------------------------------------- drawing
function bounds(data) {
  let r = 0, b = 0;
  const all = [...(data.shapes || []), ...(data.items || [])];
  for (const o of all) { r = Math.max(r, o.x + o.w); b = Math.max(b, o.y + o.h); }
  for (const l of data.labels || []) { r = Math.max(r, l.x + (l.text || '').length * 5); b = Math.max(b, l.y + 6); }
  return { r, b };
}
const CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
// Which edge or corner of a shape is under the pointer (within tol cm), or ''
function edgeHit(o, p, tol, isCircle) {
  if (isCircle) {
    const r = o.w / 2, cx = o.x + r, cy = o.y + r, dx = p.x - cx, dy = p.y - cy;
    if (Math.abs(Math.hypot(dx, dy) - r) > tol) return '';
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : (dy > 0 ? 's' : 'n');
  }
  let d = '';
  if (Math.abs(p.y - o.y) <= tol) d += 'n'; else if (Math.abs(p.y - (o.y + o.h)) <= tol) d += 's';
  if (Math.abs(p.x - o.x) <= tol) d += 'w'; else if (Math.abs(p.x - (o.x + o.w)) <= tol) d += 'e';
  return d;
}
// Each shape plays one role:
//  space = the outline of the whole area (pieces that touch join into one outline)
//  zone  = a patio, seating or dining area inside the space (gray)
//  bed   = a garden bed (green)
//  cut   = something you can't plant on: house, tree, coop (hatched)
const inside = (o, s) => s.x >= o.x && s.y >= o.y && s.x + s.w <= o.x + o.w && s.y + s.h <= o.y + o.h;
function roleOf(s, shapes) {
  if (s.cut) return 'cut';
  if (s.role) return s.role;
  if (s.bed === true) return 'bed';
  // anything drawn fully inside a bigger space outline is a zone
  const outer = shapes.some(o => o !== s && !o.cut && o.bed !== true && (!o.role || o.role === 'space')
    && inside(o, s) && o.w * o.h > s.w * s.h);
  return outer ? 'zone' : 'space';
}
const isBed = (s, shapes) => roleOf(s, shapes) === 'bed';
function shapeTag(s, attrs) {
  return s.kind === 'circle'
    ? `<ellipse cx="${s.x + s.w / 2}" cy="${s.y + s.h / 2}" rx="${s.w / 2}" ry="${s.h / 2}" ${attrs}/>`
    : `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" ${attrs}/>`;
}
function fitText(name, w, h, fs) {
  const max = Math.floor((w - 2) / (fs * 0.56));
  if (max < 2 || h < fs * 1.05) return '';
  return name.length > max ? name.slice(0, Math.max(1, max - 1)) + '…' : name;
}

// Full drawing as an SVG string.
// opts: scale (px per cm), cw/ch canvas size in cm, mode, sel, selShape, selLabel, grid, title
function drawSvg(data, o) {
  const sc = o.scale, cw = o.cw, ch = o.ch, fk = o.fontBoost || 1;
  const nss = 'vector-effect="non-scaling-stroke"';
  const out = [];
  const titleH = o.title ? 90 / sc : 0;
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(cw * sc)}" height="${Math.round((ch + titleH) * sc)}" viewBox="0 ${-titleH} ${cw} ${ch + titleH}" font-family="-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif">`);
  const dot = 8 / sc;
  out.push(`<defs><pattern id="bed" width="${dot}" height="${dot}" patternUnits="userSpaceOnUse">
    <rect width="100%" height="100%" fill="#d9eac4"/><circle cx="${dot / 2}" cy="${dot / 2}" r="${1.1 / sc}" fill="#9cc47e"/></pattern></defs>`);
  out.push(`<defs><pattern id="hatch" width="${10 / sc * 1.2}" height="${10 / sc * 1.2}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <rect width="100%" height="100%" fill="#e4dccb"/><line x1="0" y1="0" x2="0" y2="${10 / sc * 1.2}" stroke="#b9ad93" stroke-width="${3 / sc}"/></pattern></defs>`);
  out.push(`<rect x="0" y="${-titleH}" width="${cw}" height="${ch + titleH}" fill="${o.title ? '#ffffff' : '#e8ebe2'}"/>`);
  if (o.title) {
    out.push(`<text x="${12 / sc}" y="${-titleH + 38 / sc}" font-size="${28 / sc}" font-weight="700" fill="#23271f">${esc(o.title)}</text>`);
    out.push(`<text x="${12 / sc}" y="${-titleH + 68 / sc}" font-size="${16 / sc}" fill="#6b6f66">${esc(o.subtitle || '')}</text>`);
  }
  // grid
  if (o.grid !== false) {
    const imp = units() === 'imperial';
    // pick a grid spacing that stays readable at this zoom (at least ~14 px apart)
    const steps = imp ? [[30.48, 5], [152.4, 2], [304.8, 5], [1524, 2], [3048, 5]] : [[50, 2], [100, 5], [500, 2], [1000, 5], [5000, 2]];
    let [step, labelEvery] = steps.find(([st]) => st * sc >= 14) || steps[steps.length - 1];
    if (step * labelEvery * sc < 45) labelEvery *= 2;
    for (let i = 1, x = step; x < cw; i++, x += step) {
      const major = i % labelEvery === 0;
      out.push(`<line x1="${x}" y1="0" x2="${x}" y2="${ch}" stroke="rgba(0,0,0,${major ? .12 : .05})" stroke-width="1" ${nss}/>`);
      if (major) out.push(`<text x="${x + 3 / sc}" y="${ch - 4 / sc}" font-size="${10 / sc}" fill="rgba(0,0,0,.35)">${imp ? Math.round(x / 30.48) + ' ft' : (x / 100) + ' m'}</text>`);
    }
    for (let i = 1, y = step; y < ch; i++, y += step) {
      const major = i % labelEvery === 0;
      out.push(`<line x1="0" y1="${y}" x2="${cw}" y2="${y}" stroke="rgba(0,0,0,${major ? .12 : .05})" stroke-width="1" ${nss}/>`);
    }
  }
  // garden area: outline pass, then fill pass, so overlapping shapes merge into one outline
  const shapes = data.shapes || [];
  const by = r => shapes.filter(s => roleOf(s, shapes) === r);
  const adds = by('space'), zones = by('zone'), beds = by('bed'), cuts = by('cut');
  const interShapes = o.mode === 'shape';
  out.push('<g>');
  adds.forEach(s => out.push(shapeTag(s, `fill="none" stroke="#5b5f52" stroke-width="5" ${nss}`)));
  adds.forEach(s => out.push(shapeTag(s, `fill="#f7f2e2" ${interShapes ? `data-shape="${s.id}" class="shape-sel"` : ''}`)));
  adds.filter(s => s.label).forEach(s => {
    const fs = 12 * fk / sc;
    out.push(`<text x="${s.x + 6 / sc}" y="${s.y + fs + 4 / sc}" font-size="${fs}" font-weight="600" fill="#8a8470" pointer-events="none">${esc(s.label)}</text>`);
  });
  const filled = (list, fill, stroke, ink) => list.forEach(s => {
    out.push(shapeTag(s, `fill="${fill}" stroke="${stroke}" stroke-width="2.5" ${nss} ${interShapes ? `data-shape="${s.id}" class="shape-sel"` : ''}`));
    if (s.label) {
      const fs = clamp(12 * fk / sc, 2, Math.min(s.w, s.h) / 3);
      const t = fitText(s.label, s.w, s.h, fs);
      if (t) out.push(`<text x="${s.x + s.w / 2}" y="${s.y + s.h / 2}" font-size="${fs}" font-weight="600" text-anchor="middle" dominant-baseline="central" fill="${ink}" pointer-events="none">${esc(t)}</text>`);
    }
  });
  filled(zones, '#e3e1db', '#7d8077', '#4a4d45');
  filled(beds, 'url(#bed)', '#4e8f3a', '#2f5e27');
  cuts.forEach(s => {
    out.push(shapeTag(s, `fill="url(#hatch)" stroke="#8a7f66" stroke-width="1.5" stroke-dasharray="5 4" ${nss} ${interShapes ? `data-shape="${s.id}" class="shape-sel"` : ''}`));
    if (s.label) {
      const fs = clamp(12 / sc, 2, Math.min(s.w, s.h) / 3);
      const t = fitText(s.label, s.w, s.h, fs);
      if (t) out.push(`<text x="${s.x + s.w / 2}" y="${s.y + s.h / 2}" font-size="${fs}" text-anchor="middle" dominant-baseline="central" fill="#6e6450" pointer-events="none">${esc(t)}</text>`);
    }
  });
  out.push('</g>');
  // labels
  (data.labels || []).forEach(l => {
    const fs = 13 * fk / sc;
    const sel = o.selLabel === l.id;
    out.push(`<text x="${l.x}" y="${l.y}" font-size="${fs}" font-weight="700" letter-spacing="${fs * 0.04}" fill="${sel ? '#b07d00' : '#55594f'}" ${interShapes ? `data-label="${l.id}" class="shape-sel"` : 'pointer-events="none"'}>${esc(l.text)}</text>`);
  });
  // items (furniture first)
  const items = [...(data.items || [])].sort((a, b) => (a.cat === 'fixed' ? 0 : 1) - (b.cat === 'fixed' ? 0 : 1));
  out.push(`<g ${interShapes ? 'opacity=".35" pointer-events="none"' : ''}>`);
  for (const it of items) {
    const c = CATS[it.cat] || CATS.other;
    const under = /table/i.test(it.name) && it.cat === 'fixed';
    const sel = o.sel === it.id;
    const fill = `fill="${c.color}" fill-opacity="${under ? .35 : it.cat === 'fixed' ? .8 : .92}"`;
    const stroke = sel ? `stroke="#f2b400" stroke-width="3.5" ${nss}` : `stroke="rgba(0,0,0,.4)" stroke-width="1.2" ${under ? 'stroke-dasharray="4 3"' : ''} ${nss}`;
    out.push(`<g class="itm" data-id="${it.id}">${shapeTag(it.shape === 'circle' ? { ...it, kind: 'circle' } : it, `${fill} ${stroke}`)}`);
    const fs = clamp(11 * fk / sc, 1.2, Math.min(it.w, it.h) * 0.42);
    const t = fitText(it.name, it.w, it.h, fs);
    if (t) out.push(`<text x="${it.x + it.w / 2}" y="${it.y + it.h / 2}" font-size="${fs}" text-anchor="middle" dominant-baseline="central" fill="${it.cat === 'fixed' ? '#23271f' : '#fff'}" pointer-events="none">${esc(t)}</text>`);
    out.push('</g>');
  }
  out.push('</g>');
  // selected shape or item: outline + resize handles on corners and sides
  const handles = (b, isCircle) => {
    const hs = 6 / sc;
    const dirs = isCircle ? ['n', 'e', 's', 'w'] : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    for (const dir of dirs) {
      const hx = dir.includes('w') ? b.x : dir.includes('e') ? b.x + b.w : b.x + b.w / 2;
      const hy = dir.includes('n') ? b.y : dir.includes('s') ? b.y + b.h : b.y + b.h / 2;
      out.push(`<rect data-hdir="${dir}" x="${hx - hs}" y="${hy - hs}" width="${hs * 2}" height="${hs * 2}" rx="${hs * .3}" fill="#fff" stroke="#f2b400" stroke-width="2" ${nss} style="cursor:${CURSORS[dir]}"/>`);
    }
  };
  if (interShapes && o.selShape) {
    const s = shapes.find(x => x.id === o.selShape);
    if (s) {
      out.push(shapeTag(s, `fill="none" stroke="#f2b400" stroke-width="3" ${nss} pointer-events="none"`));
      if (o.canEdit) handles(s, s.kind === 'circle');
    }
  }
  if (!interShapes && o.sel && o.canEdit) {
    const it = (data.items || []).find(x => x.id === o.sel);
    if (it) handles(it, it.shape === 'circle');
  }
  out.push('</svg>');
  return out.join('');
}

function thumbSvg(data) {
  if (!data || !data.shapes) return '';
  const { r, b } = bounds(data);
  const w = Math.max(r + 20, 50), h = Math.max(b + 20, 30);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">`];
  const sh = data.shapes || [];
  sh.filter(s => roleOf(s, sh) === 'space').forEach(s => parts.push(shapeTag(s, 'fill="#f7f2e2" stroke="#8b8f80" stroke-width="2" vector-effect="non-scaling-stroke"')));
  sh.filter(s => roleOf(s, sh) === 'zone').forEach(s => parts.push(shapeTag(s, 'fill="#dedbd3" stroke="#8b8f80" stroke-width="1.5" vector-effect="non-scaling-stroke"')));
  sh.filter(s => isBed(s, sh)).forEach(s => parts.push(shapeTag(s, 'fill="#cfe3b6" stroke="#4e8f3a" stroke-width="1.5" vector-effect="non-scaling-stroke"')));
  (data.shapes || []).filter(s => s.cut).forEach(s => parts.push(shapeTag(s, 'fill="#ddd3bd"')));
  (data.items || []).forEach(it => parts.push(shapeTag(it.shape === 'circle' ? { ...it, kind: 'circle' } : it, `fill="${(CATS[it.cat] || CATS.other).color}"`)));
  parts.push('</svg>');
  return parts.join('');
}

// ---------------------------------------------------------------- editor
async function openDesign(id) {
  closeSheet(); closeModal();
  const { data: d, error } = await sb.from('designs').select('*').eq('id', id).maybeSingle();
  if (error || !d) { toast("That garden isn't available"); return setHash(''); }
  const { data: rd } = await sb.from('comment_reads').select('last_read_at').eq('design_id', id).maybeSingle();
  const isOwner = d.owner_id === S.me;
  const ed = S.ed = {
    d, data: d.data && d.data.shapes ? d.data : { v: 1, north: 0, shapes: [], labels: [], items: [] },
    isOwner, canEdit: !d.deleted_at && (isOwner || d.allow_edit),
    mode: S.nextMode || ((d.data?.shapes || []).length ? 'items' : 'shape'),
    tool: 'select', sel: null, selShape: null, selLabel: null,
    scale: 1, fitBase: 1, cw: 0, ch: 0, undo: [], snap: '', dirty: false, saveTimer: null,
    comments: [], lastRead: rd?.last_read_at || null, drag: null, pinch: null,
  };
  S.nextMode = null;
  for (const k of ['shapes', 'labels', 'items']) ed.data[k] = ed.data[k] || [];
  if (ed.data.north == null) ed.data.north = 0;
  ed.snap = JSON.stringify(ed.data);
  renderEditorShell();
  fitZoom();
  loadComments();
}

function renderEditorShell() {
  const ed = S.ed;
  app.innerHTML = `<div class="editor">
    <div class="topbar">
      <button class="icon" id="backBtn" title="All gardens">←</button>
      <span class="title" id="edTitle">${esc(ed.d.name)}</span>
      <span class="muted hide-sm" style="font-size:13px">by ${esc(ed.isOwner ? 'you' : nameOf(ed.d.owner_id))}</span>
      <span class="status" id="saveStatus"></span>
      <span class="spacer"></span>
      ${ed.canEdit ? '<button class="icon" id="undoBtn" title="Undo (Ctrl+Z)">↶</button>' : ''}
      <button id="moreBtn">⋯ More</button>
    </div>
    <div class="toolbar2" id="toolbar2"></div>
    <div id="banner"></div>
    <div class="stage-wrap">
      <div class="stage" id="stage"></div>
      <div class="fab-col">
        <button class="fab" id="notesBtn" title="Notes">📝</button>
        <button class="fab" id="commentsBtn" title="Comments">💬<span class="badge" id="cBadge" hidden>!</span></button>
      </div>
      <div class="north" id="north" title="North"></div>
    </div>
  </div>
  <aside class="panel" id="notesPanel"><header><h2>Notes</h2><button class="ghost" data-close>✕</button></header>
    <div class="body"><textarea class="notes" id="notesTa" placeholder="${ed.canEdit ? 'Plans, ideas, what to plant where…' : 'No notes yet.'}" ${ed.canEdit ? '' : 'readonly'}></textarea></div></aside>
  <aside class="panel" id="commentsPanel"><header><h2>Comments</h2><button class="ghost" data-close>✕</button></header>
    <div class="body" id="cList"></div>
    <footer><textarea id="cInput" rows="2" placeholder="Write a comment…" style="flex:1"></textarea><button class="primary" id="cSend">Send</button></footer></aside>`;

  $('#backBtn').onclick = () => setHash('');
  $('#moreBtn').onclick = moreSheet;
  if ($('#undoBtn')) $('#undoBtn').onclick = undo;
  $('#notesTa').value = ed.d.notes || '';
  $('#notesTa').oninput = e => { ed.d.notes = e.target.value; scheduleSave(); };
  $('#notesBtn').onclick = () => togglePanel('notesPanel');
  $('#commentsBtn').onclick = () => { togglePanel('commentsPanel'); if ($('#commentsPanel').classList.contains('open')) { loadComments(true); } };
  $$('[data-close]').forEach(b => b.onclick = () => { b.closest('.panel').classList.remove('open'); document.body.classList.remove('panel-open'); });
  $('#cSend').onclick = sendComment;
  wireStage();
  renderToolbar();
  setStatus(ed.canEdit ? '' : 'View only');
}

function togglePanel(id) {
  const p = $('#' + id), open = !p.classList.contains('open');
  $$('.panel').forEach(x => x.classList.remove('open'));
  if (open) p.classList.add('open');
  document.body.classList.toggle('panel-open', open);
}

function renderToolbar() {
  const ed = S.ed, t = ed.tool;
  const tb = $('#toolbar2');
  const tool = (k, label, title) => `<button class="small ${t === k ? 'active' : ''}" data-tool="${k}" title="${title}">${label}</button>`;
  tb.innerHTML = `
    <span class="seg"><button class="small ${ed.mode === 'items' ? 'active' : ''}" data-mode="items">🪴 Plants &amp; pots</button><button class="small ${ed.mode === 'shape' ? 'active' : ''}" data-mode="shape">📐 Garden shape</button></span>
    ${ed.canEdit && ed.mode === 'items' ? '<button class="small primary" id="addItemBtn">+ Add</button>' : ''}
    ${ed.canEdit && ed.mode === 'shape' ? `
      ${tool('select', '✋ Select', 'Select and move')}
      ${tool('rect', '▭ Space', 'Drag to draw the outline of the space (yard, patio, balcony)')}
      ${tool('circle', '◯ Space', 'Drag to draw a round part of the space')}
      ${tool('zonerect', '▦ Zone', 'Drag to draw a patio, seating or dining area')}
      ${tool('bedrect', '🌱 ▭ Bed', 'Drag to draw a rectangular garden bed')}
      ${tool('bedcircle', '🌱 ◯ Bed', 'Drag to draw a round garden bed')}
      ${tool('cutrect', '▭ Cut-out', 'Drag to cut out a rectangle (tree, coop, furniture)')}
      ${tool('cutcircle', '◯ Cut-out', 'Drag to cut out a circle')}
      ${tool('label', 'T Label', 'Tap to place a label')}
      <button class="small" id="northBtn" title="Rotate the north arrow">🧭 North</button>` : ''}
    <span class="spacer"></span>
    <span class="zoom"><button class="small icon" id="zOut" title="Zoom out">−</button><span class="pct" id="zPct"></span>
      <button class="small icon" id="zIn" title="Zoom in">+</button><button class="small" id="zFit">Fit</button></span>`;
  $$('[data-mode]', tb).forEach(b => b.onclick = () => {
    ed.mode = b.dataset.mode; ed.tool = 'select'; ed.sel = ed.selShape = ed.selLabel = null; closeSheet();
    renderToolbar(); renderCanvas();
  });
  $$('[data-tool]', tb).forEach(b => b.onclick = () => { ed.tool = b.dataset.tool; ed.selShape = ed.selLabel = null; closeSheet(); renderToolbar(); renderCanvas(); });
  if ($('#addItemBtn')) $('#addItemBtn').onclick = addItemSheet;
  if ($('#northBtn')) $('#northBtn').onclick = () => { ed.data.north = ((ed.data.north || 0) + 45) % 360; commit(); renderNorth(); };
  $('#zIn').onclick = () => zoomTo(ed.scale * 1.25);
  $('#zOut').onclick = () => zoomTo(ed.scale / 1.25);
  $('#zFit').onclick = fitZoom;
  updatePct();
  renderBanner();
}

function renderBanner() {
  const ed = S.ed, b = $('#banner');
  let msg = '';
  if (ed.d.deleted_at) msg = 'This garden is in the Trash. Restore it from the home page to edit.';
  else if (!ed.canEdit) msg = `View only. ${esc(nameOf(ed.d.owner_id))} hasn't turned on editing for others. Use ⋯ More → Duplicate to make your own copy.`;
  else if (ed.mode === 'shape') {
    msg = {
      select: 'Tap a shape or label to edit it. Drag the middle to move it. Drag an edge to stretch that side, or a corner to stretch both ways.',
      rect: 'Drag to draw the outline of your space. Touching or overlapping pieces join into one outline (great for L-shapes).',
      circle: 'Drag to draw a round part of your space.',
      zonerect: 'Drag to draw a zone like a patio, dining or chill area. Zones show in gray. (A Space drawn inside your space becomes a zone too.)',
      bedrect: 'Drag to draw a garden bed. Beds show in green so you can see them inside your space.',
      bedcircle: 'Drag to draw a round garden bed.',
      cutrect: 'Drag to cut out a rectangle, like a tree, chicken coop or shed.',
      cutcircle: 'Drag to cut out a circle, like a tree trunk.',
      label: 'Tap where you want a label (Fence, House, Railing…).',
    }[ed.tool];
  }
  b.innerHTML = msg ? `<div class="banner">${msg}</div>` : '';
}

function renderNorth() {
  $('#north').innerHTML = `<svg width="44" height="44" viewBox="-22 -22 44 44" style="transform:rotate(${S.ed.data.north || 0}deg)">
    <polygon points="0,-12 6,6 0,2 -6,6" fill="#b03a2e"/><polygon points="0,12 6,6 0,2 -6,6" fill="#c9ccc4"/>
    <text x="0" y="-14" font-size="10" font-weight="700" text-anchor="middle" fill="#b03a2e">N</text></svg>`;
}

function canvasSize() {
  const ed = S.ed, { r, b } = bounds(ed.data);
  ed.cw = Math.max(ed.cw, r + 80, 300);
  ed.ch = Math.max(ed.ch, b + 80, 200);
}
function renderCanvas() {
  const ed = S.ed; if (!ed) return;
  canvasSize();
  const st = $('#stage');
  st.classList.toggle('readonly', !ed.canEdit);
  st.innerHTML = drawSvg(ed.data, { scale: ed.scale, cw: ed.cw, ch: ed.ch, mode: ed.mode, sel: ed.sel, selShape: ed.selShape, selLabel: ed.selLabel, canEdit: ed.canEdit });
  renderNorth();
}

// ---------------------------------------------------------------- zoom
function updatePct() { const p = $('#zPct'); if (p && S.ed) p.textContent = Math.round(S.ed.scale / S.ed.fitBase * 100) + '%'; }
function fitZoom() {
  const ed = S.ed, st = $('#stage');
  canvasSize();
  const sc = Math.min((st.clientWidth - 60) / ed.cw, (st.clientHeight - 60) / ed.ch);
  ed.scale = ed.fitBase = clamp(sc, 0.01, 8);
  renderCanvas(); updatePct();
  st.scrollLeft = 0; st.scrollTop = 0;
}
function zoomTo(next, fx, fy) {
  const ed = S.ed, st = $('#stage');
  next = clamp(next, ed.fitBase * 0.4, Math.max(12, ed.fitBase * 4));
  if (Math.abs(next - ed.scale) < 1e-4) return;
  const svg = $('svg', st); const r = svg.getBoundingClientRect(), sr = st.getBoundingClientRect();
  if (fx == null) { fx = sr.left + st.clientWidth / 2; fy = sr.top + st.clientHeight / 2; }
  const cx = (fx - r.left) / ed.scale, cy = (fy - r.top) / ed.scale;
  ed.scale = next; renderCanvas(); updatePct();
  const r2 = $('svg', st).getBoundingClientRect();
  st.scrollLeft += (r2.left + cx * ed.scale) - fx;
  st.scrollTop += (r2.top + cy * ed.scale) - fy;
}

// ---------------------------------------------------------------- pointer interaction
function toCm(e) {
  const r = $('#stage svg').getBoundingClientRect();
  return { x: (e.clientX - r.left) / S.ed.scale, y: (e.clientY - r.top) / S.ed.scale };
}
const snap = (v, s) => Math.round(v / s) * s;

function hitInteractive(target) {
  const ed = S.ed; if (!ed || !ed.canEdit) return false;
  if (ed.mode === 'items') return !!target.closest('.itm,[data-hdir]');
  if (ed.tool !== 'select') return true;
  return !!target.closest('[data-shape],[data-hdir],[data-label]');
}

function wireStage() {
  const st = $('#stage');
  // stop the page from scrolling when a finger starts on something draggable
  st.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      const ed = S.ed; ed.drag = null; ed.pinching = true;
      const [a, b] = e.touches;
      ed.pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), s: ed.scale };
      e.preventDefault(); return;
    }
    if (hitInteractive(e.target)) e.preventDefault();
  }, { passive: false });
  st.addEventListener('touchmove', e => {
    const ed = S.ed;
    if (ed.pinch && e.touches.length === 2) {
      e.preventDefault();
      const [a, b] = e.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      zoomTo(ed.pinch.s * d / ed.pinch.d, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
    } else if (ed.drag) e.preventDefault();
  }, { passive: false });
  const endPinch = e => { const ed = S.ed; if (ed && e.touches.length < 2) { ed.pinch = null; setTimeout(() => { if (S.ed) S.ed.pinching = false; }, 60); } };
  st.addEventListener('touchend', endPinch);
  st.addEventListener('touchcancel', endPinch);
  st.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    zoomTo(S.ed.scale * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
  }, { passive: false });
  st.addEventListener('pointerdown', onDown);
  st.addEventListener('pointermove', onMove);
  st.addEventListener('pointerup', onUp);
  st.addEventListener('pointercancel', () => { if (S.ed) { S.ed.drag = null; renderCanvas(); } });
}

function onDown(e) {
  const ed = S.ed; if (!ed || ed.pinching || e.button > 0) return;
  if (!e.target.closest('svg')) return;
  const p = toCm(e), t = e.target;
  const start = { px: e.clientX, py: e.clientY, p, moved: false };
  const resizeDrag = (obj, dir, isItem) => ({ ...start, type: 'resize', obj, dir, isItem,
    ox: obj.x, oy: obj.y, ow: obj.w, oh: obj.h, circle: isItem ? obj.shape === 'circle' : obj.kind === 'circle' });
  const hd = t.closest('[data-hdir]');
  if (ed.mode === 'items') {
    if (hd && ed.canEdit && ed.sel) {
      const it = ed.data.items.find(i => i.id === ed.sel);
      if (it) { ed.drag = resizeDrag(it, hd.dataset.hdir, true); try { $('#stage').setPointerCapture(e.pointerId); } catch (_) {} return; }
    }
    const g = t.closest('.itm');
    if (!g) { if (ed.sel) { ed.sel = null; closeSheet(); renderCanvas(); } return; }
    const it = ed.data.items.find(i => i.id === g.dataset.id);
    // grab the edge of the selected item to resize it (only if it's big enough on screen to also move)
    const tol = Math.min(8 / ed.scale, Math.min(it.w, it.h) * 0.2);
    const dir = ed.canEdit && ed.sel === it.id ? edgeHit(it, p, tol, it.shape === 'circle') : '';
    ed.drag = dir ? resizeDrag(it, dir, true) : { ...start, type: 'item', it, ox: it.x, oy: it.y };
  } else {
    if (!ed.canEdit) return;
    if (ed.tool === 'select') {
      const s = t.closest('[data-shape]'), l = t.closest('[data-label]');
      const selSh = ed.selShape && ed.data.shapes.find(x => x.id === ed.selShape);
      if (hd && selSh) ed.drag = resizeDrag(selSh, hd.dataset.hdir, false);
      else if (s) {
        const sh = ed.data.shapes.find(x => x.id === s.dataset.shape);
        // grab any edge or corner of a shape to resize it, or the middle to move it
        const dir = edgeHit(sh, p, Math.min(10 / ed.scale, Math.min(sh.w, sh.h) * 0.25), sh.kind === 'circle');
        ed.drag = dir ? resizeDrag(sh, dir, false) : { ...start, type: 'shape', sh, ox: sh.x, oy: sh.y };
      }
      else if (l) { const lb = ed.data.labels.find(x => x.id === l.dataset.label); ed.drag = { ...start, type: 'label', lb, ox: lb.x, oy: lb.y }; }
      else { if (ed.selShape || ed.selLabel) { ed.selShape = ed.selLabel = null; closeSheet(); renderCanvas(); } return; }
    } else if (ed.tool === 'label') {
      ed.drag = { ...start, type: 'labeltap' };
    } else {
      const kind = ed.tool.includes('circle') ? 'circle' : 'rect';
      const sh = { id: uid(), kind, cut: ed.tool.startsWith('cut'), x: snap(p.x, 5), y: snap(p.y, 5), w: 0, h: 0 };
      if (ed.tool.startsWith('bed')) { sh.role = 'bed'; sh.label = ''; }
      if (ed.tool.startsWith('zone')) { sh.role = 'zone'; sh.label = ''; }
      if (sh.cut) sh.label = '';
      ed.data.shapes.push(sh);
      ed.drag = { ...start, type: 'draw', sh, x0: sh.x, y0: sh.y };
    }
  }
  try { $('#stage').setPointerCapture(e.pointerId); } catch (_) {}
}

function onMove(e) {
  const ed = S.ed; const d = ed && ed.drag;
  if (!d) { hoverCursor(e); return; }
  if (ed.pinching) { cancelDrag(); return; }
  const dxp = e.clientX - d.px, dyp = e.clientY - d.py;
  if (!d.moved && Math.hypot(dxp, dyp) < 5) return;
  if (!ed.canEdit && d.type === 'item') return;
  d.moved = true;
  const dx = dxp / ed.scale, dy = dyp / ed.scale, p = toCm(e);
  if (d.type === 'item') { d.it.x = Math.max(0, Math.round(d.ox + dx)); d.it.y = Math.max(0, Math.round(d.oy + dy)); ed.sel = d.it.id; }
  else if (d.type === 'shape') { d.sh.x = Math.max(0, snap(d.ox + dx, 5)); d.sh.y = Math.max(0, snap(d.oy + dy, 5)); ed.selShape = d.sh.id; }
  else if (d.type === 'label') { d.lb.x = Math.max(0, Math.round(d.ox + dx)); d.lb.y = Math.max(5, Math.round(d.oy + dy)); ed.selLabel = d.lb.id; }
  else if (d.type === 'resize') resizeObj(d, dx, dy); else if (d.type === 'draw') {
    let x1 = snap(p.x, 5), y1 = snap(p.y, 5);
    let w = Math.abs(x1 - d.x0), h = Math.abs(y1 - d.y0);
    if (d.sh.kind === 'circle') { w = h = Math.max(w, h); }
    d.sh.x = Math.max(0, x1 < d.x0 ? d.x0 - w : d.x0); d.sh.y = Math.max(0, y1 < d.y0 ? d.y0 - h : d.y0);
    d.sh.w = w; d.sh.h = h;
  }
  renderCanvas();
}

function hoverCursor(e) {
  const ed = S.ed, st = $('#stage'); if (!ed || !ed.canEdit || e.pointerType === 'touch' || !st) return;
  let cur = '';
  const t = e.target;
  if (ed.mode === 'shape' && ed.tool === 'select') {
    const s = t.closest && t.closest('[data-shape]');
    if (s) {
      const sh = ed.data.shapes.find(x => x.id === s.dataset.shape);
      const dir = sh && edgeHit(sh, toCm(e), Math.min(10 / ed.scale, Math.min(sh.w, sh.h) * 0.25), sh.kind === 'circle');
      if (dir) cur = CURSORS[dir];
    }
  } else if (ed.mode === 'items' && ed.sel) {
    const g = t.closest && t.closest('.itm');
    const it = g && g.dataset.id === ed.sel && ed.data.items.find(i => i.id === ed.sel);
    if (it) { const dir = edgeHit(it, toCm(e), Math.min(8 / ed.scale, Math.min(it.w, it.h) * 0.2), it.shape === 'circle'); if (dir) cur = CURSORS[dir]; }
  }
  st.style.cursor = cur;
}

function resizeObj(d, dx, dy) {
  const o = d.obj, step = d.isItem ? 1 : 5, min = d.isItem ? 3 : 10, dir = d.dir;
  const sn = v => Math.round(v / step) * step;
  if (d.circle) {
    // circles stay round: grow from the opposite side
    const grow = { e: dx, w: -dx, s: dy, n: -dy };
    const size0 = dir.length === 1 ? d.ow + grow[dir] : d.ow + Math.max(grow[dir[1]], grow[dir[0]]);
    let size = size0;
    size = Math.max(min, sn(size));
    o.w = o.h = size;
    o.x = dir.includes('w') ? d.ox + d.ow - size : dir.includes('e') ? d.ox : d.ox + (d.ow - size) / 2;
    o.y = dir.includes('n') ? d.oy + d.oh - size : dir.includes('s') ? d.oy : d.oy + (d.oh - size) / 2;
  } else {
    if (dir.includes('e')) o.w = Math.max(min, sn(d.ow + dx));
    if (dir.includes('w')) { o.w = Math.max(min, sn(d.ow - dx)); o.x = d.ox + d.ow - o.w; }
    if (dir.includes('s')) o.h = Math.max(min, sn(d.oh + dy));
    if (dir.includes('n')) { o.h = Math.max(min, sn(d.oh - dy)); o.y = d.oy + d.oh - o.h; }
  }
  if (o.x < 0) { o.w += o.x; o.x = 0; }
  if (o.y < 0) { o.h += o.y; o.y = 0; }
  if (d.isItem) S.ed.sel = o.id; else S.ed.selShape = o.id;
}

function cancelDrag() {
  const ed = S.ed, d = ed.drag; if (!d) return;
  if (d.type === 'item') { d.it.x = d.ox; d.it.y = d.oy; }
  if (d.type === 'shape') { d.sh.x = d.ox; d.sh.y = d.oy; }
  if (d.type === 'resize') Object.assign(d.obj, { x: d.ox, y: d.oy, w: d.ow, h: d.oh });
  if (d.type === 'draw') ed.data.shapes = ed.data.shapes.filter(s => s !== d.sh);
  ed.drag = null; renderCanvas();
}

function onUp(e) {
  const ed = S.ed; const d = ed && ed.drag; if (!d) return;
  ed.drag = null;
  if (d.type === 'draw') {
    if (d.sh.w < 10 || d.sh.h < 10) { ed.data.shapes = ed.data.shapes.filter(s => s !== d.sh); renderCanvas(); toast('Drag to draw a shape'); return; }
    commit(); ed.tool = 'select'; ed.selShape = d.sh.id; renderToolbar(); renderCanvas(); shapeSheet(d.sh);
    return;
  }
  if (d.type === 'labeltap') { labelSheet(null, d.p); return; }
  if (d.moved) {
    commit(); renderCanvas();
    // keep an open edit panel in sync with the new size
    if (d.type === 'resize' && !$('#sheet').hidden) (d.isItem ? itemSheet : shapeSheet)(d.obj);
    return;
  }
  // a tap
  if (d.type === 'item') { ed.sel = d.it.id; renderCanvas(); itemSheet(d.it); }
  else if (d.type === 'resize' && d.isItem) { ed.sel = d.obj.id; renderCanvas(); itemSheet(d.obj); }
  else if (d.type === 'resize') { ed.selShape = d.obj.id; ed.selLabel = null; renderCanvas(); shapeSheet(d.obj); }
  else if (d.type === 'shape') { ed.selShape = d.sh.id; ed.selLabel = null; renderCanvas(); shapeSheet(d.sh); }
  else if (d.type === 'label') { ed.selLabel = d.lb.id; ed.selShape = null; renderCanvas(); labelSheet(d.lb); }
}

document.addEventListener('keydown', e => {
  if (!S.ed) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.target.closest('input,textarea')) { e.preventDefault(); undo(); }
  if (e.key === 'Escape') { closeSheet(); S.ed.sel = S.ed.selShape = S.ed.selLabel = null; renderCanvas(); }
});

// ---------------------------------------------------------------- undo + save
function commit() {
  const ed = S.ed; if (!ed.canEdit) return;
  const now = JSON.stringify(ed.data);
  if (now === ed.snap) return;
  ed.undo.push(ed.snap); if (ed.undo.length > 60) ed.undo.shift();
  ed.snap = now;
  scheduleSave();
}
function undo() {
  const ed = S.ed; if (!ed || !ed.canEdit) return;
  if (!ed.undo.length) return toast('Nothing to undo');
  ed.snap = ed.undo.pop(); ed.data = JSON.parse(ed.snap);
  ed.sel = ed.selShape = ed.selLabel = null; closeSheet();
  renderCanvas(); scheduleSave(); toast('Undone', 1200);
}
function setStatus(t) { const s = $('#saveStatus'); if (s) s.textContent = t; }
function scheduleSave() {
  const ed = S.ed; if (!ed.canEdit) return;
  ed.dirty = true; setStatus('Saving…');
  clearTimeout(ed.saveTimer); ed.saveTimer = setTimeout(save, 900);
}
async function save() {
  const ed = S.ed; if (!ed || !ed.dirty) return;
  ed.dirty = false;
  const payload = { data: ed.data, notes: ed.d.notes || '' };
  const { data, error } = await sb.from('designs').update(payload).eq('id', ed.d.id).select('updated_at').maybeSingle();
  if (S.ed !== ed) return;
  if (!error && !data) { setStatus('Not saved: editing was turned off'); ed.canEdit = false; renderToolbar(); return; }
  if (error) {
    console.error(error); ed.dirty = true; setStatus('Not saved, retrying…');
    clearTimeout(ed.saveTimer); ed.saveTimer = setTimeout(save, 5000);
    return;
  }
  ed.d.updated_at = data.updated_at;
  if (!ed.dirty) setStatus('Saved ✓');
}
function flushSave() { const ed = S.ed; if (ed && ed.dirty) { clearTimeout(ed.saveTimer); save(); } }
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', async () => {
  const ed = S.ed; if (!ed) return;
  if (document.visibilityState === 'hidden') return flushSave();
  // coming back: pick up changes someone else made, if we have nothing pending
  if (ed.dirty || ed.drag) return;
  const { data } = await sb.from('designs').select('updated_at, data, notes, name, allow_edit').eq('id', ed.d.id).maybeSingle();
  if (data && S.ed === ed && data.updated_at > ed.d.updated_at && !ed.dirty) {
    Object.assign(ed.d, data); ed.data = data.data; ed.snap = JSON.stringify(ed.data); ed.undo = [];
    ed.canEdit = !ed.d.deleted_at && (ed.isOwner || ed.d.allow_edit);
    $('#notesTa').value = ed.d.notes || '';
    renderToolbar(); renderCanvas(); toast('Updated with the latest changes');
  }
  loadComments();
});

// ---------------------------------------------------------------- item sheets
function sizeFields(o, wLabel = 'Width', hLabel = 'Length') {
  const u = unitLabel();
  return `<label>Shape<select id="fShape"><option value="circle">Round</option><option value="rect">Rectangle</option></select></label>
    <label id="lW">${wLabel} (${u})<input type="number" id="fW" min="1" step="any" value="${toDisp(o.w)}"></label>
    <label id="lH">${hLabel} (${u})<input type="number" id="fH" min="1" step="any" value="${toDisp(o.h)}"></label>`;
}
function syncShapeField() {
  const circle = $('#fShape').value === 'circle';
  $('#lW').firstChild.textContent = (circle ? 'Diameter' : 'Width') + ` (${unitLabel()})`;
  $('#lH').hidden = circle;
}
function catOptions() { return Object.entries(CATS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join(''); }

function itemSheet(it) {
  const ed = S.ed;
  if (!ed.canEdit) {
    openSheet(`<div class="row center"><h2 style="flex:1">${esc(it.name)}</h2><button id="shClose">Close</button></div>
      <div class="muted">${CATS[it.cat]?.label || ''} · ${it.shape === 'circle' ? fmtLen(it.w) + ' across' : fmtLen(it.w) + ' × ' + fmtLen(it.h)}</div>`);
    $('#shClose').onclick = () => { closeSheet(); ed.sel = null; renderCanvas(); };
    return;
  }
  openSheet(`<h2>Edit item</h2>
    <div class="row"><label class="grow">Name<input type="text" id="fName" maxlength="60" value="${esc(it.name)}"></label>
      <label>Type<select id="fCat">${catOptions()}</select></label></div>
    <div class="row">${sizeFields(it)}</div>
    <div class="row"><button id="fRot">Rotate</button><button id="fDup">Duplicate</button><button id="fDel" class="danger">Delete</button>
      <span class="spacer"></span><button class="primary" id="fDone">Done</button></div>`);
  $('#fCat').value = it.cat; $('#fShape').value = it.shape; syncShapeField();
  const apply = () => {
    it.name = $('#fName').value.trim() || 'Item'; it.cat = $('#fCat').value; it.shape = $('#fShape').value;
    it.w = clamp(Math.round(fromDisp($('#fW').value)), 2, 5000);
    it.h = it.shape === 'circle' ? it.w : clamp(Math.round(fromDisp($('#fH').value)), 2, 5000);
    syncShapeField(); renderCanvas();
  };
  ['fName', 'fCat', 'fShape', 'fW', 'fH'].forEach(id => { $('#' + id).oninput = apply; $('#' + id).onchange = () => { apply(); commit(); }; });
  $('#fRot').onclick = () => { if (it.shape === 'circle') return; [it.w, it.h] = [it.h, it.w]; $('#fW').value = toDisp(it.w); $('#fH').value = toDisp(it.h); commit(); renderCanvas(); };
  $('#fDup').onclick = () => { const c = { ...clone(it), id: uid(), x: it.x + 8, y: it.y + 8 }; ed.data.items.push(c); commit(); ed.sel = c.id; renderCanvas(); itemSheet(c); };
  $('#fDel').onclick = () => { ed.data.items = ed.data.items.filter(i => i.id !== it.id); commit(); ed.sel = null; closeSheet(); renderCanvas(); };
  $('#fDone').onclick = () => { commit(); closeSheet(); ed.sel = null; renderCanvas(); };
}

function addItemSheet() {
  const ed = S.ed;
  const base = { ...PRESETS[3][1] };
  openSheet(`<h2>Add an item</h2>
    <label>Quick pick<select id="fPreset">${PRESETS.map((p, i) => `<option value="${i}">${p[0]}</option>`).join('')}</select></label>
    <div class="row"><label class="grow">Name<input type="text" id="fName" maxlength="60" value="${esc(base.name)}"></label>
      <label>Type<select id="fCat">${catOptions()}</select></label></div>
    <div class="row">${sizeFields(base)}</div>
    <div class="row"><span class="spacer"></span><button id="fCancel">Cancel</button><button class="primary" id="fAdd">Add</button></div>`);
  $('#fPreset').value = '3'; $('#fCat').value = base.cat; $('#fShape').value = base.shape; syncShapeField();
  $('#fShape').onchange = syncShapeField;
  $('#fPreset').onchange = () => {
    const p = PRESETS[+$('#fPreset').value][1]; if (!p) return;
    $('#fName').value = p.name; $('#fCat').value = p.cat; $('#fShape').value = p.shape;
    $('#fW').value = toDisp(p.w); $('#fH').value = toDisp(p.h); syncShapeField();
  };
  $('#fCancel').onclick = closeSheet;
  $('#fAdd').onclick = () => {
    const shape = $('#fShape').value;
    const w = clamp(Math.round(fromDisp($('#fW').value)), 2, 5000);
    const h = shape === 'circle' ? w : clamp(Math.round(fromDisp($('#fH').value)), 2, 5000);
    // drop it in the middle of what's on screen
    const st = $('#stage'), r = $('svg', st).getBoundingClientRect(), sr = st.getBoundingClientRect();
    const cx = (sr.left + st.clientWidth / 2 - r.left) / ed.scale, cy = (sr.top + st.clientHeight / 2 - r.top) / ed.scale;
    const it = { id: uid(), name: $('#fName').value.trim() || 'Item', cat: $('#fCat').value, shape, w, h, x: Math.max(0, Math.round(cx - w / 2)), y: Math.max(0, Math.round(cy - h / 2)) };
    ed.data.items.push(it); commit(); ed.sel = it.id; closeSheet(); renderCanvas();
    toast('Added in the middle of the screen. Drag it into place.');
  };
}

// ---------------------------------------------------------------- shape + label sheets
function shapeSheet(sh) {
  const ed = S.ed, u = unitLabel();
  const type = roleOf(sh, ed.data.shapes);
  const ph = { bed: 'e.g. Veggie bed, Herbs', zone: 'e.g. Patio, Dining area, Chill zone', cut: 'e.g. Tree, Chicken coop', space: 'e.g. Back yard' }[type];
  openSheet(`<h2>${{ cut: 'Cut-out', bed: 'Garden bed', zone: 'Zone', space: 'Space outline' }[type]}</h2>
    <div class="row">
      <label>Type<select id="sCut"><option value="space">Space outline (the whole yard, patio or balcony)</option><option value="zone">Zone (patio, seating, dining: gray)</option><option value="bed">Garden bed (green)</option><option value="cut">Cut-out (house, tree, coop)</option></select></label>
      <label class="grow">Label<input type="text" id="sLabel" maxlength="40" value="${esc(sh.label || '')}" placeholder="${ph}"></label>
    </div>
    <div class="row">
      <label>Shape<select id="sKind"><option value="rect">Rectangle</option><option value="circle">Circle</option></select></label>
      <label id="sWl">${sh.kind === 'circle' ? 'Diameter' : 'Width'} (${u})<input type="number" id="sW" step="any" value="${toDisp(sh.w)}"></label>
      <label id="sHl" ${sh.kind === 'circle' ? 'hidden' : ''}>Length (${u})<input type="number" id="sH" step="any" value="${toDisp(sh.h)}"></label>
    </div>
    <div class="row"><button id="sDel" class="danger">Delete</button><span class="spacer"></span><button class="primary" id="sDone">Done</button></div>`);
  $('#sCut').value = type; $('#sKind').value = sh.kind;
  const apply = () => {
    sh.kind = $('#sKind').value;
    sh.w = clamp(Math.round(fromDisp($('#sW').value)), 10, 10000);
    sh.h = sh.kind === 'circle' ? sh.w : clamp(Math.round(fromDisp($('#sH').value)), 10, 10000);
    if ($('#sLabel')) sh.label = $('#sLabel').value.trim();
    $('#sHl').hidden = sh.kind === 'circle';
    $('#sWl').firstChild.textContent = (sh.kind === 'circle' ? 'Diameter' : 'Width') + ` (${u})`;
    renderCanvas();
  };
  ['sKind', 'sW', 'sH', 'sLabel'].forEach(id => { const el = $('#' + id); if (!el) return; el.oninput = apply; el.onchange = () => { apply(); commit(); }; });
  $('#sCut').onchange = () => {
    const v = $('#sCut').value;
    sh.cut = v === 'cut'; delete sh.bed;
    if (v === 'cut') delete sh.role; else sh.role = v;
    if (sh.label == null) sh.label = '';
    commit(); renderCanvas(); shapeSheet(sh);
  };
  $('#sDel').onclick = () => {
    if (type === 'space' && ed.data.shapes.filter(s => roleOf(s, ed.data.shapes) === 'space').length === 1) return toast('A garden needs at least one space outline');
    ed.data.shapes = ed.data.shapes.filter(s => s.id !== sh.id); ed.selShape = null; commit(); closeSheet(); renderCanvas();
  };
  $('#sDone').onclick = () => { commit(); ed.selShape = null; closeSheet(); renderCanvas(); };
}

function labelSheet(lb, at) {
  const ed = S.ed;
  openSheet(`<h2>${lb ? 'Edit label' : 'New label'}</h2>
    <label>Text<input type="text" id="lText" maxlength="40" value="${esc(lb ? lb.text : '')}" placeholder="e.g. Fence, House, Railing"></label>
    <div class="row">${lb ? '<button id="lDel" class="danger">Delete</button>' : ''}<span class="spacer"></span>
      <button id="lCancel">Cancel</button><button class="primary" id="lOk">${lb ? 'Done' : 'Add'}</button></div>`);
  $('#lText').focus();
  $('#lCancel').onclick = () => { closeSheet(); ed.selLabel = null; renderCanvas(); };
  if ($('#lDel')) $('#lDel').onclick = () => { ed.data.labels = ed.data.labels.filter(l => l.id !== lb.id); ed.selLabel = null; commit(); closeSheet(); renderCanvas(); };
  $('#lOk').onclick = () => {
    const text = $('#lText').value.trim();
    if (!text) return toast('Type some text');
    if (lb) lb.text = text;
    else { ed.data.labels.push({ id: uid(), text, x: Math.round(at.x), y: Math.round(at.y) }); ed.tool = 'select'; renderToolbar(); }
    commit(); ed.selLabel = null; closeSheet(); renderCanvas();
  };
}

// ---------------------------------------------------------------- more menu
function moreSheet() {
  const ed = S.ed;
  openSheet(`<div class="row center"><h2 style="flex:1">${esc(ed.d.name)}</h2><button id="mClose">Close</button></div>
    ${ed.isOwner && !ed.d.deleted_at ? `
      <div class="row"><label class="grow">Name<input type="text" id="mName" maxlength="80" value="${esc(ed.d.name)}"></label><button id="mRename">Rename</button></div>
      <label class="check"><input type="checkbox" id="mAllow" ${ed.d.allow_edit ? 'checked' : ''}> Allow others to edit (off = view only)</label>` : ''}
    <div class="row">
      <button id="mDup">Duplicate</button>
      <button id="mHist">Version history</button>
      <button id="mPng">Download image</button>
      <button id="mExport">Export file</button>
      ${ed.isOwner && !ed.d.deleted_at ? '<button id="mTrash" class="danger">Move to Trash</button>' : ''}
    </div>`);
  $('#mClose').onclick = closeSheet;
  if ($('#mRename')) $('#mRename').onclick = async () => {
    const name = $('#mName').value.trim(); if (!name) return;
    flushSave();
    const { error } = await sb.from('designs').update({ name }).eq('id', ed.d.id);
    if (error) return toast("Couldn't rename");
    ed.d.name = name; $('#edTitle').textContent = name; toast('Renamed');
  };
  if ($('#mAllow')) $('#mAllow').onchange = async e => {
    flushSave();
    const { error } = await sb.from('designs').update({ allow_edit: e.target.checked }).eq('id', ed.d.id);
    if (error) { e.target.checked = !e.target.checked; return toast("Couldn't change that"); }
    ed.d.allow_edit = e.target.checked;
    toast(e.target.checked ? 'Others can now edit this garden' : 'Now view only for others');
  };
  $('#mDup').onclick = () => { flushSave(); closeSheet(); duplicateDesign({ ...ed.d, data: ed.data }); };
  $('#mHist').onclick = historyModal;
  $('#mPng').onclick = exportPng;
  $('#mExport').onclick = () => {
    const blob = new Blob([JSON.stringify({ gardenbud: 1, name: ed.d.name, notes: ed.d.notes || '', data: ed.data }, null, 1)], { type: 'application/json' });
    download(slug(ed.d.name) + '.gardenbud.json', blob);
  };
  if ($('#mTrash')) $('#mTrash').onclick = () => confirmModal('Move to Trash?', 'You can restore it from the home page for 30 days.', 'Move to Trash', async () => {
    flushSave();
    const { error } = await sb.from('designs').update({ deleted_at: new Date().toISOString() }).eq('id', ed.d.id);
    if (error) return toast("Couldn't move it to the Trash");
    toast('Moved to Trash'); setHash('');
  });
}

async function historyModal() {
  const ed = S.ed;
  closeSheet();
  const { data: vs, error } = await sb.from('design_versions').select('id, saved_at, saved_by, data, notes').eq('design_id', ed.d.id).order('saved_at', { ascending: false });
  if (error) return toast("Couldn't load history");
  openModal(`<h2>Version history</h2>
    <p class="muted" style="margin:0;font-size:13px">GardenBud keeps the last 10 versions (at most one every 10 minutes).</p>
    <div>${vs.length ? vs.map(v => `<div class="version"><div><b>${new Date(v.saved_at).toLocaleString()}</b><div class="muted" style="font-size:12px">${v.saved_by ? 'by ' + esc(nameOf(v.saved_by)) : ''} · ${(v.data.items || []).length} items</div></div>
      <span class="spacer"></span>${ed.canEdit ? `<button class="small" data-restore-v="${v.id}">Restore</button>` : ''}</div>`).join('') : '<p class="muted">No earlier versions yet. They appear as the garden gets edited.</p>'}</div>
    <div class="row"><span class="spacer"></span><button id="hClose">Close</button></div>`);
  $('#hClose').onclick = closeModal;
  $$('[data-restore-v]').forEach(b => b.onclick = () => {
    const v = vs.find(x => String(x.id) === b.dataset.restoreV);
    ed.data = clone(v.data); ed.d.notes = v.notes || ''; $('#notesTa').value = ed.d.notes;
    for (const k of ['shapes', 'labels', 'items']) ed.data[k] = ed.data[k] || [];
    commit(); closeModal(); renderCanvas(); toast('Restored. Undo (↶) brings back what you had.');
  });
}

async function exportPng() {
  const ed = S.ed;
  const { r, b } = bounds(ed.data);
  const sc = 3, cw = r + 30, ch = b + 30;
  const svg = drawSvg(ed.data, { scale: sc, cw, ch, mode: 'items', grid: true, fontBoost: 1.5, title: ed.d.name,
    subtitle: `GardenBud · by ${ed.isOwner ? nameOf(S.me) : nameOf(ed.d.owner_id)} · ${new Date().toLocaleDateString()}` });
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    c.toBlob(bl => download(slug(ed.d.name) + '.png', bl), 'image/png');
  };
  img.onerror = () => toast("Couldn't make the image");
  img.src = url;
}

// ---------------------------------------------------------------- comments
async function loadComments(markRead) {
  const ed = S.ed; if (!ed) return;
  const { data, error } = await sb.from('comments').select('id, author_id, body, created_at').eq('design_id', ed.d.id).order('created_at');
  if (error || S.ed !== ed) return;
  ed.comments = data;
  const panelOpen = $('#commentsPanel')?.classList.contains('open');
  renderComments();
  if (markRead || panelOpen) {
    const now = new Date().toISOString();
    await sb.from('comment_reads').upsert({ member_id: S.me, design_id: ed.d.id, last_read_at: now });
    ed.readMark = ed.lastRead; ed.lastRead = now;
  }
  updateBadge();
}
function updateBadge() {
  const ed = S.ed, b = $('#cBadge'); if (!b) return;
  const n = ed.comments.filter(c => c.author_id !== S.me && (!ed.lastRead || c.created_at > ed.lastRead)).length;
  b.hidden = !n;
}
function renderComments() {
  const ed = S.ed, list = $('#cList'); if (!list) return;
  const since = ed.readMark !== undefined ? ed.readMark : ed.lastRead;
  list.innerHTML = ed.comments.length ? ed.comments.map(c => `<div class="comment ${c.author_id !== S.me && (!since || c.created_at > since) ? 'new' : ''}">
      <div class="who">${esc(c.author_id === S.me ? 'You' : nameOf(c.author_id))}<span class="when">${ago(c.created_at)}</span></div>
      <div class="text">${esc(c.body)}</div>
      ${c.author_id === S.me || ed.isOwner ? `<button class="small ghost danger" data-del-c="${c.id}">Delete</button>` : ''}</div>`).join('')
    : '<p class="muted">No comments yet. Leave an idea or a question for everyone.</p>';
  $$('[data-del-c]', list).forEach(b => b.onclick = async () => {
    const { error } = await sb.from('comments').delete().eq('id', b.dataset.delC);
    if (error) return toast("Couldn't delete");
    loadComments();
  });
  list.scrollTop = list.scrollHeight;
}
async function sendComment() {
  const ed = S.ed, ta = $('#cInput'), body = ta.value.trim();
  if (!body) return;
  $('#cSend').disabled = true;
  const { error } = await sb.from('comments').insert({ design_id: ed.d.id, author_id: S.me, body });
  $('#cSend').disabled = false;
  if (error) return toast("Couldn't post");
  ta.value = ''; loadComments(true);
}

// ---------------------------------------------------------------- go
let lastW = window.innerWidth;
window.addEventListener('resize', () => {
  // phones fire resize while scrolling (address bar), so only refit on a real width change
  if (window.innerWidth === lastW) return;
  lastW = window.innerWidth;
  if (S.ed && S.ed.scale === S.ed.fitBase) fitZoom();
});
boot();
