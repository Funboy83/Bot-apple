const $ = (s) => document.querySelector(s);
let state = null;

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  keys.slice(0, -1).forEach((k) => { o = o[k] ??= {}; });
  o[keys.at(-1)] = value;
}

// Fill every input named "settings.x.y" or "secrets.x.y" from the matching object.
function fillForm(prefix, data) {
  document.querySelectorAll(`[name^="${prefix}."]`).forEach((el) => {
    const v = getPath(data, el.name.slice(prefix.length + 1));
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.type === 'radio') el.checked = el.value === v;
    else el.value = Array.isArray(v) ? v.join(', ') : v ?? '';
  });
}

function readForm(prefix) {
  const out = {};
  document.querySelectorAll(`[name^="${prefix}."]`).forEach((el) => {
    const path = el.name.slice(prefix.length + 1);
    if (el.type === 'radio') { if (el.checked) setPath(out, path, el.value); return; }
    let v = el.type === 'checkbox' ? el.checked : el.value.trim();
    if (el.type === 'number') v = Number(v);
    setPath(out, path, v);
  });
  return out;
}

function option(value, label, selected) {
  const o = document.createElement('option');
  o.value = value; o.textContent = label; o.selected = value === selected;
  return o;
}

function renderTargets(targets) {
  const body = $('#targets');
  body.innerHTML = '';
  targets.forEach((t, i) => {
    const tr = document.createElement('tr');
    const model = state.catalog[t.model] || Object.values(state.catalog)[0];
    const mSel = document.createElement('select');
    Object.entries(state.catalog).forEach(([k, m]) => mSel.append(option(k, m.label, t.model)));
    const cSel = document.createElement('select');
    model.capacities.forEach((c) => cSel.append(option(c, c, t.capacity)));
    const colSel = document.createElement('select');
    model.colors.forEach((c) => colSel.append(option(c, c, t.color)));
    const part = document.createElement('input');
    part.value = t.partNumber || ''; part.placeholder = 'Auto';
    mSel.onchange = () => {
      const m = state.catalog[mSel.value];
      const cur = readTargets();
      cur[i] = { model: mSel.value, capacity: m.capacities.includes(cur[i].capacity) ? cur[i].capacity : m.capacities[0], color: m.colors.includes(cur[i].color) ? cur[i].color : m.colors[0], partNumber: '' };
      renderTargets(cur);
    };
    const tools = document.createElement('td');
    const up = Object.assign(document.createElement('button'), { textContent: '↑', title: 'Move up', className: 'small-btn' });
    const del = Object.assign(document.createElement('button'), { textContent: 'Remove', className: 'small-btn' });
    up.disabled = i === 0;
    up.onclick = () => { const cur = readTargets(); [cur[i - 1], cur[i]] = [cur[i], cur[i - 1]]; renderTargets(cur); };
    del.onclick = () => { const cur = readTargets(); cur.splice(i, 1); renderTargets(cur); };
    tools.append(up, del);
    const num = document.createElement('td'); num.textContent = i + 1;
    tr.append(num, ...[mSel, cSel, colSel, part].map((el) => { const td = document.createElement('td'); td.append(el); return td; }), tools);
    tr.dataset.row = i;
    body.append(tr);
  });
}

function readTargets() {
  return [...document.querySelectorAll('#targets tr')].map((tr) => {
    const [m, c, col] = tr.querySelectorAll('select');
    return { model: m.value, capacity: c.value, color: col.value, partNumber: tr.querySelector('input').value.trim() };
  });
}

function renderStatus(st) {
  state.status = st;
  $('#runState').textContent = st.running ? (st.checkoutBusy ? 'Checking out…' : st.waitingForHours ? 'Waiting for checking hours' : 'Watching') : 'Stopped';
  $('#runState').classList.toggle('on', st.running);
  $('#startStop').textContent = st.running ? 'Stop bot' : 'Start bot';
  $('#resume').hidden = !st.awaitingYou;
  const banner = st.awaitingYou
    ? `Ready to buy ${st.awaitingYou}. Press Place Order in the bot's browser window, then press Resume if you want it to keep going.`
    : st.lastError ? `Inventory unknown: ${st.lastError}${st.retryAt ? `. Next check after ${new Date(st.retryAt).toLocaleTimeString()}` : ''}` : '';
  $('#banner').hidden = !banner;
  $('#banner').textContent = banner;
  if (st.lastCheck) $('#lastCheck').textContent = `Last checked ${new Date(st.lastCheck).toLocaleTimeString()}.`;
  renderRows(st.rows || []);
}

function renderRows(rows) {
  const body = $('#stock');
  body.innerHTML = '';
  if (!rows.length) { body.innerHTML = '<tr><td colspan="4" class="muted">No results yet.</td></tr>'; return; }
  [...rows].sort((a, b) => (b.available - a.available) || ((a.distance ?? 999) - (b.distance ?? 999))).forEach((r) => {
    const tr = document.createElement('tr');
    [`${r.storeName}${r.city ? `, ${r.city}` : ''} (${r.storeNumber})`, r.distance ?? '', r.part, r.quote || (r.available === null ? 'Unknown' : r.available ? 'Available' : 'Unavailable')]
      .forEach((v, i) => { const td = document.createElement('td'); td.textContent = v; if (i === 3 && r.available) td.className = 'yes'; tr.append(td); });
    body.append(tr);
  });
}

function addLog(e) {
  const line = document.createElement('div');
  line.className = `log-${e.level}`;
  line.textContent = `${new Date(e.at).toLocaleTimeString()}  ${e.msg}`;
  const log = $('#log');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.append(line);
  while (log.childElementCount > 500) log.firstChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function renderVault() {
  const v = state.vault;
  $('#vaultLocked').hidden = v.unlocked;
  $('#vaultOpen').hidden = !v.unlocked;
  $('#resetVault').hidden = !v.exists;
  $('#unlock').textContent = v.exists ? 'Unlock' : 'Create';
  $('#vaultHint').textContent = v.exists
    ? 'Enter your passphrase to use or change your card, contact and alert logins. The bot needs this unlocked to buy or send alerts.'
    : 'Pick a passphrase. Your card, contact and alert logins are encrypted with it and stay on this computer. There is no way to recover it if you forget it.';
  if (v.unlocked && state.secrets) fillForm('secrets', state.secrets);
}

function flash(el, msg, bad) {
  el.textContent = msg;
  el.style.color = bad ? 'var(--bad)' : '';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ''; }, 6000);
}

async function load() {
  state = await api('/api/state');
  fillForm('settings', state.settings);
  renderTargets(state.settings.targets);
  renderVault();
  renderStatus(state.status);
  $('#log').innerHTML = '';
  state.logs.forEach(addLog);
}

async function saveSettings() {
  const s = readForm('settings');
  s.targets = readTargets();
  const { settings } = await api('/api/settings', s);
  state.settings = settings;
  fillForm('settings', settings);
  renderTargets(settings.targets);
}

$('#addTarget').onclick = () => {
  const cur = readTargets();
  const last = cur.at(-1) || { model: Object.keys(state.catalog)[0] };
  const m = state.catalog[last.model];
  cur.push({ model: last.model, capacity: m.capacities[0], color: m.colors[0], partNumber: '' });
  renderTargets(cur);
};

$('#saveSettings').onclick = async () => {
  try { await saveSettings(); flash($('#saveMsg'), 'Saved.'); } catch (e) { flash($('#saveMsg'), e.message, true); }
};

$('#startStop').onclick = async () => {
  try {
    if (state.status.running) renderStatus((await api('/api/bot/stop', {})).status);
    else { await saveSettings(); renderStatus((await api('/api/bot/start', {})).status); }
  } catch (e) { alert(e.message); }
};

$('#resume').onclick = async () => renderStatus((await api('/api/bot/resume', {})).status);

$('#checkNow').onclick = async () => {
  const btn = $('#checkNow');
  btn.disabled = true; btn.textContent = 'Checking…';
  try {
    if (!state.status.running) await saveSettings();
    const r = await api('/api/check-now', {});
    renderRows(r.rows);
    $('#lastCheck').textContent = `Checked ${new Date().toLocaleTimeString()}. ${r.parts.map((p) => `${p.capacity} ${p.color} = ${p.partNumber}`).join(', ')}`;
    r.problems.forEach((p) => addLog({ at: new Date().toISOString(), level: 'warn', msg: p }));
  } catch (e) {
    renderRows([]);
    $('#banner').hidden = false;
    $('#banner').textContent = `Inventory unknown: ${e.message}`;
  }
  btn.disabled = false; btn.textContent = 'Check stock now';
};

$('#openBrowser').onclick = async () => {
  try { await saveSettings(); await api('/api/browser/open', {}); } catch (e) { alert(e.message); }
};

$('#unlock').onclick = async () => {
  try {
    const r = await api('/api/vault/unlock', { passphrase: $('#passphrase').value });
    $('#passphrase').value = '';
    state.vault = { exists: true, unlocked: true };
    state.secrets = r.secrets;
    renderVault();
  } catch (e) { alert(e.message); }
};
$('#passphrase').onkeydown = (e) => { if (e.key === 'Enter') $('#unlock').click(); };

$('#lockVault').onclick = async () => { await api('/api/vault/lock', {}); await load(); };

$('#resetVault').onclick = async () => {
  if (!confirm('Erase your saved card, contact and alert logins? This cannot be undone.')) return;
  await api('/api/vault/reset', {});
  await load();
};

$('#saveSecrets').onclick = async () => {
  try {
    const r = await api('/api/secrets', readForm('secrets'));
    state.secrets = r.secrets;
    fillForm('secrets', r.secrets);
    flash($('#secretMsg'), 'Saved and encrypted.');
  } catch (e) { flash($('#secretMsg'), e.message, true); }
};

document.querySelectorAll('[data-test]').forEach((btn) => {
  btn.onclick = async () => {
    try {
      await saveSettings();
      await api('/api/secrets', readForm('secrets'));
      const { result } = await api('/api/alerts/test', { channel: btn.dataset.test });
      alert(result === 'ok' ? 'Sent. Check it arrived.' : `Failed: ${result}`);
    } catch (e) { alert(e.message); }
  };
});

const events = new EventSource('/api/events');
events.addEventListener('log', (e) => addLog(JSON.parse(e.data)));
events.addEventListener('status', (e) => renderStatus(JSON.parse(e.data)));

load().catch((e) => alert(`Couldn't load: ${e.message}`));
