// Phone check-ins for the Daily Tracker. Runs every 15 minutes from GitHub Actions; no dependencies.
// It reads each dashboard from Firestore, decides whether a nudge is due, and sends it to the ntfy app.
// Buttons on the notification write a "tap" straight into Firestore, so one tap logs it, no website needed.
const PROJECT = 'daily-tracker-bbee6';
const KEY = 'AIzaSyAjIG30nPmTBBAZ7c7cmgeXn25BwdviEEA';
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const BASE = `${ROOT}/tracker_data`;
const DOCPATH = id => `projects/${PROJECT}/databases/(default)/documents/tracker_data/${id}`;
const DASHBOARDS = (process.env.DASHBOARDS || 'my_dashboard').split(',').map(s => s.trim()).filter(Boolean);
const FORCE = (process.env.FORCE_KIND || '').trim();
const AI = { key: process.env.AI_KEY || '', base: (process.env.AI_BASE || 'https://aicredits.in/v1').replace(/\/+$/, ''), model: process.env.AI_MODEL || 'google/gemini-2.5-flash-lite' };

// ---------- Firestore REST ----------
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
  return fromFs({ mapValue: { fields: (await r.json()).fields || {} } });
}
async function writeFields(id, obj) {   // only touches the given top-level fields
  const mask = Object.keys(obj).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const r = await fetch(`${BASE}/${encodeURIComponent(id)}?key=${KEY}&${mask}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFs(obj).mapValue.fields })
  });
  if (!r.ok) throw new Error(`Writing ${id} failed: ${r.status} ${await r.text()}`);
}

// ---------- time ----------
function localNow(tz, offsetDays = 0) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(Date.now() + offsetDays * 864e5)).map(p => [p.type, p.value]));
  const hh = parts.hour === '24' ? 0 : +parts.hour;
  return { today: `${parts.day}/${parts.month}`, nm: hh * 60 + +parts.minute };
}
const toMin = hm => { const [h, m] = String(hm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const fromMin = m => { m = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const within = (nm, start, len) => ((nm - start) % 1440 + 1440) % 1440 < len;
const fmtH = h => { h = +h || 0; if (h <= 0) return '0m'; const hh = Math.floor(h), mm = Math.round((h - hh) * 60); return hh && mm ? `${hh}h ${mm}m` : hh ? `${hh}h` : `${mm}m`; };
const shuffle = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
const tsOf = v => typeof v === 'number' ? v : Date.parse(v || '') || 0;

// ---------- the same habit logic the site uses ----------
function engine(S, today) {
  const allDates = S.allDates || [];
  const allColumns = () => (S.groups || []).flatMap(g => g.columns || []);
  const cellOf = (d, c) => S.logs?.[d]?.[c] || {};
  const slotsHours = slots => { let m = 0; (slots || []).forEach(s => { if (s.from && s.to) { let a = toMin(s.from), b = toMin(s.to); if (b < a) b += 1440; m += b - a; } }); return m / 60; };
  const hoursOf = cd => { const h = parseFloat(cd.hours); return cd.hours && !isNaN(h) ? h : slotsHours(cd.timeSlots); };
  const isDone = (d, c) => { const cd = cellOf(d, c); return (cd.actual !== undefined && String(cd.actual).trim() !== '') || hoursOf(cd) > 0 || (parseFloat(cd.count) || 0) > 0; };
  const ruleOf = c => { const r = S.columnRules?.[c]; if (r) return r; const g = (S.groups || []).find(g => (g.columns || []).includes(c)); return g && /media|screen|social|ott/i.test(g.name) ? 'less' : 'more'; };
  const isCore = c => { const m = S.habitMeta?.[c]; return m && typeof m.daily === 'boolean' ? m.daily : true; };
  const coreCols = () => { const a = allColumns(), c = a.filter(isCore); return c.length ? c : a; };
  const idx = (() => { const i = allDates.indexOf(today); return i >= 0 ? i : allDates.length - 1; })();
  const sleepCol = () => allColumns().find(c => /sleep/i.test(c)) || null;
  const mediaCols = () => allColumns().filter(c => ruleOf(c) === 'less');
  const studyCols = () => { const g = (S.groups || []).filter(g => /academ|study|career|learn|course|exam|college|work/i.test(g.name)); return (g.length ? g : (S.groups || []).slice(0, 1)).flatMap(x => x.columns || []); };
  const dayLogged = d => allColumns().some(c => isDone(d, c)) || !!(S.checkins?.[d] && (S.checkins[d].mood || S.checkins[d].energy || S.checkins[d].win));
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
    allColumns().forEach(c => { if (c === sc) return; (cellOf(y, c).timeSlots || []).forEach(s => {
      if (!s.from) return; const a = toMin(s.from), b = s.to ? toMin(s.to) : a + 30;
      const inside = a <= b ? nm >= a && nm <= b : nm >= a || nm <= b, d = inside ? 0 : Math.min(Math.abs(nm - a), Math.abs(nm - b));
      if (d < bd && d <= 60) { bd = d; best = c; }
    }); });
    return best;
  }
  function usualAt(nm, exclude) {
    const days = allDates.slice(Math.max(0, idx - 14), idx), sc = sleepCol(), score = {};
    days.forEach(d => allColumns().forEach(c => (cellOf(d, c).timeSlots || []).forEach(s => { if (!s.from || c === sc) return; const dd = Math.abs(nm - toMin(s.from)); if (Math.min(dd, 1440 - dd) <= 90) score[c] = (score[c] || 0) + 1; })));
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
    const media = mediaCols().filter(c => !exclude.includes(c)); if (!media.length) return null;
    const used = c => allDates.slice(Math.max(0, idx - 14), idx + 1).filter(d => isDone(d, c)).length;
    const m = media.sort((a, b) => used(b) - used(a))[0];
    return { col: m, label: `Taking a break (${m})` };
  }
  function pickOptions(nm, sleep) {
    const sc = sleepCol(), o1 = yesterdayAt(nm), used = new Set(o1 ? [o1] : []), opts = [];
    if (o1) opts.push({ label: `${o1} (like yesterday)`, col: o1 });
    const rest = restOption(nm, sleep, [...used]);
    const cands = [usualAt(nm, [...used]), ...shuffle(coreCols().filter(c => c !== sc && !isDone(today, c))), ...shuffle(allColumns().filter(c => c !== sc))];
    for (const c of cands) { if (opts.length >= (rest ? 2 : 3)) break; if (!c || used.has(c) || (rest && c === rest.col)) continue; used.add(c); opts.push({ label: c, col: c }); }
    if (rest) opts.push(rest);
    return opts;
  }
  function riskStart() {
    const bins = {}; allDates.slice(Math.max(0, idx - 14), idx).forEach(d => mediaCols().forEach(c => (cellOf(d, c).timeSlots || []).forEach(s => { if (!s.from) return; const b = Math.floor(toMin(s.from) / 30) * 30; (bins[b] = bins[b] || new Set()).add(d); })));
    let best = null, n = 0; Object.entries(bins).forEach(([b, set]) => { if (set.size > n) { n = set.size; best = +b; } });
    return n >= 3 ? best : null;
  }
  function dayText(d) {
    const lines = [];
    allColumns().forEach(c => {
      const cd = cellOf(d, c), h = hoursOf(cd), sl = (cd.timeSlots || []).filter(s => s.from).map(s => `${s.from}-${s.to || '?'}`).join(', ');
      if (!(cd.actual || h || sl || cd.reason)) return;
      lines.push(`  - ${c}: ${cd.actual ? `did ${cd.actual}` : ''}${h ? ` ${fmtH(h)}` : ''}${sl ? ` at ${sl}` : ''}${cd.reason ? ` note "${cd.reason}"` : ''}`);
    });
    const ci = S.checkins?.[d] || {};
    return `${d}${S.restDays?.[d] ? ' [rest day]' : ''}${ci.mood ? ` mood ${ci.mood}/5` : ''}${ci.energy ? ` energy ${ci.energy}/5` : ''}${ci.win ? ` "${ci.win}"` : ''}\n${lines.join('\n') || '  (nothing logged)'}`;
  }
  return { idx, allDates, allColumns, isDone, coreCols, sleepCol, mediaCols, studyCols, sleepWake, yesterdayAt, usualAt, restOption, pickOptions, riskStart, dayLogged, dayText, ruleOf, cellOf };
}

// ---------- notification buttons ----------
const tapKey = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function tapButton(label, docId, payload) {
  const k = tapKey();
  const fields = Object.fromEntries(Object.entries(payload).map(([a, b]) => [a, { stringValue: String(b) }]));
  return {
    action: 'http', label, method: 'POST', clear: true,
    url: `${ROOT}:commit?key=${KEY}`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes: [{
      update: { name: DOCPATH(`${docId}-push`), fields: { taps: { mapValue: { fields: { [k]: { mapValue: { fields } } } } } } },
      updateMask: { fieldPaths: Object.keys(payload).map(f => `taps.${k}.${f}`) },
      updateTransforms: [{ fieldPath: `taps.${k}.at`, setToServerValue: 'REQUEST_TIME' }]
    }] })
  };
}
function setButton(label, docId, path, value) {
  const parts = path.split('.'); let v = { integerValue: String(value) };
  for (let i = parts.length - 1; i > 0; i--) v = { mapValue: { fields: { [parts[i]]: v } } };
  return { action: 'http', label, method: 'PATCH', clear: true, url: `${BASE}/${encodeURIComponent(docId + '-push')}?key=${KEY}&updateMask.fieldPaths=${encodeURIComponent(path)}`, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { [parts[0]]: v } }) };
}

async function aiReview(S, E, today) {
  const days = E.allDates.slice(Math.max(0, E.idx - 8), E.idx + 1);
  const habits = (S.groups || []).map(g => `${g.name}: ${(g.columns || []).join(', ')}`).join('\n');
  const sys = `You are the personal habit coach inside a daily tracker. Use only the data given; never invent numbers. Be kind but honest, specific, with times and numbers. Short markdown with ### headings and bullets.\nAbout the user: ${S.profile?.about || 'not given'}\nGoals: ${(S.goals || []).map(g => g.title).join('; ') || 'none'}\nHabits:\n${habits}\nLog (last 9 days, DD/MM, 24h times):\n${days.map(E.dayText).join('\n')}`;
  const range = `${days.slice(-3)[0]} to ${today}`;
  const prompt = `Write my 3-day review for ${range}, comparing with the 3 days before.\n### The short version\nTwo sentences.\n### Wins\n2–3 bullets with numbers.\n### What slipped\n2–3 honest bullets.\n### Patterns\nCause-and-effect chains across the days (sleep, screen time, mood, when I studied).\n### Next 3 days\nTwo small experiments.\nUnder 260 words. Respect rest days.`;
  const r = await fetch(`${AI.base}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI.key}` }, body: JSON.stringify({ model: AI.model, messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }] }) });
  if (!r.ok) throw new Error(`AI review failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return { text: j.choices?.[0]?.message?.content || '', range };
}

async function ntfy(topic, msg) {
  const r = await fetch('https://ntfy.sh/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic, tags: ['deciduous_tree'], ...msg, actions: (msg.actions || []).slice(0, 3) }) });
  return r.status;
}

// ---------- one dashboard ----------
async function checkDashboard(docId) {
  const S = await readDoc(docId);
  if (!S) return console.log(`${docId}: no data`);
  const cfg = S.nudge || {}, phone = cfg.phone || {};
  if (!phone.on || !phone.topic) return console.log(`${docId}: phone check-ins are off`);
  const site = phone.url || '', tz = cfg.tz || 'Asia/Kolkata';
  const { today, nm } = localNow(tz), yd = localNow(tz, -1).today;
  const E = engine(S, today), pushId = `${docId}-push`;
  const P = (await readDoc(pushId)) || {};
  let rt = P.rt && P.rt.date === today ? { ...P.rt } : { date: today, count: 0, ignored: 0, lastAt: 0, bed: false, morning: false, leaves: false, risk: false, askedNight: false, night: {}, longAt: 0, staleFor: 0, scrollAt: 0 };
  rt.night = rt.night || {};
  const ctl = P.ctl || {};
  const now = Date.now();
  const pf = cfg.pageFlags && cfg.pageFlags.date === today ? cfg.pageFlags : {};
  const { sleep, wake } = E.sleepWake(), s = toMin(sleep), w = toMin(wake), sc = E.sleepCol();
  const quiet = (() => { const qe = (w + 30) % 1440; return s <= qe ? nm >= s && nm < qe : nm >= s || nm < qe; })();

  // taps from the phone that the site hasn't picked up yet still count
  const taps = Object.values(P.taps || {}).map(t => ({ ...t, ts: tsOf(t.at) })).filter(t => t.ts).sort((a, b) => a.ts - b.ts);
  let run = S.running ? { col: S.running.col, startAt: S.running.startAt || 0 } : null;
  let lastTap = 0, tappedToday = false;
  const answeredNight = new Set();
  taps.forEach(t => {
    lastTap = Math.max(lastTap, t.ts);
    if (localNow(tz, (t.ts - now) / 864e5).today === today) tappedToday = true;
    if (t.night) { answeredNight.add(`${t.nd || ''}|${t.night}`); return; }
    if (t.act === 'end') run = null; else if (t.col) run = { col: t.col, startAt: t.ts };
  });
  const lastLog = Math.max(S.lastLogAt || 0, lastTap);
  const elapsed = run ? now - (run.startAt || now) : 0;
  const staleH = run && run.col === sc ? 14 : 6, stale = run && elapsed > staleH * 3600000;
  const gentle = !!S.restDays?.[today] || (S.checkins?.[today]?.mood || 5) <= 2;
  const loggedToday = E.dayLogged(today) || tappedToday;
  const nd = nm < 5 * 60 ? yd : today;
  const nightKey = id => `n${nd.replace('/', '')}_${id}`;
  const nightDone = (date, id) => !!S.nightLog?.[date]?.[id] || answeredNight.has(`${date}|${id}`);

  const send = [];   // notifications to send this run
  let kind = FORCE || null, extra = null;
  // late-night reminders
  for (const t of S.nightTasks || []) {
    if (kind) break;
    const key = nightKey(t.id), again = ctl.nightAgain?.[key];
    if (nightDone(nd, t.id)) continue;
    if ((!rt.night[key] && within(nm, toMin(t.time), 25)) || (again && now >= again)) { rt.night[key] = true; if (again) ctl.nightAgain[key] = 0; kind = 'night'; extra = t; }
  }
  // morning: was last night's list done?
  if (!kind && !rt.askedNight && within(nm, w, 7 * 60) && !quiet) {
    rt.askedNight = true;
    (S.nightTasks || []).filter(t => !nightDone(yd, t.id)).slice(0, 3).forEach(t => send.push({
      title: 'Quick one about last night', message: `Did you do this: ${t.title}?`, click: site,
      actions: [tapButton('Yes ✓', docId, { night: t.id, val: 'done', nd: yd }), tapButton('No', docId, { night: t.id, val: 'no', nd: yd })]
    }));
  }
  // 3-day AI review (needs the AI_KEY secret)
  const lastReview = Math.max(S.lastReviewAt || 0, ...(S.reviews || []).map(r => r.at || 0), tsOf(P.review?.at));
  if (AI.key && !P.review?.text && now - lastReview >= 3 * 864e5 && nm >= 19 * 60 && nm < 23 * 60 && E.allDates.slice(Math.max(0, E.idx - 2), E.idx + 1).some(E.dayLogged)) {
    try {
      const rv = await aiReview(S, E, today);
      if (rv.text.trim()) {
        await writeFields(pushId, { review: { text: rv.text, at: now, range: rv.range } });
        const firstLine = rv.text.replace(/[#*>_]/g, '').split('\n').map(x => x.trim()).filter(Boolean)[1] || '';
        send.push({ title: 'Your 3-day review is ready 🌳', message: firstLine.slice(0, 180) || 'Three days, two experiments to try next.', click: `${site}?act=review&d=${docId}`, actions: [{ action: 'view', label: 'Read & discuss', url: `${site}?act=review&d=${docId}`, clear: true }] });
      }
    } catch (e) { console.error(`${docId}: ${e.message}`); }
  }
  // sessions: forgotten timers, long focus, screen time running long
  if (!kind && run) {
    if (stale && rt.staleFor !== run.startAt) { kind = 'stale'; rt.staleFor = run.startAt; }
    else if (!stale && E.mediaCols().includes(run.col)) {
      const lim = (parseFloat(String(E.cellOf(today, run.col).target || '').replace(/[^\d.]/g, '')) || .75) * 60;
      if (elapsed / 60000 >= lim && now >= (ctl.scrollUntil || 0) && now - (rt.scrollAt || 0) > 30 * 60000) { kind = 'scroll'; rt.scrollAt = now; }
    } else if (!stale && run.col !== sc && elapsed > 150 * 60000 && now - (rt.longAt || 0) > 150 * 60000) { kind = 'long'; rt.longAt = now; }
  }
  if (!kind && !rt.morning && !pf.morning && within(nm, w + 30, 90)) { kind = 'morning'; rt.morning = true; }
  const snoozed = (ctl.snoozeUntil || 0) > now;
  if (!kind && !snoozed && !rt.bed && !pf.bed && within(nm, s - 15, 35)) { kind = 'bed'; rt.bed = true; rt.count++; rt.lastAt = now; }
  if (!kind && !snoozed && ctl.bedAgainAt && now >= ctl.bedAgainAt) { kind = 'bed'; ctl.bedAgainAt = 0; }
  const risk = E.riskStart();
  if (!kind && !snoozed && risk !== null && !rt.risk && (!run || stale) && !quiet && !gentle && within(nm, risk - 15, 20)) { kind = 'risk'; rt.risk = true; }
  if (!kind && !snoozed && !rt.leaves && nm >= 14 * 60 && nm < 20 * 60 && !loggedToday && !S.restDays?.[today] && !quiet) { kind = 'leaves'; rt.leaves = true; rt.count++; rt.lastAt = now; }
  if (!kind && !snoozed && (!run || stale) && !quiet && rt.count < (gentle ? 2 : (cfg.max || 4))) {
    const gap = (cfg.every || 3) * 3600000 * ((rt.ignored || 0) >= 2 || gentle ? 2 : 1);
    if (now - Math.max(lastLog, rt.lastAt || 0, pf.lastAt || 0) >= gap) {
      rt.ignored = rt.lastAt && lastLog < rt.lastAt ? (rt.ignored || 0) + 1 : 0;
      kind = 'idle'; rt.count++; rt.lastAt = now;
    }
  }

  // ---------- build it ----------
  const name = S.profile?.name ? ` ${S.profile.name}` : '';
  const view = (label, params) => ({ action: 'view', label, url: `${site}?${new URLSearchParams({ ...params, d: docId })}`, clear: true });
  const tap = (label, payload) => tapButton(label, docId, payload);
  const ack = label => setButton(label, docId, 'ctl.ackAt', now);
  const optsAsTaps = opts => opts.map(o => tap(o.label, { col: o.col }));
  if (kind) {
    const msg = { click: `${site}?nudge=idle&d=${docId}` };
    if (kind === 'night') { Object.assign(msg, { title: `🌙 ${extra.title}`, message: 'Your late-night reminder.', click: site, actions: [tap('Done ✓', { night: extra.id, val: 'done', nd }), setButton('In 20 minutes', docId, `ctl.nightAgain.${nightKey(extra.id)}`, now + 20 * 60000), tap('Skip tonight', { night: extra.id, val: 'skip', nd })] }); }
    else if (kind === 'stale') Object.assign(msg, { title: `Is ${run.col} still going?`, message: `The timer has been running for ${fmtH(elapsed / 3600000)}. Forgot to stop it?`, click: site, actions: [tap('End it now', { act: 'end' }), ack('Yes, still going'), view('Fix the time', { act: 'stale' })] });
    else if (kind === 'scroll') Object.assign(msg, { title: `${fmtH(elapsed / 3600000)} on ${run.col} 🫧`, message: 'No judgement. How are you feeling about it?', click: `${site}?act=reset&d=${docId}`, actions: [setButton("I'm good, 10 more min", docId, 'ctl.scrollUntil', now + 10 * 60000), view('Help me stop', { act: 'stopscroll' }), view("I'm stuck", { act: 'reset' })] });
    else if (kind === 'long') Object.assign(msg, { title: `Still on ${run.col}? ⏱`, message: `${fmtH(elapsed / 3600000)} so far. Nice focus.`, click: site, actions: [ack('Keep going'), tap('End session', { act: 'end' }), view('Switch', { act: 'pick' })] });
    else if (kind === 'morning') {
      if (run && run.col === sc) Object.assign(msg, { title: `Good morning${name} ☀️`, message: 'Your tree is awake too. Shall I end your sleep session?', click: site, actions: [tap("I'm awake", { act: 'end' }), view('Plan my day', { act: 'plan' })] });
      else { const first = E.usualAt(nm, []); Object.assign(msg, { title: `Good morning${name} ☀️`, message: `${E.coreCols().length} daily habits to water your tree today.`, click: site, actions: [first ? tap(`Start with ${first}`, { col: first }) : null, view('Plan my day', { act: 'plan' })].filter(Boolean) }); }
    } else if (kind === 'bed') {
      const cur = run && !stale ? run.col : E.yesterdayAt(nm), actions = [];
      if (sc) actions.push(tap('Going to sleep now 😴', { col: sc }));
      actions.push(setButton('30 more minutes', docId, 'ctl.bedAgainAt', now + 30 * 60000));
      if (cur && cur !== sc) actions.push(run && !stale ? ack(`Still on ${cur}`) : tap(`Still on ${cur}`, { col: cur }));
      Object.assign(msg, { title: `Winding down${name}? 🌙`, message: `Yesterday you went to bed around ${sleep}. Tap when you head off and I'll time your sleep.`, click: site, actions });
    } else if (kind === 'risk') {
      const st = E.coreCols().find(c => E.studyCols().includes(c) && c !== sc && !E.isDone(today, c)) || E.studyCols()[0];
      Object.assign(msg, { title: 'Heads up 🫧', message: `Around ${fromMin(risk)} is usually when scrolling starts. Want to plan the next hour first?`, click: site, actions: [st ? tap(`Start ${st}`, { col: st }) : null, ack('Wind down early'), ack("I've got this")].filter(Boolean) });
    } else {
      const opts = E.pickOptions(nm, sleep);
      if (kind === 'leaves') Object.assign(msg, { title: "Your tree's leaves are dropping 🍂", message: 'Nothing logged yet today. One tap waters it. Stuck? That happens too.', actions: [...optsAsTaps(opts.slice(0, 2)), view('Feeling stuck? 🫧', { act: 'reset' })] });
      else {
        const hrs = Math.max(1, Math.round((now - Math.max(lastLog, pf.lastAt || 0)) / 3600000));
        const titles = [`Hey${name} 👋 what are you up to?`, 'Quick check-in 🌱', "What's happening right now?", 'Your tree is curious 👀 what are you doing?'];
        Object.assign(msg, { title: gentle ? 'Hey, no pressure 🌧' : titles[Math.floor(Math.random() * titles.length)], message: gentle ? 'If you feel like it, tell me what you are doing. Any answer counts, even resting.' : `${hrs > 48 ? 'A while' : hrs + 'h'} since your last log. Tap one, it logs instantly.`, actions: optsAsTaps(opts) });
      }
    }
    send.unshift(msg);
  }
  for (const m of send) console.log(`${docId}: sent "${m.title}" (${await ntfy(phone.topic, m)})`);
  if (!send.length) console.log(`${docId}: nothing due (${fromMin(nm)} ${tz}${run ? `, timing ${run.col}` : ''})`);
  if (!FORCE) await writeFields(pushId, { rt, ctl });
}

for (const id of DASHBOARDS) {
  try { await checkDashboard(id); } catch (e) { console.error(`${id}: ${e.message}`); process.exitCode = 1; }
}
