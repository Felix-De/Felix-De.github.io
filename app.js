/* =========================
   AM Allocation — app.js (client-only)
   Requires:
     <script src="https://unpkg.com/realm-web/dist/bundle.iife.js"></script>
     <script defer src="./app.js"></script>
   ========================= */

/* ========= CONFIG (client-side only; move to server if secrets matter) ========= */
const CONFIG = {
    appId: "amallocation-tgczmjh",
    baseUrl: "https://ap-southeast-1.aws.services.cloud.mongodb.com",
    service: "mongodb-atlas",
    db: "am_database",
    col: { people: "arismeeha", regions: "region", allocs: "allocation" },
    auth: { mode: "anonymous", email: "", password: "" }
};

/* ========= Logger ========= */
const L = {
    info: (...a) => console.info("[AM-Alloc]", ...a),
    warn: (...a) => console.warn("[AM-Alloc]", ...a),
    error: (...a) => console.error("[AM-Alloc]", ...a),
};

/* ========= Realm (Atlas App Services) bootstrap ========= */
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
/** Wrap DB ops to refresh once on InvalidSession. */
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

/* ========= Time & helpers ========= */
const DAY = 24 * 60 * 60 * 1000;
const clampNoon = d => { const x = new Date(d); x.setHours(12, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return clampNoon(x); };
const startOfMonth = d => clampNoon(new Date(d.getFullYear(), d.getMonth(), 1));
const endOfMonth = d => clampNoon(new Date(d.getFullYear(), d.getMonth() + 1, 0));
const isoToDate = v => (v instanceof Date ? v : new Date(v));
const daysInclusive = (a, b) => Math.floor((clampNoon(b) - clampNoon(a)) / DAY) + 1;
const keyifyObjectId = x => {
    if (x && typeof x === 'object' && typeof x.toHexString === 'function') return x.toHexString().toLowerCase();
    if (x && typeof x === 'object' && typeof x.$oid === 'string') return x.$oid.toLowerCase();
    const s = String(x); const m = s.match(/[a-f0-9]{24}/i); return (m ? m[0] : s).toLowerCase();
};
const normalizeRegionName = name => String(name || "").replace(/\s+/g, " ").trim();
const escapeAttr = s => String(s || '').replace(/"/g, '&quot;');
/** "YYYY-MM-DD" local */
function toLocalDateInputValue(d) {
    const yr = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${yr}-${mo}-${da}`;
}
/** Pick black/white text for contrast over a background hex color. */
function getContrastColor(hex) {
    if (!hex) return "#000";
    let c = hex.replace("#", "").trim().toLowerCase();
    if (c.length === 8) c = c.slice(0, 6);
    if (c.length === 3) c = c.split("").map(ch => ch + ch).join("");
    if (!/^[0-9a-f]{6}$/.test(c)) return "#000";
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 128 ? "#000000" : "#ffffff";
}
/** Robust cell width */
function getCellWidth() {
    const el = document.querySelector('.date-cell');
    if (el) {
        const w = el.getBoundingClientRect().width;
        if (w && isFinite(w)) return w;
    }
    const css = getComputedStyle(document.documentElement).getPropertyValue('--cell').trim();
    if (css.endsWith('px')) {
        const n = parseFloat(css);
        if (n && isFinite(n)) return n;
    }
    return 30;
}

/* ========= Global UI state ========= */
let viewMode = "YEAR";
let focusDate = clampNoon(new Date()); // month/year anchor

let columns = [];               // array<Date> for current view
let colIndexByYMD = {};         // "YYYY-MM-DD" => column index

let editMode = false;
let poolCollapsed = false;

let COUNTRY_COLORS = { Other: "#94a3b8" };

let peopleDocs = [];
let personIdxByOid = {};
let pool = [];                  // pending drawer
let alloc = [];                 // [personIdx][laneIdx] = items[]
let offDays = [];               // [personIdx] = Set<"YYYY-MM-DD">

/* ========= DOM refs ========= */
const $ = sel => document.querySelector(sel);
const appEl = $("#app");
const datesGrid = $("#datesGrid");
const hHeader = $("#timeline-header");
const hBody = $("#board");

/* ========= Month label control ========= */
function updateMonthLabelFromScroll() {
    const labelEl = document.getElementById('monthLabel');
    if (!labelEl || !columns?.length || !hHeader) return;
    const w = getCellWidth();
    const viewportW = hHeader.getBoundingClientRect().width || 0;
    const centerPx = (hHeader.scrollLeft || 0) + viewportW / 2;
    let idx = Math.floor(centerPx / Math.max(1, w));
    idx = Math.max(0, Math.min(columns.length - 1, idx));
    const d = columns[idx];
    labelEl.textContent = d.toLocaleString(undefined, { month: 'long', year: 'numeric' });
}
function updateMonthLabelSoon() { requestAnimationFrame(() => updateMonthLabelFromScroll()); }

/* ========= Toolbar ========= */
$("#viewSelect")?.addEventListener('change', () => {
    viewMode = $("#viewSelect").value;
    renderDates();
    renderPeople();
    applyResponsiveCellWidth();
    syncWidths();
    if (viewMode === 'YEAR') initialYearScroll(); else scrollToToday();
    updateMonthLabelSoon();
    highlightTodayColumn(); // keep highlight accurate
});
$("#prevMonth")?.addEventListener('click', () => {
    if (viewMode === 'YEAR') {
        const cur = getCenteredMonthIndex();
        const target = Math.max(0, cur - 1);
        scrollYearToMonthIndex(target);
        updateMonthLabelSoon();
        return;
    }
    focusDate.setMonth(focusDate.getMonth() - 1);
    renderDates(); renderPeople();
    applyResponsiveCellWidth(); syncWidths();
    scrollToToday(); updateMonthLabelSoon();
    highlightTodayColumn();
});
$("#nextMonth")?.addEventListener('click', () => {
    if (viewMode === 'YEAR') {
        const cur = getCenteredMonthIndex();
        const target = Math.min(11, cur + 1);
        scrollYearToMonthIndex(target);
        updateMonthLabelSoon();
        return;
    }
    focusDate.setMonth(focusDate.getMonth() + 1);
    renderDates(); renderPeople();
    applyResponsiveCellWidth(); syncWidths();
    scrollToToday(); updateMonthLabelSoon();
    highlightTodayColumn();
});

$("#toggleEdit")?.addEventListener('click', () => {
    editMode = !editMode;
    document.body.classList.toggle('edit-mode', editMode);
    $("#toggleEdit").textContent = editMode ? 'View' : 'Edit';
    const ft = $("#footer .footer-text span"); if (ft) ft.textContent = editMode ? 'Edit Mode: Press save to save progress' : 'View Mode';
    renderPool(); renderPeople();
    highlightTodayColumn();
});
$("#btnSave")?.addEventListener('click', () => {
    editMode = false;
    document.body.classList.remove('edit-mode');
    $("#toggleEdit").textContent = 'Edit';
    renderPool(); renderPeople();
    highlightTodayColumn();
});
$("#btnCollapsePool")?.addEventListener('click', () => {
    poolCollapsed = !poolCollapsed;
    $("#app").classList.toggle('drawer-collapsed', poolCollapsed);
    $("#drawer").classList.toggle('show', poolCollapsed);
    applyResponsiveCellWidth(); renderPool(); syncWidths();
    updateMonthLabelSoon();
    highlightTodayColumn();
});
$("#flipSide")?.addEventListener('click', () => { document.body.classList.toggle('pool-left'); });

/* ========= Pool tabs ========= */
function wirePoolTabs() {
    const tabPending = $('#tabPending');
    const tabApp = $('#tabApp');
    const panelPending = $('#panelPending');
    const panelApp = $('#panelApp');
    if (!tabPending || !tabApp || !panelPending || !panelApp) return;
    const activate = which => {
        const pend = which === 'pending';
        tabPending.classList.toggle('active', pend);
        tabApp.classList.toggle('active', !pend);
        panelPending.classList.toggle('hidden', !pend);
        panelApp.classList.toggle('hidden', pend);
    };
    tabPending.addEventListener('click', () => activate('pending'));
    tabApp.addEventListener('click', () => activate('app'));
}

/* ========= Sync scrolling; update month label ========= */
let syncing = false;
hHeader?.addEventListener('scroll', () => {
    if (syncing) return; syncing = true;
    if (hBody) hBody.scrollLeft = hHeader.scrollLeft;
    syncing = false;
    updateMonthLabelFromScroll();
});
hBody?.addEventListener('scroll', () => {
    if (syncing) return; syncing = true;
    if (hHeader) hHeader.scrollLeft = hBody.scrollLeft;
    syncing = false;
    updateMonthLabelFromScroll();
});

/* ========= Dates/header ========= */
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
    colIndexByYMD = {};
    columns.forEach((d, i) => { colIndexByYMD[toLocalDateInputValue(d)] = i; });
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

/* ========= Scroll anchoring ========= */
function scrollToToday() {
    if (viewMode === 'YEAR') return;
    if (!columns.length || !hHeader || !hBody) return;
    const today = clampNoon(new Date()).getTime();
    const first = clampNoon(columns[0]).getTime();
    const last = clampNoon(columns[columns.length - 1]).getTime();
    if (today < first || today > last) return;
    const offsetDays = Math.floor((today - first) / DAY);
    const w = getCellWidth();
    const viewport = hBody.getBoundingClientRect().width;
    const target = Math.max(0, offsetDays * w - viewport / 2 + w / 2);
    hHeader.scrollLeft = target;
    hBody.scrollLeft = target;
}
function syncScrollToContentX(contentX) {
    const viewport = hBody?.getBoundingClientRect().width || 0;
    const targetScrollLeft = Math.max(0, contentX - viewport / 2);
    if (hHeader) hHeader.scrollLeft = targetScrollLeft;
    if (hBody) hBody.scrollLeft = targetScrollLeft;
}
function scrollYearToMonthIndex(monthIdx) {
    monthIdx = Math.max(0, Math.min(11, monthIdx | 0));
    const focusYear = (focusDate || new Date()).getFullYear();
    const yearStart = clampNoon(new Date(focusYear, 0, 1));
    const monthStart = clampNoon(new Date(focusYear, monthIdx, 1));
    const startIdx = Math.floor((monthStart - yearStart) / DAY);
    const daysInMonth = new Date(focusYear, monthIdx + 1, 0).getDate();
    const midIdx = startIdx + Math.floor(daysInMonth / 2);
    const w = getCellWidth();
    const contentX = (midIdx + 0.5) * w;
    syncScrollToContentX(contentX);
}
function getCenteredMonthIndex() {
    if (!columns?.length || !hHeader) return 0;
    const w = getCellWidth();
    const viewportW = hHeader.getBoundingClientRect().width || 0;
    const centerPx = (hHeader.scrollLeft || 0) + viewportW / 2;
    let idx = Math.floor(centerPx / Math.max(1, w));
    idx = Math.max(0, Math.min(columns.length - 1, idx));
    return columns[idx].getMonth();
}
function initialYearScroll() {
    const today = new Date();
    const yView = (focusDate || today).getFullYear();
    const m = (today.getFullYear() === yView) ? today.getMonth() : 0;
    scrollYearToMonthIndex(m);
}

/* ========= Items & colors ========= */
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

/* ========= Drag & drop ========= */
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
    const bg = colorFor(item.category);
    const fg = getContrastColor(bg);
    ghost.style.background = bg; ghost.style.color = fg;
    ghost.textContent = item.title;
    laneEl.appendChild(ghost);
}

/* ========= Shape guards ========= */
function ensureAllocShape(numPeople) {
    if (!Array.isArray(alloc)) alloc = [];
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
function ensureOffDaysShape(numPeople) {
    if (!Array.isArray(offDays)) offDays = [];
    while (offDays.length < numPeople) offDays.push(new Set());
    if (offDays.length > numPeople) offDays.length = numPeople;
    for (let i = 0; i < offDays.length; i++) {
        if (!(offDays[i] instanceof Set)) offDays[i] = new Set();
    }
}

/* ========= Robust Off Day helpers ========= */
function personHasArrivalOn(personIdx, ymd) {
    if (!Array.isArray(alloc[personIdx])) return false;
    for (const lane of alloc[personIdx]) {
        if (!Array.isArray(lane)) continue;
        for (const it of lane) {
            if (toLocalDateInputValue(clampNoon(it.arrival)) === ymd) return true;
        }
    }
    return false;
}

/* ========= Drawer (Pending) with inline edit ========= */
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
        card.style.borderColor = bg; card.style.background = bg; card.style.color = fg;

        const controls = editMode
            ? `<div class="row" style="gap:.25rem;">
           <button class="mini-btn btn-edit" title="Edit">✎</button>
         </div>`
            : '';

        card.innerHTML = `
      <div class="row" style="justify-content:space-between; font-weight:600; font-size:.875rem;">
        ${controls}
        <span class="truncate" title="${it.title}">${it.title}</span>
      </div>
      <div style="font-size:.75rem; opacity:.9; margin-top:.25rem">
        ${it.arrival.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}
        → ${it.departure.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}
      </div>
      <div style="font-size:.7rem; opacity:.9; margin-top:.125rem">ID: ${it.id}</div>`;

        if (editMode) {
            card.querySelector('.btn-edit')?.addEventListener('click', () => {
                card.setAttribute('draggable', 'false');
                const arrivalVal = toLocalDateInputValue(it.arrival);
                const departureVal = toLocalDateInputValue(it.departure);
                const opts = getCategoryOptionsHtml();
                card.innerHTML = `
          <div class="col" style="gap:.5rem;">
            <input class="in title" placeholder="Title" value="${escapeAttr(it.title)}" />
            <div class="row" style="gap:.5rem;">
              <input class="in arr" type="date" value="${arrivalVal}" />
              <input class="in dep" type="date" value="${departureVal}" />
              <select class="in cat">${opts}</select>
            </div>
            <input class="in notes" placeholder="Notes" value="${escapeAttr(it.notes || '')}" />
            <div class="row" style="gap:.5rem; margin-top:.25rem;">
              <button class="mini-btn btn-save">Save</button>
              <button class="mini-btn btn-cancel">Cancel</button>
            </div>
          </div>`;
                const sel = card.querySelector('.cat'); if (sel && it.category) sel.value = it.category;

                card.querySelector('.btn-cancel')?.addEventListener('click', () => renderPool());
                card.querySelector('.btn-save')?.addEventListener('click', async () => {
                    const title = card.querySelector('.title')?.value.trim();
                    const arr = card.querySelector('.arr')?.value;
                    const dep = card.querySelector('.dep')?.value;
                    const cat = card.querySelector('.cat')?.value;
                    const notes = card.querySelector('.notes')?.value.trim();

                    if (!title || !arr || !dep || !cat) { alert("Please fill Title, Arrival, Departure, Category."); return; }
                    const a = new Date(arr + 'T12:00:00');
                    const d = new Date(dep + 'T12:00:00');
                    if (isNaN(a) || isNaN(d) || d < a) { alert("Invalid dates (Departure must be >= Arrival)."); return; }

                    it.title = title; it.arrival = a; it.departure = d; it.category = cat; it.notes = notes;

                    try {
                        await atlasUpsertAllocations([{
                            id: it.id, title: it.title,
                            guestName: it.guestName || "", villa: it.villa || "",
                            arrival: it.arrival.toISOString(), departure: it.departure.toISOString(),
                            region: it.category, status: "pending",
                            assignedTo: null, lane: null, notes: it.notes || ""
                        }]);
                    } catch (e) { L.warn("Pending inline edit save failed:", e); }
                    renderPool();
                });
            });
        }

        panel.appendChild(card);
        makeDraggable(card, it);
    });

    if (list.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'font-size:.9rem; color:var(--muted); margin:.5rem 0;';
        empty.textContent = 'No pending villa allocations';
        panel.appendChild(empty);
    }
}

/* ========= Off Day markers (CSS-styled) ========= */
function renderOffdayMarkers(personIdx, laneEl) {
    // Clear previous markers in this lane
    laneEl.querySelectorAll('.offday-mark').forEach(n => n.remove());
    const set = offDays[personIdx];
    if (!set || set.size === 0) return;
    if (getComputedStyle(laneEl).position === 'static') laneEl.style.position = 'relative';

    // Paint a column-wide marker for each off-day in this person's set
    set.forEach(ymd => {
        const colIdx = colIndexByYMD[ymd];
        if (colIdx == null) return;
        const mark = document.createElement('div');
        mark.className = 'offday-mark';
        mark.style.left = `calc(${colIdx} * var(--cell))`;
        mark.style.width = 'var(--cell)';
        laneEl.appendChild(mark);
    });
}

/* ========= People & lanes ========= */
function renderPeople() {
    if (!hBody) return;
    ensureAllocShape(peopleDocs.length);
    ensureOffDaysShape(peopleDocs.length);

    hBody.innerHTML = '';
    const showIdx = peopleDocs.map((_, idx) => ({ idx }));

    showIdx.forEach(({ idx: personIdx }) => {
        if (!alloc[personIdx]) alloc[personIdx] = [[]];
        if (alloc[personIdx].length === 0) alloc[personIdx] = [[]];

        const p = peopleDocs[personIdx];
        const name = (p && (p.preferredName && p.preferredName.trim())) || p.fullname || "Unknown";

        const person = document.createElement('section');
        person.className = 'person';

        // Folder-styled header (no occupancy toggle anymore)
        const head = document.createElement('div');
        head.className = 'head';
        head.innerHTML = `
      <div class="person-head">
        <div class="person-name">${name}</div>
        <div class="person-lanes">Lanes: ${alloc[personIdx].length}</div>
      </div>`;
        person.appendChild(head);

        // Lanes wrapper
        const lanesWrap = document.createElement('div');
        lanesWrap.className = 'lanes';
        lanesWrap.style.width = `calc(${columns.length} * var(--cell))`;

        // Real lanes
        alloc[personIdx].forEach((laneArr, laneIdx) => {
            const lane = document.createElement('div'); lane.className = 'lane'; lane.style.position = 'relative';

            const laneGrid = document.createElement('div');
            laneGrid.className = 'lane-grid';
            laneGrid.style.gridTemplateColumns = `repeat(${columns.length}, var(--cell))`;

            columns.forEach(d => {
                const cell = document.createElement('div'); cell.className = 'lane-cell';
                const ymd = toLocalDateInputValue(d);
                cell.dataset.date = ymd; cell.dataset.person = String(personIdx);

                // DnD
                cell.addEventListener('dragover', (ev) => {
                    if (!editMode) return;
                    allowDrop(ev);
                    const itm = (dragSource && dragSource.itemRef) || null;
                    if (!itm) return;
                    showGhost(lane, d, itm);
                });
                cell.addEventListener('dragleave', () => { removeGhosts(); });
                cell.addEventListener('drop', (ev) => {
                    if (!editMode) return; ev.preventDefault();
                    let movingItem = null; const from = dragSource;
                    if (from && from.type === 'pool') movingItem = from.itemRef;
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
                        highlightTodayColumn();
                    }
                    dragSource = null; removeGhosts();
                });

                // Double click to toggle Off Day (blocked if an ARRIVAL exists that day)
                cell.addEventListener('dblclick', () => {
                    if (!editMode) return;
                    const set = offDays[personIdx];
                    const isOff = set.has(ymd);
                    if (isOff) {
                        set.delete(ymd);
                        renderPeople();
                        highlightTodayColumn();
                        return;
                    }
                    if (personHasArrivalOn(personIdx, ymd)) {
                        L.warn(`Cannot set Off Day on ${ymd} — an allocation ARRIVES this day.`);
                        cell.classList.add('offday-blocked'); setTimeout(() => cell.classList.remove('offday-blocked'), 600);
                        return;
                    }
                    set.add(ymd);
                    renderPeople();
                    highlightTodayColumn();
                });

                laneGrid.appendChild(cell);
            });

            lane.appendChild(laneGrid);
            renderOffdayMarkers(personIdx, lane);

            // Bars
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
                bar.style.background = bg; bar.style.color = fg;
                bar.style.zIndex = '2';
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
        hBody.appendChild(person);
    });

    // After people render, apply today's column highlight (header + lanes)
    highlightTodayColumn();
}

/* ========= Placement & unassignment ========= */
function placeItem(personIdx, dropDate, item, laneIdx) {
    if (!editMode) return false;
    ensureAllocShape(peopleDocs.length); ensureOffDaysShape(peopleDocs.length);

    const arrivalYMD = toLocalDateInputValue(item.arrival);
    if (offDays[personIdx] && offDays[personIdx].has(arrivalYMD)) {
        L.warn(`Cannot place "${item.title}" — arrival ${arrivalYMD} is an Off Day.`);
        return false;
    }

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
    const moved = { id: it.id, title: it.title, arrival: it.arrival, departure: it.departure, category: it.category, notes: it.notes };
    pool.push(moved);
    renderPool(); renderPeople();
    atlasUnassignAllocation(it.id).catch(err => {
        L.error("Unassign failed:", err);
        pool = pool.filter(p => p.id !== it.id);
        laneRef.push(it);
        renderPool(); renderPeople();
    });
}

/* ========= Today column highlight ========= */
/** Highlight the entire timeline column where date === today (header + all lanes). */
function highlightTodayColumn() {
    // Clear any previous
    document.querySelectorAll('.today-col').forEach(el => el.classList.remove('today-col'));
    if (!columns.length) return;

    const todayYMD = toLocalDateInputValue(new Date());
    const idx = colIndexByYMD[todayYMD];
    if (idx == null) return;

    // Header cell
    const headerCell = datesGrid?.children?.[idx];
    if (headerCell) headerCell.classList.add('today-col');

    // Lane grids
    document.querySelectorAll('.lane-grid').forEach(grid => {
        const cell = grid.children?.[idx];
        if (cell) cell.classList.add('today-col');
    });
}

/* ========= Width sync & Month cell responsiveness ========= */
function syncWidths() {
    document.querySelectorAll('.lanes').forEach(l => { l.style.width = `calc(${columns.length} * var(--cell))`; });
    if (datesGrid) datesGrid.style.gridTemplateColumns = `repeat(${columns.length}, var(--cell))`;
    if (hHeader) hHeader.style.width = `calc(${columns.length} * var(--cell))`;
}
/** In MONTH view: adjust --cell depending on whether the drawer is open. */
function applyResponsiveCellWidth() {
    const root = document.documentElement;
    const drawer = document.getElementById('drawer');
    const isDrawerShown = !!drawer && drawer.classList.contains('show');
    if (viewMode === 'MONTH') {
        const expr = isDrawerShown ? '(100vw - 3em - 24px)' : '(100vw - 25vw - 24px)';
        root.style.setProperty('--cell', `calc(${expr} / 31)`);
    }
}

/* ========= Sheet page: dynamic rows / delete / save ========= */
function getCategoryOptionsHtml() {
    const keys = Object.keys(COUNTRY_COLORS || {}).sort((a, b) => a.localeCompare(b));
    return keys.map(k => `<option value="${k}">${k}</option>`).join("");
}
function clearSheetRows() {
    const sheet = document.getElementById('sheet');
    const err = document.getElementById('sheetError');
    if (!sheet) return;
    while (sheet.children.length > 8) sheet.removeChild(sheet.lastElementChild);
    if (err) err.textContent = '';
}
function ensureSheetHasRows(n) {
    const sheet = document.getElementById('sheet');
    if (!sheet) return;
    const opts = getCategoryOptionsHtml();
    for (let i = 0; i < n; i++) {
        const rid = `r${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const today = new Date(), tomorrow = addDays(today, 1);
        const arrivalVal = toLocalDateInputValue(today), departureVal = toLocalDateInputValue(tomorrow);
        sheet.insertAdjacentHTML('beforeend', `
      <div class="sheet-row" data-row="${rid}"><input id="${rid}_id" placeholder="ID" /></div>
      <div class="sheet-row" data-row="${rid}"><input id="${rid}_title" placeholder="Title" /></div>
      <div class="sheet-row" data-row="${rid}"><input id="${rid}_guest" placeholder="Guest Name" /></div>
      <div class="sheet-row" data-row="${rid}"><input id="${rid}_villa" placeholder="Villa" /></div>
      <div class="sheet-row" data-row="${rid}"><input id="${rid}_arr" type="date" value="${arrivalVal}" /></div>
      <div class="sheet-row" data-row="${rid}"><input id="${rid}_dep" type="date" value="${departureVal}" /></div>
      <div class="sheet-row" data-row="${rid}"><select id="${rid}_cat">${opts}</select></div>
      <div class="sheet-row" data-row="${rid}">
        <div style="display:flex; align-items:center; gap:.5rem;">
          <input id="${rid}_notes" placeholder="Notes" style="flex:1;"/>
          <button type="button" class="row-del" data-row="${rid}" title="Delete row">🗑</button>
        </div>
      </div>`);
    }
}
function deleteSheetRow(rid) {
    const sheet = document.getElementById('sheet');
    if (!sheet) return;
    sheet.querySelectorAll(`.sheet-row[data-row="${rid}"]`).forEach(el => el.remove());
}
document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.row-del');
    if (btn) deleteSheetRow(btn.dataset.row);
});
async function atlasUpsertAllocations(docs) {
    return withDB(async (db) => {
        const ops = docs.map(d => ({
            updateOne: {
                filter: { id: d.id },
                update: {
                    $set: {
                        title: d.title, guestName: d.guestName ?? "", villa: d.villa ?? "",
                        arrival: d.arrival, departure: d.departure, region: d.region,
                        status: "pending", assignedTo: null, lane: null,
                        notes: d.notes ?? "", updatedAt: new Date().toISOString()
                    },
                    $setOnInsert: { version: 1, createdAt: new Date().toISOString() }
                },
                upsert: true
            }
        }));
        await db.collection(CONFIG.col.allocs).bulkWrite(ops, { ordered: false });
    });
}
async function saveSheetToPool() {
    const sheet = document.getElementById('sheet');
    const err = document.getElementById('sheetError');
    if (!sheet || !err) return;
    err.textContent = '';

    const rowIds = Array.from(new Set(
        Array.from(sheet.querySelectorAll('.sheet-row[data-row]')).map(el => el.dataset.row)
    ));
    const rows = [];
    for (const rid of rowIds) {
        const id = sheet.querySelector(`#${rid}_id`)?.value.trim();
        const title = sheet.querySelector(`#${rid}_title`)?.value.trim();
        const guest = sheet.querySelector(`#${rid}_guest`)?.value.trim();
        const villa = sheet.querySelector(`#${rid}_villa`)?.value.trim();
        const arr = sheet.querySelector(`#${rid}_arr`)?.value;
        const dep = sheet.querySelector(`#${rid}_dep`)?.value;
        const cat = sheet.querySelector(`#${rid}_cat`)?.value;
        const notes = sheet.querySelector(`#${rid}_notes`)?.value.trim();
        if (!id && !title && !guest && !villa && !arr && !dep && !cat && !notes) continue;
        if (!id || !title || !arr || !dep || !cat) { err.textContent = 'Each non-empty row needs ID, Title, Arrival, Departure and Category.'; return; }
        const a = new Date(arr + 'T12:00:00');
        const d = new Date(dep + 'T12:00:00');
        if (isNaN(a) || isNaN(d)) { err.textContent = 'Invalid date in one of the rows.'; return; }
        if (d < a) { err.textContent = 'Departure cannot be before Arrival.'; return; }
        rows.push({ id, title, guestName: guest || "", villa: villa || "", arrival: a, departure: d, category: cat, notes: notes || "" });
    }
    if (!rows.length) { err.textContent = 'No rows to save.'; return; }

    const seen = new Set();
    for (const r of rows) { if (seen.has(r.id)) { err.textContent = `Duplicate ID in sheet: ${r.id}`; return; } seen.add(r.id); }

    for (const r of rows) {
        pool = pool.filter(x => x.id !== r.id);
        pool.push({ id: r.id, title: r.title, arrival: r.arrival, departure: r.departure, category: r.category, notes: r.notes, guestName: r.guestName, villa: r.villa });
    }
    renderPool();

    try {
        const docs = rows.map(r => ({
            id: r.id, title: r.title, guestName: r.guestName, villa: r.villa,
            arrival: r.arrival.toISOString(), departure: r.departure.toISOString(),
            region: r.category, status: "pending", assignedTo: null, lane: null, notes: r.notes
        }));
        await atlasUpsertAllocations(docs);
    } catch (e) { L.warn("Upsert to DB failed (kept locally):", e); }
}

/* ========= Atlas ops ========= */
async function atlasLoadPeople() {
    return withDB(async (db) => {
        const docs = await db.collection(CONFIG.col.people).find({}, { sort: { fullname: 1 } });
        const people = docs.map(d => {
            const preferred = (typeof d.preferedname === 'string') ? d.preferedname.trim() : null;
            const full = (typeof d.fullname === 'string') ? d.fullname.trim() : '';
            return { _id: d._id, id: d.id, fullname: full, preferredName: (preferred && preferred.length ? preferred : null), status: d.status };
        });
        const idxByOid = {};
        people.forEach((p, i) => { idxByOid[keyifyObjectId(p._id)] = i; });
        return { people, idxByOid };
    });
}
async function atlasLoadRegions() {
    return withDB(async (db) => {
        const doc = await db.collection(CONFIG.col.regions).findOne({});
        if (!doc) { L.warn("Regions: no doc found; using fallback."); return { Other: "#94a3b8" }; }
        const map = {};
        for (const [k, v] of Object.entries(doc)) {
            if (k === "_id") continue;
            if (typeof v === "string" && v.trim()) map[k.trim()] = v.trim();
        }
        if (!map.Other) map.Other = "#94a3b8";
        return map;
    });
}
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
                }, $inc: { version: 1 }
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
                }, $inc: { version: 1 }
            }
        );
    });
}

/* ========= Render all ========= */
function renderAll() {
    renderDates();
    renderPool();
    renderPeople();
    if (viewMode === 'YEAR') initialYearScroll(); else scrollToToday();
    updateMonthLabelSoon();
    highlightTodayColumn();
}

/* ========= Boot ========= */
async function bootFromAtlas() {
    const y = focusDate.getFullYear();
    const from = new Date(y, 0, 1);
    const to = new Date(y, 11, 31, 23, 59, 59);

    try {
        const { people, idxByOid } = await atlasLoadPeople();
        peopleDocs = people;
        personIdxByOid = idxByOid;
        ensureAllocShape(peopleDocs.length);
        ensureOffDaysShape(peopleDocs.length);
        L.info("People:", peopleDocs.length);
    } catch (e) {
        L.error("People load failed:", e);
        peopleDocs = []; personIdxByOid = {};
        ensureAllocShape(0); ensureOffDaysShape(0);
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

        pool = pending.map(a => ({
            id: a.id, title: a.title,
            arrival: a.arrival, departure: a.departure,
            category: normalizeRegionName(a.region),
            notes: a.notes || "", guestName: a.guestName || "", villa: a.villa || ""
        }));

        alloc = Array.from({ length: peopleDocs.length }, () => [[]]);
        for (const a of assigned) {
            const pid = keyifyObjectId(a.assignedTo && (a.assignedTo._id || a.assignedTo));
            const personIdx = personIdxByOid[pid];
            if (personIdx == null) { L.warn("Unmapped assignedTo:", pid, "title:", a.title); continue; }
            const lane = Number.isInteger(a.lane) ? a.lane : 0;
            while (!alloc[personIdx][lane]) alloc[personIdx].push([]);
            alloc[personIdx][lane].push({
                id: a.id, title: a.title,
                arrival: a.arrival, departure: a.departure,
                category: normalizeRegionName(a.region),
                notes: a.notes || ""
            });
        }
        for (const lanes of alloc) for (const lane of lanes) lane.sort((x, y) => x.arrival - y.arrival);
    } catch (e) {
        L.error("Allocation load failed — empty board:", e);
        pool = [];
        alloc = Array.from({ length: peopleDocs.length }, () => [[]]);
    }

    renderAll();
    applyResponsiveCellWidth();
    syncWidths();
    if (viewMode === 'YEAR') initialYearScroll(); else scrollToToday();
    updateMonthLabelSoon();
    highlightTodayColumn();
}

/* ========= CSS var fallback ========= */
if (!getComputedStyle(document.documentElement).getPropertyValue('--cell').trim()) {
    document.documentElement.style.setProperty('--cell', '30px');
}

/* ========= Add Items Page wiring ========= */
function showAddItemsPage() {
    document.getElementById('app')?.classList.add('hidden');
    document.getElementById('addItemsPage')?.classList.remove('hidden');
    clearSheetRows();
    ensureSheetHasRows(1);
}
function hideAddItemsPage() {
    document.getElementById('addItemsPage')?.classList.add('hidden');
    document.getElementById('app')?.classList.remove('hidden');
}
function wireAddItemsPageEvents() {
    document.getElementById('btnAddShortcut')?.addEventListener('click', showAddItemsPage);
    document.getElementById('backToMain')?.addEventListener('click', hideAddItemsPage);

    const addBtn = document.getElementById('addRows');
    const countInput = document.getElementById('rowCount');
    addBtn?.addEventListener('click', () => {
        const n = Math.max(1, Math.min(500, Number(countInput?.value || 1)));
        ensureSheetHasRows(n);
    });

    const add5 = document.getElementById('add5Rows');
    add5?.addEventListener('click', () => ensureSheetHasRows(5));

    const saveBtn = document.getElementById('saveSheet');
    saveBtn?.addEventListener('click', async () => {
        const errEl = document.getElementById('sheetError');
        if (!saveBtn) return;
        const prev = saveBtn.textContent;
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        try {
            await saveSheetToPool();
            if (!errEl || !errEl.textContent) hideAddItemsPage();
        } catch (e) {
            console.error('[AM-Alloc] Save failed:', e);
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = prev;
        }
    });
}

/* ========= Start ========= */
document.addEventListener('DOMContentLoaded', () => {
    renderDates();
    applyResponsiveCellWidth();
    syncWidths();
    bootFromAtlas().catch(e => {
        L.error("Boot failed. Using empty data.", e);
        renderAll(); applyResponsiveCellWidth(); syncWidths();
        if (viewMode === 'YEAR') initialYearScroll(); else scrollToToday();
        updateMonthLabelSoon();
        highlightTodayColumn();
    });
    wireAddItemsPageEvents();
    wirePoolTabs();

    window.addEventListener('resize', () => {
        applyResponsiveCellWidth(); syncWidths();
        updateMonthLabelSoon();
        highlightTodayColumn();
    });
});
