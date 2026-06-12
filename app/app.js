/* ============================================================
   Iron Percentile — engine + UI
   Data: PERCENTILE_DATA (percentiles.js) — quantiles 1..99 of
   best raw competition lifts, on a bodyweight grid, per sex/lift.
   ============================================================ */

"use strict";

const KG2LB = 2.2046226218;

/* ---------------- 1RM model (RPE chart) ----------------
   Standard RTS-style %1RM chart collapses to one sequence:
   index = (reps - 1 + (10 - rpe)) * 2 steps of "effort distance". */
const RPE_PCT = [
  100, 97.8, 95.5, 93.9, 92.2, 90.7, 89.2, 87.8, 86.3, 85.0,
  83.7, 82.4, 81.1, 79.9, 78.6, 77.4, 76.2, 75.1, 73.9, 72.3,
  70.7, 69.4, 68.0, 66.7, 65.3, 64.0, 62.6, 61.3, 59.9, 58.6, 57.4,
];

function repPct(reps, rpe) {
  let idx = (reps - 1) * 2 + (10 - rpe) * 2;
  if (idx < 0) idx = 0;
  if (idx <= RPE_PCT.length - 1) {
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    const f = idx - lo;
    return (RPE_PCT[lo] + (RPE_PCT[hi] - RPE_PCT[lo]) * f) / 100;
  }
  // beyond the chart: keep sliding at the chart's tail slope, floor at 40%
  const tail = RPE_PCT[RPE_PCT.length - 1];
  return Math.max(40, tail - 1.25 * (idx - (RPE_PCT.length - 1))) / 100;
}

const est1RM = (weight, reps, rpe) => weight / repPct(reps, rpe);
const setWeightFor1RM = (oneRM, reps, rpe) => oneRM * repPct(reps, rpe);

/* ---------------- percentile engine ---------------- */
const DATA = PERCENTILE_DATA.data;
const PCTS = PERCENTILE_DATA.meta.pcts; // [1..99]

function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }

/** Quantile row (length 99) interpolated at bodyweight bw. */
function rowAt(sex, lift, bw) {
  const t = DATA[sex][lift];
  const g = t.bw;
  if (bw <= g[0]) return t.q[0];
  if (bw >= g[g.length - 1]) return t.q[g.length - 1];
  let i = 0;
  while (g[i + 1] < bw) i++;
  const f = (bw - g[i]) / (g[i + 1] - g[i]);
  const a = t.q[i], b = t.q[i + 1];
  const out = new Array(a.length);
  for (let k = 0; k < a.length; k++) out[k] = a[k] + (b[k] - a[k]) * f;
  return out;
}

/** Percentile (continuous, ~0.3..99.9) of a 1RM at sex/lift/bodyweight. */
function percentileOf(sex, lift, bw, oneRM) {
  const q = rowAt(sex, lift, bw);
  const n = q.length;
  if (oneRM <= q[0]) return clamp((oneRM / q[0]) * 1, 0.2, 1);
  if (oneRM >= q[n - 1]) {
    const spread = Math.max(1, q[n - 1] - q[n - 10]);
    return Math.min(99.9, 99 + 0.9 * Math.min(1, (oneRM - q[n - 1]) / spread));
  }
  let i = 0;
  while (q[i + 1] < oneRM) i++;
  const f = q[i + 1] === q[i] ? 0 : (oneRM - q[i]) / (q[i + 1] - q[i]);
  return PCTS[i] + f * (PCTS[i + 1] - PCTS[i]);
}

/** 1RM at percentile p (1..99, fractional ok) for sex/lift/bodyweight. */
function weightAtPercentile(sex, lift, bw, p) {
  const q = rowAt(sex, lift, bw);
  p = clamp(p, 1, 99);
  const i = Math.min(Math.floor(p) - 1, q.length - 2);
  const f = p - (i + 1);
  return q[i] + (q[i + 1] - q[i]) * f;
}

/** Bodyweight at which `oneRM` sits exactly at percentile p.
    Returns {bw, status} — status: "ok" | "below" | "above". */
function bodyweightForPercentile(sex, lift, p, oneRM) {
  const g = DATA[sex][lift].bw;
  const at = (bw) => weightAtPercentile(sex, lift, bw, p);
  if (oneRM <= at(g[0])) return { bw: g[0], status: "below" };
  if (oneRM >= at(g[g.length - 1])) return { bw: g[g.length - 1], status: "above" };
  for (let i = 0; i < g.length - 1; i++) {
    const a = at(g[i]), b = at(g[i + 1]);
    if (oneRM >= a && oneRM <= b) {
      const f = b === a ? 0 : (oneRM - a) / (b - a);
      return { bw: g[i] + (g[i + 1] - g[i]) * f, status: "ok" };
    }
  }
  return { bw: g[g.length - 1], status: "above" };
}

/* ---------------- formatting ---------------- */
let unit = "kg"; // global display unit; everything internal is kg

const toDisp = (kg) => unit === "kg" ? kg : kg * KG2LB;
const fromDisp = (v) => unit === "kg" ? v : v / KG2LB;
const fmtW = (kg, dec = 1) => `${toDisp(kg).toFixed(dec)} ${unit}`;
const ordinal = (p) => {
  const r = Math.round(p);
  if (r < 1) return "<1st";
  if (r > 99) return ">99th";
  const s = ["th", "st", "nd", "rd"], v = r % 100;
  return r + (s[(v - 20) % 10] || s[v] || s[0]);
};

/* ============================================================
   SVG line chart (dependency-free)
   ============================================================ */
function niceTicks(min, max, count = 5) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  let step = mag;
  for (const m of [1, 2, 2.5, 5, 10]) if (step0 <= m * mag) { step = m * mag; break; }
  const lo = Math.ceil(min / step) * step;
  const out = [];
  for (let v = lo; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

/**
 * Render a line chart into container `el`.
 * opts: { series: [{xs, ys, color, color2, fill, dash}], marker: {x, y, color},
 *         xLabel, yLabel, fmtX(v), fmtY(v), tip(x, idx) -> html }
 */
function lineChart(el, opts) {
  const W = 720, H = 300, padL = 58, padR = 16, padT = 14, padB = 38;
  const ns = "http://www.w3.org/2000/svg";
  el.innerHTML = "";

  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const s of opts.series) {
    for (const x of s.xs) { if (x < xMin) xMin = x; if (x > xMax) xMax = x; }
    for (const y of s.ys) { if (y < yMin) yMin = y; if (y > yMax) yMax = y; }
  }
  if (opts.marker) {
    yMin = Math.min(yMin, opts.marker.y); yMax = Math.max(yMax, opts.marker.y);
  }
  const ySpan = (yMax - yMin) || 1;
  yMin -= ySpan * 0.07; yMax += ySpan * 0.07;

  const sx = (x) => padL + ((x - xMin) / (xMax - xMin || 1)) * (W - padL - padR);
  const sy = (y) => H - padB - ((y - yMin) / (yMax - yMin || 1)) * (H - padT - padB);

  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const defs = document.createElementNS(ns, "defs");
  svg.appendChild(defs);

  const mk = (tag, attrs, parent = svg) => {
    const n = document.createElementNS(ns, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    parent.appendChild(n);
    return n;
  };

  // grid + axes
  const yTicks = niceTicks(yMin, yMax, 5);
  for (const t of yTicks) {
    mk("line", { x1: padL, x2: W - padR, y1: sy(t), y2: sy(t), stroke: "rgba(130,160,230,0.10)", "stroke-width": 1 });
    const lbl = mk("text", { x: padL - 8, y: sy(t) + 4, "text-anchor": "end", fill: "#8a96ad", "font-size": 11, "font-family": "monospace" });
    lbl.textContent = opts.fmtY ? opts.fmtY(t) : t;
  }
  const xTicks = niceTicks(xMin, xMax, 8);
  for (const t of xTicks) {
    mk("line", { x1: sx(t), x2: sx(t), y1: padT, y2: H - padB, stroke: "rgba(130,160,230,0.06)", "stroke-width": 1 });
    const lbl = mk("text", { x: sx(t), y: H - padB + 18, "text-anchor": "middle", fill: "#8a96ad", "font-size": 11, "font-family": "monospace" });
    lbl.textContent = opts.fmtX ? opts.fmtX(t) : t;
  }
  if (opts.xLabel) {
    const l = mk("text", { x: (padL + W - padR) / 2, y: H - 4, "text-anchor": "middle", fill: "#647089", "font-size": 11, "letter-spacing": "1.5" });
    l.textContent = opts.xLabel.toUpperCase();
  }
  if (opts.yLabel) {
    const l = mk("text", { x: 14, y: (padT + H - padB) / 2, "text-anchor": "middle", fill: "#647089", "font-size": 11, "letter-spacing": "1.5", transform: `rotate(-90 14 ${(padT + H - padB) / 2})` });
    l.textContent = opts.yLabel.toUpperCase();
  }

  opts.series.forEach((s, si) => {
    const gid = `g${si}-${Math.random().toString(36).slice(2, 7)}`;
    const grad = mk("linearGradient", { id: gid, x1: 0, y1: 0, x2: 1, y2: 0 }, defs);
    mk("stop", { offset: "0%", "stop-color": s.color }, grad);
    mk("stop", { offset: "100%", "stop-color": s.color2 || s.color }, grad);

    let d = "";
    for (let i = 0; i < s.xs.length; i++) {
      d += (i === 0 ? "M" : "L") + sx(s.xs[i]).toFixed(1) + " " + sy(s.ys[i]).toFixed(1) + " ";
    }
    if (s.fill) {
      const fid = `f${gid}`;
      const fg = mk("linearGradient", { id: fid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      mk("stop", { offset: "0%", "stop-color": s.color, "stop-opacity": 0.22 }, fg);
      mk("stop", { offset: "100%", "stop-color": s.color, "stop-opacity": 0 }, fg);
      const dArea = d + `L ${sx(s.xs[s.xs.length - 1])} ${H - padB} L ${sx(s.xs[0])} ${H - padB} Z`;
      mk("path", { d: dArea, fill: `url(#${fid})`, stroke: "none" });
    }
    mk("path", {
      d, fill: "none", stroke: `url(#${gid})`, "stroke-width": 2.5,
      "stroke-linecap": "round", ...(s.dash ? { "stroke-dasharray": s.dash } : {}),
    });
  });

  if (opts.marker) {
    const mx = sx(opts.marker.x), my = sy(opts.marker.y);
    mk("line", { x1: mx, x2: mx, y1: padT, y2: H - padB, stroke: opts.marker.color, "stroke-width": 1, "stroke-dasharray": "3 4", opacity: 0.7 });
    mk("circle", { cx: mx, cy: my, r: 6.5, fill: opts.marker.color, opacity: 0.25 });
    mk("circle", { cx: mx, cy: my, r: 3.5, fill: "#fff", stroke: opts.marker.color, "stroke-width": 2 });
    if (opts.marker.label) {
      const anchor = mx > W * 0.7 ? "end" : "start";
      const tx = mx + (anchor === "end" ? -10 : 10);
      const t = mk("text", { x: tx, y: Math.max(my - 10, padT + 12), "text-anchor": anchor, fill: opts.marker.color, "font-size": 12, "font-weight": 700, "font-family": "monospace" });
      t.textContent = opts.marker.label;
    }
  }

  el.appendChild(svg);

  // hover tooltip on the primary series
  if (opts.tip) {
    const tipEl = document.createElement("div");
    tipEl.className = "chart-tip";
    el.appendChild(tipEl);
    const cross = mk("line", { x1: 0, x2: 0, y1: padT, y2: H - padB, stroke: "rgba(255,255,255,0.25)", "stroke-width": 1, visibility: "hidden" });
    const dot = mk("circle", { r: 4, fill: "#fff", visibility: "hidden" });
    const s0 = opts.series[0];
    svg.addEventListener("mousemove", (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const xVal = xMin + ((px - padL) / (W - padL - padR)) * (xMax - xMin);
      let best = 0, bd = Infinity;
      for (let i = 0; i < s0.xs.length; i++) {
        const dd = Math.abs(s0.xs[i] - xVal);
        if (dd < bd) { bd = dd; best = i; }
      }
      const cx = sx(s0.xs[best]), cy = sy(s0.ys[best]);
      cross.setAttribute("x1", cx); cross.setAttribute("x2", cx);
      cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", cx); dot.setAttribute("cy", cy);
      dot.setAttribute("visibility", "visible");
      tipEl.style.display = "block";
      tipEl.style.left = `${(cx / W) * 100}%`;
      tipEl.style.top = `${(cy / H) * 100}%`;
      tipEl.innerHTML = opts.tip(s0.xs[best], best);
    });
    svg.addEventListener("mouseleave", () => {
      cross.setAttribute("visibility", "hidden");
      dot.setAttribute("visibility", "hidden");
      tipEl.style.display = "none";
    });
  }
}

/* ============================================================
   UI wiring
   ============================================================ */
const $ = (id) => document.getElementById(id);

const state = {
  mode: "compare",
  lift: "bench",
  a: { sex: "M", bw: 90, weight: 100, reps: 5, rpe: 10 },
  b: { sex: "F", bw: 63, reps: 5, rpe: 10 },
  m: { sex: "M", bw: 82.5, lift: "squat", weight: 140, reps: 5, rpe: 9, target: 90 },
};

const LIFT_NAME = { squat: "squat", bench: "bench press", deadlift: "deadlift" };

function segInit(field, onChange) {
  const seg = document.querySelector(`[data-field="${field}"]`);
  seg.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      seg.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      onChange(btn.dataset.val);
    });
  });
}

function bindNum(id, obj, key, render) {
  $(id).addEventListener("input", () => {
    const v = parseFloat($(id).value);
    if (!isNaN(v) && v > 0) { obj[key] = fromDisp(v); render(); }
  });
}

function bindSlider(id, outId, obj, key, render) {
  $(id).addEventListener("input", () => {
    obj[key] = parseFloat($(id).value);
    $(outId).textContent = $(id).value;
    render();
  });
}

/* ---------------- compare mode ---------------- */
function renderCompare() {
  const { a, b } = state;
  const lift = state.lift;

  const a1rm = est1RM(a.weight, a.reps, a.rpe);
  const pct = percentileOf(a.sex, lift, a.bw, a1rm);

  $("a-1rm").textContent = fmtW(a1rm, 1);
  $("a-pct").textContent = ordinal(pct);
  $("a-bar").style.width = `${clamp(pct, 0, 100)}%`;

  // B: same percentile in B's population
  const b1rm = weightAtPercentile(b.sex, lift, b.bw, pct);
  const bSet = setWeightFor1RM(b1rm, b.reps, b.rpe);

  $("b-pct-echo").textContent = ordinal(pct);
  $("b-lift-echo").textContent = LIFT_NAME[lift];
  $("b-target").textContent =
    `${toDisp(bSet).toFixed(1)} ${unit} × ${b.reps} @ RPE ${b.rpe}`;
  $("b-1rm").textContent = fmtW(b1rm, 1);
  $("b-bar").style.width = `${clamp(pct, 0, 100)}%`;

  // chart: required set weight vs reps (1..12), at B's bodyweight, B's RPE
  const reps = [], need = [];
  for (let r = 1; r <= 12; r++) {
    reps.push(r);
    need.push(setWeightFor1RM(b1rm, r, b.rpe));
  }
  lineChart($("compare-chart"), {
    series: [{ xs: reps, ys: need.map(toDisp), color: "#f472b6", color2: "#a78bfa", fill: true }],
    marker: { x: b.reps, y: toDisp(setWeightFor1RM(b1rm, b.reps, b.rpe)), color: "#f472b6", label: `${toDisp(bSet).toFixed(1)} ${unit} × ${b.reps}` },
    xLabel: "reps", yLabel: `set weight (${unit})`,
    fmtX: (v) => Math.round(v),
    fmtY: (v) => Math.round(v),
    tip: (x, i) => `${Math.round(x)} reps @ RPE ${b.rpe}<br>${need[i] !== undefined ? toDisp(need[i]).toFixed(1) : "—"} ${unit}`,
  });
}

/* ---------------- my percentile mode ---------------- */
function renderMe() {
  const m = state.m;
  const oneRM = est1RM(m.weight, m.reps, m.rpe);
  const pct = percentileOf(m.sex, m.lift, m.bw, oneRM);

  $("m-1rm").textContent = fmtW(oneRM, 1);
  $("m-pct").textContent = ordinal(pct);
  $("m-pct-note").textContent =
    `of ${m.sex === "M" ? "male" : "female"} raw competitors near ${toDisp(m.bw).toFixed(0)} ${unit}`;
  $("m-bar").style.width = `${clamp(pct, 0, 100)}%`;

  // chart 1: 1RM needed at each percentile for this bw/sex/lift
  const ps = [], ws = [];
  for (let p = 1; p <= 99; p++) {
    ps.push(p);
    ws.push(weightAtPercentile(m.sex, m.lift, m.bw, p));
  }
  lineChart($("me-chart-curve"), {
    series: [{ xs: ps, ys: ws.map(toDisp), color: "#22d3ee", color2: "#a78bfa", fill: true }],
    marker: { x: clamp(pct, 1, 99), y: toDisp(oneRM), color: "#f472b6", label: `you — ${ordinal(pct)}` },
    xLabel: "percentile", yLabel: `1RM (${unit})`,
    fmtX: (v) => Math.round(v),
    fmtY: (v) => Math.round(v),
    tip: (x, i) => `p${Math.round(x)}: ${toDisp(ws[i]).toFixed(1)} ${unit} 1RM<br>` +
      `set: ${toDisp(setWeightFor1RM(ws[i], m.reps, m.rpe)).toFixed(1)} ${unit} × ${m.reps} @ ${m.rpe}`,
  });

  // target percentile callout
  const t1rm = weightAtPercentile(m.sex, m.lift, m.bw, m.target);
  const tSet = setWeightFor1RM(t1rm, m.reps, m.rpe);
  const gap = t1rm - oneRM;
  $("m-target-text").innerHTML =
    `Percentile <strong>${m.target}</strong> at your bodyweight = <strong>${fmtW(t1rm, 1)}</strong> 1RM ` +
    `— i.e. <strong>${toDisp(tSet).toFixed(1)} ${unit} × ${m.reps} @ RPE ${m.rpe}</strong>. ` +
    (gap > 0
      ? `That's <strong>${fmtW(gap, 1)}</strong> over your current estimated 1RM.`
      : `You're already <strong>${fmtW(-gap, 1)}</strong> past it.`);

  // chart 2: bodyweight needed for current 1RM to hit each percentile
  const ps2 = [], bws = [];
  let lastOk = null;
  for (let p = 1; p <= 99; p++) {
    const r = bodyweightForPercentile(m.sex, m.lift, p, oneRM);
    if (r.status === "ok") { ps2.push(p); bws.push(r.bw); lastOk = p; }
  }
  const markerP = clamp(pct, 1, 99);
  if (ps2.length > 1) {
    lineChart($("me-chart-bw"), {
      series: [{ xs: ps2, ys: bws.map(toDisp), color: "#a78bfa", color2: "#f472b6", fill: true }],
      marker: { x: markerP, y: toDisp(m.bw), color: "#22d3ee", label: `you — ${toDisp(m.bw).toFixed(1)} ${unit}` },
      xLabel: "percentile", yLabel: `bodyweight (${unit})`,
      fmtX: (v) => Math.round(v),
      fmtY: (v) => Math.round(v),
      tip: (x, i) => `p${Math.round(x)} needs ≤ ${toDisp(bws[i]).toFixed(1)} ${unit} bodyweight<br>at your ${fmtW(oneRM, 0)} 1RM`,
    });
  } else {
    $("me-chart-bw").innerHTML = `<p class="callout">Not enough range in the data for this 1RM.</p>`;
  }

  const r90 = bodyweightForPercentile(m.sex, m.lift, m.target, oneRM);
  $("m-bw-text").innerHTML =
    r90.status === "ok"
      ? `At a bodyweight of <strong>${fmtW(r90.bw, 1)}</strong>, your current ` +
        `<strong>${fmtW(oneRM, 1)}</strong> ${LIFT_NAME[m.lift]} would sit at the ` +
        `<strong>${ordinal(m.target)}</strong> percentile.` +
        (r90.bw < m.bw
          ? ` (${fmtW(m.bw - r90.bw, 1)} below your current bodyweight.)`
          : ` (${fmtW(r90.bw - m.bw, 1)} above your current bodyweight.)`)
      : r90.status === "above"
        ? `Even at the heaviest bodyweights in the data, <strong>${fmtW(oneRM, 1)}</strong> ` +
          `stays above the ${ordinal(m.target)} percentile. Strong everywhere.`
        : `Even at the lightest bodyweights in the data, <strong>${fmtW(oneRM, 1)}</strong> ` +
          `doesn't reach the ${ordinal(m.target)} percentile.`;
}

function renderAll() {
  if (state.mode === "compare") renderCompare();
  else renderMe();
}

/* ---------------- init ---------------- */
function refreshNumberInputs() {
  $("a-bw").value = +toDisp(state.a.bw).toFixed(1);
  $("a-weight").value = +toDisp(state.a.weight).toFixed(1);
  $("b-bw").value = +toDisp(state.b.bw).toFixed(1);
  $("m-bw").value = +toDisp(state.m.bw).toFixed(1);
  $("m-weight").value = +toDisp(state.m.weight).toFixed(1);
  document.querySelectorAll(".unit-label").forEach((el) => (el.textContent = unit));
}

function init() {
  // mode tabs
  document.querySelectorAll("#modeTabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#modeTabs button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.mode = btn.dataset.mode;
      document.querySelectorAll(".mode").forEach((s) => s.classList.remove("active"));
      $(`mode-${state.mode}`).classList.add("active");
      renderAll();
    });
  });

  // unit toggle
  document.querySelectorAll("#unitToggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#unitToggle button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      unit = btn.dataset.unit;
      refreshNumberInputs();
      renderAll();
    });
  });

  segInit("a-sex", (v) => { state.a.sex = v; renderAll(); });
  segInit("b-sex", (v) => { state.b.sex = v; renderAll(); });
  segInit("lift", (v) => { state.lift = v; renderAll(); });
  segInit("m-sex", (v) => { state.m.sex = v; renderAll(); });
  segInit("m-lift", (v) => { state.m.lift = v; renderAll(); });

  bindNum("a-bw", state.a, "bw", renderAll);
  bindNum("a-weight", state.a, "weight", renderAll);
  bindNum("b-bw", state.b, "bw", renderAll);
  bindNum("m-bw", state.m, "bw", renderAll);
  bindNum("m-weight", state.m, "weight", renderAll);

  bindSlider("a-reps", "a-reps-out", state.a, "reps", renderAll);
  bindSlider("a-rpe", "a-rpe-out", state.a, "rpe", renderAll);
  bindSlider("b-reps", "b-reps-out", state.b, "reps", renderAll);
  bindSlider("b-rpe", "b-rpe-out", state.b, "rpe", renderAll);
  bindSlider("m-reps", "m-reps-out", state.m, "reps", renderAll);
  bindSlider("m-rpe", "m-rpe-out", state.m, "rpe", renderAll);
  bindSlider("m-target", "m-target-out", state.m, "target", renderAll);

  // footer sample counts
  const c = PERCENTILE_DATA.meta.counts;
  const total = Object.values(c).reduce(
    (s, lifts) => s + Object.values(lifts).reduce((a, b) => a + b, 0), 0);
  $("foot-note").textContent =
    `Ground truth: OpenPowerlifting database — raw (unequipped) competition entries, best lift per lifter ` +
    `(${total.toLocaleString()} lifter-lift data points). 1RM estimates use an RPE-based percentage chart. ` +
    `Percentiles are relative to competitive powerlifters, not the general population.`;

  refreshNumberInputs();
  renderAll();
}

if (typeof document !== "undefined" && typeof PERCENTILE_DATA !== "undefined") {
  document.addEventListener("DOMContentLoaded", init);
  if (document.readyState !== "loading") init();
}

/* node test hook */
if (typeof module !== "undefined") {
  module.exports = { repPct, est1RM, percentileOf, weightAtPercentile, bodyweightForPercentile };
}
