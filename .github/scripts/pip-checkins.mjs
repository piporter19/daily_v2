// Pip phone check-ins: reads each dashboard from Firestore, decides whether a nudge is due,
// and sends it to the ntfy app. Runs every 15 minutes from GitHub Actions. No dependencies.
const PROJECT = 'daily-tracker-bbee6';
const KEY = 'AIzaSyAjIG30nPmTBBAZ7c7cmgeXn25BwdviEEA';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/tracker_data`;
const DASHBOARDS = (process.env.DASHBOARDS || 'my_dashboard').split(',').map(s => s.trim()).filter(Boolean);
const FORCE = (process.env.FORCE_KIND || '').trim();
const RULE_TEXT = { more: 'More is better', less: 'Less is better', exact: 'Hit it exactly' };

// ---------- Firestore REST helpers ----------
function fromFs(v) {
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) { const o = {}; for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = fromFs(x); return o; }
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs);
  return undefined;
}
function toFs(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (typeof x === 'string') return { stringValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(toFs) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(x).map(([k, v]) => [k, toFs(v)])) } };
}
async function readDoc(id) {
  const r = await fetch(`${BASE}/${encodeURIComponent(id)}?key=${KEY}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Reading ${id} failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return fromFs({ mapValue: { fields: j.fields || {} } });
}
async function writeDoc(id, obj) {
  const r = await fetch(`${BASE}/${encodeURIComponent(id)}?key=${KEY}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFs(obj).mapValue.fields })
  });
  if (!r.ok) throw new Error(`Writing ${id} failed: ${r.status} ${await r.text()}`);
}

// ---------- time ----------
function localNow(tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  const hh = parts.hour === '24' ? 0 : +parts.hour;
  return { today: `${parts.day}/${parts.month}`, nm: hh * 60 + +parts.minute };
}
const toMin = hm => { const [h, m] = String(hm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const within = (nm, start, len) => ((nm - start) % 1440 + 1440) % 1440 < len;
const fmtH = h => { h = +h || 0; if (h <= 0) return '0m'; const hh = Math.floor(h), mm = Math.round((h - hh) * 60); return hh && mm ? `${hh}h ${mm}m` : hh ? `${hh}h` : `${mm}m`; };

// ---------- the same habit logic the site uses ----------
function engine(S, today) {
  const allDates = S.allDates || [];
  const allColumns = () => (S.groups || []).flatMap(g => g.columns || []);
  const cellOf = (d, c) => S.logs?.[d]?.[c] || {};
  const slotsHours = slots => {
    let mins = 0;
    (slots || []).forEach(s => { if (s.from && s.to) { let a = toMin(s.from), b = toMin(s.to); if (b < a) b += 1440; mins += b - a; } });
    return mins / 60;
  };
  const hoursOf = cd => { const h = parseFloat(cd.hours); return !isNaN(h) && cd.hours ? h : slotsHours(cd.timeSlots); };
  const isDone = (d, c) => { const cd = cellOf(d, c); return (cd.actual !== undefined && String(cd.actual).trim() !== '') || hoursOf(cd) > 0; };
  const ruleOf = c => { const r = S.columnRules?.[c]; if (r) return r; const g = (S.groups || []).find(g => (g.columns || []).includes(c)); return g && /media|screen|social|ott/i.test(g.name) ? 'less' : 'more'; };
  const isCore = c => { const m = S.habitMeta?.[c]; return m && typeof m.daily === 'boolean' ? m.daily : true; };
  const coreCols = () => { const a = allColumns(), c = a.filter(isCore); return c.length ? c : a; };
  const idx = (() => { const i = allDates.indexOf(today); return i >= 0 ? i : allDates.length - 1; })();
  const sleepCol = () => allColumns().find(c => /sleep/i.test(c)) || null;
  function sleepWake() {
    const cfg = S.nudge || {}; let found = null; const sc = sleepCol();
    if (sc) for (let k = idx; k >= Math.max(0, idx - 4) && !found; k--) {
      const sl = (cellOf(allDates[k], sc).timeSlots || []).filter(s => s.from && s.to);
      if (sl.length) found = sl.find(s => { const m = toMin(s.from); return m >= 18 * 60 || m < 5 * 60; }) || sl[sl.length - 1];
    }
    return { sleep: cfg.sleep || found?.from || '23:30', wake: cfg.wake || found?.to || '07:30' };
  }
  function yesterdayAt(nm) {
    const y = allDates[idx - 1]; if (!y) return null;
    let best = null, bd = 1e9; const sc = sleepCol();
    allColumns().forEach(c => {
      if (c === sc) return;
      (cellOf(y, c).timeSlots || []).forEach(s => {
        if (!s.from) return;
        const a = toMin(s.from), b = s.to ? toMin(s.to) : a + 30;
        const inside = a <= b ? nm >= a && nm <= b : nm >= a || nm <= b;
        const d = inside ? 0 : Math.min(Math.abs(nm - a), Math.abs(nm - b));
        if (d < bd && d <= 60) { bd = d; best = c; }
      });
    });
    return best;
  }
  function usualAt(nm, exclude) {
    const days = allDates.slice(Math.max(0, idx - 14), idx), sc = sleepCol(), score = {};
    days.forEach(d => allColumns().forEach(c => (cellOf(d, c).timeSlots || []).forEach(s => {
      if (!s.from || c === sc) return;
      const dd = Math.abs(nm - toMin(s.from)); if (Math.min(dd, 1440 - dd) <= 90) score[c] = (score[c] || 0) + 1;
    })));
    let ranked = Object.keys(score).sort((a, b) => score[b] - score[a]).filter(c => !exclude.includes(c));
    if (ranked.length) return ranked[0];
    const freq = {};
    allDates.slice(Math.max(0, idx - 14), idx + 1).forEach(d => allColumns().forEach(c => { if (c !== sc && isDone(d, c)) freq[c] = (freq[c] || 0) + 1; }));
    ranked = Object.keys(freq).sort((a, b) => freq[b] - freq[a]).filter(c => !exclude.includes(c));
    return ranked[0] || coreCols().find(c => c !== sc && !exclude.includes(c)) || null;
  }
  function restOption(nm, sleep, exclude) {
    const sc = sleepCol();
    if (sc && !exclude.includes(sc) && within(nm, toMin(sleep) - 90, 150)) return { col: sc, label: 'Going to sleep 😴' };
    const media = allColumns().filter(c => ruleOf(c) === 'less' && !exclude.includes(c));
    if (!media.length) return null;
    const used = c => allDates.slice(Math.max(0, idx - 14), idx + 1).filter(d => isDone(d, c)).length;
    const m = media.sort((a, b) => used(b) - used(a))[0];
    return { col: m, label: `Taking a break (${m})` };
  }
  return { sleepCol, sleepWake, yesterdayAt, usualAt, restOption, coreCols };
}

// ---------- one dashboard ----------
async function checkDashboard(docId) {
  const S = await readDoc(docId);
  if (!S) return console.log(`${docId}: no data`);
  const cfg = S.nudge || {}, phone = cfg.phone || {};
  if (!phone.on || !phone.topic) return console.log(`${docId}: phone check-ins are off`);
  const site = phone.url || '';
  const tz = cfg.tz || 'Asia/Kolkata';
  const { today, nm } = localNow(tz);
  const E = engine(S, today);
  const pushId = `${docId}-push`;
  const prev = (await readDoc(pushId)) || {};
  let rt = prev.date === today ? { ...prev } : { date: today, count: 0, ignored: 0, lastAt: 0, bed: false, morning: false, bedAgainAt: prev.bedAgainAt || 0, snoozeUntil: prev.snoozeUntil || 0, longFor: prev.longFor || 0 };
  const pf = cfg.pageFlags && cfg.pageFlags.date === today ? cfg.pageFlags : {};
  const { sleep, wake } = E.sleepWake(), s = toMin(sleep), w = toMin(wake);
  const now = Date.now(), r = S.running, sc = E.sleepCol();
  const elapsed = r ? (r.startAt ? now - r.startAt : 0) : 0;
  const quiet = (() => { const qe = (w + 30) % 1440; return s <= qe ? nm >= s && nm < qe : nm >= s || nm < qe; })();

  let kind = FORCE || null;
  if (!kind && r && r.col !== sc && elapsed > 150 * 60000 && rt.longFor !== r.startAt) { kind = 'long'; rt.longFor = r.startAt; }
  if (!kind && !rt.morning && !pf.morning && within(nm, w + 30, 90)) { kind = 'morning'; rt.morning = true; }
  const snoozed = (rt.snoozeUntil || 0) > now;
  if (!kind && !snoozed && !rt.bed && !pf.bed && within(nm, s - 15, 35)) { kind = 'bed'; rt.bed = true; rt.count++; rt.lastAt = now; }
  if (!kind && !snoozed && rt.bedAgainAt && now >= rt.bedAgainAt) { kind = 'bed'; rt.bedAgainAt = 0; }
  if (!kind && !snoozed && !r && !quiet && rt.count < (cfg.max || 4)) {
    const gap = (cfg.every || 3) * 3600000 * ((rt.ignored || 0) >= 2 ? 2 : 1);
    const last = Math.max(S.lastLogAt || 0, rt.lastAt || 0, pf.lastAt || 0);
    if (now - last >= gap) {
      rt.ignored = rt.lastAt && (S.lastLogAt || 0) < rt.lastAt ? (rt.ignored || 0) + 1 : 0;
      kind = 'idle'; rt.count++; rt.lastAt = now;
    }
  }
  if (!kind) {
    if (prev.date !== today) await writeDoc(pushId, rt);
    return console.log(`${docId}: nothing due (${String(Math.floor(nm / 60)).padStart(2, '0')}:${String(nm % 60).padStart(2, '0')} ${tz})`);
  }

  // ---------- build the notification ----------
  const name = S.profile?.name ? ` ${S.profile.name}` : '';
  const link = params => `${site}?${new URLSearchParams({ ...params, d: docId })}`;
  const view = (label, params) => ({ action: 'view', label, url: link(params), clear: true });
  const setField = (label, field, value) => ({
    action: 'http', label, method: 'PATCH', clear: true,
    url: `${BASE}/${encodeURIComponent(pushId)}?key=${KEY}&updateMask.fieldPaths=${field}`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { [field]: { integerValue: String(value) } } })
  });
  let title, message, actions, click = link({ nudge: 'idle' });
  if (kind === 'long') {
    title = `Still on ${r.col}? ⏱`; message = `${fmtH(elapsed / 3600000)} so far. Nice focus.`;
    actions = [setField('Keep going', 'ackAt', now), view('End session', { act: 'end' }), view('Switch', { act: 'pick' })];
    click = site;
  } else if (kind === 'bed') {
    const cur = r ? r.col : E.yesterdayAt(nm);
    title = `Winding down${name}? 🌙`;
    message = `Yesterday you went to bed around ${sleep}. Tap when you head off and I'll time your sleep.`;
    actions = [];
    if (sc) actions.push(view('Going to sleep now 😴', { go: sc }));
    actions.push(setField('30 more minutes', 'bedAgainAt', now + 30 * 60000));
    if (cur && cur !== sc) actions.push(r ? setField(`Still on ${cur}`, 'ackAt', now) : view(`Still on ${cur}`, { go: cur }));
    click = site;
  } else if (kind === 'morning') {
    title = `Good morning${name} ☀️`;
    if (r && r.col === sc) { message = "Pip's awake too. Shall I end your sleep session?"; actions = [view("I'm awake", { act: 'end' }), view('Plan my day', { act: 'plan' })]; }
    else {
      const first = E.usualAt(nm, []);
      message = `${E.coreCols().length} daily habits for Pip to grow today.`;
      actions = [first ? view(`Start with ${first}`, { go: first }) : null, view('Plan my day', { act: 'plan' })].filter(Boolean);
    }
    click = site;
  } else {
    const o1 = E.yesterdayAt(nm), o2 = E.usualAt(nm, o1 ? [o1] : []), o3 = E.restOption(nm, sleep, [o1, o2].filter(Boolean));
    const hrs = Math.max(1, Math.round((now - Math.max(S.lastLogAt || 0, pf.lastAt || 0)) / 3600000));
    title = [`Hey${name} 👋 what are you up to?`, 'Quick check-in from Pip 🌱', "What's happening right now?", 'Pip is curious 👀 what are you doing?'][Math.floor(Math.random() * 4)];
    message = `${hrs > 48 ? 'A while' : hrs + 'h'} since your last log. One tap is enough.`;
    actions = [];
    if (o1) actions.push(view(`${o1} (like yesterday)`, { go: o1 }));
    if (o2) actions.push(view(o2, { go: o2 }));
    if (o3) actions.push(view(o3.label, { go: o3.col }));
  }
  const res = await fetch('https://ntfy.sh/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: phone.topic, title, message, tags: ['seedling'], click, actions: actions.slice(0, 3) })
  });
  console.log(`${docId}: sent "${kind}" check-in (${res.status})`);
  if (!FORCE) await writeDoc(pushId, rt);
}

for (const id of DASHBOARDS) {
  try { await checkDashboard(id); } catch (e) { console.error(`${id}: ${e.message}`); process.exitCode = 1; }
}
