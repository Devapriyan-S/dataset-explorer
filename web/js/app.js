/*
 * Dataset Explorer — UI controller.
 *
 * The interesting constraint is size. Rendering 200,000 <tr> elements locks the
 * browser for tens of seconds and then scrolls at single-digit frames per
 * second, so the table is virtualised: only the ~40 rows inside the viewport
 * exist in the DOM at any moment, and a spacer element supplies the scrollbar
 * height. Sorting and filtering operate on an index array rather than moving
 * the data, which keeps them allocation-free.
 */

import { parseTable, inferType, columnStats } from "./csv.js";

const ROW_HEIGHT = 30;     // must match --row-h in the stylesheet
const OVERSCAN = 8;        // rows rendered beyond the viewport, to hide scroll tearing

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;   // textContent, never innerHTML
  return n;
};
const fmtInt = (n) => n.toLocaleString("en-US");
const fmtNum = (v, d = 3) => {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e9 || a < 1e-4)) return v.toExponential(2);
  if (a >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return String(Number(v.toFixed(d)));
};

const TYPE_CLASS = {
  integer: "t-num", number: "t-num", date: "t-date",
  boolean: "t-bool", text: "t-text", empty: "t-empty",
};

const state = {
  columns: [],
  rows: [],
  types: [],
  stats: [],
  view: [],          // row indices, after filter + sort
  sortCol: null,
  sortDir: 1,
  filter: "",
  filterCol: -1,     // -1 = all columns
};

/* ── Loading ──────────────────────────────────────────────── */

const dz = $("#dropzone");
const fileInput = $("#file-input");

dz.addEventListener("click", () => fileInput.click());
dz.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
["dragenter", "dragover"].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) =>
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
dz.addEventListener("drop", (e) => e.dataTransfer.files[0] && readFile(e.dataTransfer.files[0]));
fileInput.addEventListener("change", (e) => e.target.files[0] && readFile(e.target.files[0]));

document.querySelectorAll("[data-sample]").forEach((b) =>
  b.addEventListener("click", () => load(makeSample(b.dataset.sample), `${b.dataset.sample}.csv`)));

function readFile(file) {
  const reader = new FileReader();
  reader.onerror = () => showError(`Could not read ${file.name}.`);
  reader.onload = () => load(reader.result, file.name);
  reader.readAsText(file);
}

const showError = (msg) => { $("#error").hidden = false; $("#error").textContent = msg; };

/* Suppresses the smooth-scroll that suits a click and not a page setting
   itself up before anyone has touched it. */
let booting = false;

function load(text, name) {
  $("#error").hidden = true;
  const t0 = performance.now();

  let table;
  try {
    table = parseTable(text);
  } catch (err) {
    showError(`Parse failed: ${err.message}`);
    return;
  }
  if (!table.columns.length) { showError("No columns found in that file."); return; }
  if (!table.rows.length) { showError("The file has a header but no data rows."); return; }

  state.columns = table.columns;
  state.rows = table.rows;
  state.types = table.columns.map((_, i) => inferType(table.rows.map((r) => r[i])));
  state.stats = table.columns.map((_, i) =>
    columnStats(table.rows.map((r) => r[i]), state.types[i]));
  state.sortCol = null;
  state.sortDir = 1;
  state.filter = "";
  $("#filter").value = "";

  const ms = performance.now() - t0;

  renderMeta(name, table.delimiter, ms, text.length);
  renderFilterOptions();
  renderStats();
  buildHeader();
  applyView();

  $("#workspace").hidden = false;
  if (!booting) $("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderMeta(name, delimiter, ms, bytes) {
  const delimName = { ",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe" }[delimiter] ?? delimiter;
  const missing = state.stats.reduce((a, s) => a + s.missing, 0);
  const cells = state.rows.length * state.columns.length;

  const items = [
    [fmtInt(state.rows.length), "Rows"],
    [fmtInt(state.columns.length), "Columns"],
    [fmtInt(cells), "Cells"],
    [fmtInt(missing), "Missing"],
    [`${ms.toFixed(0)} ms`, "Parse time"],
    [`${(bytes / 1024 / 1024).toFixed(2)} MB`, "File size"],
  ];
  $("#meta").replaceChildren(...items.map(([v, l]) => {
    const s = el("div", "stat");
    s.append(el("div", "stat-val", v), el("div", "stat-lab", l));
    return s;
  }));
  $("#file-name").textContent = `${name} · ${delimName}-delimited`;
}

/* ── Column statistics panel ──────────────────────────────── */

function sparkline(values, width = 150, height = 30, bins = 24) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "spark");
  if (!values || values.length < 2) return svg;

  const lo = values[0], hi = values[values.length - 1];
  if (hi === lo) return svg;

  const counts = new Array(bins).fill(0);
  for (const v of values) {
    const idx = Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo)) * bins));
    counts[idx]++;
  }
  const max = Math.max(...counts);
  const bw = width / bins;
  counts.forEach((c, i) => {
    const h = (c / max) * (height - 2);
    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    // 1px gap between bars so adjacent bins stay distinguishable.
    r.setAttribute("x", (i * bw).toFixed(2));
    r.setAttribute("y", (height - h).toFixed(2));
    r.setAttribute("width", Math.max(1, bw - 1).toFixed(2));
    r.setAttribute("height", h.toFixed(2));
    r.setAttribute("rx", "1");
    r.setAttribute("fill", "#1fa8a3");
    svg.append(r);
  });
  return svg;
}

function renderStats() {
  $("#stats").replaceChildren(...state.columns.map((name, i) => {
    const st = state.stats[i];
    const type = state.types[i];
    const card = el("div", `col-card role-${type === "integer" ? "numeric" : type}`);
    card.append(el("div", "col-name", name), el("div", "col-role", type));

    const bits = [`${fmtInt(st.unique)} unique`];
    if (st.missing) bits.push(`${st.missingPct.toFixed(1)}% missing`);
    card.append(el("div", "col-meta", bits.join(" · ")));

    if (type === "number" || type === "integer") {
      card.append(sparkline(st.values));
      card.append(el("div", "col-meta",
        `min ${fmtNum(st.min)} · med ${fmtNum(st.median)} · max ${fmtNum(st.max)}`));
      card.append(el("div", "col-meta", `mean ${fmtNum(st.mean)} ± ${fmtNum(st.sd)}`));
      if (st.outliers) card.append(el("div", "col-warn", `${fmtInt(st.outliers)} outliers (1.5×IQR)`));
    } else if (st.top?.length) {
      const list = el("div", "freq");
      const total = st.count - st.missing;
      st.top.slice(0, 5).forEach(([value, count]) => {
        const row = el("div", "freq-row");
        row.append(el("span", "freq-label", value.length > 22 ? value.slice(0, 21) + "…" : value));
        const track = el("span", "freq-track");
        const bar = el("span", "freq-bar");
        bar.style.width = `${(count / total) * 100}%`;
        track.append(bar);
        row.append(track, el("span", "freq-count", fmtInt(count)));
        list.append(row);
      });
      card.append(list);
    }
    return card;
  }));
}

/* ── Header, sorting, filtering ───────────────────────────── */

function buildHeader() {
  const head = $("#grid-head");
  head.replaceChildren(...state.columns.map((name, i) => {
    const cell = el("div", `gcell ghead ${TYPE_CLASS[state.types[i]]}`);
    cell.append(el("span", "ghead-name", name));
    cell.append(el("span", "ghead-type", state.types[i]));
    const arrow = el("span", "ghead-sort", "");
    cell.append(arrow);
    cell.title = `Sort by ${name}`;
    cell.addEventListener("click", () => {
      if (state.sortCol === i) state.sortDir = -state.sortDir;
      else { state.sortCol = i; state.sortDir = 1; }
      applyView();
    });
    return cell;
  }));
  head.style.gridTemplateColumns = `repeat(${state.columns.length}, minmax(120px, 1fr))`;
  $("#grid-body").style.gridTemplateColumns = head.style.gridTemplateColumns;
}

function renderFilterOptions() {
  const sel = $("#filter-col");
  sel.replaceChildren(el("option", null, "All columns"));
  sel.firstChild.value = "-1";
  state.columns.forEach((name, i) => {
    const o = el("option", null, name);
    o.value = String(i);
    sel.append(o);
  });
  sel.value = "-1";
}

$("#filter").addEventListener("input", (e) => { state.filter = e.target.value; applyView(); });
$("#filter-col").addEventListener("change", (e) => { state.filterCol = Number(e.target.value); applyView(); });

function applyView() {
  const needle = state.filter.trim().toLowerCase();
  const col = state.filterCol;

  let view;
  if (!needle) {
    view = state.rows.map((_, i) => i);
  } else {
    view = [];
    for (let i = 0; i < state.rows.length; i++) {
      const row = state.rows[i];
      if (col >= 0) {
        if (row[col].toLowerCase().includes(needle)) view.push(i);
      } else {
        for (let c = 0; c < row.length; c++) {
          if (row[c].toLowerCase().includes(needle)) { view.push(i); break; }
        }
      }
    }
  }

  if (state.sortCol !== null) {
    const c = state.sortCol;
    const numeric = state.types[c] === "number" || state.types[c] === "integer";
    const dir = state.sortDir;
    view.sort((ia, ib) => {
      const a = state.rows[ia][c], b = state.rows[ib][c];
      // Blanks always sink, regardless of direction — a column of empty cells
      // floating to the top on every sort is pure noise.
      if (a === "" && b === "") return 0;
      if (a === "") return 1;
      if (b === "") return -1;
      if (numeric) return (Number(a) - Number(b)) * dir;
      return a.localeCompare(b, undefined, { numeric: true }) * dir;
    });
  }

  state.view = view;

  document.querySelectorAll(".ghead-sort").forEach((n, i) => {
    n.textContent = state.sortCol === i ? (state.sortDir === 1 ? "▲" : "▼") : "";
  });

  $("#row-count").textContent = needle
    ? `${fmtInt(view.length)} of ${fmtInt(state.rows.length)} rows match`
    : `${fmtInt(view.length)} rows`;

  $("#spacer").style.height = `${view.length * ROW_HEIGHT}px`;
  $("#scroller").scrollTop = 0;
  renderWindow();
}

/* ── Virtual scrolling ────────────────────────────────────── */

const scroller = $("#scroller");
let frameQueued = false;

scroller.addEventListener("scroll", () => {
  // Coalesce scroll events into one render per animation frame; the raw event
  // can fire far more often than the display refreshes.
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => { frameQueued = false; renderWindow(); });
});

function renderWindow() {
  const body = $("#grid-body");
  const total = state.view.length;
  if (!total) {
    body.replaceChildren();
    body.style.transform = "translateY(0)";
    return;
  }

  const viewportRows = Math.ceil(scroller.clientHeight / ROW_HEIGHT);
  const first = Math.max(0, Math.floor(scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(total, first + viewportRows + OVERSCAN * 2);

  const frag = document.createDocumentFragment();
  for (let i = first; i < last; i++) {
    const row = state.rows[state.view[i]];
    for (let c = 0; c < state.columns.length; c++) {
      const value = row[c];
      const cell = el("div", `gcell ${TYPE_CLASS[state.types[c]]}${i % 2 ? " odd" : ""}`);
      if (value === "") {
        cell.classList.add("null");
        cell.textContent = "—";
      } else {
        cell.textContent = value;
        cell.title = value;
      }
      frag.append(cell);
    }
  }
  body.replaceChildren(frag);
  // Offset the rendered block to sit where those rows would actually be.
  body.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
}

window.addEventListener("resize", renderWindow);

/* ── Export the current view ──────────────────────────────── */

$("#export").addEventListener("click", () => {
  const quote = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [state.columns.map(quote).join(",")];
  for (const idx of state.view) lines.push(state.rows[idx].map(quote).join(","));

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "filtered.csv";
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

/* ── Sample data ──────────────────────────────────────────── */

function makeSample(kind) {
  if (kind === "messy") {
    // Every awkward case the parser handles, in one file.
    return [
      'order_id,customer,notes,amount,ordered_at,priority',
      '1001,"Smith, John","Called twice — said ""urgent""",249.99,2024-03-14,true',
      '1002,"Patel, Priya","Multi-line note:\nsecond line here",89.50,2024-03-15,false',
      '1003,"O\'Brien, Sean",,1299.00,2024-03-15,true',
      '1004,"Zhang, Wei","Delivered, signed for",45.25,2024-03-16,false',
      '1005,"Müller, Anna","Refund requested",,2024-03-17,true',
      '1006,"Silva, João","Address: 12 High St, Apt 4",560.00,2024-03-18,false',
    ].join("\n");
  }
  // A large synthetic file, to make the virtual scrolling visible.
  const n = kind === "large" ? 100000 : 5000;
  const cities = ["Chennai", "Mumbai", "Bengaluru", "Delhi", "Kolkata", "Hyderabad", "Pune"];
  const plans = ["free", "pro", "team", "enterprise"];
  const out = ["id,name,city,plan,monthly_spend,sessions,signup_date,active"];
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 1; i <= n; i++) {
    const spend = (rand() * 480 + 5).toFixed(2);
    const d = new Date(2022, 0, 1 + Math.floor(rand() * 1000));
    out.push([
      i,
      `user_${i}`,
      cities[Math.floor(rand() * cities.length)],
      plans[Math.floor(rand() * plans.length)],
      rand() < 0.04 ? "" : spend,                      // some missing values
      Math.floor(rand() * 60),
      d.toISOString().slice(0, 10),
      rand() > 0.3,
    ].join(","));
  }
  return out.join("\n");
}


/* ── Automatic demo on arrival ────────────────────────────── */

/* A visitor should land on a working grid, not an empty upload box. The
   medium sample is used rather than the 100k one: the point of the first
   screen is that the tool works, and 5,000 rows makes that instantly, while
   the 100k button right there proves it scales. */
(function bootstrapDemo() {
  booting = true;
  try {
    load(makeSample("medium"), "sample-customers.csv");

    const host = $("#workspace").querySelector(".step");
    const banner = el("div", "demo-banner");
    banner.append(el("span", "badge badge-privacy", "Live demo"));
    const text = el("span");
    text.textContent =
      "Loaded with 5,000 generated rows so you can start straight away. " +
      "Sort a column, filter, or load the 100,000-row file to watch it stay smooth.";
    banner.append(text, el("span", "spacer"));
    const btn = el("button", null, "Open your own CSV →");
    btn.type = "button";
    btn.addEventListener("click", () => {
      dz.hidden = false;
      dz.classList.add("compact");
      dz.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    banner.append(btn);
    host.insertBefore(banner, host.querySelector(".lead").nextSibling);

    dz.hidden = true;

    dz.classList.add("compact");
    dz.querySelector(".dz-title").textContent = "Drop your own CSV to replace the sample";
    dz.querySelector(".dz-sub").textContent =
      "Comma, semicolon, tab or pipe delimited — detected automatically";
  } catch (err) {
    console.error("demo bootstrap failed", err);
  } finally {
    booting = false;
  }
})();
