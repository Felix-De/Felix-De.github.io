const DAY = 24 * 60 * 60 * 1000;
const clampNoon = d => { const x = new Date(d); x.setHours(12, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return clampNoon(x); };
const startOfMonth = d => clampNoon(new Date(d.getFullYear(), d.getMonth(), 1));
const endOfMonth = d => clampNoon(new Date(d.getFullYear(), d.getMonth() + 1, 0));
const daysInclusive = (a, b) => Math.floor((clampNoon(b) - clampNoon(a)) / DAY) + 1;

// ===== Demo data =====
const COUNTRY_COLORS = {
    "GCC & African": "#0f4e0dff", "US & Canada": "#174477ff", "India": "#8d5f22ff", "CIS": "#03b879ff",
    "European Union": "#174477ff", "China": "#f42e2eff", "SEA & Australia": "#86efac", "CALA": "#fb923c", "Other": "#94a3b8"
};
const demoPool = [
    { id: "i1", title: "V200 – Mr Ahmed", arrival: new Date("2025-08-01T12:00:00"), departure: new Date("2025-08-03T12:00:00"), category: "India" },
    { id: "i2", title: "V305 – Ms Hanna", arrival: new Date("2025-08-03T12:00:00"), departure: new Date("2025-08-10T12:00:00"), category: "European Union" },
    { id: "i3", title: "V411 – Fam Zhao", arrival: new Date("2025-08-05T12:00:00"), departure: new Date("2025-08-12T12:00:00"), category: "China" },
    { id: "i4", title: "V122 – Mr Khalid", arrival: new Date("2025-07-27T12:00:00"), departure: new Date("2025-08-02T12:00:00"), category: "GCC & African" },
    { id: "i5", title: "V144 – Rivera", arrival: new Date("2025-08-12T12:00:00"), departure: new Date("2025-08-15T12:00:00"), category: "CIS" },
    { id: "i6", title: "V144 – Rivera", arrival: new Date("2025-08-12T12:00:00"), departure: new Date("2025-08-15T12:00:00"), category: "CIS" },

];
const demoPeople = ["EDDIE", "SHAGHAF", "PAKO", "ARAFATH", "AHMED", "MALIKA", "NOVITA", "MARY", "FORD", "MUNEEF", "SHUHU", "EMMA", "AFFAN", "ICE", "ANGEL", "BUNYOD", "ASLAM"];

// ===== State =====
let viewMode = "YEAR"; // default YEAR
let focusDate = clampNoon(new Date());
let columns = [];
let editMode = false;
let poolCollapsed = false; // rail state

let pool = [...demoPool];
let alloc = demoPeople.map(() => [[]]); // at least one lane per person

// ===== DOM =====
const $ = sel => document.querySelector(sel);
const app = $("#app");
const timeline = $("#timeline-header");
const datesGrid = $("#datesGrid");
const peopleWrap = $("#board");


// ===== Toolbar actions =====
$("#viewSelect").addEventListener('change', (e) => { viewMode = e.target.value; renderDates(); renderPeople(); syncWidths(); scrollToCurrentMonthIfYear(); });
$("#prevMonth").addEventListener('click', () => { focusDate.setMonth(focusDate.getMonth() - 1); renderDates(); renderPeople(); syncWidths(); scrollToCurrentMonthIfYear(); });
$("#nextMonth").addEventListener('click', () => { focusDate.setMonth(focusDate.getMonth() + 1); renderDates(); renderPeople(); syncWidths(); scrollToCurrentMonthIfYear(); });
$("#toggleEdit").addEventListener('click', () => { editMode = !editMode; document.body.classList.toggle('edit-mode', editMode); $("#toggleEdit").textContent = editMode ? 'View' : 'Edit'; $("#footer .footer-text span").textContent = editMode ? 'Edit Mode: Press save to save progress' : 'View Mode'; renderPool(); renderPeople(); });
$("#btnSave").addEventListener('click', () => { editMode = false; document.body.classList.remove('edit-mode'); $("#toggleEdit").textContent = 'Edit'; renderPool(); renderPeople(); });
$("#btnCollapsePool").addEventListener('click', () => { poolCollapsed = !poolCollapsed; $("#app").classList.toggle('drawer-collapsed', poolCollapsed); $("#drawer").classList.toggle('show', poolCollapsed); renderPool(); });



$("#flipSide").addEventListener('click', () => { document.body.classList.toggle('pool-left'); });


// ==== Sync horizontal scroll between header and body
const hHeader = document.getElementById('timeline-header');
const hBody = document.getElementById('board');
let syncing = false;
hHeader.addEventListener('scroll', () => { if (syncing) return; syncing = true; hBody.scrollLeft = hHeader.scrollLeft; syncing = false; });
hBody.addEventListener('scroll', () => { if (syncing) return; syncing = true; hHeader.scrollLeft = hBody.scrollLeft; syncing = false; });

function buildColumns() {
    let start, end; const now = new Date(focusDate);
    if (viewMode === 'YEAR') { start = new Date(now.getFullYear(), 0, 1); end = new Date(now.getFullYear(), 11, 31); }
    else if (viewMode === 'THREE') { start = new Date(now.getFullYear(), now.getMonth() - 1, 1); end = new Date(now.getFullYear(), now.getMonth() + 1, 0); }
    else { start = startOfMonth(now); end = endOfMonth(now); }
    start = clampNoon(start); end = clampNoon(end);
    const days = Math.floor((end - start) / DAY) + 1;
    columns = Array.from({ length: days }, (_, i) => addDays(start, i));
    document.getElementById('monthLabel').textContent = now.toLocaleString(undefined, { month: 'long', year: 'numeric' });
}

function renderDates() {
    buildColumns();
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
    const w = cellEl ? cellEl.getBoundingClientRect().width : 30; // px fallback
    const target = offsetDays * w;
    hHeader.scrollLeft = target; hBody.scrollLeft = target;
}

function overlaps(a, b) {
    const aS = clampNoon(a.arrival).getTime(), aE = clampNoon(a.departure).getTime();
    const bS = clampNoon(b.arrival).getTime(), bE = clampNoon(b.departure).getTime();
    return !(aE <= bS || bE <= aS);
}
function withinView(it) {
    const s = clampNoon(it.arrival).getTime(), e = clampNoon(it.departure).getTime();
    const vs = clampNoon(columns[0]).getTime(), ve = clampNoon(columns[columns.length - 1]).getTime();
    return !(e < vs || s > ve);
}
function colorFor(cat) { return COUNTRY_COLORS[cat] || COUNTRY_COLORS.Other; }


// ===== Safe DOM helpers & scrollers =====
const req = sel => document.querySelector(sel);
const scroller = datesGrid?.parentElement || document.documentElement; // use your real scroller if different


// ===== Guarded month label set (replace your direct call if you prefer) =====
function setMonthLabel(d) {
    const el = document.getElementById('monthLabel');
    if (el) el.textContent = d.toLocaleString(undefined, { month: 'long', year: 'numeric' });
}

// Patch your buildColumns to call setMonthLabel safely
const _buildColumns = buildColumns;
buildColumns = function () {
    _buildColumns();                // runs your existing code
    setMonthLabel(focusDate);       // safe label update
};

// ===== Year scroll helper safety =====
function ensureYearScroll(target) {
    if (!hHeader || !hBody) return;
    hHeader.scrollLeft = target;
    hBody.scrollLeft = target;
}


// place and DnD (gated by editMode)
function placeItem(personIdx, dropDate, item) {
    // Ignore dropDate; place at item's own arrival/departure.
    if (!editMode) return false; // guard
    if (alloc[personIdx].length === 0) alloc[personIdx] = [[]];
    const laneCount = alloc[personIdx].length;
    for (let lane = 0; lane < laneCount; lane++) {
        const laneArr = alloc[personIdx][lane];
        const sorted = laneArr.slice().sort((a, b) => a.arrival - b.arrival);
        if (sorted.some(x => overlaps(item, x))) continue; // try next lane if conflict
        laneArr.push(item);
        pool = pool.filter(p => p.id !== item.id); // remove from pool if it came from there
        renderPool(); renderPeople();
        return true;
    }
    if (alloc[personIdx].length < 10) { alloc[personIdx].push([]); return placeItem(personIdx, dropDate, item); }
    return false;
}

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
        if (el.onDragStartHandler) el.removeEventListener('dragstart', el.onDragStartHandler);
        if (el.onDragEndHandler) el.removeEventListener('dragend', el.onDragEndHandler);
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

function renderPool() {
    const panel = document.getElementById('panelPending');
    panel.innerHTML = '';
    const list = pool.slice().sort((a, b) => a.arrival - b.arrival);

    list.forEach(it => {
        const card = document.createElement('div');             // <— ADD THIS LINE
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


    // populate categories
    const catSel = document.getElementById('addCategory');
    if (catSel) { catSel.innerHTML = Object.keys(COUNTRY_COLORS).map(k => `<option value="${k}">${k}</option>`).join(''); }
}

function withinView(it) {
    if (!columns.length) return true;
    const a = columns[0];
    const b = columns[columns.length - 1];
    return clampNoon(it.departure) >= a && clampNoon(it.arrival) <= b;
}

function renderPeople() {
    peopleWrap.innerHTML = '';
    demoPeople.forEach((name, personIdx) => {
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
                    if (!editMode) return; ev.preventDefault(); let movingItem = null; const from = dragSource; if (dragSource && dragSource.type === 'pool') { movingItem = dragSource.itemRef; } else if (dragSource && dragSource.type === 'placed') { const srcLane = alloc[dragSource.personIdx][dragSource.laneIdx]; const idx = srcLane.indexOf(dragSource.itemRef); if (idx > -1) srcLane.splice(idx, 1); movingItem = dragSource.itemRef; }
                    let ok = false; if (movingItem) ok = placeItem(personIdx, d, movingItem);
                    if (!ok && from && from.type === 'placed') { // revert if move failed
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
                    bar.addEventListener('dblclick', () => { const laneRef = alloc[personIdx][laneIdx]; const i = laneRef.indexOf(it); if (i > -1) laneRef.splice(i, 1); pool.push({ id: it.id, title: it.title, arrival: it.arrival, departure: it.departure, category: it.category }); renderPool(); renderPeople(); });
                }
                lane.appendChild(bar);
            });

            lanesWrap.appendChild(lane);
        });

        person.appendChild(lanesWrap);
        peopleWrap.appendChild(person);
    });
}

function syncWidths() {
    document.querySelectorAll('.lanes').forEach(l => { l.style.width = `calc(${columns.length} * var(--cell))`; });
    // document.querySelectorAll('.person-head').forEach(l => { l.style.width = `calc(${columns.length} * var(--cell))`; });
    datesGrid.style.gridTemplateColumns = `repeat(${columns.length}, var(--cell))`;
    timeline.style.width = `calc(${columns.length} * var(--cell))`;
}

// ===== Add Items Page logic =====
function showAddItemsPage() {
    appGrid.classList.add('hidden');
    addPage.classList.remove('hidden');
    ensureSheetHasRows(5);
}
function hideAddItemsPage() {
    addPage.classList.add('hidden');
    appGrid.classList.remove('hidden');
    setTab('Pending');
    renderPool();
}
$("#backToMain").addEventListener('click', hideAddItemsPage);
$("#add5Rows").addEventListener('click', () => ensureSheetHasRows(5));
$("#saveSheet").addEventListener('click', saveSheetToPool);

function ensureSheetHasRows(n) {
    const sheet = document.getElementById('sheet');
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
function saveSheetToPool() {
    const sheet = document.getElementById('sheet');
    const err = document.getElementById('sheetError');
    err.textContent = '';
    const rows = [];
    // gather by scanning children 5 at a time after header (5 hdr cells)
    const cells = Array.from(sheet.children).slice(5);
    for (let i = 0; i < cells.length; i += 5) {
        const id = cells[i].querySelector('input')?.value.trim();
        const title = cells[i + 1].querySelector('input')?.value.trim();
        const arr = cells[i + 2].querySelector('input')?.value;
        const dep = cells[i + 3].querySelector('input')?.value;
        const cat = cells[i + 4].querySelector('select')?.value;
        if (!id && !title && !arr && !dep) continue; // skip empty row
        if (!id || !title || !arr || !dep) { err.textContent = 'All non-empty rows need ID, Title, Arrival and Departure.'; return; }
        const a = new Date(arr + 'T12:00:00');
        const d = new Date(dep + 'T12:00:00');
        if (isNaN(a) || isNaN(d)) { err.textContent = 'Invalid date in one of the rows.'; return; }
        if (d < a) { err.textContent = 'Departure cannot be before Arrival.'; return; }
        rows.push({ id, title, arrival: a, departure: d, category: cat });
    }
    // check duplicate IDs within sheet and against pool
    const seen = new Set(pool.map(x => x.id));
    for (const r of rows) {
        if (seen.has(r.id)) { err.textContent = `Duplicate ID: ${r.id}`; return; }
        seen.add(r.id);
    }
    pool.push(...rows);
    hideAddItemsPage();
}

function renderAll() { renderDates(); renderPool(); renderPeople(); scrollToCurrentMonthIfYear(); }


// CSS var fallback
if (!getComputedStyle(document.documentElement).getPropertyValue('--cell').trim()) {
    document.documentElement.style.setProperty('--cell', '30px');
}

// first render + width sync
renderAll();
syncWidths();
