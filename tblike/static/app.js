"use strict";

const state = {
  runs: [],                 // [{run_id, display_name, ...}]
  selectedRuns: new Set(),
  tags: {},                 // tag -> {min_step, max_step, runs}
  selectedTags: new Set(),
  runColor: new Map(),
  expanded: new Set(),      // group paths currently expanded in the tag tree
  cards: new Map(),         // tag -> { fetchSig, series, loading } (lazy chart state)
  visible: new Set(),       // tags whose chart is currently in the viewport
  lastFilter: undefined,    // last tag-filter value (to auto-expand matches once)
  loadedTagCounts: new Set(), // num_tags values whose tag set is already loaded
  collapsedGroups: new Set(), // top-level chart groups the user has collapsed
  showSelectedOnly: false,    // tree shows only the snapshot taken when toggled on
  selectedSnapshot: new Set(),// tags shown in "selected" mode (frozen at toggle)
  stepBounds: { min: null, max: null },  // global [min,max] step across loaded tags
  stepRange: { lo: null, hi: null },     // user-chosen window (null = at the edge)
};

const CHART_WARN = 80;      // soft warning threshold for the pending counter

const MAX_CHILDREN = 1200;  // cap rendered children per group (refine via filter)

const PALETTE = [
  "#4c9aff", "#f2545b", "#3dd68c", "#f4b740", "#b07cf0", "#26c6da",
  "#ff8a65", "#9ccc65", "#ec407a", "#7e9cff", "#ffca28", "#66bb6a",
];

function colorFor(runId) {
  if (!state.runColor.has(runId)) {
    state.runColor.set(runId, PALETTE[state.runColor.size % PALETTE.length]);
  }
  return state.runColor.get(runId);
}

const $ = (id) => document.getElementById(id);
const debounce = (fn, ms) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

// ---- instant tooltip (for reading full, truncated tag names) ---------------
const _tip = document.createElement("div");
_tip.id = "tip";
document.body.appendChild(_tip);
function showTip(text, x, y) {
  _tip.textContent = text;
  _tip.style.display = "block";
  const w = _tip.offsetWidth;
  _tip.style.left = Math.min(x + 14, window.innerWidth - w - 8) + "px";
  _tip.style.top = (y + 16) + "px";
}
function hideTip() { _tip.style.display = "none"; }

// ---- busy indicator (top bar + status text) --------------------------------
// The bar only appears if work runs longer than ~800ms (no flashing for fast ops).
let _busy = 0;
let _barTimer = null;
function busy(msg) {
  _busy++;
  if (!_barTimer) _barTimer = setTimeout(() => $("loadbar").classList.remove("hidden"), 800);
  if (msg) $("status").textContent = msg;
}
function idle(msg) {
  _busy = Math.max(0, _busy - 1);
  if (_busy === 0) {
    clearTimeout(_barTimer);
    _barTimer = null;
    $("loadbar").classList.add("hidden");
  }
  if (msg) $("status").textContent = msg;
}

// ---- data loading ----------------------------------------------------------
async function loadRuns() {
  busy("loading runs…");
  try {
    const r = await fetch("api/runs").then((x) => x.json());
    state.runs = r.runs.sort((a, b) => a.display_name.localeCompare(b.display_name));
    renderRunList();
    $("run-count").textContent = `(${state.runs.length})`;
    idle(`${state.runs.length} runs · select runs to begin`);
    loadTags();   // pre-populate the tag tree from the first run
  } catch (e) {
    idle("failed to load runs");
  }
}

// Tags are loaded from the selected runs, or — when nothing is selected — from
// the first run as a baseline so the tree is always browseable. We only refetch
// when a selected run has a tag-set size we haven't already loaded (cheap proxy
// for "different tags"), so flipping between identical runs costs nothing.
async function loadTags(force = false) {
  const sel = [...state.selectedRuns];
  const runs = sel.length ? sel : (state.runs[0] ? [state.runs[0].run_id] : []);
  if (!runs.length) return;
  const numTags = (rid) => state.runs.find((r) => r.run_id === rid)?.num_tags ?? -1;
  const counts = runs.map(numTags);
  const haveTags = Object.keys(state.tags).length > 0;
  if (!force && haveTags && counts.every((c) => state.loadedTagCounts.has(c))) return;

  busy(sel.length ? `loading tags for ${sel.length} run(s)…` : "loading tags…");
  if (!haveTags) $("tag-list").innerHTML = `<div class="placeholder">loading tags…</div>`;
  try {
    const r = await fetch("api/tags?runs=" + encodeURIComponent(runs.join(","))).then((x) => x.json());
    state.tags = r.tags;
    state.loadedTagCounts = new Set(counts);
    recomputeStepBounds();
    renderTagTree();
    idle(`${Object.keys(state.tags).length.toLocaleString()} tags`);
  } catch (e) {
    idle("failed to load tags");
  }
}

let _prevReady = -1;
async function loadStatus() {
  let s;
  try { s = await fetch("api/status").then((x) => x.json()); } catch { return; }
  const p = s.progress || {};
  const processing = !!p.converting || (p.pending || 0) > 0;
  // Persistent background-processing indicator (so runs appearing late is explained).
  if (processing && !_busy) {
    $("status").textContent = p.converting
      ? `⏳ converting ${p.converting} … (${p.done}/${p.total} runs)`
      : `⏳ ${p.pending} run(s) pending conversion…`;
  } else if (!processing && !_busy && !state.selectedTags.size) {
    const w = s.watcher || {};
    $("status").textContent = `${s.num_runs} runs · ${w.at ? "watcher ok" : "watcher starting…"}`;
  }
  // As runs finish converting, surface them in the list automatically.
  if (s.num_runs !== _prevReady) {
    _prevReady = s.num_runs;
    if (state.runs.length !== s.num_runs) loadRuns();
  }
}

// ---- rendering: lists ------------------------------------------------------
function renderRunList() {
  const filter = $("run-filter").value.toLowerCase();
  const list = $("run-list");
  list.innerHTML = "";
  for (const run of state.runs) {
    if (filter && !run.display_name.toLowerCase().includes(filter) &&
        !run.run_id.toLowerCase().includes(filter)) continue;
    const row = document.createElement("label");
    row.className = "item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.selectedRuns.has(run.run_id);
    cb.onchange = () => {
      cb.checked ? state.selectedRuns.add(run.run_id) : state.selectedRuns.delete(run.run_id);
      onRunsChanged();
    };
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = colorFor(run.run_id);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = run.display_name;
    const tip = `${run.display_name}  ·  ${run.num_tags} tags · ${run.num_rows.toLocaleString()} rows · ${run.num_event_files} event files`;
    row.addEventListener("mousemove", (e) => showTip(tip, e.clientX, e.clientY));
    row.addEventListener("mouseleave", hideTip);
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${run.num_tags}t`;
    row.append(cb, sw, name, meta);
    list.appendChild(row);
  }
}

// Build a hierarchical tree from tag names. Hierarchy splits on "/" and ".",
// tracking which separator preceded each token so we can later collapse the
// noisy ".chains" while keeping "/" group boundaries. Every node carries the
// flat list of descendant tags (`tags`) so group select / counts are O(1).
const COLLAPSE_MIN = 4;          // collapse this many digit-only siblings into one group
const isInt = (s) => /^\d+$/.test(s);

function buildTagTree(tagNames) {
  const root = { name: "", path: "", sep: "", children: new Map(), tags: [], tag: null };
  for (const tag of tagNames) {
    const slash = tag.split("/");
    let node = root;
    root.tags.push(tag);
    for (let si = 0; si < slash.length; si++) {
      const dots = slash[si].split(".");
      for (let di = 0; di < dots.length; di++) {
        const part = dots[di];
        const sep = di === 0 ? (si === 0 ? "" : "/") : ".";
        let child = node.children.get(part);
        if (!child) {
          child = { name: part, path: "", sep, children: new Map(), tags: [], tag: null };
          node.children.set(part, child);
        }
        child.tags.push(tag);
        if (si === slash.length - 1 && di === dots.length - 1) child.tag = tag;
        node = child;
      }
    }
  }
  collapseNumeric(root);
  compressChains(root);  // merge single-child ".chains" (model.model.layers, dkv_proj.weight)
  flattenSingles(root);  // never wrap a single tag in a group — show it as one leaf
  assignPaths(root);     // (re)compute stable paths after restructuring
  return root;
}

// A subtree holding exactly one tag is a pointless chain of single-child groups
// (e.g. mtp_norms/ -> 0/ -> weight). Collapse it to one leaf showing the full
// remaining path, joined with the real separators.
function flattenSingles(node) {
  const next = new Map();
  for (let c of node.children.values()) {
    if (c.tags.length === 1 && c.children.size > 0) {
      let name = c.name, cur = c;
      while (cur.children.size > 0) {
        const only = cur.children.values().next().value;
        name += (only.sep || ".") + only.name;
        cur = only;
      }
      c = { name, sep: c.sep, children: new Map(), tags: cur.tags, tag: cur.tag };
    } else {
      flattenSingles(c);
    }
    next.set(c.name, c);
  }
  node.children = next;
}

// Heuristic grouping: among a node's children, those whose names match the same
// digit-masked template (e.g. "weight1__expert_idx_<n>") are folded into one
// synthetic group, so 72 experts show as a single expandable row. Pure-integer
// siblings (e.g. layer indices) are left alone — their parent already groups them.
const template = (name) => name.replace(/\d+/g, "#");
function collapseNumeric(node) {
  for (const c of node.children.values()) collapseNumeric(c);
  const byTpl = new Map();
  for (const [name, child] of node.children) {
    const tpl = template(name);
    if (tpl === name || tpl === "#") continue;     // no digits, or a bare integer
    (byTpl.get(tpl) || byTpl.set(tpl, []).get(tpl)).push([name, child]);
  }
  for (const [tpl, items] of byTpl) {
    if (items.length < COLLAPSE_MIN) continue;
    const synthName = tpl.replace(/#/g, "∗");
    const synth = { name: synthName, path: "", sep: items[0][1].sep,
                    children: new Map(), tags: [], tag: null, synthetic: true };
    for (const [name, child] of items) {
      node.children.delete(name);
      synth.children.set(name, child);
      for (const t of child.tags) synth.tags.push(t);
    }
    node.children.set(synthName, synth);
  }
}

// Collapse single-child chains joined by "." into one node (radix compression),
// e.g. model/model/layers -> "model.model.layers". We never merge across "/"
// boundaries, into a leaf, or through an integer token (so layer indices stay
// their own level).
function compressChains(node) {
  const next = new Map();
  for (let c of node.children.values()) {
    while (c.children.size === 1 && !c.tag) {
      const only = c.children.values().next().value;
      if (isInt(c.name) || isInt(only.name)) break;   // keep integer levels (layer indices)
      c = { name: c.name + only.sep + only.name, sep: c.sep, synthetic: c.synthetic,
            children: only.children, tags: only.tags, tag: only.tag };
    }
    compressChains(c);
    next.set(c.name, c);
  }
  node.children = next;
}

function assignPaths(node) {
  for (const c of node.children.values()) {
    c.path = node.path ? node.path + "/" + c.name : c.name;
    assignPaths(c);
  }
}

function sortedChildren(node) {
  // groups (with children) first, then natural/numeric-aware order
  return [...node.children.values()].sort((a, b) => {
    const ga = a.children.size > 0, gb = b.children.size > 0;
    if (ga !== gb) return ga ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

function groupSelectState(node) {
  let sel = 0;
  for (const t of node.tags) if (state.selectedTags.has(t)) sel++;
  if (sel === 0) return "none";
  return sel === node.tags.length ? "all" : "some";
}

// Filter input is treated as a case-insensitive regex; if it doesn't compile
// (e.g. mid-typing "loss(") we fall back to a plain substring match.
function makeTagMatcher(raw) {
  const input = $("tag-filter");
  if (!raw) { input.classList.remove("bad-re"); return null; }
  try {
    const re = new RegExp(raw, "i");
    input.classList.remove("bad-re");
    return (t) => re.test(t);
  } catch {
    input.classList.add("bad-re");
    const sub = raw.toLowerCase();
    return (t) => t.toLowerCase().includes(sub);
  }
}

function renderTagTree() {
  hideTip();
  const filter = $("tag-filter").value.trim();
  const list = $("tag-list");
  list.innerHTML = "";

  const match = makeTagMatcher(filter);
  let names = Object.keys(state.tags);
  if (match) names = names.filter(match);
  // Selected mode shows the frozen snapshot, so deselecting just greys an item
  // out (it stays put) instead of removing it from the list.
  if (state.showSelectedOnly) names = names.filter((t) => state.selectedSnapshot.has(t));
  const root = buildTagTree(names);

  // When the filter or selected-only mode *changes*, auto-expand the groups
  // leading to the shown tags — but only once, so manual expand/collapse sticks.
  const fkey = filter + " " + (state.showSelectedOnly ? "S" : "");
  if (fkey !== state.lastFilter) {
    state.lastFilter = fkey;
    if (filter || state.showSelectedOnly) {
      const addPaths = (node) => {
        for (const c of node.children.values()) {
          if (c.children.size) { state.expanded.add(c.path); addPaths(c); }
        }
      };
      addPaths(root);
    }
  }

  let rendered = 0;
  const renderChildren = (node, depth) => {
    const kids = sortedChildren(node);
    const limited = kids.slice(0, MAX_CHILDREN);
    for (const child of limited) {
      const isGroup = child.children.size > 0;
      const row = document.createElement("div");
      row.className = "tnode " + (isGroup ? "group" : "leaf-row");
      row.style.paddingLeft = 6 + depth * 14 + "px";

      // instant tooltip with the full tag/group path (names are truncated)
      const full = child.tag || child.path + "/";
      row.addEventListener("mousemove", (e) => showTip(full, e.clientX, e.clientY));
      row.addEventListener("mouseleave", hideTip);

      const caret = document.createElement("span");
      caret.className = "caret" + (isGroup ? "" : " leaf");
      const expanded = state.expanded.has(child.path);
      caret.textContent = isGroup ? (expanded ? "▼" : "▶") : "•";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      if (isGroup) {
        const st = groupSelectState(child);
        cb.checked = st === "all";
        cb.indeterminate = st === "some";
        cb.onchange = () => {
          const turnOn = !(groupSelectState(child) === "all");
          for (const t of child.tags) turnOn ? state.selectedTags.add(t) : state.selectedTags.delete(t);
          renderTagTree(); updatePending(); scheduleGrid();
        };
      } else {
        cb.checked = state.selectedTags.has(child.tag);
        cb.onchange = () => {
          cb.checked ? state.selectedTags.add(child.tag) : state.selectedTags.delete(child.tag);
          updatePending(); scheduleGrid();   // in selected mode the row stays (snapshot), just toggles
        };
      }

      const label = document.createElement("span");
      label.className = "label";
      // trailing separator reflects how this node joins to its children ("/" or ".")
      const childSep = isGroup ? (child.children.values().next().value?.sep || "") : "";
      label.textContent = child.name + childSep;
      label.title = child.tag || child.path;

      row.append(caret, cb, label);
      if (isGroup || child.tags.length > 1) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = child.tags.length;
        row.append(badge);
      }

      // clicking the row (not the checkbox) toggles expand for groups
      if (isGroup) {
        const toggle = (e) => {
          if (e.target === cb) return;
          state.expanded.has(child.path) ? state.expanded.delete(child.path) : state.expanded.add(child.path);
          renderTagTree();
        };
        caret.onclick = toggle;
        label.onclick = toggle;
      }
      list.appendChild(row);
      rendered++;

      if (isGroup && expanded) renderChildren(child, depth + 1);
    }
    if (kids.length > limited.length) {
      const more = document.createElement("div");
      more.className = "tmore";
      more.style.paddingLeft = 6 + (depth + 1) * 14 + "px";
      more.textContent = `+${kids.length - limited.length} more — refine the filter`;
      list.appendChild(more);
    }
  };
  renderChildren(root, 0);

  const total = Object.keys(state.tags).length;
  $("tag-count").textContent = (filter || state.showSelectedOnly)
    ? `(${names.length}/${total})` : `(${total})`;
}

// ---- smoothing (TensorBoard-style EMA with debias) -------------------------
function smoothValues(values, weight) {
  const out = new Array(values.length);
  let last = 0, numAcc = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || !isFinite(v)) { out[i] = v; continue; }
    last = last * weight + (1 - weight) * v;
    numAcc++;
    out[i] = last / (1 - Math.pow(weight, numAcc));
  }
  return out;
}

// ---- pending counter -------------------------------------------------------
function updatePending() {
  const nTags = state.selectedTags.size;
  const nRuns = state.selectedRuns.size;
  const pending = $("pending");
  if (!pending) return;
  if (!nTags || !nRuns) {
    pending.textContent = nRuns === 0 ? "select runs + tags" : "no tags selected";
    pending.classList.remove("warn");
    return;
  }
  pending.textContent =
    `${nTags} chart${nTags > 1 ? "s" : ""} × ${nRuns} run${nRuns > 1 ? "s" : ""} ` +
    `— rendered as you scroll`;
  pending.classList.toggle("warn", nTags > CHART_WARN);
}

// ---- lazy chart grid (render on scroll) ------------------------------------
// Selecting tags just lays out lightweight placeholder cards. Each card fetches
// and draws its own series only when it scrolls into view, so selecting an
// 800-series group costs ~800 cheap divs, not 800 plots.
const chartsEl = () => $("charts");
const optMaxPoints = () => parseInt($("max-points").value, 10) || 1500;
const optXaxis = () => $("xaxis").value;
const optLogy = () => $("logy").checked;
const optSmoothOn = () => $("smooth-on").checked;
const optWeight = () => parseFloat($("smooth").value);
const optOutliers = () => $("outliers-on").checked;
const optQLow = () => parseFloat($("q-low").value);
const optQHigh = () => parseFloat($("q-high").value);

// ---- global step range (limits every chart to a step window, client-side) --
const _human = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a % 1e6 ? 1 : 0) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(a % 1e3 ? 1 : 0) + "k";
  return String(n);
};

// Global step extent across all loaded tags. Snap the user's window to the new
// edges if it was sitting at the old ones, otherwise clamp it inside the bounds.
function recomputeStepBounds() {
  let min = Infinity, max = -Infinity;
  for (const t in state.tags) {
    const m = state.tags[t];
    if (m.min_step != null) min = Math.min(min, m.min_step);
    if (m.max_step != null) max = Math.max(max, m.max_step);
  }
  if (!isFinite(min)) { min = 0; max = 0; }
  const prev = state.stepBounds, r = state.stepRange;
  const atLo = r.lo == null || prev.min == null || r.lo <= prev.min;
  const atHi = r.hi == null || prev.max == null || r.hi >= prev.max;
  state.stepBounds = { min, max };
  r.lo = atLo ? min : Math.max(min, Math.min(r.lo, max));
  r.hi = atHi ? max : Math.max(min, Math.min(r.hi, max));
  syncStepSlider();
}

function syncStepSlider() {
  const { min, max } = state.stepBounds, r = state.stepRange;
  const lo = $("step-lo"), hi = $("step-hi"), val = $("step-range-val");
  const usable = max > min;
  for (const el of [lo, hi]) { el.min = min; el.max = max; el.disabled = !usable; }
  // step granularity ~1000 ticks across the range, but at least 1
  const gran = Math.max(1, Math.floor((max - min) / 1000)) || 1;
  lo.step = hi.step = gran;
  lo.value = r.lo; hi.value = r.hi;
  val.textContent = (!usable || !stepRangeActive())
    ? "all" : `${_human(r.lo)} … ${_human(r.hi)}`;
}

// Active window, or null when it spans the full extent (a no-op we skip).
function stepRangeActive() {
  const b = state.stepBounds, r = state.stepRange;
  if (b.max == null || b.max <= b.min) return null;
  const lo = r.lo ?? b.min, hi = r.hi ?? b.max;
  if (lo <= b.min && hi >= b.max) return null;
  return [lo, hi];
}

// Filter each series' points to the active step window (copy; leaves cache intact).
function stepLimited(series) {
  const win = stepRangeActive();
  if (!win) return series;
  const [lo, hi] = win;
  return series.map((s) => {
    const steps = [], values = [], wall = [];
    for (let i = 0; i < s.steps.length; i++) {
      const st = s.steps[i];
      if (st < lo || st > hi) continue;
      steps.push(st); values.push(s.values[i]); wall.push(s.wall_time[i]);
    }
    return { ...s, steps, values, wall_time: wall };
  });
}

// quantile of an unsorted numeric array (linear interpolation)
function quantileSorted(sorted, q) {
  const n = sorted.length;
  if (!n) return null;
  const pos = q * (n - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// y-range that excludes spikes: [qLow, qHigh] percentile of all plotted values.
function outlierRange(series, logy) {
  const vals = [];
  for (const s of series) for (const v of s.values) if (v != null && isFinite(v) && (!logy || v > 0)) vals.push(v);
  if (vals.length < 5) return null;
  vals.sort((a, b) => a - b);
  let lo = quantileSorted(vals, optQLow()), hi = quantileSorted(vals, optQHigh());
  if (lo == null || hi == null || !(hi > lo)) return null;
  if (logy) return [Math.log10(Math.max(lo, 1e-12)), Math.log10(Math.max(hi, 1e-12))];
  const pad = (hi - lo) * 0.05;
  return [lo - pad, hi + pad];
}

// signature of options that require a *server refetch* (vs. client-only styling)
const fetchSig = () =>
  JSON.stringify([[...state.selectedRuns].sort(), optMaxPoints(), optXaxis()]);

// Candidate cards = those within a wide margin of the viewport. The scheduler
// (below) decides *which* of them to fetch first. `state.visible` here means
// "near the viewport" (the candidate pool), kept small so scoring is cheap.
const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const tag = e.target.dataset.tag;
      if (e.isIntersecting) state.visible.add(tag);
      else state.visible.delete(tag);
    }
    pump();
  },
  { root: null, rootMargin: "1200px 0px", threshold: 0 }
);

// ---- priority fetch scheduler ----------------------------------------------
const MAX_CONCURRENT = 5;   // simultaneous /api/series requests
let inflight = 0;
let scrollDir = 1;          // +1 scrolling down, -1 up
let lastScrollTop = 0;

// Score a candidate: lower = fetched sooner. On-screen cards win; off-screen
// cards are ranked by distance, with the scroll direction discounted 3×.
function score(card) {
  const r = card.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const onScreen = r.bottom > 0 && r.top < vh;
  const d = (r.top + r.height / 2) - vh / 2;
  if (onScreen) return Math.abs(d);
  const ahead = Math.sign(d) === scrollDir;        // card lies in scroll direction
  return 1e6 + Math.abs(d) * (ahead ? 1 : 4);      // off-screen always after on-screen
}

function pickNext() {
  let best = null, bestScore = Infinity;
  const sig = fetchSig();
  for (const tag of state.visible) {
    const cs = state.cards.get(tag);
    if (!cs || cs.loading) continue;
    if (cs.series && cs.fetchSig === sig) continue;  // already fresh
    const card = $("chart-" + cssId(tag));
    if (!card) continue;
    const sc = score(card);
    if (sc < bestScore) { bestScore = sc; best = card; }
  }
  return best;
}

function pump() {
  while (inflight < MAX_CONCURRENT) {
    const card = pickNext();
    if (!card) break;
    inflight++;
    ensureChart(card).finally(() => { inflight--; pump(); });
  }
}

function renderGrid() {
  const charts = chartsEl();
  const panel = ensureDiffPanel();            // the text-diff block is pinned last
  if (panel.parentNode !== charts) charts.appendChild(panel);
  // natural sort so layer indices order numerically (layers.2 before layers.10)
  const tags = [...state.selectedTags].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!state.selectedRuns.size || !tags.length) {
    observer.takeRecords();
    for (const el of [...charts.children]) {
      if (el === panel) continue;
      if (el.dataset && el.dataset.tag) observer.unobserve(el);
      el.remove();
    }
    state.cards.clear();
    state.visible.clear();
    charts.appendChild(panel);
    return;
  }
  $("empty")?.remove();
  const want = new Set(tags);
  for (const el of [...charts.children]) {
    const t = el.dataset && el.dataset.tag;
    if (t && !want.has(t)) { observer.unobserve(el); el.remove(); state.cards.delete(t); state.visible.delete(t); }
  }
  const hadCards = charts.children.length > 0;
  const newCards = [];
  for (const i in tags) {
    const tag = tags[i];
    const id = "chart-" + cssId(tag);
    if (document.getElementById(id)) continue;
    const card = document.createElement("div");
    card.className = "chart pending-card";
    card.id = id;
    card.dataset.tag = tag;
    // Quiet placeholder (no spinner) — the ring only appears if a fetch is slow.
    card.innerHTML =
      `<div class="chart-spinner quiet"><div class="ring"></div><div class="cap">${esc(tag)}</div></div>` +
      `<div class="plot" id="plot-${cssId(tag)}" style="display:none"></div>`;
    // Insert in sorted position so a newly selected tag lands predictably;
    // fall back to the diff panel so cards always precede it.
    let anchor = panel;
    for (let j = +i + 1; j < tags.length; j++) {
      const el = document.getElementById("chart-" + cssId(tags[j]));
      if (el) { anchor = el; break; }
    }
    charts.insertBefore(card, anchor);
    state.cards.set(tag, { fetchSig: null, series: null, loading: false });
    observer.observe(card);
    newCards.push(card);
  }
  syncGroupHeaders();
  charts.appendChild(panel);   // keep the diff panel as the last block
  pump();
  if (hadCards && newCards.length) maybeShowNewPill(newCards);
}

// Full-width collapsible header before each top-level group (the part before
// the first "/"). Click toggles the group; collapsed cards are hidden (and so
// stop loading). Only shown when >1 group is on screen.
function syncGroupHeaders() {
  const charts = chartsEl();
  for (const el of [...charts.querySelectorAll(".group-sep")]) el.remove();
  const cards = [...charts.children].filter((el) => el.dataset && el.dataset.tag);
  const order = [], byGroup = new Map();
  for (const c of cards) {
    const g = c.dataset.tag.split("/")[0];
    if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g); }
    byGroup.get(g).push(c);
  }
  const multi = byGroup.size >= 2;
  for (const g of order) {
    const gcards = byGroup.get(g);
    const collapsed = multi && state.collapsedGroups.has(g);
    if (multi) {
      const hdr = document.createElement("div");
      hdr.className = "group-sep";
      hdr.innerHTML =
        `<span class="gcaret">${collapsed ? "▶" : "▼"}</span>` +
        `<span class="gname">${esc(g)}</span>` +
        `<span class="gline"></span><span class="gcount">${gcards.length}</span>`;
      hdr.onclick = () => toggleGroup(g);
      charts.insertBefore(hdr, gcards[0]);
    }
    for (const c of gcards) c.style.display = collapsed ? "none" : "";
  }
}

function toggleGroup(g) {
  if (state.collapsedGroups.has(g)) state.collapsedGroups.delete(g);
  else state.collapsedGroups.add(g);
  syncGroupHeaders();
  requestAnimationFrame(pump);   // expanding may reveal cards that now need loading
}

// ---- text-diff panel (always the last block in the charts area) ------------
const _textCache = new Map();   // "run|tag|step" -> text
let _diffIndex = {};            // {run_id: {display_name, tags: {tag: [{step, chars}]}}}
const dq = (side, which) => $("diffpanel").querySelector(`.diff-side.${side} .d-${which}`);

function ensureDiffPanel() {
  let panel = $("diffpanel");
  if (panel) return panel;
  const side = (s) =>
    `<div class="diff-side ${s}"><span class="sidetag">${s.toUpperCase()}</span>` +
    `<select class="d-run" title="run"></select><select class="d-tag" title="text tag"></select>` +
    `<select class="d-step" title="step"></select></div>`;
  panel = document.createElement("div");
  panel.id = "diffpanel";
  panel.className = "diffpanel collapsed";
  panel.innerHTML =
    `<div class="diff-head"><span class="dcaret">▶</span><span>Text diff</span>` +
    `<span class="dhint">— compare logged text (e.g. configs) across runs / steps</span></div>` +
    `<div class="diff-body"><div class="diff-selectors">${side("a")}${side("b")}</div>` +
    `<div class="diff-summary"></div>` +
    `<div class="diff-view"><div class="diff-empty">Pick a text on each side to compare.</div></div></div>`;
  panel.querySelector(".diff-head").onclick = () => {
    const collapsed = panel.classList.toggle("collapsed");
    panel.querySelector(".dcaret").textContent = collapsed ? "▶" : "▼";
    if (!collapsed) refreshDiffRuns();
  };
  // Wire against `panel` directly — it isn't in the DOM yet, so $("diffpanel")
  // (used by dq) would be null here and throw, taking renderGrid down with it.
  const q = (s, w) => panel.querySelector(`.diff-side.${s} .d-${w}`);
  for (const s of ["a", "b"]) {
    q(s, "run").onchange = () => populateTags(s);
    q(s, "tag").onchange = () => populateSteps(s);
    q(s, "step").onchange = () => renderDiff();
  }
  return panel;
}

function fillSelect(sel, options, keep) {
  const prev = keep && options.some((o) => o.value === sel.value) ? sel.value
             : (options[0] ? options[0].value : "");
  sel.innerHTML = options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("");
  sel.value = prev;
}

async function refreshDiffRuns() {
  const panel = $("diffpanel");
  if (!panel || panel.classList.contains("collapsed")) return;
  const runs = [...state.selectedRuns];
  const setEmpty = (m) => { panel.querySelector(".diff-view").innerHTML = `<div class="diff-empty">${esc(m)}</div>`; };
  if (!runs.length) { _diffIndex = {}; return setEmpty("Select runs to compare their logged text."); }
  try {
    _diffIndex = (await fetch("api/text-index?runs=" + encodeURIComponent(runs.join(","))).then((x) => x.json())).runs || {};
  } catch { _diffIndex = {}; }
  const runOpts = Object.keys(_diffIndex).map((rid) => ({ value: rid, label: _diffIndex[rid].display_name || rid }));
  if (!runOpts.length) {
    for (const s of ["a", "b"]) { fillSelect(dq(s, "run"), []); fillSelect(dq(s, "tag"), []); fillSelect(dq(s, "step"), []); }
    return setEmpty("No text summaries (e.g. config) found in the selected runs.");
  }
  for (const s of ["a", "b"]) { fillSelect(dq(s, "run"), runOpts, true); populateTags(s, true); }
}

function populateTags(side, keep) {
  const rid = dq(side, "run").value;
  const tags = _diffIndex[rid] ? Object.keys(_diffIndex[rid].tags) : [];
  fillSelect(dq(side, "tag"), tags.map((t) => ({ value: t, label: t })), keep);
  populateSteps(side, keep);
}

function populateSteps(side, keep) {
  const rid = dq(side, "run").value, tag = dq(side, "tag").value;
  const entries = (_diffIndex[rid] && _diffIndex[rid].tags[tag]) || [];
  fillSelect(dq(side, "step"),
    entries.map((e) => ({ value: String(e.step), label: `step ${e.step} (${e.chars} chars)` })), keep);
  renderDiff();
}

async function getText(rid, tag, step) {
  const key = `${rid}|${tag}|${step}`;
  if (_textCache.has(key)) return _textCache.get(key);
  const r = await fetch(`api/text?run=${encodeURIComponent(rid)}&tag=${encodeURIComponent(tag)}&step=${encodeURIComponent(step)}`)
    .then((x) => x.json()).catch(() => ({ text: "" }));
  _textCache.set(key, r.text || "");
  return r.text || "";
}

const diffPick = (side) => ({ run: dq(side, "run").value, tag: dq(side, "tag").value, step: dq(side, "step").value });

async function renderDiff() {
  const panel = $("diffpanel");
  const view = panel.querySelector(".diff-view"), sum = panel.querySelector(".diff-summary");
  const a = diffPick("a"), b = diffPick("b");
  if (!a.run || !a.tag || a.step === "" || !b.run || !b.tag || b.step === "") return;
  view.innerHTML = `<div class="diff-empty">loading…</div>`;
  const [ta, tb] = await Promise.all([getText(a.run, a.tag, a.step), getText(b.run, b.tag, b.step)]);
  const rows = diffLines(ta, tb);
  let add = 0, del = 0;
  const html = rows.map((r) => {
    if (r.t === "+") add++; else if (r.t === "-") del++;
    const cls = r.t === "+" ? "add" : r.t === "-" ? "del" : "same";
    return `<div class="dl ${cls}"><span class="gut">${r.t}</span><span class="txt">${esc(r.line) || " "}</span></div>`;
  }).join("");
  sum.innerHTML = (add || del)
    ? `<span class="add">+${add}</span> / <span class="del">−${del}</span> lines changed`
    : "identical";
  view.innerHTML = html || `<div class="diff-empty">identical</div>`;
}

// Line diff via LCS; returns [{t:' '|'-'|'+', line}].
function diffLines(aText, bText) {
  const A = aText.split("\n"), B = bText.split("\n");
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: " ", line: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: "-", line: A[i] }); i++; }
    else { out.push({ t: "+", line: B[j] }); j++; }
  }
  while (i < n) out.push({ t: "-", line: A[i++] });
  while (j < m) out.push({ t: "+", line: B[j++] });
  return out;
}

async function ensureChart(card) {
  const tag = card.dataset.tag;
  const cs = state.cards.get(tag);
  if (!cs) return;
  const sig = fetchSig();
  if (cs.series && cs.fetchSig === sig) { drawCard(card, cs.series); return; }  // already fresh
  if (cs.loading) return;
  cs.loading = true;
  // Per the sub-second rule: only reveal the spinner ring if the fetch is slow.
  const slowTimer = setTimeout(() => card.classList.add("loading"), 800);
  try {
    const resp = await fetch("api/series", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_ids: [...state.selectedRuns], tags: [tag], max_points: optMaxPoints() }),
    }).then((x) => x.json());
    clearTimeout(slowTimer);
    cs.series = resp.series || [];
    cs.fetchSig = sig;
    drawCard(card, cs.series);
  } catch (e) {
    clearTimeout(slowTimer);
    card.querySelector(".chart-spinner div:last-child")?.replaceChildren(document.createTextNode("failed to load"));
  } finally {
    cs.loading = false;
  }
}

// Distinct markers at each break in a line, so a gap is explained: NaN, +Inf or
// −Inf. Each marker sits at the nearest finite value (the break point), keyed by
// the server-supplied gap list.
// Distinct symbol per break kind; fill is the RUN color (so you can tell which
// run) and a light halo lifts it off the line. Symbols: ✕ NaN, ▲ +Inf, ▼ −Inf.
// These MUST be scattergl (not scatter): Plotly draws the WebGL line layer above
// the SVG layer, so SVG markers would stay buried no matter the order. As gl
// markers appended after the gl lines, trace order puts them on top.
const GAP_STYLE = {
  "nan":  { sym: "x",             label: "NaN",  size: 8 },
  "+inf": { sym: "triangle-up",   label: "+Inf", size: 9 },
  "-inf": { sym: "triangle-down", label: "−Inf", size: 9 },
};
function addGapMarkers(out, s, xaxis, color) {
  const win = stepRangeActive();
  for (const kind of ["nan", "+inf", "-inf"]) {
    const pts = s.gaps.filter((g) =>
      g.kind === kind && (!win || (g.step >= win[0] && g.step <= win[1])));
    if (!pts.length) continue;
    const st = GAP_STYLE[kind];
    const gx = pts.map((g) => xaxis === "wall_time" ? (g.wall_time - s.wall_time[0]) / 60.0 : g.step);
    out.push({
      x: gx, y: pts.map((g) => g.y), type: "scattergl", mode: "markers",
      marker: { symbol: st.sym, size: st.size, color, line: { width: 1.5, color: "#f5f7fa" } },
      name: st.label, showlegend: false, hoverinfo: "text",
      text: pts.map((g) => `${st.label} · ${s.display_name} · step ${g.step}`),
    });
  }
}

function drawCard(card, series) {
  const tag = card.dataset.tag;
  card.classList.remove("loading", "pending-card");
  card.querySelector(".chart-spinner")?.remove();
  const plotDiv = $("plot-" + cssId(tag));
  if (plotDiv) plotDiv.style.display = "";

  const view = stepLimited(series);
  const xaxis = optXaxis(), logy = optLogy(), smoothOn = optSmoothOn(), weight = optWeight();
  const traces = [];
  const gapTraces = [];   // appended last so the markers sit on top of every line
  for (const s of view) {
    const x = xaxis === "wall_time" ? s.wall_time.map((w) => (w - s.wall_time[0]) / 60.0) : s.steps;
    const color = colorFor(s.run_id);
    if (smoothOn) {
      traces.push({ x, y: s.values, type: "scattergl", mode: "lines",
        line: { color, width: 0.7 }, opacity: 0.13, hoverinfo: "skip", showlegend: false, name: s.display_name });
      traces.push({ x, y: smoothValues(s.values, weight), type: "scattergl", mode: "lines",
        line: { color, width: 2.2 }, name: s.display_name, hovertemplate: "%{y:.5g}<extra></extra>" });
    } else {
      traces.push({ x, y: s.values, type: "scattergl", mode: "lines",
        line: { color, width: 1.4 }, name: s.display_name, hovertemplate: "%{y:.5g}<extra></extra>" });
    }
    if (s.gaps && s.gaps.length) addGapMarkers(gapTraces, s, xaxis, color);
  }
  traces.push(...gapTraces);   // markers drawn after (over) all the lines
  // Outlier clip sets an explicit y-range from value percentiles (of the window).
  const clip = optOutliers() ? outlierRange(view, logy) : null;
  const yaxis = { type: logy ? "log" : "linear", gridcolor: "#2a313c", zeroline: false };
  if (clip) { yaxis.range = clip; yaxis.autorange = false; }

  // In step mode, pin the x-axis to the active window so the limit is exact.
  const win = stepRangeActive();
  const xAxisObj = { title: xaxis === "wall_time" ? "min" : "step", gridcolor: "#2a313c", zeroline: false };
  if (win && xaxis === "step") { xAxisObj.range = win; xAxisObj.autorange = false; }

  const layout = {
    title: { text: tag, font: { size: 13 }, x: 0.01 },
    margin: { l: 48, r: 10, t: 28, b: 32 },
    paper_bgcolor: "#161b22", plot_bgcolor: "#161b22",
    font: { color: "#d7dde5", size: 10 },
    xaxis: xAxisObj,
    yaxis,
    showlegend: view.length <= 12,
    legend: { font: { size: 9 }, orientation: "h", y: -0.2 },
    // "x unified" lists every series at the hovered step (overlapping lines included)
    hovermode: "x unified",
    hoverlabel: { namelength: 32, font: { size: 10 }, bgcolor: "#0f1419" },
    // uirevision preserves the user's zoom/pan across re-renders, but is bumped
    // when an axis-defining option changes so new ranges/clip actually apply.
    uirevision: `${xaxis}|${logy}|${optOutliers() ? optQLow() + "-" + optQHigh() : "noclip"}` +
      `|${win ? win[0] + "-" + win[1] : "fullstep"}`,
  };
  Plotly.react("plot-" + cssId(tag), traces, layout, { responsive: true, displaylogo: false });
}

// ---- "scroll to new charts" pill -------------------------------------------
const PILL_MS = 4000;
const _pill = document.createElement("button");
_pill.id = "newpill";
_pill.innerHTML = `<span class="pill-text"></span><div class="pill-timer"></div>`;
document.body.appendChild(_pill);
let _pillTimer = null;
function hideNewPill() { _pill.classList.remove("show"); clearTimeout(_pillTimer); }

// Show only when the first newly-added chart is off-screen; click scrolls to it.
function maybeShowNewPill(newCards) {
  requestAnimationFrame(() => {
    const first = newCards[0];
    if (!first || !first.isConnected) return;
    const r = first.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (r.top >= 0 && r.top < vh) return;   // already visible -> no pill
    const n = newCards.length;
    _pill.querySelector(".pill-text").textContent =
      `${r.top < 0 ? "↑" : "↓"} ${n} new chart${n > 1 ? "s" : ""} — click to view`;
    _pill.onclick = () => { first.scrollIntoView({ behavior: "smooth", block: "start" }); hideNewPill(); };
    // (re)start the shrinking countdown bar so it's clear the pill auto-dismisses
    const bar = _pill.querySelector(".pill-timer");
    bar.style.animation = "none"; void bar.offsetWidth; bar.style.animation = `pillshrink ${PILL_MS}ms linear forwards`;
    _pill.classList.add("show");
    clearTimeout(_pillTimer);
    _pillTimer = setTimeout(hideNewPill, PILL_MS);
  });
}

// ---- refresh selected runs from disk ---------------------------------------
// Tear down every rendered Plotly chart so they rebuild cleanly (also clears any
// glitched Plotly state). Cards drop back to their pending placeholder.
function purgeRenderedCharts() {
  for (const tag of state.cards.keys()) {
    const plotDiv = $("plot-" + cssId(tag));
    if (plotDiv && plotDiv._fullLayout) { try { Plotly.purge(plotDiv); } catch {} }
    if (plotDiv) plotDiv.style.display = "none";
    $("chart-" + cssId(tag))?.classList.add("pending-card");
  }
}

async function refreshSelected() {
  const runs = [...state.selectedRuns];
  if (!runs.length) return;
  const btn = $("refresh-btn");
  btn.disabled = true;
  busy(`refreshing ${runs.length} run(s) from disk…`);
  try {
    const r = await fetch("api/refresh", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_ids: runs }),
    }).then((x) => x.json());
    await loadTags();                                  // tags may have grown
    for (const cs of state.cards.values()) { cs.fetchSig = null; cs.series = null; }  // invalidate cache
    purgeRenderedCharts();                             // force a clean Plotly rebuild
    pump();                                            // refetch + redraw what's on screen
    _textCache.clear(); refreshDiffRuns();             // text summaries may have changed
    loadRuns();                                        // refresh run row stats
    idle(`refreshed ${r.refreshed.length} run(s) · +${(r.new_rows || 0).toLocaleString()} rows`);
  } catch (e) {
    idle("refresh failed");
  } finally {
    btn.disabled = !state.selectedRuns.size;
  }
}

function updateRefreshBtn() { $("refresh-btn").disabled = !state.selectedRuns.size; }

// Redraw the currently-visible charts from cached data (style-only changes).
function redrawVisible() {
  for (const tag of state.visible) {
    const cs = state.cards.get(tag);
    const card = $("chart-" + cssId(tag));
    if (cs && cs.series && card) drawCard(card, cs.series);
  }
}

// Invalidate cached series (refetch-affecting change) and reload via the queue.
function reloadVisible() {
  for (const cs of state.cards.values()) cs.fetchSig = null;
  pump();
}

const scheduleGrid = debounce(renderGrid, 150);

// Track scroll direction so the scheduler prefetches ahead of the user.
function trackScroll(el) {
  const handler = () => {
    const st = el === window ? window.scrollY : el.scrollTop;
    if (st !== lastScrollTop) { scrollDir = st > lastScrollTop ? 1 : -1; lastScrollTop = st; }
    pump();
  };
  el.addEventListener("scroll", handler, { passive: true });
}

function onRunsChanged() {
  loadTags();
  updatePending();
  updateRefreshBtn();
  renderGrid();
  refreshDiffRuns();   // update the text-diff run options (if the panel is open)
  reloadVisible();     // run set changed -> refetch what's on screen
}

// ---- helpers ---------------------------------------------------------------
const cssId = (s) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
const esc = (s) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

// ---- wiring ----------------------------------------------------------------
$("run-filter").oninput = debounce(renderRunList, 100);
$("tag-filter").oninput = debounce(renderTagTree, 100);
$("runs-all").onclick = () => {
  state.runs.forEach((r) => state.selectedRuns.add(r.run_id));
  renderRunList(); onRunsChanged();
};
$("runs-none").onclick = () => {
  state.selectedRuns.clear();
  renderRunList(); onRunsChanged();
};
$("tags-expand").onclick = () => {
  // expand only the top-level groups (cheap; deep expand of 18k tags is huge)
  for (const t of Object.keys(state.tags)) {
    const top = t.split("/")[0];
    if (t.includes("/")) state.expanded.add(top);
  }
  renderTagTree();
};
$("tags-selected").onclick = () => {
  state.showSelectedOnly = !state.showSelectedOnly;
  // Freeze the shown set on entering, so toggling rows doesn't shrink the list.
  if (state.showSelectedOnly) state.selectedSnapshot = new Set(state.selectedTags);
  $("tags-selected").classList.toggle("active", state.showSelectedOnly);
  renderTagTree();
};
$("tags-collapse").onclick = () => { state.expanded.clear(); renderTagTree(); };
$("tags-clear").onclick = () => {
  state.selectedTags.clear();
  renderTagTree(); updatePending(); renderGrid();
};

// Style-only controls redraw from cache (no refetch); these need a server refetch.
function updateQReadout() {
  $("q-low-val").textContent = `${(optQLow() * 100).toFixed(1)}%`;
  $("q-high-val").textContent = `${(optQHigh() * 100).toFixed(1)}%`;
  $("smooth-val").firstElementChild.textContent = optWeight().toFixed(2);
}
const styleDebounced = debounce(() => { updateQReadout(); redrawVisible(); }, 120);
for (const id of ["logy", "smooth-on", "smooth", "outliers-on", "q-low", "q-high"]) {
  $(id).oninput = styleDebounced;
  $(id).onchange = styleDebounced;
}
updateQReadout();

// Global step range — client-side window, so redraw from cache (no refetch).
const stepDebounced = debounce(redrawVisible, 120);
function onStepInput(which) {
  let lo = parseInt($("step-lo").value, 10), hi = parseInt($("step-hi").value, 10);
  if (lo > hi) { if (which === "lo") hi = lo; else lo = hi; }   // keep lo ≤ hi
  state.stepRange.lo = lo; state.stepRange.hi = hi;
  syncStepSlider();
  stepDebounced();
}
$("step-lo").oninput = () => onStepInput("lo");
$("step-hi").oninput = () => onStepInput("hi");
$("step-reset").onclick = () => {
  state.stepRange.lo = state.stepBounds.min;
  state.stepRange.hi = state.stepBounds.max;
  syncStepSlider(); redrawVisible();
};

const refetchDebounced = debounce(reloadVisible, 200);
for (const id of ["max-points", "xaxis"]) {
  $(id).oninput = refetchDebounced;
  $(id).onchange = refetchDebounced;
}

// ---- resizable sidebar (deferred: dashed guide while dragging, apply on drop)
(function initDivider() {
  const divider = $("divider");
  const guide = document.createElement("div");
  guide.id = "drag-guide";
  document.body.appendChild(guide);
  const MIN = 200, MAX = () => Math.min(window.innerWidth - 360, 900);

  let dragging = false, targetX = 0;
  const clampX = (x) => Math.max(MIN, Math.min(MAX(), x));

  divider.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    document.body.classList.add("dragging");
    divider.classList.add("dragging");
    targetX = clampX(e.clientX);
    guide.style.left = targetX + "px";
    guide.style.display = "block";
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    targetX = clampX(e.clientX);     // only move the guide; no resize/redraw yet
    guide.style.left = targetX + "px";
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("dragging");
    divider.classList.remove("dragging");
    guide.style.display = "none";
    document.documentElement.style.setProperty("--sidebar-w", targetX + "px");
    window.dispatchEvent(new Event("resize"));  // single relayout of Plotly charts
  });
})();

$("refresh-btn").onclick = refreshSelected;

trackScroll(chartsEl());
trackScroll(window);
loadRuns();
updatePending();
updateRefreshBtn();
renderGrid();
loadStatus();
setInterval(loadStatus, 3000);
