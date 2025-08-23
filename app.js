/* =========================
   AM Allocation — app.js (client-only, no Node)
   Requires:
     <script src="https://unpkg.com/realm-web/dist/bundle.iife.js"></script>
     <script defer src="./app.js"></script>
   ========================= */

/* ====== CONFIG ====== */
const CONFIG = {
    appId: "amallocation-tgczmjh",
    baseUrl: "https://ap-southeast-1.aws.services.cloud.mongodb.com",
    service: "mongodb-atlas",
    db: "am_database",
    col: { people: "arismeeha", regions: "region", allocs: "allocation" },
    auth: { mode: "anonymous", email: "", password: "" }
};

/* ====== Minimal logger ====== */
const L = {
    info: (...a) => console.info("[AM-Alloc]", ...a),
    warn: (...a) => console.warn("[AM-Alloc]", ...a),
    error: (...a) => console.error("[AM-Alloc]", ...a)
};

/* ====== Realm init ====== */
const realmApp = new Realm.App({ id: CONFIG.appId, baseUrl: CONFIG.baseUrl });
function getCredentials() {
    return CONFIG.auth.mode === "email"
        ? Realm.Credentials.emailPassword(CONFIG.auth.email, CONFIG.auth.password)
        : Realm.Credentials.anonymous();
}
function isInvalidSession(err) {
    return (err && err.error_code === "InvalidSession") ||
        (err && /InvalidSession|invalid session|401/.test(String(err)));
}
async function ensureLogin() {
    if (realmApp.currentUser?.isLoggedIn) return realmApp.currentUser;
    return realmApp.logIn(getCredentials());
}
async function getDB() {
    try {
        const user = await ensureLogin();
        return user.mongoClient(CONFIG.service).db(CONFIG.db);
    } catch {
        try { if (realmApp.currentUser) await realmApp.currentUser.logOut(); } catch { }
        try { await Promise.all(Object.values(realmApp.allUsers).map(u => realmApp.deleteUser(u))); } catch { }
        const user = await realmApp.logIn(getCredentials());
        return user.mongoClient(CONFIG.service).db(CONFIG.db);
    }
}
async function withDB(fn) {
    try {
        const db = await getDB();
        return await fn(db);
    } catch (err) {
        if (!isInvalidSession(err)) throw err;
        try { if (realmApp.currentUser) await realmApp.currentUser.logOut(); } catch { }
        try { await Promise.all(Object.values(realmApp.allUsers).map(u => realmApp.deleteUser(u))); } catch { }
        const db2 = (await realmApp.logIn(getCredentials())).mongoClient(CONFIG.service).db(CONFIG.db);
        return await fn(db2);
    }
}

/* ====== Time & utils ====== */
const DAY = 24 * 60 * 60 * 1000;
const clampNoon = d => { const x = new Date(d); x.setHours(12, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return clampNoon(x); };
const startOfMonth = d => clampNoon(new Date(d.getFullYear(), d.getMonth(), 1));
const endOfMonth = d => clampNoon(new Date(d.getFullYear(), d.getMonth() + 1, 0));
const daysInclusive = (a, b) => Math.floor((clampNoon(b) - clampNoon(a)) / DAY) + 1;
const isoToDate = v => (v instanceof Date ? v : new Date(v));

function keyifyObjectId(x) {
    if (x && typeof x === 'object' && typeof x.toHexString === 'function') return x.toHexString().toLowerCase();
    if (x && typeof x === 'object' && typeof x.$oid === 'string') return x.$oid.toLowerCase();
    const s = String(x);
    const m = s.match(/[a-f0-9]{24}/i);
    return (m ? m[0] : s).toLowerCase();
}
function normalizeRegionName(name) { return String(name || "").replace(/\s+/g, " ").trim(); }

/* Contrast helper: picks black/white text based on background color */
function getContrastColor(hex) {
    if (!hex) return "#000";
    let c = hex.replace("#", "").trim().toLowerCase();
    // handle #RRGGBBAA → drop AA
    if (c.length === 8) c = c.slice(0, 6);
    // handle #RGB
    if (c.length === 3) c = c.split("").map(ch => ch + ch).join("");
    // fallback
    if (!/^[0-9a-f]{6}$/.test(c)) return "#000";

    const r = parseInt(c.substr(0, 2), 16);
    const g = parseInt(c.substr(2, 2), 16);
    const b = parseInt(c.substr(4, 2), 16);
    // YIQ luminance
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 128 ? "#000000" : "#ffffff";
}

/* ====== State ====== */
let viewMode = "YEAR";
let focusDate = clampNoon(new Date());
let columns = [];
let editMode = false;
let poolCollapsed = false;

let COUNTRY_COLORS = { Other: "#94a3b8" }; // filled from region mapping
let peopleDocs = [];          // all people docs
let demoPeople = [];          // names to display (actives preferred)
let personIdxByOid = {};      // _id hex -> index
let pool = [];                // pending items
let alloc = [];               // [personIdx][laneIdx] = items[]

/* ====== DOM ====== */
const $ = sel => document.querySelector(sel);
const datesGrid = $("#datesGrid");
const timeline = $("#timeline-header");
const peopleWrap = $("#board");
const hHeader = document.getElementById('timeline-header');
const hBody = document.getElementById('board');

/* ====== Toolbar ====== */
$("#viewSelect")?.addEventListener('change', () => { viewMode = $("#viewSelect").value; renderDates(); renderPeople(); syncWidths(); scrollToCurrentMonthIfYear(); });
$("#prevMonth")?.addEventListener('click', () => { focusDate.setMonth(focusDate.getMonth() - 1); renderDates(); renderPeople(); syncWidths(); scrollToCurrentMonthIfYear(); });
$("#nextMonth")?.addEventListener('click', () => { focusDate.setMonth(focusDate.getMonth() + 1); renderDates(); renderPeople(); syncWidths(); scrollToCurrentMonthIfYear(); });
$("#toggleEdit")?.addEventListener('click', () => {
    editMode = !editMode;
    document.body.classList.toggle('edit-mode', editMode);
    $("#toggleEdit").textContent = editMode ? 'View' : 'Edit';
    const ft = $("#footer .footer-text span"); if (ft) ft.textContent = editMode ? 'Edit Mode: Press save to save progress' : 'View Mode';
    renderPool(); renderPeople();
});
$("#btnSave")?.addEventListener('click', () => { editMode = false; document.body.classList.remove('edit-mode'); $("#toggleEdit").textContent = 'Edit'; renderPool(); renderPeople(); });
$("#btnCollapsePool")?.addEventListener('click', () => { poolCollapsed = !poolCollapsed; $("#app").classList.toggle('drawer-collapsed', poolCollapsed); $("#drawer").classList.toggle('show', poolCollapsed); renderPool(); });
$("#flipSide")?.addEventListener('click', () => { document.body.classList.toggle('pool-left'); });

/* ====== Sync header/body scroll ====== */
let syncing = false;
hHeader?.addEventListener('scroll', () => { if (syncing) return; syncing = true; if (hBody) hBody.scrollLeft = hHeader.scrollLeft; syncing = false; });
hBody?.addEventListener('scroll', () => { if (syncing) return; syncing = true; if (hHeader) hHeader.scrollLeft = hBody.scrollLeft; syncing = false; });

/* ====== Dates/columns ====== */
function setMonthLabel(d) {
    const el = document.getElementById('monthLabel');
    if (el) el.textContent = d.toLocaleString(undefined, { month: 'long', year: 'numeric' });
}
function buildColumns() {
    const now = new Date(focusDate);
    let start, end;
    if (viewMode === 'YEAR') { start = new Date(now.getFullYear(), 0, 1); end = new Date(now.getFullYear(), 11, 31); }
    else if (viewMode === 'THREE') { start = new Date(now.getFullYear(), now.getMonth() - 1, 1); end = new Date(now.getFullYear(), now.getMonth() + 1, 0); }
    else { start = startOfMonth(now); end = endOfMonth(now); }
    const s = clampNoon(start), e = clampNoon(end);
    columns = Array.from({ length: Math.floor((e - s) / DAY) + 1 }, (_, i) => addDays(s, i));
    setMonthLabel(now);
}
function renderDates() {
    buildColumns();
    if (!datesGrid) return;
    datesGrid.style.gridTemplateColumns = `repeat(${columns.length}, var(--cell))`;
    datesGrid.innerHTML = columns.map(d => `
    <div class="date-cell">
      <div class="date-num">${d.getDate()}</div>
      <div class="date-mon">${d.toLocaleString(undefined, { month: 'short' })}</div>
    </div>`).join('');
}
function scrollToCurrentMonthIfYear() {
    if (viewMode !== 'YEAR' || columns.length === 0) return;
    const now = new Date(focusDate);
    const jan1 = clampNoon(new Date(now.getFullYear(), 0, 1));
    const m0 = clampNoon(new Date(now.getFullYear(), now.getMonth(), 1));
    const offsetDays = Math.max(0, Math.floor((m0 - jan1) / DAY));
    const cellEl = document.querySelector('.date-cell');
    const w = cellEl ? cellEl.getBoundingClientRect().width : 30;
    const target = offsetDays * w;
    if (hHeader && hBody) { hHeader.scrollLeft = target; hBody.scrollLeft = target; }
}

/* ====== Items & colors ====== */
function colorFor(cat) {
    const key = normalizeRegionName(cat);
    return COUNTRY_COLORS[key] || COUNTRY_COLORS.Other || "#94a3b8";
}
function overlaps(a, b) {
    const aS = clampNoon(a.arrival).getTime(), aE = clampNoon(a.departure).getTime();
    const bS = clampNoon(b.arrival).getTime(), bE = clampNoon(b.departure).getTime();
    return !(aE <= bS || bE <= aS);
}
function withinView(it) {
    if (!columns.length) return true;
    const vs = clampNoon(columns[0]).getTime();
    const ve = clampNoon(columns[columns.length - 1]).getTime();
    const s = clampNoon(it.arrival).getTime();
    const e = clampNoon(it.departure).getTime();
    return !(e < vs || s > ve);
}

/* ====== DnD ====== */
let dragSource = null;
function makeDraggable(el, item) {
    if (!el) return;
    if (editMode) {
        el.setAttribute('draggable', 'true');
        el.onDragStartHandler = () => { dragSource = { type: 'pool', itemRef: item }; };
        el.onDragEndHandler = () => { dragSource = null; removeGhosts(); };
        el.addEventListener('dragstart', el.onDragStartHandler);
        el.addEventListener('dragend', el.onDragEndHandler);
    } else {
        el.removeAttribute('draggable');
        if (el.onDragStartHandler) { el.removeEventListener('dragstart', el.onDragStartHandler); el.onDragStartHandler = null; }
        if (el.onDragEndHandler) { el.removeEventListener('dragend', el.onDragEndHandler); el.onDragEndHandler = null; }
    }
}
function allowDrop(ev) { ev.preventDefault(); }
function removeGhosts() { document.querySelectorAll('.ghost-bar').forEach(g => g.remove()); }
function showGhost(laneEl, _startDate, item) {
    removeGhosts();
    const startOffset = Math.max(0, Math.floor((clampNoon(item.arrival) - clampNoon(columns[0])) / DAY));
    const len = daysInclusive(item.arrival, item.departure);
    const endOffset = Math.min(columns.length - 1, startOffset + len - 1);
    const span = Math.max(1, endOffset - startOffset + 1);
    const ghost = document.createElement('div');
    ghost.className = 'ghost-bar';
    ghost.style.left = `calc(${startOffset} * var(--cell))`;
    ghost.style.width = `calc(${span} * var(--cell))`;
    ghost.style.background = colorFor(item.category);
    ghost.style.color = getContrastColor(colorFor(item.category));
    ghost.textContent = item.title;
    laneEl.appendChild(ghost);
}

/* ====== Shape guards ====== */
function ensureAllocShape(numPeople) {
    if (!Array.isArray(alloc)) alloc = [];
    if (!Number.isInteger(numPeople) || numPeople < 0) numPeople = 0;
    while (alloc.length < numPeople) alloc.push([]);
    if (alloc.length > numPeople) alloc.length = numPeople;
    for (let i = 0; i < alloc.length; i++) {
        if (!Array.isArray(alloc[i])) alloc[i] = [];
        if (alloc[i].length === 0) alloc[i] = [[]];
        for (let l = 0; l < alloc[i].length; l++) {
            if (!Array.isArray(alloc[i][l])) alloc[i][l] = [];
        }
    }
}

/* ====== Drawer (pool) ====== */
function renderPool() {
    const panel = document.getElementById('panelPending');
    if (!panel) return;
    panel.innerHTML = '';
    const list = pool.slice().sort((a, b) => a.arrival - b.arrival);

    list.forEach(it => {
        const card = document.createElement('div');
        card.className = 'item-card';
        const bg = colorFor(it.category);
        const fg = getContrastColor(bg);
        card.style.borderColor = bg;
        card.style.background = bg;
        card.style.color = fg;
        card.innerHTML = `
      <div class="row" style="justify-content:space-between; font-weight:600; font-size:.875rem;">
        <span class="truncate" title="${it.title}">${it.title}</span>
      </div>
      <div style="font-size:.75rem; opacity:.9; margin-top:.25rem">
        ${it.arrival.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}
        → ${it.departure.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}
      </div>
      <div style="font-size:.7rem; opacity:.9; margin-top:.125rem">ID: ${it.id}</div>`;
        panel.appendChild(card);
        makeDraggable(card, it);
    });

    if (list.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'font-size:.9rem; color:var(--muted); margin:.5rem 0;';
        empty.textContent = 'No pending villa allocations';
        panel.appendChild(empty);
    }

    const catSel = document.getElementById('addCategory');
    if (catSel) {
        catSel.innerHTML = Object.keys(COUNTRY_COLORS)
            .map(k => `<option value="${k}">${k}</option>`).join('');
    }
}

/* ====== People & lanes ====== */
function renderPeople() {
    if (!peopleWrap) return;
    ensureAllocShape(peopleDocs.length);
    peopleWrap.innerHTML = '';

    const showIdx = peopleDocs.map((p, idx) => ({ idx }));

    showIdx.forEach(({ idx: personIdx }) => {
        if (!alloc[personIdx]) alloc[personIdx] = [[]];
        if (alloc[personIdx].length === 0) alloc[personIdx] = [[]];

        const p = peopleDocs[personIdx];
        const name = (p && (p.preferredName && p.preferredName.trim())) || p.fullname || "Unknown";

        const person = document.createElement('section'); person.className = 'person';
        person.innerHTML = `
      <div class="head"><div class="person-head">
        <div class="person-name">${name}</div>
        <div style="font-size:.75rem; color:var(--muted)">Lanes: ${alloc[personIdx].length}</div>
      </div></div>`;

        const lanesWrap = document.createElement('div'); lanesWrap.className = 'lanes';
        lanesWrap.style.width = `calc(${columns.length} * var(--cell))`;

        alloc[personIdx].forEach((laneArr, laneIdx) => {
            const lane = document.createElement('div'); lane.className = 'lane';
            const laneGrid = document.createElement('div'); laneGrid.className = 'lane-grid';
            laneGrid.style.gridTemplateColumns = `repeat(${columns.length}, var(--cell))`;

            columns.forEach(d => {
                const cell = document.createElement('div'); cell.className = 'lane-cell';
                cell.addEventListener('dragover', (ev) => { if (!editMode) return; allowDrop(ev); const itm = (dragSource && dragSource.itemRef) || null; if (!itm) return; showGhost(lane, d, itm); });
                cell.addEventListener('dragleave', () => { removeGhosts(); });
                cell.addEventListener('drop', (ev) => {
                    if (!editMode) return; ev.preventDefault();
                    let movingItem = null; const from = dragSource;
                    if (from && from.type === 'pool') { movingItem = from.itemRef; }
                    else if (from && from.type === 'placed') {
                        const srcLane = alloc[from.personIdx][from.laneIdx];
                        const i = srcLane.indexOf(from.itemRef);
                        if (i > -1) srcLane.splice(i, 1);
                        movingItem = from.itemRef;
                    }
                    let ok = false; if (movingItem) ok = placeItem(personIdx, d, movingItem, laneIdx);
                    if (!ok && from && from.type === 'placed') {
                        alloc[from.personIdx][from.laneIdx].push(movingItem);
                        renderPeople();
                    }
                    dragSource = null; removeGhosts();
                });
                laneGrid.appendChild(cell);
            });

            lane.appendChild(laneGrid);

            laneArr.filter(withinView).forEach((it) => {
                const startOffset = Math.max(0, Math.floor((clampNoon(it.arrival) - clampNoon(columns[0])) / DAY));
                const endOffset = Math.min(columns.length - 1, Math.floor((clampNoon(it.departure) - clampNoon(columns[0])) / DAY));
                const span = Math.max(1, endOffset - startOffset + 1);
                const bar = document.createElement('div');
                bar.className = 'bar';
                const bg = colorFor(it.category);
                const fg = getContrastColor(bg);
                bar.style.left = `calc(${startOffset} * var(--cell))`;
                bar.style.width = `calc(${span} * var(--cell))`;
                bar.style.background = bg;
                bar.style.color = fg;
                bar.title = `${it.title} • ${it.arrival.toDateString()} → ${it.departure.toDateString()}`;
                bar.innerHTML = `<span class="truncate">${it.title}</span><span style="opacity:.9">${it.arrival.getDate()}–${it.departure.getDate()}</span>`;
                if (editMode) {
                    bar.setAttribute('draggable', 'true');
                    bar.addEventListener('dragstart', () => { dragSource = { type: 'placed', personIdx, laneIdx, itemRef: it }; });
                    bar.addEventListener('dragend', () => { dragSource = null; removeGhosts(); });
                    bar.addEventListener('dblclick', () => unassignItem(personIdx, laneIdx, it));
                }
                lane.appendChild(bar);
            });

            lanesWrap.appendChild(lane);
        });

        person.appendChild(lanesWrap);
        peopleWrap.appendChild(person);
    });
}

function placeItem(personIdx, dropDate, item, laneIdx) {
    if (!editMode) return false;
    ensureAllocShape(peopleDocs.length);

    const tryLane = (li) => {
        const laneArr = alloc[personIdx][li];
        const sorted = laneArr.slice().sort((a, b) => a.arrival - b.arrival);
        if (sorted.some(x => overlaps(item, x))) return false;
        laneArr.push(item);
        pool = pool.filter(p => p.id !== item.id);
        renderPool(); renderPeople();
        const personDoc = peopleDocs[personIdx];
        atlasAssignAllocation(item.id, personDoc?._id, li).catch(err => {
            L.error("Save failed:", err);
            const i = laneArr.indexOf(item);
            if (i > -1) laneArr.splice(i, 1);
            pool.push(item);
            renderPool(); renderPeople();
        });
        return true;
    };

    if (laneIdx == null) laneIdx = 0;
    if (!alloc[personIdx][laneIdx]) alloc[personIdx][laneIdx] = [];
    if (tryLane(laneIdx)) return true;

    for (let l = 0; l < alloc[personIdx].length; l++) {
        if (l === laneIdx) continue;
        if (tryLane(l)) return true;
    }
    if (alloc[personIdx].length < 10) {
        alloc[personIdx].push([]);
        return tryLane(alloc[personIdx].length - 1);
    }
    return false;
}
function unassignItem(personIdx, laneIdx, it) {
    const laneRef = alloc[personIdx][laneIdx];
    const i = laneRef.indexOf(it);
    if (i > -1) laneRef.splice(i, 1);
    const moved = { id: it.id, title: it.title, arrival: it.arrival, departure: it.departure, category: it.category };
    pool.push(moved);
    renderPool(); renderPeople();
    atlasUnassignAllocation(it.id).catch(err => {
        L.error("Unassign failed:", err);
        pool = pool.filter(p => p.id !== it.id);
        laneRef.push(it);
        renderPool(); renderPeople();
    });
}

/* ====== Width sync ====== */
function syncWidths() {
    document.querySelectorAll('.lanes').forEach(l => { l.style.width = `calc(${columns.length} * var(--cell))`; });
    if (datesGrid) datesGrid.style.gridTemplateColumns = `repeat(${columns.length}, var(--cell))`;
    if (timeline) timeline.style.width = `calc(${columns.length} * var(--cell))`;
}

/* ====== Add Items (optional) ====== */
async function saveSheetToPool() {
    const sheet = document.getElementById('sheet');
    const err = document.getElementById('sheetError');
    if (!sheet || !err) return;
    err.textContent = '';
    const rows = [];
    const cells = Array.from(sheet.children).slice(5);
    for (let i = 0; i < cells.length; i += 5) {
        const id = cells[i].querySelector('input')?.value.trim();
        const title = cells[i + 1].querySelector('input')?.value.trim();
        const arr = cells[i + 2].querySelector('input')?.value;
        const dep = cells[i + 3].querySelector('input')?.value;
        const cat = cells[i + 4].querySelector('select')?.value;
        if (!id && !title && !arr && !dep) continue;
        if (!id || !title || !arr || !dep) { err.textContent = 'All non-empty rows need ID, Title, Arrival and Departure.'; return; }
        const a = new Date(arr + 'T12:00:00');
        const d = new Date(dep + 'T12:00:00');
        if (isNaN(a) || isNaN(d)) { err.textContent = 'Invalid date in one of the rows.'; return; }
        if (d < a) { err.textContent = 'Departure cannot be before Arrival.'; return; }
        rows.push({ id, title, arrival: a, departure: d, category: cat });
    }
    const seen = new Set(pool.map(x => x.id));
    for (const r of rows) { if (seen.has(r.id)) { err.textContent = `Duplicate ID: ${r.id}`; return; } seen.add(r.id); }
    pool.push(...rows);
    renderPool();
    try {
        const docs = rows.map(r => ({
            id: r.id, title: r.title,
            arrival: r.arrival.toISOString(), departure: r.departure.toISOString(),
            region: r.category, status: "pending",
            assignedTo: null, lane: null, notes: "",
            version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        }));
        await atlasCreateAllocations(docs);
    } catch (e) { L.warn("Insert to DB failed (continuing locally):", e); }
}

/* ====== Atlas data ops ====== */
// PEOPLE: load all; index by _id; keep preferedname as separate field
async function atlasLoadPeople() {
    return withDB(async (db) => {
        const docs = await db.collection(CONFIG.col.people).find({}, { sort: { fullname: 1 } });
        const people = docs.map(d => {
            const preferred = (typeof d.preferedname === 'string') ? d.preferedname.trim() : null; // schema key = preferedname
            const full = (typeof d.fullname === 'string') ? d.fullname.trim() : '';
            return {
                _id: d._id, id: d.id,
                fullname: full,
                preferredName: (preferred && preferred.length ? preferred : null),
                status: d.status
            };
        });
        const idxByOid = {};
        people.forEach((p, i) => { idxByOid[keyifyObjectId(p._id)] = i; });
        return { people, idxByOid };
    });
}

// REGIONS: single mapping doc with keys → color hex
async function atlasLoadRegions() {
    return withDB(async (db) => {
        const doc = await db.collection(CONFIG.col.regions).findOne({});
        if (!doc) {
            L.warn("Regions: no doc found; using fallback.");
            return { Other: "#94a3b8" };
        }
        const map = {};
        for (const [k, v] of Object.entries(doc)) {
            if (k === "_id") continue;
            if (typeof v === "string" && v.trim()) map[k.trim()] = v.trim();
        }
        if (!map.Other) map.Other = "#94a3b8";
        return map;
    });
}

// ALLOCATIONS: arrival/departure are strings in your schema → filter with ISO strings
async function atlasLoadAllocations(fromDate, toDate) {
    return withDB(async (db) => {
        const Alloc = db.collection(CONFIG.col.allocs);
        const fromISO = fromDate.toISOString();
        const toISO = toDate.toISOString();

        const assigned = await Alloc.find({
            status: { $in: ["assigned", "Assigned", "ASSIGNED"] },
            arrival: { $lt: toISO },
            departure: { $gt: fromISO }
        });
        const pending = await Alloc.find(
            { status: { $in: ["pending", "Pending", "PENDING"] } },
            { sort: { arrival: 1 } }
        );

        assigned.forEach(a => { a.arrival = isoToDate(a.arrival); a.departure = isoToDate(a.departure); });
        pending.forEach(a => { a.arrival = isoToDate(a.arrival); a.departure = isoToDate(a.departure); });

        return { assigned, pending };
    });
}

async function atlasAssignAllocation(appId, personOid, laneIndex) {
    return withDB(async (db) => {
        await db.collection(CONFIG.col.allocs).updateOne(
            { id: appId },
            {
                $set: {
                    status: "assigned",
                    assignedTo: new Realm.BSON.ObjectId(String(personOid)),
                    lane: laneIndex,
                    updatedAt: new Date().toISOString()
                },
                $inc: { version: 1 }
            }
        );
    });
}
async function atlasUnassignAllocation(appId) {
    return withDB(async (db) => {
        await db.collection(CONFIG.col.allocs).updateOne(
            { id: appId },
            {
                $set: {
                    status: "pending",
                    assignedTo: null,
                    lane: null,
                    updatedAt: new Date().toISOString()
                },
                $inc: { version: 1 }
            }
        );
    });
}
async function atlasCreateAllocations(docs) {
    return withDB(async (db) => {
        await db.collection(CONFIG.col.allocs).insertMany(docs);
    });
}

/* ====== Render all ====== */
function renderAll() { renderDates(); renderPool(); renderPeople(); scrollToCurrentMonthIfYear(); }

/* ====== Boot ====== */
async function bootFromAtlas() {
    const y = focusDate.getFullYear();
    const from = new Date(y, 0, 1);
    const to = new Date(y, 11, 31, 23, 59, 59);

    try {
        const { people, idxByOid } = await atlasLoadPeople();
        peopleDocs = people;
        personIdxByOid = idxByOid;
        demoPeople = people.map(p => (p.preferredName && p.preferredName.trim()) || p.fullname);
        ensureAllocShape(peopleDocs.length);
        L.info("People:", peopleDocs.length);
    } catch (e) {
        L.error("People load failed:", e);
        peopleDocs = []; personIdxByOid = {}; demoPeople = [];
        ensureAllocShape(0);
    }

    try {
        COUNTRY_COLORS = await atlasLoadRegions();
        L.info("Regions keys:", Object.keys(COUNTRY_COLORS).length);
    } catch (e) {
        L.warn("Regions load failed; using fallback:", e);
        COUNTRY_COLORS = { Other: "#94a3b8" };
    }

    try {
        const { assigned, pending } = await atlasLoadAllocations(from, to);
        L.info("Allocations — assigned:", assigned.length, "pending:", pending.length);

        // Drawer pool
        pool = pending.map(a => ({
            id: a.id, title: a.title,
            arrival: a.arrival, departure: a.departure,
            category: normalizeRegionName(a.region)
        }));

        // Initialize lanes
        alloc = Array.from({ length: peopleDocs.length }, () => [[]]);

        // Map assigned → people/lanes
        for (const a of assigned) {
            const pid = keyifyObjectId(a.assignedTo && (a.assignedTo._id || a.assignedTo));
            const personIdx = personIdxByOid[pid];
            if (personIdx == null) {
                L.warn("Unmapped assignedTo:", pid, "title:", a.title);
                continue;
            }
            const lane = Number.isInteger(a.lane) ? a.lane : 0;
            while (!alloc[personIdx][lane]) alloc[personIdx].push([]);
            alloc[personIdx][lane].push({
                id: a.id, title: a.title,
                arrival: a.arrival, departure: a.departure,
                category: normalizeRegionName(a.region)
            });
        }
        for (const lanes of alloc) for (const lane of lanes) lane.sort((x, y) => x.arrival - y.arrival);

    } catch (e) {
        L.error("Allocation load failed — empty board:", e);
        pool = [];
        alloc = Array.from({ length: peopleDocs.length }, () => [[]]);
    }

    renderAll();
    syncWidths();
}

/* ====== CSS var fallback ====== */
if (!getComputedStyle(document.documentElement).getPropertyValue('--cell').trim()) {
    document.documentElement.style.setProperty('--cell', '30px');
}

/* ====== Start ====== */
document.addEventListener('DOMContentLoaded', () => {
    renderDates();
    syncWidths();
    bootFromAtlas().catch(e => {
        L.error("Boot failed. Using empty data.", e);
        renderAll();
        syncWidths();
    });
});
