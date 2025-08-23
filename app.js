/* =========================
   AM Allocation — app.js (client-only, no Node)
   - Requires: <script src="https://unpkg.com/realm-web/dist/bundle.iife.js"></script>
   - Put this file after the SDK in your HTML: <script defer src="./app.js"></script>
   - Update CONFIG below to match your Atlas App Services app & DB.
   ========================= */

// ===== Atlas App Services config =====
const CONFIG = {
    appId: "amallocation-tgczmjh",             // Your App Services Client App ID
    baseUrl: "https://services.cloud.mongodb.com",
    service: "mongodb-atlas",                  // default service name
    db: "am_database",                        // your DB
    col: { people: "people", regions: "regions", allocs: "allocations" },
    auth: { mode: "anonymous" }                // dev: "anonymous"; prod: { mode:"email", email:"", password:"" }
};

// ===== Atlas helpers =====
const realmApp = new Realm.App({ id: CONFIG.appId, baseUrl: CONFIG.baseUrl });

async function getDB() {
    if (!realmApp.currentUser) {
        if (CONFIG.auth.mode === "email") {
            await realmApp.logIn(Realm.Credentials.emailPassword(CONFIG.auth.email, CONFIG.auth.password));
        } else {
            await realmApp.logIn(Realm.Credentials.anonymous());
        }
    }
    return realmApp.currentUser.mongoClient(CONFIG.service).db(CONFIG.db);
}

const isoToDate = v => (v instanceof Date ? v : new Date(v));

async function atlasLoadPeople(db) {
    const docs = await db.collection(CONFIG.col.people)
        .find({ status: "active" }, { sort: { fullname: 1 } });
    const people = docs.map(d => ({
        _id: d._id, id: d.id,
        fullname: d.fullname,
        preferredName: d.preferredName || d.fullname
    }));
    const idxByOid = Object.fromEntries(people.map((p, i) => [String(p._id), i]));
    return { people, idxByOid };
}

async function atlasLoadRegions(db) {
    const docs = await db.collection(CONFIG.col.regions)
        .find({ active: true }, { sort: { order: 1 } });
    return Object.fromEntries(docs.map(r => [r.name, r.color]));
}

async function atlasLoadAllocations(db, fromDate, toDate) {
    const Alloc = db.collection(CONFIG.col.allocs);
    const assigned = await Alloc.find({
        status: "assigned",
        arrival: { $lt: toDate.toISOString() },
        departure: { $gt: fromDate.toISOString() }
    });
    const pending = await Alloc.find({ status: "pending" }, { sort: { arrival: 1 } });
    assigned.forEach(a => { a.arrival = isoToDate(a.arrival); a.departure = isoToDate(a.departure); });
    pending.forEach(a => { a.arrival = isoToDate(a.arrival); a.departure = isoToDate(a.departure); });
    return { assigned, pending };
}

async function atlasAssignAllocation(appId, personOid, laneIndex) {
    const db = await getDB();
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
}

async function atlasUnassignAllocation(appId) {
    const db = await getDB();
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
}

async function atlasCreateAllocations(docs) {
    const db = await getDB();
    await db.collection(CONFIG.col.allocs).insertMany(docs);
}

// ===== Time/date utilities =====
const DAY = 24 * 60 * 60 * 1000;
const clampNoon = d => { const x = new Date(d); x.setHours(12, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return clampNoon(x); };
const startOfMonth = d => clampNoon(new Date(d.getFullYear(), d.getMonth(), 1));
const endOfMonth = d => clampNoon(new Date(d.getFullYear(), d.getMonth() + 1, 0));
const daysInclusive = (a, b) => Math.floor((clampNoon(b) - clampNoon(a)) / DAY) + 1;

// ===== State =====
let viewMode = "YEAR";                         // 'YEAR' | 'THREE' | 'MONTH'
let focusDate = clampNoon(new Date());
let columns = [];
let editMode = false;
let poolCollapsed = false;

let COUNTRY_COLORS = {};                       // filled by Atlas
let demoPeople = [];                           // filled by Atlas
let pool = [];                                 // pending (drawer), filled by Atlas
let alloc = [];                                // [personIdx][lane] -> items, filled by Atlas
let peopleDocs = [];                           // full people documents (with _id)
let personIdxByOid = {};                       // { "<oid>": index }

// ===== DOM =====
const $ = sel => document.querySelector(sel);
const app = $("#app");
const timeline = $("#timeline-header");
const datesGrid = $("#datesGrid");
const peopleWrap = $("#board");
const hHeader = document.getElementById('timeline-header');
const hBody = document.getElementById('board');

// ===== Toolbar actions =====
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

// ==== Sync horizontal scroll between header and body
let syncing = false;
hHeader?.addEventListener('scroll', () => { if (syncing) return; syncing = true; if (hBody) hBody.scrollLeft = hHeader.scrollLeft; syncing = false; });
hBody?.addEventListener('scroll', () => { if (syncing) return; syncing = true; if (hHeader) hHeader.scrollLeft = hBody.scrollLeft; syncing = false; });

// ===== Dates/columns =====
function setMonthLabel(d) {
    const el = document.getElementById('monthLabel');
    if (el) el.textContent = d.toLocaleString(undefined, { month: 'long', year: 'numeric' });
}

function buildColumns() {
    let start, end; const now = new Date(focusDate);
    if (viewMode === 'YEAR') { start = new Date(now.getFullYear(), 0, 1); end = new Date(now.getFullYear(), 11, 31); }
    else if (viewMode === 'THREE') { start = new Date(now.getFullYear(), now.getMonth() - 1, 1); end = new Date(now.getFullYear(), now.getMonth() + 1, 0); }
    else { start = startOfMonth(now); end = endOfMonth(now); }
    start = clampNoon(start); end = clampNoon(end);
    const days = Math.floor((end - start) / DAY) + 1;
    columns = Array.from({ length: days }, (_, i) => addDays(start, i));
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

// ===== Item utilities =====
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
function colorFor(cat) { return COUNTRY_COLORS[cat] || COUNTRY_COLORS.Other || "#94a3b8"; }

// ===== DnD helpers =====
let dragItemId = null; let dragSource = null;

function makeDraggable(el, item) {
    if (!el) return;
    if (editMode) {
        el.setAttribute('draggable', 'true');
        el.onDragStartHandler = () => { dragItemId = item.id; dragSource = { type: 'pool', itemRef: item }; };
        el.onDragEndHandler = () => { dragItemId = null; dragSource = null; removeGhosts(); };
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
    ghost.textContent = item.title;
    laneEl.appendChild(ghost);
}

// ===== Placement (lanes) =====
function placeItem(personIdx, dropDate, item) {
    // Note: currently ignoring dropDate; uses item's own arrival/departure.
    if (!editMode) return false;
    if (!alloc[personIdx]) alloc[personIdx] = [[]];
    if (alloc[personIdx].length === 0) alloc[personIdx] = [[]];
    const laneCount = alloc[personIdx].length;
    for (let lane = 0; lane < laneCount; lane++) {
        const laneArr = alloc[personIdx][lane];
        const sorted = laneArr.slice().sort((a, b) => a.arrival - b.arrival);
        if (sorted.some(x => overlaps(item, x))) continue;
        laneArr.push(item);
        pool = pool.filter(p => p.id !== item.id);
        renderPool(); renderPeople();
        return true;
    }
    if (alloc[personIdx].length < 10) { alloc[personIdx].push([]); return placeItem(personIdx, dropDate, item); }
    return false;
}

// ===== Pool rendering =====
function renderPool() {
    const panel = document.getElementById('panelPending');
    if (!panel) return;
    panel.innerHTML = '';
    const list = pool.slice().sort((a, b) => a.arrival - b.arrival);

    list.forEach(it => {
        const card = document.createElement('div');
        card.className = 'item-card';
        card.style.borderColor = colorFor(it.category);
        card.style.background = colorFor(it.category);
        card.innerHTML = `
      <div class="row" style="justify-content:space-between; font-weight:600; font-size:.875rem;">
        <span class="truncate" title="${it.title}">${it.title}</span>
      </div>
      <div style="font-size:.75rem; color:var(--muted); margin-top:.25rem">
        ${it.arrival.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}
        → ${it.departure.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}
      </div>
      <div style="font-size:.7rem; color:var(--muted); margin-top:.125rem">ID: ${it.id}</div>`;
        panel.appendChild(card);
        makeDraggable(card, it);
    });
    if (list.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'font-size:.9rem; color:var(--muted); margin:.5rem 0;';
        empty.textContent = 'No pending villa allocations';
        panel.appendChild(empty);
    }

    // populate categories in add-item sheet
    const catSel = document.getElementById('addCategory');
    if (catSel) { catSel.innerHTML = Object.keys(COUNTRY_COLORS).map(k => `<option value="${k}">${k}</option>`).join(''); }
}

// ===== People & lanes rendering =====
function renderPeople() {
    if (!peopleWrap) return;
    peopleWrap.innerHTML = '';
    demoPeople.forEach((name, personIdx) => {
        if (!alloc[personIdx]) alloc[personIdx] = [[]];
        if (alloc[personIdx].length === 0) alloc[personIdx] = [[]];
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
                    if (dragSource && dragSource.type === 'pool') { movingItem = dragSource.itemRef; }
                    else if (dragSource && dragSource.type === 'placed') {
                        const srcLane = alloc[dragSource.personIdx][dragSource.laneIdx];
                        const idx = srcLane.indexOf(dragSource.itemRef);
                        if (idx > -1) srcLane.splice(idx, 1);
                        movingItem = dragSource.itemRef;
                    }
                    let ok = false; if (movingItem) ok = placeItem(personIdx, d, movingItem);
                    if (ok) {
                        // Persist via Atlas
                        const personDoc = peopleDocs[personIdx];
                        atlasAssignAllocation(movingItem.id, personDoc?._id, laneIdx).catch(err => {
                            console.error("Save failed:", err);
                            // Revert UI on failure
                            const laneRef = alloc[personIdx][laneIdx];
                            const i = laneRef.indexOf(movingItem);
                            if (i > -1) laneRef.splice(i, 1);
                            pool.push(movingItem);
                            renderPool(); renderPeople();
                        });
                    } else if (!ok && from && from.type === 'placed') {
                        // revert if move failed
                        alloc[from.personIdx][from.laneIdx].push(movingItem);
                        renderPeople();
                    }
                    dragItemId = null; dragSource = null; removeGhosts();
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
                bar.style.left = `calc(${startOffset} * var(--cell))`;
                bar.style.width = `calc(${span} * var(--cell))`;
                bar.style.background = colorFor(it.category);
                bar.title = `${it.title} • ${it.arrival.toDateString()} → ${it.departure.toDateString()}`;
                bar.innerHTML = `<span class="truncate">${it.title}</span><span style="opacity:.9">${it.arrival.getDate()}–${it.departure.getDate()}</span>`;
                if (editMode) {
                    bar.setAttribute('draggable', 'true');
                    bar.addEventListener('dragstart', () => { dragSource = { type: 'placed', personIdx, laneIdx, itemRef: it }; });
                    bar.addEventListener('dragend', () => { dragSource = null; removeGhosts(); });
                    bar.addEventListener('dblclick', () => {
                        const laneRef = alloc[personIdx][laneIdx];
                        const i = laneRef.indexOf(it);
                        if (i > -1) laneRef.splice(i, 1);
                        const moved = { id: it.id, title: it.title, arrival: it.arrival, departure: it.departure, category: it.category };
                        pool.push(moved);
                        renderPool(); renderPeople();
                        atlasUnassignAllocation(it.id).catch(err => {
                            console.error("Unassign failed:", err);
                            // Revert
                            pool = pool.filter(p => p.id !== it.id);
                            laneRef.push(it);
                            renderPool(); renderPeople();
                        });
                    });
                }
                lane.appendChild(bar);
            });

            lanesWrap.appendChild(lane);
        });

        person.appendChild(lanesWrap);
        peopleWrap.appendChild(person);
    });
}

// ===== Width sync =====
function syncWidths() {
    document.querySelectorAll('.lanes').forEach(l => { l.style.width = `calc(${columns.length} * var(--cell))`; });
    if (datesGrid) datesGrid.style.gridTemplateColumns = `repeat(${columns.length}, var(--cell))`;
    if (timeline) timeline.style.width = `calc(${columns.length} * var(--cell))`;
}

// ===== Add Items Page logic (optional: insert to DB) =====
function showAddItemsPage() {
    const appGrid = document.getElementById('appGrid');
    const addPage = document.getElementById('addPage');
    if (!appGrid || !addPage) return;
    appGrid.classList.add('hidden');
    addPage.classList.remove('hidden');
    ensureSheetHasRows(5);
}
function hideAddItemsPage() {
    const appGrid = document.getElementById('appGrid');
    const addPage = document.getElementById('addPage');
    if (!appGrid || !addPage) return;
    addPage.classList.add('hidden');
    appGrid.classList.remove('hidden');
    if (typeof setTab === 'function') setTab('Pending'); // guard if setTab exists
    renderPool();
}
$("#backToMain")?.addEventListener('click', hideAddItemsPage);
$("#add5Rows")?.addEventListener('click', () => ensureSheetHasRows(5));
$("#saveSheet")?.addEventListener('click', saveSheetToPool);

function ensureSheetHasRows(n) {
    const sheet = document.getElementById('sheet'); if (!sheet) return;
    const cats = Object.keys(COUNTRY_COLORS);
    for (let i = 0; i < n; i++) {
        const rid = `r${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        sheet.insertAdjacentHTML('beforeend', `
      <div class="sheet-row"><input id="${rid}_id" placeholder="ID" /></div>
      <div class="sheet-row"><input id="${rid}_title" placeholder="Title" /></div>
      <div class="sheet-row"><input id="${rid}_arr" type="date" /></div>
      <div class="sheet-row"><input id="${rid}_dep" type="date" /></div>
      <div class="sheet-row"><select id="${rid}_cat">${cats.map(c => `<option value="${c}">${c}</option>`).join('')}</select></div>
    `);
    }
}

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
    // de-dup by ID
    const seen = new Set(pool.map(x => x.id));
    for (const r of rows) {
        if (seen.has(r.id)) { err.textContent = `Duplicate ID: ${r.id}`; return; }
        seen.add(r.id);
    }
    pool.push(...rows);
    renderPool();
    // Optional: also insert into MongoDB as pending
    try {
        const docs = rows.map(r => ({
            id: r.id,
            title: r.title,
            arrival: r.arrival.toISOString(),
            departure: r.departure.toISOString(),
            region: r.category,
            status: "pending",
            assignedTo: null, lane: null,
            notes: "", version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        }));
        await atlasCreateAllocations(docs);
    } catch (e) { console.warn("Insert to DB failed (continuing locally):", e); }
    hideAddItemsPage();
}

// ===== Render all =====
function renderAll() { renderDates(); renderPool(); renderPeople(); scrollToCurrentMonthIfYear(); }

// ===== Boot from Atlas =====
async function bootFromAtlas() {
    // Decide a reasonable range to fetch initially (full current year)
    const y = focusDate.getFullYear();
    const from = new Date(y, 0, 1);
    const to = new Date(y, 11, 31, 23, 59, 59);

    const db = await getDB();
    const [{ people, idxByOid }, colors, { assigned, pending }] = await Promise.all([
        atlasLoadPeople(db),
        atlasLoadRegions(db),
        atlasLoadAllocations(db, from, to)
    ]);

    // Build UI data
    peopleDocs = people;
    personIdxByOid = idxByOid;
    demoPeople = people.map(p => p.preferredName);
    COUNTRY_COLORS = colors;

    // pool (pending)
    pool = pending.map(a => ({ id: a.id, title: a.title, arrival: a.arrival, departure: a.departure, category: a.region }));

    // alloc (assigned)
    alloc = Array.from({ length: people.length }, () => []);
    for (const a of assigned) {
        const oid = a.assignedTo && (a.assignedTo._id || a.assignedTo);
        const personIdx = personIdxByOid[String(oid)];
        if (personIdx == null) continue;
        const lane = Number.isInteger(a.lane) ? a.lane : 0;
        while (!alloc[personIdx][lane]) alloc[personIdx].push([]);
        alloc[personIdx][lane].push({
            id: a.id, title: a.title,
            arrival: a.arrival, departure: a.departure,
            category: a.region
        });
    }
    // sort each lane
    for (const lanes of alloc) for (const lane of lanes) lane.sort((x, y) => x.arrival - y.arrival);

    // First render
    renderAll();
    syncWidths();
}

// ===== CSS var fallback =====
if (!getComputedStyle(document.documentElement).getPropertyValue('--cell').trim()) {
    document.documentElement.style.setProperty('--cell', '30px');
}

// ===== Kick everything off =====
document.addEventListener('DOMContentLoaded', () => {
    // Build columns before boot so header renders promptly
    renderDates();
    syncWidths();
    // Then load from Atlas and paint data
    bootFromAtlas().catch(e => {
        console.error("[Atlas] boot failed. Using empty data.", e);
        renderAll();
        syncWidths();
    });
});
