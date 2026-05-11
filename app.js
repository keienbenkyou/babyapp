/* ============================================================
   BabyTrack v6 — Full-featured PWA
   Single-file Preact app: logging, editing, sleep-window alerts,
   charts, CSV/JSON export, multi-baby, Supabase partner sync.
   ============================================================ */

const { h, render } = preact;
const { useState, useEffect, useRef, useCallback, useMemo } = preactHooks;
const html = htm.bind(h);

// ─── UUID helper ───────────────────────────────────────────
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : (
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    })
  );
}

// ─── Date helpers ──────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
function fmtTime(iso) {
  if (!iso) return '--:--';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function fmtDuration(ms) {
  if (!ms || ms < 0) return '0m';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function toLocalISO(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}
function toISO(localStr) {
  return new Date(localStr).toISOString();
}
function dayStart(d) {
  const dt = new Date(d);
  dt.setHours(0,0,0,0);
  return dt;
}
function daysBetween(a, b) {
  return Math.floor((dayStart(b) - dayStart(a)) / 86400000);
}

// ─── Database (Dexie + IndexedDB) ──────────────────────────
const db = new Dexie('babytrack');
db.version(1).stores({
  babies:    'id, name, dob',
  logs:      'id, babyId, type, startAt, endAt, createdAt, updatedAt, deletedAt, [babyId+startAt]',
  guideRows: 'id, babyId, ageWeeksMin',
  settings:  '&key'
});

// ─── Default sleep guide ───────────────────────────────────
const DEFAULT_GUIDE = [
  { ageWeeksMin:0,  ageWeeksMax:4,  wakeWindowMin:45,  napCountMin:4, napCountMax:6 },
  { ageWeeksMin:4,  ageWeeksMax:8,  wakeWindowMin:75,  napCountMin:4, napCountMax:5 },
  { ageWeeksMin:8,  ageWeeksMax:12, wakeWindowMin:90,  napCountMin:3, napCountMax:4 },
  { ageWeeksMin:12, ageWeeksMax:16, wakeWindowMin:105, napCountMin:3, napCountMax:4 },
  { ageWeeksMin:16, ageWeeksMax:24, wakeWindowMin:135, napCountMin:2, napCountMax:3 },
  { ageWeeksMin:24, ageWeeksMax:36, wakeWindowMin:150, napCountMin:2, napCountMax:3 },
  { ageWeeksMin:36, ageWeeksMax:52, wakeWindowMin:180, napCountMin:1, napCountMax:2 },
  { ageWeeksMin:52, ageWeeksMax:999,wakeWindowMin:240, napCountMin:1, napCountMax:1 },
];

async function seedGuide(babyId) {
  const existing = await db.guideRows.where('babyId').equals(babyId).count();
  if (existing > 0) return;
  const rows = DEFAULT_GUIDE.map(r => ({ id: uuid(), babyId, ...r }));
  await db.guideRows.bulkAdd(rows);
}

// ─── Sleep-window logic ────────────────────────────────────
function getAgeWeeks(dob) {
  return (Date.now() - new Date(dob).getTime()) / (7 * 24 * 3600000);
}

function getWakeWindow(guideRows, ageWeeks) {
  const row = guideRows.find(r => ageWeeks >= r.ageWeeksMin && ageWeeks < r.ageWeeksMax);
  return row ? row.wakeWindowMin : 60;
}

async function getLastWake(babyId) {
  // Last completed sleep log (has endAt, not deleted)
  const all = await db.logs
    .where('[babyId+startAt]')
    .between([babyId, ''], [babyId, '\uffff'])
    .filter(l => l.type === 'sleep' && l.endAt && !l.deletedAt)
    .sortBy('endAt');
  return all.length ? all[all.length - 1] : null;
}

async function getActiveSleep(babyId) {
  const all = await db.logs
    .where('[babyId+startAt]')
    .between([babyId, ''], [babyId, '\uffff'])
    .filter(l => l.type === 'sleep' && !l.endAt && !l.deletedAt)
    .sortBy('startAt');
  return all.length ? all[all.length - 1] : null;
}

// ─── Supabase sync engine ──────────────────────────────────
let supa = null;
let realtimeSub = null;

function initSupabase(url, anonKey) {
  if (!url || !anonKey) return null;
  supa = supabase.createClient(url, anonKey);
  return supa;
}

async function pushToSupabase(table, rows) {
  if (!supa) return;
  try {
    const { error } = await supa.from(table).upsert(rows, { onConflict: 'id' });
    if (error) console.warn(`Sync push ${table}:`, error.message);
  } catch(e) { console.warn('Sync push error:', e); }
}

async function pullFromSupabase(table, householdId, lastPulled) {
  if (!supa) return [];
  try {
    let q = supa.from(table).select('*').eq('household_id', householdId);
    if (lastPulled) q = q.gt('updated_at', lastPulled);
    const { data, error } = await q;
    if (error) { console.warn(`Sync pull ${table}:`, error.message); return []; }
    return data || [];
  } catch(e) { console.warn('Sync pull error:', e); return []; }
}

function subscribeRealtime(householdId, onLogChange) {
  if (!supa || realtimeSub) return;
  realtimeSub = supa.channel('logs')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'logs', filter: `household_id=eq.${householdId}` }, payload => {
      onLogChange(payload);
    })
    .subscribe();
}

function unsubscribeRealtime() {
  if (realtimeSub) { supa.removeChannel(realtimeSub); realtimeSub = null; }
}

// ─── CSV / JSON export ─────────────────────────────────────
function escCSV(v) { return `"${String(v ?? '').replace(/"/g, '""')}"`; }

function logsToCSV(logs) {
  const cols = ['id','babyId','type','subtype','startAt','endAt','durationMin','amount','quality','note','createdAt','updatedAt','editedBy'];
  const rows = logs.map(l => ({
    ...l,
    durationMin: l.endAt ? Math.round((new Date(l.endAt) - new Date(l.startAt)) / 60000) : ''
  }));
  return [cols.join(','), ...rows.map(r => cols.map(c => escCSV(r[c])).join(','))].join('\n');
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function exportCSV(babyId) {
  const logs = await db.logs.where('babyId').equals(babyId).filter(l => !l.deletedAt).sortBy('startAt');
  const csv = logsToCSV(logs);
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `babytrack-${fmtDate(new Date().toISOString())}.csv`);
}

async function exportJSON() {
  const babies = await db.babies.toArray();
  const logs = await db.logs.toArray();
  const guideRows = await db.guideRows.toArray();
  const settings = await db.settings.toArray();
  const data = { version: 6, exportedAt: new Date().toISOString(), babies, logs, guideRows, settings };
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `babytrack-backup-${fmtDate(new Date().toISOString())}.json`);
}

async function importJSON(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  await db.transaction('rw', db.babies, db.logs, db.guideRows, db.settings, async () => {
    if (data.babies) await db.babies.bulkPut(data.babies);
    if (data.logs) await db.logs.bulkPut(data.logs);
    if (data.guideRows) await db.guideRows.bulkPut(data.guideRows);
    if (data.settings) await db.settings.bulkPut(data.settings);
  });
}

// ─── Notification helper ───────────────────────────────────
async function sendNotification(title, body, tag) {
  if (Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg) {
      reg.active.postMessage({ type: 'NOTIFY', title, body, tag });
    } else {
      new Notification(title, { body, icon: './icons/icon-192.png' });
    }
  } catch(e) { console.warn('Notification failed:', e); }
}

// ─── Color map for log types ───────────────────────────────
const TYPE_CONFIG = {
  sleep:  { icon: '🌙', color: 'violet', bg: 'bg-violet-100', text: 'text-violet-700', border: 'border-violet-300' },
  feed:   { icon: '🍼', color: 'amber', bg: 'bg-amber-100', text: 'text-amber-700', border: 'border-amber-300' },
  diaper: { icon: '👶', color: 'teal', bg: 'bg-teal-100', text: 'text-teal-700', border: 'border-teal-300' },
  note:   { icon: '📝', color: 'slate', bg: 'bg-slate-100', text: 'text-slate-700', border: 'border-slate-300' },
};

const SUBTYPES = {
  sleep:  ['crib', 'contact', 'stroller', 'car', 'carrier', 'swing'],
  feed:   ['breast_left', 'breast_right', 'bottle', 'solids'],
  diaper: ['pee', 'poop', 'both'],
  note:   [],
};

// ─── COMPONENTS ────────────────────────────────────────────

// ──── Tabs ─────────────────────────────────────────────────
function BottomTabs({ tab, setTab }) {
  const tabs = [
    { id: 'home', label: 'Home', icon: '🏠' },
    { id: 'history', label: 'History', icon: '📋' },
    { id: 'charts', label: 'Charts', icon: '📊' },
    { id: 'settings', label: 'Settings', icon: '⚙️' },
  ];
  return html`
    <nav class="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 flex z-50" style="padding-bottom: env(safe-area-inset-bottom)">
      ${tabs.map(t => html`
        <button key=${t.id} onClick=${() => setTab(t.id)}
          class="flex-1 flex flex-col items-center py-2 text-xs ${tab === t.id ? 'text-violet-600 font-bold' : 'text-slate-400'}">
          <span class="text-lg">${t.icon}</span>
          <span>${t.label}</span>
        </button>
      `)}
    </nav>
  `;
}

// ──── Modal ────────────────────────────────────────────────
function Modal({ open, onClose, title, children }) {
  if (!open) return null;
  return html`
    <div class="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center" onClick=${e => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[90vh] flex flex-col">
        <div class="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <h3 class="font-bold text-lg">${title}</h3>
          <button onClick=${onClose} class="text-slate-400 text-2xl leading-none">&times;</button>
        </div>
        <div class="scroll-y p-4 flex-1">${children}</div>
      </div>
    </div>
  `;
}

// ──── Baby Profile Modal ───────────────────────────────────
function BabyProfileModal({ open, onClose, baby, onSave }) {
  const [name, setName] = useState('');
  const [dob, setDob] = useState('');
  useEffect(() => { if (baby) { setName(baby.name || ''); setDob(baby.dob || ''); } else { setName(''); setDob(''); } }, [baby, open]);

  const save = async () => {
    if (!name.trim()) return;
    const now = new Date().toISOString();
    if (baby) {
      await db.babies.update(baby.id, { name: name.trim(), dob, updatedAt: now });
    } else {
      const id = uuid();
      await db.babies.add({ id, name: name.trim(), dob, createdAt: now, updatedAt: now });
      await seedGuide(id);
    }
    onSave();
    onClose();
  };

  return html`
    <${Modal} open=${open} onClose=${onClose} title=${baby ? 'Edit Baby' : 'Add Baby'}>
      <label class="block mb-3">
        <span class="text-sm text-slate-600">Name</span>
        <input class="block w-full mt-1 border border-slate-300 rounded-lg px-3 py-2" value=${name} onInput=${e => setName(e.target.value)} placeholder="Baby name" />
      </label>
      <label class="block mb-4">
        <span class="text-sm text-slate-600">Date of Birth</span>
        <input type="date" class="block w-full mt-1 border border-slate-300 rounded-lg px-3 py-2" value=${dob} onInput=${e => setDob(e.target.value)} />
      </label>
      <button onClick=${save} class="btn w-full bg-violet-600 text-white">Save</button>
    <//>
  `;
}

// ──── Log Form Modal ───────────────────────────────────────
function LogFormModal({ open, onClose, babyId, log, onSave }) {
  const [type, setType] = useState('sleep');
  const [subtype, setSubtype] = useState('');
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [amount, setAmount] = useState('');
  const [quality, setQuality] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (log) {
      setType(log.type);
      setSubtype(log.subtype || '');
      setStartAt(log.startAt ? toLocalISO(log.startAt) : '');
      setEndAt(log.endAt ? toLocalISO(log.endAt) : '');
      setAmount(log.amount ?? '');
      setQuality(log.quality ?? '');
      setNote(log.note || '');
    } else {
      setType('sleep');
      setSubtype('');
      setStartAt(toLocalISO(new Date()));
      setEndAt('');
      setAmount('');
      setQuality('');
      setNote('');
    }
  }, [log, open]);

  const save = async () => {
    const now = new Date().toISOString();
    const deviceLabel = (await db.settings.get('deviceLabel'))?.value || 'device';
    const entry = {
      babyId,
      type,
      subtype: subtype || null,
      startAt: startAt ? toISO(startAt) : now,
      endAt: endAt ? toISO(endAt) : null,
      amount: amount !== '' ? Number(amount) : null,
      quality: quality !== '' ? Number(quality) : null,
      note: note || null,
      updatedAt: now,
      editedBy: deviceLabel,
    };
    if (log) {
      await db.logs.update(log.id, entry);
    } else {
      entry.id = uuid();
      entry.createdAt = now;
      entry.deletedAt = null;
      await db.logs.add(entry);
    }
    // Push to Supabase if configured
    const hid = (await db.settings.get('householdId'))?.value;
    if (supa && hid) {
      pushToSupabase('logs', [{ ...entry, id: log?.id || entry.id, household_id: hid }]);
    }
    onSave();
    onClose();
  };

  const remove = async () => {
    if (!log) return;
    const now = new Date().toISOString();
    await db.logs.update(log.id, { deletedAt: now, updatedAt: now });
    const hid = (await db.settings.get('householdId'))?.value;
    if (supa && hid) {
      pushToSupabase('logs', [{ id: log.id, household_id: hid, deleted_at: now, updated_at: now }]);
    }
    onSave();
    onClose();
  };

  const types = ['sleep', 'feed', 'diaper', 'note'];

  return html`
    <${Modal} open=${open} onClose=${onClose} title=${log ? 'Edit Log' : 'New Log'}>
      <div class="flex gap-2 mb-4">
        ${types.map(t => html`
          <button key=${t} onClick=${() => { setType(t); setSubtype(''); }}
            class="btn flex-1 text-sm ${type === t ? `${TYPE_CONFIG[t].bg} ${TYPE_CONFIG[t].text} border ${TYPE_CONFIG[t].border}` : 'bg-slate-100 text-slate-500'}">
            ${TYPE_CONFIG[t].icon} ${t[0].toUpperCase() + t.slice(1)}
          </button>
        `)}
      </div>

      ${SUBTYPES[type]?.length > 0 && html`
        <div class="mb-3">
          <span class="text-sm text-slate-600 block mb-1">Subtype</span>
          <div class="flex flex-wrap gap-2">
            ${SUBTYPES[type].map(s => html`
              <button key=${s} onClick=${() => setSubtype(s === subtype ? '' : s)}
                class="btn text-xs ${subtype === s ? 'bg-violet-100 text-violet-700 border border-violet-300' : 'bg-slate-100 text-slate-500'}">
                ${s.replace('_', ' ')}
              </button>
            `)}
          </div>
        </div>
      `}

      <label class="block mb-3">
        <span class="text-sm text-slate-600">Start</span>
        <input type="datetime-local" class="block w-full mt-1 border border-slate-300 rounded-lg px-3 py-2"
          value=${startAt} onInput=${e => setStartAt(e.target.value)} />
      </label>

      ${(type === 'sleep' || type === 'feed') && html`
        <label class="block mb-3">
          <span class="text-sm text-slate-600">End ${type === 'sleep' ? '(leave blank if still sleeping)' : ''}</span>
          <input type="datetime-local" class="block w-full mt-1 border border-slate-300 rounded-lg px-3 py-2"
            value=${endAt} onInput=${e => setEndAt(e.target.value)} />
        </label>
      `}

      ${type === 'feed' && html`
        <label class="block mb-3">
          <span class="text-sm text-slate-600">Amount (ml or min)</span>
          <input type="number" class="block w-full mt-1 border border-slate-300 rounded-lg px-3 py-2"
            value=${amount} onInput=${e => setAmount(e.target.value)} placeholder="e.g. 120" />
        </label>
      `}

      ${(type === 'sleep' || type === 'feed') && html`
        <div class="mb-3">
          <span class="text-sm text-slate-600 block mb-1">Quality</span>
          <div class="flex gap-2">
            ${[1,2,3,4,5].map(q => html`
              <button key=${q} onClick=${() => setQuality(q === quality ? '' : q)}
                class="btn text-sm w-10 h-10 ${Number(quality) === q ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-500'}">
                ${q}
              </button>
            `)}
          </div>
        </div>
      `}

      <label class="block mb-4">
        <span class="text-sm text-slate-600">Note</span>
        <textarea class="block w-full mt-1 border border-slate-300 rounded-lg px-3 py-2 h-20" value=${note} onInput=${e => setNote(e.target.value)} placeholder="Optional note..." />
      </label>

      <button onClick=${save} class="btn w-full bg-violet-600 text-white mb-2">
        ${log ? 'Update' : 'Save'}
      </button>

      ${log && html`
        <button onClick=${remove} class="btn w-full bg-red-100 text-red-700">Delete</button>
      `}
    <//>
  `;
}

// ──── Sleep Guide Editor ───────────────────────────────────
function SleepGuideModal({ open, onClose, babyId, onSave }) {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    if (open && babyId) {
      db.guideRows.where('babyId').equals(babyId).sortBy('ageWeeksMin').then(setRows);
    }
  }, [open, babyId]);

  const update = (idx, field, val) => {
    const copy = [...rows];
    copy[idx] = { ...copy[idx], [field]: Number(val) };
    setRows(copy);
  };

  const save = async () => {
    for (const r of rows) await db.guideRows.put(r);
    onSave();
    onClose();
  };

  const resetDefaults = async () => {
    await db.guideRows.where('babyId').equals(babyId).delete();
    await seedGuide(babyId);
    const fresh = await db.guideRows.where('babyId').equals(babyId).sortBy('ageWeeksMin');
    setRows(fresh);
  };

  return html`
    <${Modal} open=${open} onClose=${onClose} title="Sleep Guide">
      <p class="text-sm text-slate-500 mb-3">Adjust wake windows (minutes) by age in weeks.</p>
      <div class="space-y-3">
        ${rows.map((r, i) => html`
          <div key=${r.id} class="flex items-center gap-2 text-sm">
            <span class="w-20 text-slate-500">${r.ageWeeksMin}–${r.ageWeeksMax}w</span>
            <input type="number" class="border border-slate-300 rounded px-2 py-1 w-20 text-center"
              value=${r.wakeWindowMin} onInput=${e => update(i, 'wakeWindowMin', e.target.value)} />
            <span class="text-slate-400">min</span>
          </div>
        `)}
      </div>
      <div class="mt-4 flex gap-2">
        <button onClick=${save} class="btn flex-1 bg-violet-600 text-white">Save</button>
        <button onClick=${resetDefaults} class="btn flex-1 bg-slate-100 text-slate-600">Reset defaults</button>
      </div>
    <//>
  `;
}

// ──── Dashboard ────────────────────────────────────────────
function Dashboard({ baby, onAddLog, refresh, refreshKey }) {
  const [activeSleep, setActiveSleep] = useState(null);
  const [lastWake, setLastWake] = useState(null);
  const [guideRows, setGuideRows] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [recentLogs, setRecentLogs] = useState([]);
  const alertedRef = useRef(null);

  useEffect(() => {
    if (!baby) return;
    const load = async () => {
      const active = await getActiveSleep(baby.id);
      setActiveSleep(active);
      const last = await getLastWake(baby.id);
      setLastWake(last);
      const rows = await db.guideRows.where('babyId').equals(baby.id).sortBy('ageWeeksMin');
      setGuideRows(rows);
      const recent = await db.logs.where('babyId').equals(baby.id).filter(l => !l.deletedAt).reverse().sortBy('startAt');
      setRecentLogs(recent.slice(0, 5));
    };
    load();
  }, [baby, refreshKey]);

  // Tick every 15s
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(iv);
  }, []);

  // Alert check
  useEffect(() => {
    if (!baby || !lastWake || activeSleep) return;
    const ageWeeks = getAgeWeeks(baby.dob);
    const ww = getWakeWindow(guideRows, ageWeeks);
    const wokeAt = new Date(lastWake.endAt).getTime();
    const overtiredAt = wokeAt + ww * 60000;
    const msLeft = overtiredAt - now;
    const tenMin = 10 * 60000;
    if (msLeft <= tenMin && msLeft > -60000 && alertedRef.current !== lastWake.id) {
      alertedRef.current = lastWake.id;
      sendNotification('BabyTrack', `${baby.name} is approaching overtired! ${Math.max(0, Math.round(msLeft/60000))}min left.`, 'overtired');
    }
  }, [now, baby, lastWake, activeSleep, guideRows]);

  if (!baby) return html`<div class="p-6 text-center text-slate-400">Add a baby to get started.</div>`;

  const ageWeeks = getAgeWeeks(baby.dob);
  const ww = getWakeWindow(guideRows, ageWeeks);
  let awakeMs = 0, overtiredAt = 0, msLeft = 0, pct = 0;
  if (lastWake && !activeSleep) {
    awakeMs = now - new Date(lastWake.endAt).getTime();
    overtiredAt = new Date(lastWake.endAt).getTime() + ww * 60000;
    msLeft = overtiredAt - now;
    pct = Math.min(100, Math.max(0, (awakeMs / (ww * 60000)) * 100));
  }
  const sleeping = !!activeSleep;
  const sleepMs = sleeping ? now - new Date(activeSleep.startAt).getTime() : 0;

  const statusClass = sleeping ? 'bg-violet-50' : msLeft <= 0 ? 'pulse-red' : msLeft <= 10*60000 ? 'pulse-amber' : 'bg-white';

  const stopSleep = async () => {
    const now2 = new Date().toISOString();
    await db.logs.update(activeSleep.id, { endAt: now2, updatedAt: now2 });
    refresh();
  };

  const quickAdd = (type) => {
    onAddLog(type);
  };

  return html`
    <div class="p-4 space-y-4">
      <!-- Status card -->
      <div class="card ${statusClass}">
        ${sleeping ? html`
          <div class="text-center">
            <div class="text-4xl mb-2">🌙</div>
            <div class="text-lg font-bold text-violet-700">Sleeping for ${fmtDuration(sleepMs)}</div>
            <div class="text-sm text-slate-500">Since ${fmtTime(activeSleep.startAt)}</div>
            <button onClick=${stopSleep} class="btn mt-3 bg-violet-600 text-white">Stop Sleep</button>
          </div>
        ` : lastWake ? html`
          <div class="text-center">
            <div class="text-sm text-slate-500 mb-1">Awake since ${fmtTime(lastWake.endAt)}</div>
            <div class="text-3xl font-bold ${msLeft <= 0 ? 'text-red-600' : msLeft <= 10*60000 ? 'text-amber-600' : 'text-slate-800'}">
              ${fmtDuration(awakeMs)}
            </div>
            <div class="w-full bg-slate-200 rounded-full h-2.5 mt-3 mb-2">
              <div class="h-2.5 rounded-full transition-all duration-500 ${pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-violet-500'}" style="width: ${pct}%"></div>
            </div>
            <div class="text-sm ${msLeft <= 0 ? 'text-red-600 font-bold' : 'text-slate-500'}">
              ${msLeft <= 0
                ? `Overtired by ${fmtDuration(Math.abs(msLeft))}!`
                : `Next nap by ${fmtTime(new Date(overtiredAt).toISOString())} (${fmtDuration(msLeft)} left)`
              }
            </div>
            <div class="text-xs text-slate-400 mt-1">Wake window: ${ww} min (${Math.floor(ageWeeks)}w old)</div>
          </div>
        ` : html`
          <div class="text-center text-slate-400">No sleep logged yet. Add the first one!</div>
        `}
      </div>

      <!-- Quick-add buttons -->
      <div class="grid grid-cols-4 gap-2">
        ${['sleep', 'feed', 'diaper', 'note'].map(t => html`
          <button key=${t} onClick=${() => quickAdd(t)}
            class="card flex flex-col items-center py-3 active:scale-95 transition">
            <span class="text-2xl">${TYPE_CONFIG[t].icon}</span>
            <span class="text-xs mt-1 text-slate-600">${t[0].toUpperCase() + t.slice(1)}</span>
          </button>
        `)}
      </div>

      <!-- Recent activity -->
      <div class="card">
        <h3 class="font-bold text-sm text-slate-500 mb-2">Recent Activity</h3>
        ${recentLogs.length === 0 ? html`<p class="text-sm text-slate-400">No logs yet.</p>` : html`
          <div class="space-y-2">
            ${recentLogs.map(l => html`
              <div key=${l.id} onClick=${() => onAddLog(null, l)}
                class="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-50 cursor-pointer transition">
                <span class="text-xl">${TYPE_CONFIG[l.type]?.icon}</span>
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-medium">${l.type}${l.subtype ? ` · ${l.subtype.replace('_',' ')}` : ''}</div>
                  <div class="text-xs text-slate-400">${fmtTime(l.startAt)}${l.endAt ? ` – ${fmtTime(l.endAt)}` : ' (ongoing)'}${l.note ? ` · ${l.note}` : ''}</div>
                </div>
                ${l.endAt && html`<span class="text-xs text-slate-400">${fmtDuration(new Date(l.endAt) - new Date(l.startAt))}</span>`}
              </div>
            `)}
          </div>
        `}
      </div>
    </div>
  `;
}

// ──── History ──────────────────────────────────────────────
function History({ baby, onEdit, refreshKey }) {
  const [logs, setLogs] = useState([]);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    if (!baby) return;
    db.logs.where('babyId').equals(baby.id).filter(l => !l.deletedAt).reverse().sortBy('startAt').then(setLogs);
  }, [baby, refreshKey]);

  const filtered = filter === 'all' ? logs : logs.filter(l => l.type === filter);
  const grouped = useMemo(() => {
    const g = {};
    filtered.forEach(l => {
      const d = fmtDate(l.startAt);
      (g[d] = g[d] || []).push(l);
    });
    return g;
  }, [filtered]);

  if (!baby) return html`<div class="p-6 text-center text-slate-400">Select a baby first.</div>`;

  return html`
    <div class="p-4">
      <div class="flex gap-2 mb-4 overflow-x-auto">
        ${['all', 'sleep', 'feed', 'diaper', 'note'].map(t => html`
          <button key=${t} onClick=${() => setFilter(t)}
            class="btn text-xs whitespace-nowrap ${filter === t ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-500'}">
            ${t === 'all' ? 'All' : `${TYPE_CONFIG[t].icon} ${t[0].toUpperCase() + t.slice(1)}`}
          </button>
        `)}
      </div>
      ${Object.keys(grouped).length === 0 ? html`<p class="text-center text-slate-400 mt-10">No logs found.</p>` : null}
      ${Object.entries(grouped).map(([date, items]) => html`
        <div key=${date} class="mb-4">
          <div class="text-xs font-bold text-slate-400 mb-2 sticky top-0 bg-slate-50 py-1">${date} · ${items.length} entries</div>
          <div class="space-y-1">
            ${items.map(l => html`
              <div key=${l.id} onClick=${() => onEdit(l)}
                class="card flex items-center gap-3 py-2 px-3 cursor-pointer hover:border-violet-300 transition">
                <span class="text-lg">${TYPE_CONFIG[l.type]?.icon}</span>
                <div class="flex-1 min-w-0">
                  <span class="text-sm font-medium">${l.type}${l.subtype ? ` · ${l.subtype.replace('_',' ')}` : ''}</span>
                  ${l.note ? html`<span class="text-xs text-slate-400 ml-2">${l.note.slice(0,40)}</span>` : null}
                </div>
                <div class="text-right">
                  <div class="text-sm">${fmtTime(l.startAt)}${l.endAt ? ` – ${fmtTime(l.endAt)}` : ''}</div>
                  ${l.endAt && html`<div class="text-xs text-slate-400">${fmtDuration(new Date(l.endAt) - new Date(l.startAt))}</div>`}
                </div>
              </div>
            `)}
          </div>
        </div>
      `)}
    </div>
  `;
}

// ──── Charts ───────────────────────────────────────────────
function Charts({ baby, refreshKey }) {
  const canvasRef1 = useRef(null);
  const canvasRef2 = useRef(null);
  const chart1Ref = useRef(null);
  const chart2Ref = useRef(null);
  const [days, setDays] = useState(7);

  useEffect(() => {
    if (!baby) return;
    (async () => {
      const allLogs = await db.logs.where('babyId').equals(baby.id).filter(l => !l.deletedAt).sortBy('startAt');
      const now = new Date();
      const cutoff = new Date(now.getTime() - days * 86400000);
      const recent = allLogs.filter(l => new Date(l.startAt) >= cutoff);

      // --- Chart 1: Daily sleep total (bar) ---
      const sleepByDay = {};
      for (let i = 0; i < days; i++) {
        const d = new Date(now.getTime() - (days - 1 - i) * 86400000);
        sleepByDay[fmtDate(d.toISOString())] = 0;
      }
      recent.filter(l => l.type === 'sleep' && l.endAt).forEach(l => {
        const d = fmtDate(l.startAt);
        if (d in sleepByDay) {
          sleepByDay[d] += (new Date(l.endAt) - new Date(l.startAt)) / 3600000;
        }
      });

      if (chart1Ref.current) chart1Ref.current.destroy();
      if (canvasRef1.current) {
        chart1Ref.current = new Chart(canvasRef1.current, {
          type: 'bar',
          data: {
            labels: Object.keys(sleepByDay).map(d => d.slice(5)),
            datasets: [{
              label: 'Sleep (hours)',
              data: Object.values(sleepByDay).map(v => Math.round(v * 10) / 10),
              backgroundColor: 'rgba(124,58,237,0.5)',
              borderColor: 'rgb(124,58,237)',
              borderWidth: 1, borderRadius: 6,
            }]
          },
          options: { responsive: true, plugins: { legend: { display: false }, title: { display: true, text: 'Daily Sleep Total' } }, scales: { y: { beginAtZero: true, title: { display: true, text: 'hours' } } } }
        });
      }

      // --- Chart 2: Activity counts (stacked bar) ---
      const countsByDay = {};
      for (let i = 0; i < days; i++) {
        const d = new Date(now.getTime() - (days - 1 - i) * 86400000);
        countsByDay[fmtDate(d.toISOString())] = { sleep: 0, feed: 0, diaper: 0, note: 0 };
      }
      recent.forEach(l => {
        const d = fmtDate(l.startAt);
        if (d in countsByDay && countsByDay[d][l.type] !== undefined) countsByDay[d][l.type]++;
      });

      if (chart2Ref.current) chart2Ref.current.destroy();
      if (canvasRef2.current) {
        chart2Ref.current = new Chart(canvasRef2.current, {
          type: 'bar',
          data: {
            labels: Object.keys(countsByDay).map(d => d.slice(5)),
            datasets: [
              { label: 'Sleep', data: Object.values(countsByDay).map(v => v.sleep), backgroundColor: 'rgba(124,58,237,0.6)', borderRadius: 4 },
              { label: 'Feed', data: Object.values(countsByDay).map(v => v.feed), backgroundColor: 'rgba(245,158,11,0.6)', borderRadius: 4 },
              { label: 'Diaper', data: Object.values(countsByDay).map(v => v.diaper), backgroundColor: 'rgba(20,184,166,0.6)', borderRadius: 4 },
              { label: 'Note', data: Object.values(countsByDay).map(v => v.note), backgroundColor: 'rgba(148,163,184,0.4)', borderRadius: 4 },
            ]
          },
          options: { responsive: true, plugins: { title: { display: true, text: 'Activity Counts' } }, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1 } } } }
        });
      }
    })();
  }, [baby, refreshKey, days]);

  if (!baby) return html`<div class="p-6 text-center text-slate-400">Select a baby first.</div>`;

  return html`
    <div class="p-4 space-y-4">
      <div class="flex gap-2 mb-2">
        ${[7, 14, 30].map(d => html`
          <button key=${d} onClick=${() => setDays(d)}
            class="btn text-xs ${days === d ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-500'}">${d}d</button>
        `)}
      </div>
      <div class="card"><canvas ref=${canvasRef1}></canvas></div>
      <div class="card"><canvas ref=${canvasRef2}></canvas></div>
    </div>
  `;
}

// ──── Settings ─────────────────────────────────────────────
function Settings({ baby, babies, onBabyChange, onEditBaby, onAddBaby, onRefresh }) {
  const [deviceLabel, setDeviceLabel] = useState('');
  const [supaUrl, setSupaUrl] = useState('');
  const [supaKey, setSupaKey] = useState('');
  const [householdId, setHouseholdId] = useState('');
  const [syncStatus, setSyncStatus] = useState('');
  const [notifPerm, setNotifPerm] = useState('default');
  const [guideOpen, setGuideOpen] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    (async () => {
      setDeviceLabel((await db.settings.get('deviceLabel'))?.value || '');
      setSupaUrl((await db.settings.get('supabaseUrl'))?.value || '');
      setSupaKey((await db.settings.get('supabaseKey'))?.value || '');
      setHouseholdId((await db.settings.get('householdId'))?.value || '');
    })();
    setNotifPerm(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  }, []);

  const saveSetting = async (key, value) => {
    await db.settings.put({ key, value });
  };

  const requestNotif = async () => {
    if (typeof Notification === 'undefined') return;
    const p = await Notification.requestPermission();
    setNotifPerm(p);
  };

  const connectSync = async () => {
    if (!supaUrl || !supaKey) { setSyncStatus('Please enter URL and key.'); return; }
    let hid = householdId;
    if (!hid) { hid = uuid(); setHouseholdId(hid); }
    await saveSetting('supabaseUrl', supaUrl);
    await saveSetting('supabaseKey', supaKey);
    await saveSetting('householdId', hid);
    try {
      initSupabase(supaUrl, supaKey);
      setSyncStatus('Connected! Household: ' + hid.slice(0, 8) + '...');
    } catch(e) { setSyncStatus('Error: ' + e.message); }
  };

  const doSync = async () => {
    if (!supa || !householdId) { setSyncStatus('Not connected.'); return; }
    setSyncStatus('Syncing...');
    try {
      // Push all local logs
      const allLogs = await db.logs.where('babyId').equals(baby.id).toArray();
      const mapped = allLogs.map(l => ({ ...l, household_id: householdId, deleted_at: l.deletedAt, updated_at: l.updatedAt, created_at: l.createdAt, start_at: l.startAt, end_at: l.endAt, baby_id: l.babyId, edited_by: l.editedBy }));
      await pushToSupabase('logs', mapped);
      // Pull remote
      const remote = await pullFromSupabase('logs', householdId);
      for (const r of remote) {
        const local = await db.logs.get(r.id);
        if (!local || new Date(r.updated_at) > new Date(local.updatedAt)) {
          await db.logs.put({ id: r.id, babyId: r.baby_id || baby.id, type: r.type, subtype: r.subtype, startAt: r.start_at, endAt: r.end_at, amount: r.amount, quality: r.quality, note: r.note, createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at, editedBy: r.edited_by });
        }
      }
      setSyncStatus(`Synced! Pushed ${allLogs.length}, pulled ${remote.length} rows.`);
      onRefresh();
    } catch(e) { setSyncStatus('Sync error: ' + e.message); }
  };

  const handleImport = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await importJSON(file);
      onRefresh();
      alert('Import successful!');
    } catch(e) { alert('Import failed: ' + e.message); }
  };

  return html`
    <div class="p-4 space-y-4">
      <!-- Baby selector -->
      <div class="card">
        <h3 class="font-bold text-sm text-slate-500 mb-2">Babies</h3>
        <div class="space-y-2">
          ${babies.map(b => html`
            <div key=${b.id} class="flex items-center gap-2">
              <button onClick=${() => onBabyChange(b.id)}
                class="btn text-sm flex-1 text-left ${baby?.id === b.id ? 'bg-violet-100 text-violet-700 border border-violet-300' : 'bg-slate-50 text-slate-600'}">
                ${b.name} ${b.dob ? ` · ${Math.floor(getAgeWeeks(b.dob))}w` : ''}
              </button>
              <button onClick=${() => onEditBaby(b)} class="text-slate-400 text-lg">✏️</button>
            </div>
          `)}
          <button onClick=${onAddBaby} class="btn w-full bg-slate-100 text-slate-500 text-sm">+ Add Baby</button>
        </div>
      </div>

      <!-- Sleep guide -->
      ${baby && html`
        <div class="card">
          <h3 class="font-bold text-sm text-slate-500 mb-2">Sleep Guide</h3>
          <p class="text-xs text-slate-400 mb-2">Customize wake windows for ${baby.name}'s age.</p>
          <button onClick=${() => setGuideOpen(true)} class="btn bg-violet-100 text-violet-700 text-sm">Edit Sleep Guide</button>
        </div>
      `}

      <!-- Device label -->
      <div class="card">
        <h3 class="font-bold text-sm text-slate-500 mb-2">Device</h3>
        <label class="block">
          <span class="text-xs text-slate-400">Device label (shown in logs)</span>
          <input class="block w-full mt-1 border border-slate-300 rounded-lg px-3 py-2 text-sm"
            value=${deviceLabel} onInput=${e => { setDeviceLabel(e.target.value); saveSetting('deviceLabel', e.target.value); }}
            placeholder="e.g. Mom's iPhone" />
        </label>
      </div>

      <!-- Notifications -->
      <div class="card">
        <h3 class="font-bold text-sm text-slate-500 mb-2">Notifications</h3>
        <p class="text-xs text-slate-400 mb-2">Permission: <strong>${notifPerm}</strong></p>
        ${notifPerm !== 'granted' && notifPerm !== 'unsupported' && html`
          <button onClick=${requestNotif} class="btn bg-violet-100 text-violet-700 text-sm">Enable Notifications</button>
        `}
        ${notifPerm === 'granted' && html`<p class="text-sm text-green-600">Notifications enabled.</p>`}
      </div>

      <!-- Export / Import -->
      <div class="card">
        <h3 class="font-bold text-sm text-slate-500 mb-2">Data</h3>
        <div class="flex flex-wrap gap-2">
          ${baby && html`<button onClick=${() => exportCSV(baby.id)} class="btn bg-slate-100 text-slate-600 text-sm">Export CSV</button>`}
          <button onClick=${exportJSON} class="btn bg-slate-100 text-slate-600 text-sm">Backup JSON</button>
          <button onClick=${() => fileRef.current.click()} class="btn bg-slate-100 text-slate-600 text-sm">Import JSON</button>
          <input type="file" accept=".json" ref=${fileRef} class="hidden" onChange=${handleImport} />
        </div>
      </div>

      <!-- Supabase sync -->
      <div class="card">
        <h3 class="font-bold text-sm text-slate-500 mb-2">Partner Sync (Supabase)</h3>
        <p class="text-xs text-slate-400 mb-2">Connect to a free Supabase project to share logs with your partner.</p>
        <label class="block mb-2">
          <span class="text-xs text-slate-400">Supabase URL</span>
          <input class="block w-full mt-1 border border-slate-300 rounded-lg px-3 py-2 text-sm"
            value=${supaUrl} onInput=${e => setSupaUrl(e.target.value)} placeholder="https://xyz.supabase.co" />
        </label>
        <label class="block mb-2">
          <span class="text-xs text-slate-400">Anon Key</span>
          <input class="block w-full mt-1 border border-slate-300 rounded-lg px-3 py-2 text-sm"
            value=${supaKey} onInput=${e => setSupaKey(e.target.value)} placeholder="eyJ..." />
        </label>
        <label class="block mb-3">
          <span class="text-xs text-slate-400">Household ID (auto-generated)</span>
          <input class="block w-full mt-1 border border-slate-300 rounded-lg px-3 py-2 text-sm bg-slate-50"
            value=${householdId} onInput=${e => setHouseholdId(e.target.value)} placeholder="Auto-generated on first connect" />
        </label>
        <div class="flex gap-2">
          <button onClick=${connectSync} class="btn bg-violet-600 text-white text-sm">Connect</button>
          <button onClick=${doSync} class="btn bg-violet-100 text-violet-700 text-sm">Sync Now</button>
        </div>
        ${syncStatus && html`<p class="text-xs mt-2 text-slate-500">${syncStatus}</p>`}
      </div>

      ${baby && html`<${SleepGuideModal} open=${guideOpen} onClose=${() => setGuideOpen(false)} babyId=${baby.id} onSave=${onRefresh} />`}
    </div>
  `;
}

// ──── App Root ─────────────────────────────────────────────
function App() {
  const [tab, setTab] = useState('home');
  const [babies, setBabies] = useState([]);
  const [activeBabyId, setActiveBabyId] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [logModalOpen, setLogModalOpen] = useState(false);
  const [editLog, setEditLog] = useState(null);
  const [logType, setLogType] = useState(null);
  const [babyModalOpen, setBabyModalOpen] = useState(false);
  const [editBaby, setEditBaby] = useState(null);

  const refresh = useCallback(() => setRefreshKey(k => k + 1), []);

  // Load babies
  useEffect(() => {
    (async () => {
      const list = await db.babies.toArray();
      setBabies(list);
      const stored = (await db.settings.get('activeBabyId'))?.value;
      if (stored && list.find(b => b.id === stored)) {
        setActiveBabyId(stored);
      } else if (list.length > 0) {
        setActiveBabyId(list[0].id);
      }
      // Init Supabase if configured
      const url = (await db.settings.get('supabaseUrl'))?.value;
      const key = (await db.settings.get('supabaseKey'))?.value;
      if (url && key) initSupabase(url, key);
    })();
  }, [refreshKey]);

  const activeBaby = babies.find(b => b.id === activeBabyId) || null;

  const changeBaby = async (id) => {
    setActiveBabyId(id);
    await db.settings.put({ key: 'activeBabyId', value: id });
    refresh();
  };

  const openAddLog = (type, existing) => {
    if (existing) {
      setEditLog(existing);
      setLogType(null);
    } else {
      setEditLog(null);
      setLogType(type || 'sleep');
    }
    setLogModalOpen(true);
  };

  const openAddBaby = () => { setEditBaby(null); setBabyModalOpen(true); };
  const openEditBaby = (b) => { setEditBaby(b); setBabyModalOpen(true); };

  // First-run: if no babies, open add modal
  useEffect(() => {
    if (babies.length === 0 && refreshKey > 0) setBabyModalOpen(true);
  }, [babies, refreshKey]);

  // Trigger initial load
  useEffect(() => { refresh(); }, []);

  return html`
    <div class="min-h-screen pb-20">
      <!-- Header -->
      <header class="bg-violet-600 text-white px-4 py-3 flex items-center justify-between sticky top-0 z-40">
        <div>
          <h1 class="font-bold text-lg">BabyTrack</h1>
          ${activeBaby && html`<span class="text-violet-200 text-xs">${activeBaby.name} · ${Math.floor(getAgeWeeks(activeBaby.dob))} weeks</span>`}
        </div>
        ${babies.length > 1 && html`
          <select class="bg-violet-500 text-white rounded px-2 py-1 text-sm" value=${activeBabyId} onChange=${e => changeBaby(e.target.value)}>
            ${babies.map(b => html`<option key=${b.id} value=${b.id}>${b.name}</option>`)}
          </select>
        `}
      </header>

      <!-- Content -->
      ${tab === 'home' && html`<${Dashboard} baby=${activeBaby} onAddLog=${openAddLog} refresh=${refresh} refreshKey=${refreshKey} />`}
      ${tab === 'history' && html`<${History} baby=${activeBaby} onEdit=${l => openAddLog(null, l)} refreshKey=${refreshKey} />`}
      ${tab === 'charts' && html`<${Charts} baby=${activeBaby} refreshKey=${refreshKey} />`}
      ${tab === 'settings' && html`<${Settings} baby=${activeBaby} babies=${babies}
        onBabyChange=${changeBaby} onEditBaby=${openEditBaby} onAddBaby=${openAddBaby} onRefresh=${refresh} />`}

      <${BottomTabs} tab=${tab} setTab=${setTab} />

      <!-- Modals -->
      <${LogFormModal} open=${logModalOpen} onClose=${() => setLogModalOpen(false)}
        babyId=${activeBabyId} log=${editLog} onSave=${refresh} />

      <${BabyProfileModal} open=${babyModalOpen} onClose=${() => setBabyModalOpen(false)}
        baby=${editBaby} onSave=${refresh} />
    </div>
  `;
}

// ─── Mount ─────────────────────────────────────────────────
render(html`<${App} />`, document.getElementById('app'));
