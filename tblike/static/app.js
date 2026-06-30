"use strict";

const state = {
  runs: [],                 // [{run_id, display_name, ...}]
  selectedRuns: new Set(),
  tagNames: [],             // sorted union of tag names for the loaded runs
  tagRuns: [],              // run ids those tag names came from (for step bounds)
  selectedTags: new Set(),
  runColor: new Map(),
  expanded: new Set(),      // group paths currently expanded in the tag tree
  expandedSaved: null,      // manual expansion snapshot, restored when filter clears
  filtering: false,         // whether a filter / selected-only is currently active
  cards: new Map(),         // tag -> { fetchSig, series, loading } (lazy chart state)
  visible: new Set(),       // tags near the viewport (wide zone) — drives data prefetch
  onscreen: new Set(),      // tags in/near the viewport (narrow zone) — drives rendering
  live: new Set(),          // tags with a live Plotly (WebGL) plot — capped (see MAX_LIVE_PLOTS)
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
    // A shared selection waiting from the ?sel= URL takes over here (it loads its
    // own tags); otherwise pre-populate the tree from the first run as a baseline.
    if (_pendingSel) { const p = _pendingSel; _pendingSel = null; applySelection(p); }
    else loadTags();
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
  const haveTags = state.tagNames.length > 0;
  if (!force && haveTags && counts.every((c) => state.loadedTagCounts.has(c))) return;

  busy(sel.length ? `loading tags for ${sel.length} run(s)…` : "loading tags…");
  if (!haveTags) $("tag-list").innerHTML = `<div class="placeholder">loading tags…</div>`;
  try {
    const r = await fetch("api/tags?runs=" + encodeURIComponent(runs.join(","))).then((x) => x.json());
    state.tagNames = r.tags;       // server now returns a compact names list
    state.tagRuns = runs;
    _tagsVersion++;   // invalidate the memoized tag tree
    state.loadedTagCounts = new Set(counts);
    recomputeStepBounds();
    renderTagTree();
    idle(`${state.tagNames.length.toLocaleString()} tags`);
  } catch (e) {
    idle("failed to load tags");
  }
}

let _prevReady = -1;
async function loadStatus() {
  let s;
  try { s = await fetch("api/status").then((x) => x.json()); } catch { return; }
  // Show the source folder the server was launched against (copyable). Set once.
  const srcEl = $("srcpath");
  if (srcEl && s.runs_dir && srcEl.dataset.path !== s.runs_dir) {
    srcEl.dataset.path = s.runs_dir;
    srcEl.textContent = "src: " + s.runs_dir;
    srcEl.title = s.runs_dir;
    // Tab title = the source folder's last-level name (not the full path).
    const leaf = s.runs_dir.replace(/[/\\]+$/, "").split(/[/\\]/).pop();
    document.title = leaf ? `tb_like: ${leaf}` : "tb_like";
  }
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

// O(1): reads the cached selected-count maintained by annotateTree + the toggle
// handlers, instead of rescanning every tag in the subtree on each call (that
// rescan, run per visible group on every click, was the per-click stall).
function groupSelectState(node) {
  const sel = node.sel || 0;
  if (sel === 0) return "none";
  return sel === node.tags.length ? "all" : "some";
}

// Annotate the freshly-built tree with parent pointers and a `sel` count (how
// many of a node's tags are currently selected), computed bottom-up in one O(n)
// pass. After this, toggles update `sel` incrementally (O(depth)) so the tree
// never rescans the full tag set again until it's structurally rebuilt.
function annotateTree(node, parent) {
  node.parent = parent;
  // A node may be both a tag and a group ("loss" alongside "loss/total"), so its
  // own tag counts too — matching node.tags, which includes it.
  let s = node.tag != null && state.selectedTags.has(node.tag) ? 1 : 0;
  for (const c of node.children.values()) s += annotateTree(c, node);
  node.sel = s;
  return s;
}

// Push a full-subtree selection (group checkbox) into the cached counts.
function setSubtreeSel(node, on) {
  node.sel = on ? node.tags.length : 0;
  for (const c of node.children.values()) setSubtreeSel(c, on);
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

// Registry of the checkbox rows currently in the DOM, so a selection toggle can
// refresh their checked/indeterminate state IN PLACE — without re-parsing 18k tag
// names or rebuilding thousands of DOM rows (which is what made clicking a group
// checkbox jank violently).
let _treeRows = [];

// A broad regex filter can match (and auto-expand) tens of thousands of tags;
// building every row synchronously freezes the tab. Cap the TOTAL rows produced
// in one render pass — beyond it we stop and show a "refine the filter" note.
const TREE_RENDER_CAP = 3000;
let _renderLeft = 0;          // rows still allowed in the current pass
let _renderTruncated = false; // hit the cap → show the note

function refreshTreeChecks() {
  for (const r of _treeRows) {
    if (r.isGroup) {
      const st = groupSelectState(r.node);
      r.cb.checked = st === "all";
      r.cb.indeterminate = st === "some";
    } else {
      r.cb.checked = state.selectedTags.has(r.tag);
    }
  }
}

// buildTagTree (string splits + several restructuring passes over up to ~18k
// names) is the costly part and depends ONLY on the filtered name set — never on
// selection or expansion. Memoize it and rebuild only when that set changes;
// expand/collapse and selection toggles reuse the cached tree. The key folds in
// everything that alters the name set: filter, selected-only mode, and version
// counters bumped when the tags map or the selected snapshot changes.
let _tagsVersion = 0, _snapVersion = 0;
let _treeCache = { key: null, root: null };
function buildTagTreeCached(names, key) {
  if (_treeCache.key !== key) _treeCache = { key, root: buildTagTree(names) };
  return _treeCache.root;
}

// Rebuild the checkbox registry from the DOM after an incremental expand/collapse
// (cheap — bounded by visible rows; the point is to avoid a full tree re-render).
function rebuildTreeRows() {
  _treeRows = [];
  for (const row of $("tag-list").children) {
    const node = row._node;
    if (!node) continue;   // skip the ".tmore" sentinel
    _treeRows.push({
      row, node, isGroup: node.children.size > 0, tag: node.tag,
      cb: row.querySelector('input[type="checkbox"]'),
    });
  }
}

// Expand/collapse WITHOUT re-rendering the whole tree. Rows are a flat DFS list
// tagged with their depth, so a node's descendants are exactly the contiguous run
// of deeper rows right after it: collapse removes that run; expand builds the
// node's subtree into a fragment and splices it in.
function toggleExpand(node, rowEl) {
  const caret = rowEl.querySelector(".caret");
  const depth = +rowEl.dataset.depth;
  if (state.expanded.has(node.path)) {
    state.expanded.delete(node.path);
    let el = rowEl.nextElementSibling;
    while (el && +el.dataset.depth > depth) { const next = el.nextElementSibling; el.remove(); el = next; }
    caret.textContent = "▶";
  } else {
    state.expanded.add(node.path);
    const frag = document.createDocumentFragment();
    _renderLeft = TREE_RENDER_CAP;
    _renderTruncated = false;
    renderTreeChildren(frag, node, depth + 1);
    if (_renderTruncated) {
      const more = document.createElement("div");
      more.className = "tmore";
      more.style.paddingLeft = 6 + (depth + 1) * 14 + "px";
      more.dataset.depth = depth + 1;
      more.textContent = `showing first ${TREE_RENDER_CAP.toLocaleString()} — refine the filter`;
      frag.appendChild(more);
    }
    rowEl.after(frag);
    caret.textContent = "▼";
  }
  rebuildTreeRows();
}

// Render a node's children (honoring nested expansion) into `container` — the
// live list for a full render, or a fragment for an incremental expand. Each row
// carries its depth + node so expand/collapse can splice subtrees in place.
function renderTreeChildren(container, node, depth) {
  const kids = sortedChildren(node);
  const limited = kids.slice(0, MAX_CHILDREN);
  for (const child of limited) {
    if (_renderLeft <= 0) { _renderTruncated = true; return; }   // global cap reached
    _renderLeft--;
    const isGroup = child.children.size > 0;
    const row = document.createElement("div");
    row.className = "tnode " + (isGroup ? "group" : "leaf-row");
    row.style.paddingLeft = 6 + depth * 14 + "px";
    row.dataset.depth = depth;
    row._node = child;

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
        const delta = (turnOn ? child.tags.length : 0) - (child.sel || 0);
        setSubtreeSel(child, turnOn);
        for (let n = child.parent; n; n = n.parent) n.sel = (n.sel || 0) + delta;
        refreshTreeChecks(); updatePending(); scheduleGrid();
      };
    } else {
      cb.checked = state.selectedTags.has(child.tag);
      cb.onchange = () => {
        const on = cb.checked;
        on ? state.selectedTags.add(child.tag) : state.selectedTags.delete(child.tag);
        const d = on ? 1 : -1;   // bubble the single change up to every ancestor
        for (let n = child; n; n = n.parent) n.sel = (n.sel || 0) + d;
        refreshTreeChecks(); updatePending(); scheduleGrid();
      };
    }

    const label = document.createElement("span");
    label.className = "label";
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

    if (isGroup) {
      const toggle = (e) => { if (e.target === cb) return; toggleExpand(child, row); };
      caret.onclick = toggle;
      label.onclick = toggle;
    }
    container.appendChild(row);
    _treeRows.push({ row, cb, isGroup, node: child, tag: child.tag });

    if (isGroup && expanded) renderTreeChildren(container, child, depth + 1);
  }
  if (kids.length > limited.length) {
    const more = document.createElement("div");
    more.className = "tmore";
    more.style.paddingLeft = 6 + (depth + 1) * 14 + "px";
    more.dataset.depth = depth + 1;   // so collapse removes it with the subtree
    more.textContent = `+${kids.length - limited.length} more — refine the filter`;
    container.appendChild(more);
  }
}

function renderTagTree() {
  hideTip();
  const filter = $("tag-filter").value.trim();
  const list = $("tag-list");
  list.innerHTML = "";
  _treeRows = [];

  const match = makeTagMatcher(filter);
  let names = state.tagNames;
  if (match) names = names.filter(match);
  // Selected mode shows the frozen snapshot, so deselecting just greys an item
  // out (it stays put) instead of removing it from the list.
  if (state.showSelectedOnly) names = names.filter((t) => state.selectedSnapshot.has(t));
  const key = filter + "\x00" + (state.showSelectedOnly ? "S" : "") + "\x00" + _tagsVersion + "\x00" + _snapVersion;
  const root = buildTagTreeCached(names, key);
  annotateTree(root, null);   // refresh parent pointers + cached selected-counts

  // Filtering auto-expands to reveal matches (mutating state.expanded). Snapshot
  // the manual expansion on entering filter mode and restore it on leaving, so
  // clearing the filter doesn't leave the whole tree expanded.
  const filtering = !!filter || state.showSelectedOnly;
  if (filtering && !state.filtering) {
    state.expandedSaved = new Set(state.expanded);
  } else if (!filtering && state.filtering && state.expandedSaved) {
    state.expanded = state.expandedSaved;
    state.expandedSaved = null;
  }
  state.filtering = filtering;

  // When the filter or selected-only mode *changes*, auto-expand the groups
  // leading to the shown tags — but only once, so manual expand/collapse sticks.
  const fkey = filter + " " + (state.showSelectedOnly ? "S" : "");
  if (fkey !== state.lastFilter) {
    state.lastFilter = fkey;
    if (filtering) {
      const addPaths = (node) => {
        for (const c of node.children.values()) {
          if (c.children.size) { state.expanded.add(c.path); addPaths(c); }
        }
      };
      addPaths(root);
    }
  }

  _renderLeft = TREE_RENDER_CAP;
  _renderTruncated = false;
  renderTreeChildren(list, root, 0);
  if (_renderTruncated) {
    const more = document.createElement("div");
    more.className = "tmore";
    more.style.paddingLeft = "20px";
    more.textContent = `showing first ${TREE_RENDER_CAP.toLocaleString()} — refine the filter`;
    list.appendChild(more);
  }

  const total = state.tagNames.length;
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

// Global step extent for the loaded runs. Read from each run's meta (O(runs))
// rather than scanning every tag, so 250k tags cost nothing here. Snap the user's
// window to the new edges if it was sitting at the old ones, else clamp inside.
function recomputeStepBounds() {
  let min = Infinity, max = -Infinity;
  for (const rid of state.tagRuns) {
    const run = state.runs.find((x) => x.run_id === rid);
    if (!run) continue;
    if (run.step_min != null) min = Math.min(min, run.step_min);
    if (run.step_max != null) max = Math.max(max, run.step_max);
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

// Two zones, because rendering a chart is far costlier than fetching its data.
// The WIDE zone (state.visible) prefetches series over the network so data is
// ready well ahead of scroll — dozens of charts stay cached and redraw
// instantly. The NARROW zone (state.onscreen) decides which charts actually get
// drawn.
//
// Hybrid SVG/WebGL: data is downsampled server-side (≤max_points), so most
// charts render fine as SVG `scatter` — which holds NO WebGL context and so can
// never produce the "broken image" tiles that come from context exhaustion. We
// only escalate a card to `scattergl` when it carries enough points that SVG
// would actually drag (GL_POINT_THRESHOLD).
//
// Two distinct caps:
//  • MAX_RENDERED  — total charts drawn at once (SVG + GL). The cheap SVG default
//    lets this run high, so lots of plots stay live and redraw-free as you scroll.
//  • MAX_LIVE_PLOTS — of those, how many may be WebGL. Browsers hard-cap WebGL
//    contexts at ~16 (Chrome); 64 of *those* is physically impossible and would
//    bring back the broken tiles, so GL stays rationed to the browser-safe count.
const GL_POINT_THRESHOLD = 6000;   // total plotted points above which a card uses WebGL
const MAX_RENDERED = 64;           // total live charts (mostly cheap SVG)

// Live WebGL-context budget, scaled to the machine. Weak/integrated GPUs choke
// well before Chrome's ~16 ceiling, so modest devices get fewer. Computed once.
const MAX_LIVE_PLOTS = (() => {
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;          // GB, coarse & privacy-rounded
  if (cores <= 4 || mem <= 4) return 6;
  if (cores <= 8 || mem <= 8) return 10;
  return 16;
})();

// A card needs WebGL only if it plots enough points that SVG would lag. Smoothing
// draws a second (raw) line, so the visible point count roughly doubles.
function seriesPointTotal(series, smoothOn) {
  let n = 0;
  for (const s of series) n += s.values.length;
  return smoothOn ? n * 2 : n;
}

const observer = new IntersectionObserver(   // wide: prefetch data (cheap, no WebGL)
  (entries) => {
    for (const e of entries) {
      const tag = e.target.dataset.tag;
      if (e.isIntersecting) state.visible.add(tag); else state.visible.delete(tag);
    }
    pump();
  },
  { root: null, rootMargin: "6500px 0px", threshold: 0 }   // prefetch data well ahead of the render zone
);

const renderObserver = new IntersectionObserver(   // narrow: render/purge plots
  (entries) => {
    for (const e of entries) {
      const tag = e.target.dataset.tag;
      if (e.isIntersecting) state.onscreen.add(tag); else state.onscreen.delete(tag);
    }
    renderOnscreen();
  },
  { root: null, rootMargin: "4500px 0px", threshold: 0 }   // ~enough rows to fill MAX_RENDERED
);

// ---- priority fetch scheduler ----------------------------------------------
const MAX_CONCURRENT = 5;   // simultaneous /api/series requests
let inflight = 0;
let scrollDir = 1;          // +1 scrolling down, -1 up
let lastScrollTop = 0;
let lastScrollT = 0;        // timestamp of the last scroll sample (perf.now)

// While the user is flinging through the list (think 11k charts), drawing every
// card they blow past is wasted work that just stalls the main thread. Above this
// speed we skip rendering entirely and let the data prefetch coast; a short
// "settle" timer fires renderOnscreen once the scroll slows or stops.
const FAST_SCROLL_PX_PER_MS = 2.2;   // ~ a fast flick
let fastScrolling = false;
const onScrollSettle = debounce(() => {
  fastScrolling = false;
  pump(); renderOnscreen(); updateGroupFab();
}, 130);

// Score a candidate: lower = nearer the viewport. On-screen cards win; off-screen
// cards are ranked by distance, with the scroll direction discounted 4×.
function score(card) {
  const r = card.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const onScreen = r.bottom > 0 && r.top < vh;
  const d = (r.top + r.height / 2) - vh / 2;
  if (onScreen) return Math.abs(d);
  const ahead = Math.sign(d) === scrollDir;        // card lies in scroll direction
  return 1e6 + Math.abs(d) * (ahead ? 1 : 4);      // off-screen always after on-screen
}
const scoreTag = (tag) => { const c = $("chart-" + cssId(tag)); return c ? score(c) : Infinity; };

// pickNext / pump fetch DATA only (no WebGL): the next visible card lacking fresh series.
function pickNext() {
  let best = null, bestScore = Infinity;
  const sig = fetchSig();
  for (const tag of state.visible) {
    const cs = state.cards.get(tag);
    if (!cs || cs.loading) continue;
    if (cs.series && cs.fetchSig === sig) continue;  // data already fresh
    const card = $("chart-" + cssId(tag));
    if (!card) continue;
    const sc = score(card);
    if (sc < bestScore) { bestScore = sc; best = card; }
  }
  return best;
}

function evictPlot(tag) {
  const cs = state.cards.get(tag);
  const plotDiv = $("plot-" + cssId(tag));
  if (plotDiv && plotDiv._fullLayout) { try { Plotly.purge(plotDiv); } catch {} }  // release the WebGL context
  if (plotDiv) plotDiv.style.display = "none";
  const card = $("chart-" + cssId(tag));
  if (card) {
    card.classList.remove("loading");
    card.classList.add("pending-card");
    card.querySelector(".chart-title")?.remove();   // placeholder shows the cap instead
    if (!card.querySelector(".chart-spinner")) {   // restore the quiet placeholder
      const ph = document.createElement("div");
      ph.className = "chart-spinner quiet";
      ph.innerHTML = `<div class="ring"></div><div class="cap">${esc(tag)}</div>`;
      card.insertBefore(ph, plotDiv || null);
    }
  }
  if (cs) cs.drawn = false;
  state.live.delete(tag);
}

// Single authority over which charts are live: render the closest on-screen
// cards that have fresh data, purge everything else. Idempotent — safe to call
// on any scroll/observer/fetch event without thrashing. SVG cards draw with no
// limit (no WebGL context); only WebGL cards are rationed to MAX_LIVE_PLOTS.
function renderOnscreen() {
  if (fastScrolling) return;   // mid-fling: defer all drawing until scroll settles
  const sig = fetchSig();
  const renderable = [...state.onscreen].filter((t) => {
    const cs = state.cards.get(t);
    return cs && cs.series && cs.fetchSig === sig;
  });
  renderable.sort((a, b) => scoreTag(a) - scoreTag(b));   // closest first
  const keep = new Set();
  let glBudget = MAX_LIVE_PLOTS;
  const smoothOn = optSmoothOn();
  for (const t of renderable) {
    if (keep.size >= MAX_RENDERED) break;                          // total live cap
    const cs = state.cards.get(t);
    cs.glWanted = seriesPointTotal(cs.series, smoothOn) > GL_POINT_THRESHOLD;
    if (cs.glWanted && glBudget <= 0) continue;                    // GL exhausted — skip this one
    if (cs.glWanted) glBudget--;                                   // ration WebGL only
    keep.add(t);
  }
  for (const t of [...state.live]) if (!keep.has(t)) evictPlot(t);   // purge the rest
  // Draw at most a few per frame so filling a large render zone (up to 64 cards)
  // from cache never stalls the main thread — the rest finish on the next frame.
  let drawn = 0;
  for (const t of keep) {
    const cs = state.cards.get(t), card = $("chart-" + cssId(t));
    if (card && !(cs.drawn && cs.fetchSig === sig)) {
      drawCard(card, cs.series);
      if (++drawn >= 12) { requestAnimationFrame(renderOnscreen); break; }
    }
  }
}

function pump() {
  while (inflight < MAX_CONCURRENT) {
    const card = pickNext();
    if (!card) break;
    inflight++;
    fetchCard(card).finally(() => { inflight--; pump(); });
  }
}

// Selecting a many-thousand-tag group used to build every placeholder card (and
// hunt its sorted insert position) in one synchronous burst — a long main-thread
// stall right after the click. Now the build is time-sliced: the first screenful
// of cards lands immediately, then the rest fill in over later frames. A token
// cancels an in-flight build when a newer selection supersedes it.
let _gridToken = 0;
// The pinned side panels (overlay + text-diff), always kept last in the charts
// area, in this order.
function panelEls() { return [ensureOverlayPanel(), ensureDiffPanel()]; }
function pinPanels(charts) { for (const p of panelEls()) charts.appendChild(p); }

function renderGrid() {
  const charts = chartsEl();
  const panels = panelEls();                  // overlay + text-diff, pinned last
  for (const p of panels) if (p.parentNode !== charts) charts.appendChild(p);
  // natural sort so layer indices order numerically (layers.2 before layers.10)
  const tags = [...state.selectedTags].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const token = ++_gridToken;                 // any older progressive build now bails

  if (!state.selectedRuns.size || !tags.length) {
    observer.takeRecords();
    for (const el of [...charts.children]) {
      if (panels.includes(el)) continue;
      if (el.dataset && el.dataset.tag) {
        observer.unobserve(el); renderObserver.unobserve(el);
        const pd = document.getElementById("plot-" + cssId(el.dataset.tag));
        if (pd && pd._fullLayout) { try { Plotly.purge(pd); } catch {} }
      }
      el.remove();
    }
    state.cards.clear();
    state.visible.clear();
    state.onscreen.clear();
    state.live.clear();
    pinPanels(charts);
    return;
  }
  $("empty")?.remove();
  const hadCards = state.cards.size > 0;
  const want = new Set(tags);

  // Remove no-longer-wanted cards via a set diff over known tags (no DOM scan).
  for (const t of [...state.cards.keys()]) {
    if (want.has(t)) continue;
    const el = $("chart-" + cssId(t));
    if (el) {
      observer.unobserve(el); renderObserver.unobserve(el);
      const pd = $("plot-" + cssId(t));
      if (pd && pd._fullLayout) { try { Plotly.purge(pd); } catch {} }  // free the WebGL context
      el.remove();
    }
    state.cards.delete(t); state.visible.delete(t); state.onscreen.delete(t); state.live.delete(t);
  }
  // Drop group headers up front; rebuilt once the ordered pass finishes, so the
  // positioning below need only reason about card elements (+ the pinned panel).
  for (const el of [...charts.querySelectorAll(".group-sep")]) el.remove();

  // Single ordered pass, time-sliced (~8ms/frame): create any missing card and
  // place each one right after its predecessor. Existing cards already in place
  // are skipped, so an incremental single-tag add is near free.
  const newCards = [];
  const FRAME_MS = 8;
  let i = 0, prevEl = null;
  const build = () => {
    if (token !== _gridToken) return;         // superseded by a newer selection
    const start = performance.now();
    while (i < tags.length && (i === 0 || performance.now() - start < FRAME_MS)) {
      const tag = tags[i++];
      let card = $("chart-" + cssId(tag));
      if (!card) {
        card = document.createElement("div");
        card.className = "chart pending-card";
        card.id = "chart-" + cssId(tag);
        card.dataset.tag = tag;
        // Quiet placeholder (no spinner) — the ring only appears if a fetch is slow.
        card.innerHTML =
          `<div class="chart-spinner quiet"><div class="ring"></div><div class="cap">${esc(tag)}</div></div>` +
          `<div class="plot" id="plot-${cssId(tag)}" style="display:none"></div>`;
        state.cards.set(tag, { fetchSig: null, series: null, loading: false, drawn: false });
        observer.observe(card);
        renderObserver.observe(card);
        newCards.push(card);
      }
      const ref = prevEl ? prevEl.nextSibling : charts.firstChild;
      if (ref !== card) charts.insertBefore(card, ref);   // skip if already positioned
      prevEl = card;
    }
    if (i < tags.length) { requestAnimationFrame(build); return; }
    // Build complete for this token.
    pinPanels(charts);   // keep the side panels as the last blocks
    syncGroupHeaders();
    pump();              // fetch data for the wide zone
    renderOnscreen();    // draw any already-cached cards now on-screen
    if (hadCards && newCards.length) maybeShowNewPill(newCards);
  };
  build();               // first chunk runs synchronously → first screen is instant
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
  charts.classList.toggle("has-groups", multi);   // enables the per-card collapse button
  for (const g of order) {
    const gcards = byGroup.get(g);
    const collapsed = multi && state.collapsedGroups.has(g);
    if (multi) {
      const hdr = document.createElement("div");
      hdr.className = "group-sep";
      hdr.dataset.group = g;
      hdr.innerHTML =
        `<span class="gcaret">${collapsed ? "▶" : "▼"}</span>` +
        `<span class="gname">${esc(g)}</span>` +
        `<span class="gline"></span><span class="gcount">${gcards.length}</span>`;
      hdr.onclick = () => toggleGroup(g);
      charts.insertBefore(hdr, gcards[0]);
    }
    for (const c of gcards) c.style.display = collapsed ? "none" : "";
  }
  updateGroupFab();
}

function toggleGroup(g) {
  if (state.collapsedGroups.has(g)) state.collapsedGroups.delete(g);
  else state.collapsedGroups.add(g);
  syncGroupHeaders();
  requestAnimationFrame(() => { pump(); renderOnscreen(); });   // reveal/draw newly shown cards
}

// ---- graph overlay panel (two tags, independent y-scales) ------------------
// Plots tag A on the left y-axis and tag B on the right, both across the selected
// runs, so you can eyeball e.g. learning_rate against max_vio without forcing a
// shared scale. Color tracks the run; line style tracks the tag (A solid / B
// dashed) so the two are distinguishable where they cross.
let _ovA = null, _ovB = null;          // the two tag comboboxes
let _ovToken = 0;                      // cancels a superseded async render
const _ovCache = new Map();            // "fetchSig|tag" -> series

// Lightweight filterable combobox over state.tagNames (up to 250k names, so a
// plain <select>/<datalist> is out — we filter to the first matches as you type).
function makeTagCombo(onPick) {
  const wrap = document.createElement("div");
  wrap.className = "ov-combo";
  const input = document.createElement("input");
  input.type = "search";
  input.className = "ov-input";
  input.placeholder = "filter tag…";
  const menu = document.createElement("div");
  menu.className = "ov-menu";
  menu.style.display = "none";
  wrap.append(input, menu);
  let value = "";
  const render = () => {
    const q = input.value.trim().toLowerCase();
    let names = state.tagNames;
    if (q) names = names.filter((t) => t.toLowerCase().includes(q));
    const shown = names.slice(0, 50);
    menu.innerHTML = shown.map((t) => `<div class="ov-opt" data-tag="${esc(t)}">${esc(t)}</div>`).join("") +
      (names.length > shown.length ? `<div class="ov-more">+${names.length - shown.length} more — refine</div>` : "") +
      (shown.length ? "" : `<div class="ov-more">no match</div>`);
    menu.style.display = "block";
  };
  input.addEventListener("focus", render);
  input.addEventListener("input", render);
  input.addEventListener("blur", () => setTimeout(() => { menu.style.display = "none"; }, 150));
  menu.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".ov-opt");
    if (!opt) return;
    value = opt.dataset.tag;
    input.value = value;
    menu.style.display = "none";
    onPick(value);
  });
  return { wrap, get: () => value, set: (v) => { value = v || ""; input.value = value; } };
}

function ensureOverlayPanel() {
  let panel = $("overlaypanel");
  if (panel) return panel;
  panel = document.createElement("div");
  panel.id = "overlaypanel";
  panel.className = "diffpanel ovpanel collapsed";   // reuse the diff-panel chrome
  panel.innerHTML =
    `<div class="diff-head"><span class="dcaret">▶</span><span>Graph overlay</span>` +
    `<span class="dhint">— two tags on one x-axis with independent y-scales (left = A, right = B), across selected runs</span></div>` +
    `<div class="diff-body">` +
      `<div class="ov-selectors">` +
        `<div class="ov-side a"><span class="sidetag">A · left</span></div>` +
        `<div class="ov-side b"><span class="sidetag">B · right</span></div>` +
      `</div>` +
      `<div class="ov-legend"></div>` +
      `<div class="ov-plot" id="overlayplot" style="display:none"></div>` +
      `<div class="ov-empty">Pick tag A and tag B to overlay.</div>` +
    `</div>`;
  _ovA = makeTagCombo(() => renderOverlay());
  _ovB = makeTagCombo(() => renderOverlay());
  panel.querySelector(".ov-side.a").appendChild(_ovA.wrap);
  panel.querySelector(".ov-side.b").appendChild(_ovB.wrap);
  panel.querySelector(".diff-head").onclick = () => {
    const collapsed = panel.classList.toggle("collapsed");
    panel.querySelector(".dcaret").textContent = collapsed ? "▶" : "▼";
    if (!collapsed) renderOverlay();
  };
  return panel;
}

async function ovSeries(tag) {
  const key = fetchSig() + "|" + tag;
  if (_ovCache.has(key)) return _ovCache.get(key);
  const resp = await fetch("api/series", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ run_ids: [...state.selectedRuns], tags: [tag], max_points: optMaxPoints() }),
  }).then((x) => x.json()).catch(() => ({ series: [] }));
  const series = resp.series || [];
  _ovCache.set(key, series);
  return series;
}

async function renderOverlay() {
  const panel = $("overlaypanel");
  if (!panel || panel.classList.contains("collapsed")) return;
  const empty = panel.querySelector(".ov-empty");
  const legend = panel.querySelector(".ov-legend");
  const plotEl = $("overlayplot");
  const tagA = _ovA.get(), tagB = _ovB.get();
  const setEmpty = (m) => {
    empty.textContent = m; empty.style.display = "block"; legend.innerHTML = "";
    plotEl.style.display = "none";
    if (plotEl._fullLayout) { try { Plotly.purge(plotEl); } catch {} }
  };
  if (!state.selectedRuns.size) return setEmpty("Select runs to overlay.");
  if (!tagA || !tagB) return setEmpty("Pick tag A and tag B to overlay.");

  const token = ++_ovToken;
  empty.style.display = "none";
  const [sa, sb] = await Promise.all([ovSeries(tagA), ovSeries(tagB)]);
  if (token !== _ovToken) return;                       // a newer render superseded us
  if (!sa.length && !sb.length) return setEmpty("No data for these tags in the selected runs.");

  const xaxis = optXaxis(), logy = optLogy(), smoothOn = optSmoothOn(), weight = optWeight();
  const ttype = seriesPointTotal([...sa, ...sb], smoothOn) > GL_POINT_THRESHOLD ? "scattergl" : "scatter";
  const traces = [];
  // Same treatment as the chart cards: optional faint raw underlay + smoothed line.
  const addSide = (series, yaxis, dash, label) => {
    const view = stepLimited(series);
    for (const s of view) {
      const x = xaxis === "wall_time" ? s.wall_time.map((w) => (w - s.wall_time[0]) / 60.0) : s.steps;
      const color = colorFor(s.run_id);
      const nm = `${s.display_name} · ${label}`;
      if (smoothOn) {
        traces.push({ x, y: s.values, type: ttype, mode: "lines", yaxis,
          line: { color, width: 0.7, dash }, opacity: 0.13, hoverinfo: "skip", showlegend: false, name: nm });
        traces.push({ x, y: smoothValues(s.values, weight), type: ttype, mode: "lines", yaxis,
          line: { color, width: 1.5, dash }, name: nm, hovertemplate: "%{y:.5g}<extra></extra>" });
      } else {
        traces.push({ x, y: s.values, type: ttype, mode: "lines", yaxis,
          line: { color, width: 1.5, dash }, name: nm, hovertemplate: "%{y:.5g}<extra></extra>" });
      }
    }
    return view;
  };
  const viewA = addSide(sa, "y", "solid", "A");
  const viewB = addSide(sb, "y2", "dot", "B");

  // Outlier clipping is per-axis (each tag has its own scale).
  const clipA = optOutliers() ? outlierRange(viewA, logy) : null;
  const clipB = optOutliers() ? outlierRange(viewB, logy) : null;
  const yA = { title: { text: tagA, font: { size: 10 } }, type: logy ? "log" : "linear", gridcolor: "#2a313c", zeroline: false };
  if (clipA) { yA.range = clipA; yA.autorange = false; }
  const yB = { title: { text: tagB, font: { size: 10 } }, type: logy ? "log" : "linear", overlaying: "y", side: "right", showgrid: false, zeroline: false };
  if (clipB) { yB.range = clipB; yB.autorange = false; }

  const win = stepRangeActive();
  const xAxisObj = { title: xaxis === "wall_time" ? "min" : "step", gridcolor: "#2a313c", zeroline: false };
  if (win && xaxis === "step") { xAxisObj.range = win; xAxisObj.autorange = false; }
  const layout = {
    margin: { l: 58, r: 58, t: 8, b: 36 },
    paper_bgcolor: "#161b22", plot_bgcolor: "#161b22", font: { color: "#d7dde5", size: 10 },
    xaxis: xAxisObj,
    yaxis: yA,
    yaxis2: yB,
    showlegend: false,
    hovermode: "x unified",
    hoverlabel: { namelength: 40, font: { size: 10 }, bgcolor: "#0f1419" },
  };
  plotEl.style.display = "";
  Plotly.react("overlayplot", traces, layout, { responsive: true, displaylogo: false });
  // Legend: line-style → tag, then a color → run key (the colors aren't otherwise
  // labelled here, unlike the chart cards which carry a Plotly legend).
  const runMap = new Map();
  for (const s of [...sa, ...sb]) if (!runMap.has(s.run_id)) runMap.set(s.run_id, s.display_name);
  const runKeys = [...runMap].map(([rid, name]) =>
    `<span class="ov-key" title="${esc(name)}"><span class="ov-dot" style="background:${colorFor(rid)}"></span>` +
    `<span class="ov-runname">${esc(name)}</span></span>`).join("");
  legend.innerHTML =
    `<span class="ov-key"><span class="ov-swatch solid"></span>A · ${esc(tagA)} <em>(left)</em></span>` +
    `<span class="ov-key"><span class="ov-swatch dashed"></span>B · ${esc(tagB)} <em>(right)</em></span>` +
    `<span class="ov-sep"></span>` + runKeys;
}

// ---- text-diff panel (always the last block in the charts area) ------------
const _textCache = new Map();   // "run|tag|i" -> text
let _diffIndex = {};            // {run_id: {display_name, tags: {tag: [{i, step, wall_time, chars}]}}}
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
  // Several entries can share a step (distinct texts at the same step), so the
  // option *value* is the entry id; the label disambiguates duplicate steps.
  const counts = {};
  for (const e of entries) counts[e.step] = (counts[e.step] || 0) + 1;
  const seen = {};
  const opts = entries.map((e) => {
    let label = `step ${e.step} (${e.chars} chars)`;
    if (counts[e.step] > 1) { seen[e.step] = (seen[e.step] || 0) + 1; label = `step ${e.step} #${seen[e.step]} (${e.chars} chars)`; }
    return { value: String(e.i), label };
  });
  fillSelect(dq(side, "step"), opts, keep);
  renderDiff();
}

async function getText(rid, tag, i) {
  const key = `${rid}|${tag}|${i}`;
  if (_textCache.has(key)) return _textCache.get(key);
  const r = await fetch(`api/text?run=${encodeURIComponent(rid)}&tag=${encodeURIComponent(tag)}&i=${encodeURIComponent(i)}`)
    .then((x) => x.json()).catch(() => ({ text: "" }));
  _textCache.set(key, r.text || "");
  return r.text || "";
}

// `step` here carries the selected entry id (the <option> value), not a raw step.
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

// Fetch a card's series into the cache (no WebGL). Rendering is left to
// renderOnscreen, which draws it iff it's on-screen and within the live cap.
async function fetchCard(card) {
  const tag = card.dataset.tag;
  const cs = state.cards.get(tag);
  if (!cs) return;
  const sig = fetchSig();
  if (cs.series && cs.fetchSig === sig) { renderOnscreen(); return; }  // data ready
  if (cs.loading) return;
  cs.loading = true;
  // Per the sub-second rule: only reveal the spinner ring if on-screen and slow.
  const slowTimer = setTimeout(() => { if (state.onscreen.has(tag)) card.classList.add("loading"); }, 800);
  try {
    const resp = await fetch("api/series", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_ids: [...state.selectedRuns], tags: [tag], max_points: optMaxPoints() }),
    }).then((x) => x.json());
    clearTimeout(slowTimer);
    cs.series = resp.series || [];
    cs.fetchSig = sig;
    cs.drawn = false;
    renderOnscreen();   // draw now if it's on-screen
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
// The marker trace MUST share the card's trace type (`ttype`): when the lines are
// WebGL (`scattergl`), Plotly composites that layer above SVG, so SVG markers
// would stay buried — gl markers appended after the gl lines sit on top. When the
// lines are SVG (`scatter`), SVG markers layer naturally by trace order.
const GAP_STYLE = {
  "nan":  { sym: "x",             label: "NaN",  size: 8 },
  "+inf": { sym: "triangle-up",   label: "+Inf", size: 9 },
  "-inf": { sym: "triangle-down", label: "−Inf", size: 9 },
};
function addGapMarkers(out, s, xaxis, color, ttype) {
  const win = stepRangeActive();
  for (const kind of ["nan", "+inf", "-inf"]) {
    const pts = s.gaps.filter((g) =>
      g.kind === kind && (!win || (g.step >= win[0] && g.step <= win[1])));
    if (!pts.length) continue;
    const st = GAP_STYLE[kind];
    const gx = pts.map((g) => xaxis === "wall_time" ? (g.wall_time - s.wall_time[0]) / 60.0 : g.step);
    out.push({
      x: gx, y: pts.map((g) => g.y), type: ttype, mode: "markers",
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

  // Render the tag name as real HTML (selectable/copyable) above the plot, rather
  // than Plotly's SVG title which can't be selected. Created once per card.
  let titleEl = card.querySelector(".chart-title");
  if (!titleEl) {
    titleEl = document.createElement("div");
    titleEl.className = "chart-title";
    card.insertBefore(titleEl, plotDiv || null);
  }
  titleEl.textContent = tag;
  titleEl.title = tag;

  const view = stepLimited(series);
  const xaxis = optXaxis(), logy = optLogy(), smoothOn = optSmoothOn(), weight = optWeight();
  // SVG by default (no WebGL context — immune to context exhaustion / broken
  // tiles); escalate to WebGL only for point-heavy cards where SVG would drag.
  const ttype = seriesPointTotal(series, smoothOn) > GL_POINT_THRESHOLD ? "scattergl" : "scatter";
  const cs = state.cards.get(tag);
  if (cs) cs.glWanted = ttype === "scattergl";
  const traces = [];
  const gapTraces = [];   // appended last so the markers sit on top of every line
  for (const s of view) {
    const x = xaxis === "wall_time" ? s.wall_time.map((w) => (w - s.wall_time[0]) / 60.0) : s.steps;
    const color = colorFor(s.run_id);
    if (smoothOn) {
      traces.push({ x, y: s.values, type: ttype, mode: "lines",
        line: { color, width: 0.7 }, opacity: 0.13, hoverinfo: "skip", showlegend: false, name: s.display_name });
      traces.push({ x, y: smoothValues(s.values, weight), type: ttype, mode: "lines",
        line: { color, width: 1.5 }, name: s.display_name, hovertemplate: "%{y:.5g}<extra></extra>" });
    } else {
      traces.push({ x, y: s.values, type: ttype, mode: "lines",
        line: { color, width: 1.4 }, name: s.display_name, hovertemplate: "%{y:.5g}<extra></extra>" });
    }
    if (s.gaps && s.gaps.length) addGapMarkers(gapTraces, s, xaxis, color, ttype);
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
    // Title is rendered as HTML (.chart-title) above the plot so it's selectable;
    // no Plotly SVG title here, so the top margin can be tight.
    margin: { l: 48, r: 10, t: 8, b: 32 },
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
  if (cs) cs.drawn = true;
  state.live.add(tag);   // renderOnscreen owns eviction; this just records the drawn plot
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

// ---- "jump to top of group" floating button --------------------------------
const _groupFab = document.createElement("button");
_groupFab.id = "groupfab";
_groupFab.title = "scroll to the top of this group";
document.body.appendChild(_groupFab);
_groupFab.onclick = () => {
  const g = currentTopGroup();
  const hdr = g && chartsEl().querySelector(`.group-sep[data-group="${CSS.escape(g)}"]`);
  hdr?.scrollIntoView({ behavior: "smooth", block: "start" });
};

// The group of the topmost chart currently visible at the top of the scroll area.
function currentTopGroup() {
  const charts = chartsEl();
  const top = charts.getBoundingClientRect().top;
  let best = null, bestTop = Infinity;
  for (const el of charts.children) {
    if (!el.dataset || !el.dataset.tag || el.style.display === "none") continue;
    const r = el.getBoundingClientRect();
    if (r.bottom <= top + 4) continue;                    // fully scrolled above
    if (r.top < bestTop) { bestTop = r.top; best = el; }
  }
  return best ? best.dataset.tag.split("/")[0] : null;
}

// Show the button only when the current group's header has scrolled out of view above.
function updateGroupFab() {
  const charts = chartsEl();
  if (!charts.classList.contains("has-groups")) { _groupFab.classList.remove("show"); return; }
  const g = currentTopGroup();
  const hdr = g && charts.querySelector(`.group-sep[data-group="${CSS.escape(g)}"]`);
  const top = charts.getBoundingClientRect().top;
  if (hdr && hdr.getBoundingClientRect().top < top - 8) {
    _groupFab.innerHTML = `<span class="gf-arrow">↑</span><span class="gf-name">${esc(g)}</span>`;
    _groupFab.classList.add("show");
  } else {
    _groupFab.classList.remove("show");
  }
}

// ---- refresh selected runs from disk ---------------------------------------
// Tear down every rendered Plotly chart so they rebuild cleanly (also clears any
// glitched Plotly state). Cards drop back to their pending placeholder.
function purgeRenderedCharts() {
  for (const tag of [...state.cards.keys()]) evictPlot(tag);  // purge + reset to placeholder
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
    _ovCache.clear(); renderOverlay();                 // overlay data may have changed on disk
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

// ---- shareable named selections --------------------------------------------
// Snapshot the current runs + tags + view options into a payload the server can
// persist, and restore one such payload on load (from the ?sel= URL).
let _pendingSel = null;   // selection fetched at boot, applied once runs are known

function selectionPayload() {
  const op = $("overlaypanel");
  return {
    runs: [...state.selectedRuns],
    tags: [...state.selectedTags],
    view: {
      maxPoints: optMaxPoints(), xaxis: optXaxis(),
      smoothOn: optSmoothOn(), weight: optWeight(), logy: optLogy(),
      outliers: optOutliers(), qLow: optQLow(), qHigh: optQHigh(),
      stepLo: state.stepRange.lo, stepHi: state.stepRange.hi,
    },
    overlay: {
      a: _ovA ? _ovA.get() : "",
      b: _ovB ? _ovB.get() : "",
      open: !!(op && !op.classList.contains("collapsed")),
    },
  };
}

async function applySelection(payload) {
  if (!payload) return;
  const v = payload.view || {};
  // Restore the view inputs first (so the grid renders with the right options).
  if (v.maxPoints != null) $("max-points").value = v.maxPoints;
  if (v.xaxis) $("xaxis").value = v.xaxis;
  if (v.smoothOn != null) $("smooth-on").checked = !!v.smoothOn;
  if (v.weight != null) $("smooth").value = v.weight;
  if (v.logy != null) $("logy").checked = !!v.logy;
  if (v.outliers != null) $("outliers-on").checked = !!v.outliers;
  if (v.qLow != null) $("q-low").value = v.qLow;
  if (v.qHigh != null) $("q-high").value = v.qHigh;
  updateQReadout();
  // Runs/tags may have changed since the link was made — apply the intersection.
  const haveRuns = new Set(state.runs.map((r) => r.run_id));
  state.selectedRuns = new Set((payload.runs || []).filter((r) => haveRuns.has(r)));
  renderRunList();
  updateRefreshBtn();
  await loadTags(true);                       // load tags for exactly these runs
  const haveTags = new Set(state.tagNames);
  state.selectedTags = new Set((payload.tags || []).filter((t) => haveTags.has(t)));
  if (v.stepLo != null) state.stepRange.lo = v.stepLo;
  if (v.stepHi != null) state.stepRange.hi = v.stepHi;
  syncStepSlider();
  updatePending();
  renderTagTree();
  renderGrid();                                // ensures the overlay panel exists
  refreshDiffRuns();
  // Restore the graph-overlay picks and open state.
  const ov = payload.overlay || {};
  ensureOverlayPanel();
  if (_ovA) _ovA.set(ov.a || "");
  if (_ovB) _ovB.set(ov.b || "");
  const op = $("overlaypanel");
  if (op) {
    const collapsed = op.classList.contains("collapsed");
    if (ov.open && collapsed) { op.classList.remove("collapsed"); op.querySelector(".dcaret").textContent = "▼"; }
    else if (!ov.open && !collapsed) { op.classList.add("collapsed"); op.querySelector(".dcaret").textContent = "▶"; }
  }
  renderOverlay();
  idle(`restored selection: ${payload.name || "shared"}`);
}

async function shareSelection() {
  if (!state.selectedRuns.size && !state.selectedTags.size) {
    idle("nothing selected to share");
    return;
  }
  const name = prompt("Name this selection (used in the share link):");
  if (!name) return;
  busy("creating share link…");
  try {
    const r = await fetch("api/selections", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, ...selectionPayload() }),
    }).then((x) => x.json());
    const url = new URL(document.baseURI);
    url.searchParams.set("sel", r.id);
    const link = url.toString();
    try { await navigator.clipboard.writeText(link); idle("share link copied ✓ — " + link); }
    catch { window.prompt("Share link:", link); idle("share link ready"); }
  } catch (e) {
    idle("failed to create share link");
  }
}

// Redraw the live charts from cached data (style-only changes).
function redrawVisible() {
  for (const tag of [...state.live]) {
    const cs = state.cards.get(tag);
    const card = $("chart-" + cssId(tag));
    if (cs && cs.series && card) drawCard(card, cs.series);
  }
  renderOverlay();   // the overlay shares the same style options (logy, step window, x-axis)
}

// Invalidate cached series (refetch-affecting change) and reload via the queue.
function reloadVisible() {
  for (const cs of state.cards.values()) { cs.fetchSig = null; cs.drawn = false; }
  _ovCache.clear();   // overlay series depend on runs/max_points/x-axis too
  pump();
  renderOnscreen();   // drop now-stale plots; fresh ones redraw as fetches land
  renderOverlay();
}

const scheduleGrid = debounce(renderGrid, 150);

// Track scroll direction so the scheduler prefetches ahead of the user.
function trackScroll(el) {
  const handler = () => {
    const st = el === window ? window.scrollY : el.scrollTop;
    const now = performance.now();
    const dt = now - lastScrollT;
    const vel = dt > 0 ? Math.abs(st - lastScrollTop) / dt : 0;   // px/ms
    if (st !== lastScrollTop) { scrollDir = st > lastScrollTop ? 1 : -1; lastScrollTop = st; }
    lastScrollT = now;
    updateGroupFab();
    onScrollSettle();   // always schedule a final pass once motion stops
    if (vel > FAST_SCROLL_PX_PER_MS) { fastScrolling = true; return; }  // flinging: don't draw
    fastScrolling = false;
    pump();
    renderOnscreen();   // re-pick the closest charts as proximity changes
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
  for (const t of state.tagNames) {
    const top = t.split("/")[0];
    if (t.includes("/")) state.expanded.add(top);
  }
  renderTagTree();
};
$("tags-selected").onclick = () => {
  state.showSelectedOnly = !state.showSelectedOnly;
  // Freeze the shown set on entering, so toggling rows doesn't shrink the list.
  if (state.showSelectedOnly) { state.selectedSnapshot = new Set(state.selectedTags); _snapVersion++; }
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
    if (document.body.classList.contains("sidebar-collapsed")) return;  // nothing to resize
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

// Collapse/expand the left panel so only the charts show. The toggle lives on the
// divider; stop its mousedown from starting a resize-drag.
(function initSidebarToggle() {
  const btn = $("sidebar-toggle");
  if (!btn) return;
  btn.addEventListener("mousedown", (e) => e.stopPropagation());
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const collapsed = document.body.classList.toggle("sidebar-collapsed");
    btn.textContent = collapsed ? "›" : "‹";
    btn.title = collapsed ? "show the panel" : "hide the panel";
    window.dispatchEvent(new Event("resize"));   // relayout Plotly to the new width
  });
})();

$("refresh-btn").onclick = refreshSelected;
$("share-btn").onclick = shareSelection;

trackScroll(chartsEl());
trackScroll(window);
updatePending();
updateRefreshBtn();
renderGrid();

// If the URL carries ?sel=<id>, fetch that saved selection BEFORE anything that
// loads runs (loadRuns applies it; loadStatus can also trigger loadRuns), so the
// pending selection is always set first; otherwise just load runs normally.
(async function boot() {
  const sel = new URLSearchParams(location.search).get("sel");
  if (sel) {
    try { _pendingSel = await fetch("api/selections/" + encodeURIComponent(sel)).then((x) => x.ok ? x.json() : null); }
    catch { _pendingSel = null; }
  }
  loadRuns();
  loadStatus();
  setInterval(loadStatus, 3000);
})();
