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
const LIFTS3 = ["squat", "bench", "deadlift"];
/** the two lifts that aren't `lift`, in canonical order */
const OTHER_TWO = {
  squat: ["bench", "deadlift"],
  bench: ["squat", "deadlift"],
  deadlift: ["squat", "bench"],
};

function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }

/** bodyweight grid for a sex/lift ("total" shares the squat grid). */
function gridFor(sex, lift) {
  return DATA[sex][lift === "total" ? "squat" : lift].bw;
}

/** Quantile row (length 99) interpolated at bodyweight bw.
    lift === "total" sums the three lifts' rows (same-percentile model). */
function rowAt(sex, lift, bw) {
  if (lift === "total") {
    const s = rowAt(sex, "squat", bw);
    const b = rowAt(sex, "bench", bw);
    const d = rowAt(sex, "deadlift", bw);
    const out = new Array(s.length);
    for (let k = 0; k < s.length; k++) out[k] = s[k] + b[k] + d[k];
    return out;
  }
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
  const g = gridFor(sex, lift);
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

/* ---------------- normal helpers (for the heat map) ---------------- */
/** Φ⁻¹ — Acklam's rational approximation of the probit function. */
function probit(p) {
  if (p <= 0) return -6; if (p >= 1) return 6;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const plow = 0.02425, phigh = 1 - plow; let q, r;
  if (p < plow) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p <= phigh) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

/** Assumed latent (Gaussian-copula) rank correlation between any two lifts.
    Real raw powerlifters sit around here; it governs how tight the heat blob is. */
const RHO = 0.62;

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

/* ---------------- sex-driven palette ----------------
   light blue for male, pink for female — everywhere. */
const SEX_COLORS = {
  M: { main: "#38bdf8", alt: "#818cf8", glow: "rgba(56,189,248,0.38)", heatBg: "#081424" },
  F: { main: "#f472b6", alt: "#c084fc", glow: "rgba(244,114,182,0.38)", heatBg: "#1c0a1a" },
};
const sexC = (sex) => SEX_COLORS[sex] || SEX_COLORS.M;

/** set --c / --c2 custom props so CSS picks up the sex colors. */
function paintSex(el, sex) {
  const c = sexC(sex);
  el.style.setProperty("--c", c.main);
  el.style.setProperty("--c2", c.alt);
  el.style.setProperty("--glow", c.glow);
}
/** gradient-fill a text element with the sex colors. */
function gradText(el, sex) {
  const c = sexC(sex);
  el.style.backgroundImage = `linear-gradient(90deg, ${c.main}, ${c.alt})`;
  el.style.webkitBackgroundClip = "text";
  el.style.backgroundClip = "text";
  el.style.color = "transparent";
}
/** colour a percentile bar fill with the sex colors. */
function paintBar(el, sex) {
  const c = sexC(sex);
  el.style.backgroundImage = `linear-gradient(90deg, ${c.alt}, ${c.main})`;
}

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
   SVG heat map (Gaussian-copula joint of the other two lifts)
   ============================================================ */
const lerpHex = (a, b, t) => {
  const ah = parseInt(a.slice(1), 16), bh = parseInt(b.slice(1), 16);
  const ar = ah >> 16 & 255, ag = ah >> 8 & 255, ab = ah & 255;
  const br = bh >> 16 & 255, bg = bh >> 8 & 255, bb = bh & 255;
  return `rgb(${Math.round(ar + (br - ar) * t)},${Math.round(ag + (bg - ag) * t)},${Math.round(ab + (bb - ab) * t)})`;
};
function heatColor(t, main, bg) {
  return t < 0.6 ? lerpHex(bg, main, t / 0.6) : lerpHex(main, "#e6f0ff", (t - 0.6) / 0.4);
}

/**
 * Heat map of where the two non-fixed lifts land, given the fixed lift's
 * percentile, for a lifter of this sex/bodyweight.
 * opts: { sex, bw, fixedLift, fixedPct, axes:[xLift,yLift], actual?:{[lift]:1RM} }
 */
function heatMap(el, opts) {
  const ns = "http://www.w3.org/2000/svg";
  const W = 560, H = 460, padL = 64, padR = 18, padT = 16, padB = 46;
  el.innerHTML = "";
  const c = sexC(opts.sex);
  const [lx, ly] = opts.axes;

  const z0 = probit(clamp(opts.fixedPct, 0.5, 99.5) / 100);
  const m = RHO * z0;                 // conditional mean (both axes)
  const v = 1 - RHO * RHO;            // conditional variance
  const r = RHO / (1 + RHO);          // conditional correlation between the two
  const sd = Math.sqrt(v);

  const zLo = clamp(m - 3 * sd, probit(0.01), probit(0.985));
  const zHi = clamp(m + 3 * sd, probit(0.015), probit(0.99));
  const N = 30;                       // cells per axis
  const zAt = (i) => zLo + (zHi - zLo) * (i / (N - 1));
  const pAtZ = (z) => clamp(normCdf(z) * 100, 1, 99);
  const kgAt = (lift, z) => weightAtPercentile(opts.sex, lift, opts.bw, pAtZ(z));

  // density grid (unnormalised) + max
  const dens = [];
  let maxD = 0;
  for (let j = 0; j < N; j++) {
    const zy = zAt(j);
    const row = [];
    for (let i = 0; i < N; i++) {
      const zx = zAt(i);
      const dx = zx - m, dy = zy - m;
      const q = (dx * dx - 2 * r * dx * dy + dy * dy) / (v * (1 - r * r));
      const d = Math.exp(-0.5 * q);
      row.push(d);
      if (d > maxD) maxD = d;
    }
    dens.push(row);
  }

  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const mk = (tag, attrs, parent = svg) => {
    const n = document.createElementNS(ns, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    parent.appendChild(n);
    return n;
  };
  const px = (i) => padL + (i / N) * (W - padL - padR);
  const py = (j) => (H - padB) - (j / N) * (H - padT - padB);   // j=0 at bottom
  const cellW = (W - padL - padR) / N + 0.6;
  const cellH = (H - padT - padB) / N + 0.6;

  // background panel
  mk("rect", { x: padL, y: padT, width: W - padL - padR, height: H - padT - padB, fill: c.heatBg, rx: 6 });

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const t = Math.pow(dens[j][i] / maxD, 1.25);   // >1 darkens the tails → crisper blob
      if (t < 0.025) continue;
      mk("rect", {
        x: px(i).toFixed(1), y: (py(j + 1)).toFixed(1),
        width: cellW.toFixed(1), height: cellH.toFixed(1),
        fill: heatColor(t, c.main, c.heatBg), opacity: 0.95,
      });
    }
  }

  // axis frame + ticks (labelled in kg)
  mk("rect", { x: padL, y: padT, width: W - padL - padR, height: H - padT - padB, fill: "none", stroke: "rgba(130,160,230,0.18)", rx: 6 });
  const tickZs = [0, 0.25, 0.5, 0.75, 1].map((f) => zLo + (zHi - zLo) * f);
  tickZs.forEach((z, k) => {
    const fx = padL + ((z - zLo) / (zHi - zLo)) * (W - padL - padR);
    const fy = (H - padB) - ((z - zLo) / (zHi - zLo)) * (H - padT - padB);
    mk("text", { x: fx, y: H - padB + 18, "text-anchor": "middle", fill: "#8a96ad", "font-size": 11, "font-family": "monospace" }).textContent = Math.round(toDisp(kgAt(lx, z)));
    mk("text", { x: padL - 8, y: fy + 4, "text-anchor": "end", fill: "#8a96ad", "font-size": 11, "font-family": "monospace" }).textContent = Math.round(toDisp(kgAt(ly, z)));
  });
  mk("text", { x: (padL + W - padR) / 2, y: H - 6, "text-anchor": "middle", fill: "#647089", "font-size": 11, "letter-spacing": "1.5" })
    .textContent = `${LIFT_NAME[lx]} (${unit})`.toUpperCase();
  mk("text", { x: 15, y: (padT + H - padB) / 2, "text-anchor": "middle", fill: "#647089", "font-size": 11, "letter-spacing": "1.5", transform: `rotate(-90 15 ${(padT + H - padB) / 2})` })
    .textContent = `${LIFT_NAME[ly]} (${unit})`.toUpperCase();

  // "typical" peak marker at the conditional mean
  const peakX = padL + ((m - zLo) / (zHi - zLo)) * (W - padL - padR);
  const peakY = (H - padB) - ((m - zLo) / (zHi - zLo)) * (H - padT - padB);
  if (m >= zLo && m <= zHi) {
    mk("circle", { cx: peakX, cy: peakY, r: 6, fill: "none", stroke: "#fff", "stroke-width": 2, opacity: 0.9 });
    mk("circle", { cx: peakX, cy: peakY, r: 2, fill: "#fff" });
    mk("text", { x: peakX + 10, y: peakY - 8, fill: "#fff", "font-size": 11, "font-weight": 700, "font-family": "monospace", opacity: 0.92 }).textContent = "typical";
  }

  // actual point, if the lifter supplied the other two lifts
  if (opts.actual && opts.actual[lx] != null && opts.actual[ly] != null) {
    const zx = probit(clamp(percentileOf(opts.sex, lx, opts.bw, opts.actual[lx]), 0.5, 99.5) / 100);
    const zy = probit(clamp(percentileOf(opts.sex, ly, opts.bw, opts.actual[ly]), 0.5, 99.5) / 100);
    const ax = padL + ((clamp(zx, zLo, zHi) - zLo) / (zHi - zLo)) * (W - padL - padR);
    const ay = (H - padB) - ((clamp(zy, zLo, zHi) - zLo) / (zHi - zLo)) * (H - padT - padB);
    mk("circle", { cx: ax, cy: ay, r: 7, fill: c.main, opacity: 0.3 });
    mk("circle", { cx: ax, cy: ay, r: 4, fill: "#fff", stroke: c.main, "stroke-width": 2 });
    mk("text", { x: ax + 10, y: ay + 4, fill: c.main, "font-size": 11, "font-weight": 700, "font-family": "monospace" }).textContent = "you";
  }

  el.appendChild(svg);
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
  t: {
    sex: "M", bw: 90, target: 90,
    lifts: {
      squat: { weight: 160, reps: 3, rpe: 8 },
      bench: { weight: 110, reps: 3, rpe: 8 },
      deadlift: { weight: 200, reps: 3, rpe: 8 },
    },
    alloc: null,        // {squat,bench,deadlift} 1RM kg, holds total fixed
    allocKey: "",       // sex|bw|target fingerprint for auto-reset
  },
};

const LIFT_NAME = { squat: "squat", bench: "bench press", deadlift: "deadlift", total: "total" };
const LIFT_SHORT = { squat: "Squat", bench: "Bench", deadlift: "Deadlift", total: "Total" };

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
    if (outId) $(outId).textContent = $(id).value;
    render();
  });
}

/* ---------------- cross-lift equivalents ----------------
   Same percentile, same person → equivalent 1RM in every lift. */
function renderEquivTiles(elId, sex, bw, pct, reps, rpe, activeLift) {
  const el = $(elId);
  el.innerHTML = "";
  const c = sexC(sex);
  for (const lift of LIFTS3) {
    const oneRM = weightAtPercentile(sex, lift, bw, pct);
    const set = setWeightFor1RM(oneRM, reps, rpe);
    const tile = document.createElement("div");
    tile.className = "equiv-tile" + (lift === activeLift ? " equiv-tile-active" : "");
    if (lift === activeLift) {
      tile.style.borderColor = c.main;
      tile.style.background = `linear-gradient(135deg, ${c.main}22, ${c.alt}11)`;
    }
    tile.innerHTML =
      `<span class="tile-lift"${lift === activeLift ? ` style="color:${c.main}"` : ""}>${lift}</span>` +
      `<span class="tile-1rm">${toDisp(oneRM).toFixed(1)} <em>${unit}</em></span>` +
      `<span class="tile-set">${toDisp(set).toFixed(1)} × ${reps} @ ${rpe}</span>`;
    el.appendChild(tile);
  }
}

/* ---------------- compare mode ---------------- */
function renderCompare() {
  const { a, b } = state;
  const lift = state.lift;
  const ca = sexC(a.sex), cb = sexC(b.sex);

  // sex-driven paint
  paintSex($("card-a"), a.sex);
  paintSex($("card-b"), b.sex);
  paintBar($("a-bar"), a.sex);
  paintBar($("b-bar"), b.sex);
  gradText($("a-pct"), a.sex);
  $("badge-a").style.background = `linear-gradient(135deg, ${ca.main}, ${ca.alt})`;
  $("badge-b").style.background = `linear-gradient(135deg, ${cb.main}, ${cb.alt})`;

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

  renderEquivTiles("b-equiv-tiles", b.sex, b.bw, clamp(pct, 1, 99), b.reps, b.rpe, lift);

  // chart: required set weight vs reps (1..12), at B's bodyweight, B's RPE
  const reps = [], need = [];
  for (let r = 1; r <= 12; r++) {
    reps.push(r);
    need.push(setWeightFor1RM(b1rm, r, b.rpe));
  }
  lineChart($("compare-chart"), {
    series: [{ xs: reps, ys: need.map(toDisp), color: cb.main, color2: cb.alt, fill: true }],
    marker: { x: b.reps, y: toDisp(setWeightFor1RM(b1rm, b.reps, b.rpe)), color: cb.main, label: `${toDisp(bSet).toFixed(1)} ${unit} × ${b.reps}` },
    xLabel: "reps", yLabel: `set weight (${unit})`,
    fmtX: (v) => Math.round(v),
    fmtY: (v) => Math.round(v),
    tip: (x, i) => `${Math.round(x)} reps @ RPE ${b.rpe}<br>${need[i] !== undefined ? toDisp(need[i]).toFixed(1) : "—"} ${unit}`,
  });

  // heat map: if you matched A's percentile in this lift, where your other two land
  const [hx, hy] = OTHER_TWO[lift];
  $("compare-heat-sub").textContent =
    `if your ${LIFT_NAME[lift]} matched ${ordinal(pct)}, where your ${LIFT_NAME[hx]} & ${LIFT_NAME[hy]} most likely land (${b.sex === "M" ? "male" : "female"}, ${toDisp(b.bw).toFixed(0)} ${unit})`;
  heatMap($("compare-heat"), {
    sex: b.sex, bw: b.bw, fixedLift: lift, fixedPct: pct, axes: [hx, hy],
  });
}

/* ---------------- my percentile mode ---------------- */
function renderMe() {
  const m = state.m;
  const cm = sexC(m.sex);
  paintSex($("card-m"), m.sex);
  paintBar($("m-bar"), m.sex);
  gradText($("m-pct"), m.sex);
  $("badge-m").style.background = `linear-gradient(135deg, ${cm.main}, ${cm.alt})`;

  const oneRM = est1RM(m.weight, m.reps, m.rpe);
  const pct = percentileOf(m.sex, m.lift, m.bw, oneRM);

  $("m-1rm").textContent = fmtW(oneRM, 1);
  $("m-pct").textContent = ordinal(pct);
  $("m-pct-note").textContent =
    `of ${m.sex === "M" ? "male" : "female"} raw competitors near ${toDisp(m.bw).toFixed(0)} ${unit}`;
  $("m-bar").style.width = `${clamp(pct, 0, 100)}%`;

  renderEquivTiles("m-equiv-tiles", m.sex, m.bw, clamp(pct, 1, 99), m.reps, m.rpe, m.lift);

  // chart 1: 1RM needed at each percentile for this bw/sex/lift
  const ps = [], ws = [];
  for (let p = 1; p <= 99; p++) {
    ps.push(p);
    ws.push(weightAtPercentile(m.sex, m.lift, m.bw, p));
  }
  lineChart($("me-chart-curve"), {
    series: [{ xs: ps, ys: ws.map(toDisp), color: cm.main, color2: cm.alt, fill: true }],
    marker: { x: clamp(pct, 1, 99), y: toDisp(oneRM), color: cm.main, label: `you — ${ordinal(pct)}` },
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

  // chart 2: percentile of the current 1RM at every bodyweight
  const grid = gridFor(m.sex, m.lift);
  const bws = [], ps2 = [];
  for (let bw = grid[0]; bw <= grid[grid.length - 1] + 1e-9; bw += 1) {
    bws.push(bw);
    ps2.push(percentileOf(m.sex, m.lift, bw, oneRM));
  }
  lineChart($("me-chart-bw"), {
    series: [{ xs: bws.map(toDisp), ys: ps2, color: cm.alt, color2: cm.main, fill: true }],
    marker: {
      x: toDisp(clamp(m.bw, grid[0], grid[grid.length - 1])),
      y: pct,
      color: cm.main,
      label: `you — ${ordinal(pct)} @ ${toDisp(m.bw).toFixed(1)} ${unit}`,
    },
    xLabel: `bodyweight (${unit})`, yLabel: "percentile",
    fmtX: (v) => Math.round(v),
    fmtY: (v) => Math.round(v),
    tip: (x, i) => `at ${x.toFixed(0)} ${unit} bodyweight<br>your ${fmtW(oneRM, 0)} 1RM = ${ordinal(ps2[i])} percentile`,
  });

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

  // heat map: where the other two lifts most likely land given this lift
  const [hx, hy] = OTHER_TWO[m.lift];
  $("me-heat-sub").textContent =
    `given your ${ordinal(pct)} ${LIFT_NAME[m.lift]}, where your ${LIFT_NAME[hx]} & ${LIFT_NAME[hy]} most likely land`;
  heatMap($("me-heat"), {
    sex: m.sex, bw: m.bw, fixedLift: m.lift, fixedPct: pct, axes: [hx, hy],
  });
}

/* ---------------- total mode ---------------- */
function lift1RM(L) { return est1RM(L.weight, L.reps, L.rpe); }

/** reset the maintain-allocator to "each lift at the target percentile". */
function resetAlloc(t) {
  t.alloc = {};
  for (const lift of LIFTS3) t.alloc[lift] = weightAtPercentile(t.sex, lift, t.bw, t.target);
  t.allocKey = `${t.sex}|${t.bw.toFixed(2)}|${t.target}`;
}

/** move `changed` lift to newVal (kg); the other two absorb the opposite
    delta equally so the total stays fixed, clamped to the p1..p99 range. */
function redistribute(t, changed, newVal) {
  const a = t.alloc;
  const lo = (l) => weightAtPercentile(t.sex, l, t.bw, 1);
  const hi = (l) => weightAtPercentile(t.sex, l, t.bw, 99);
  newVal = clamp(newVal, lo(changed), hi(changed));
  let give = a[changed] - newVal;   // amount to spread onto the others (kg)
  a[changed] = newVal;
  const others = LIFTS3.filter((l) => l !== changed);
  let rem = give;
  others.forEach((l, i) => {
    const share = rem / (others.length - i);
    const nv = clamp(a[l] + share, lo(l), hi(l));
    rem -= (nv - a[l]);
    a[l] = nv;
  });
  // any leftover (everything clamped) goes back to the lift we moved
  if (Math.abs(rem) > 1e-6) a[changed] = clamp(a[changed] + rem, lo(changed), hi(changed));
}

function renderTotal() {
  const t = state.t;
  const ct = sexC(t.sex);
  paintSex($("card-t"), t.sex);
  paintSex($("card-maintain"), t.sex);
  paintBar($("t-bar"), t.sex);
  gradText($("t-pct"), t.sex);
  $("badge-t").style.background = `linear-gradient(135deg, ${ct.main}, ${ct.alt})`;

  // --- entered lifts → total percentile ---
  let total = 0;
  const oneRMs = {};
  for (const lift of LIFTS3) {
    const o = lift1RM(t.lifts[lift]);
    oneRMs[lift] = o;
    total += o;
    const p = percentileOf(t.sex, lift, t.bw, o);
    $(`t-${lift}-pct`).textContent = ordinal(p);
    $(`t-${lift}-1rm`).textContent = `${toDisp(o).toFixed(0)} ${unit} 1RM`;
  }
  const totalPct = percentileOf(t.sex, "total", t.bw, total);
  $("t-1rm").textContent = fmtW(total, 0);
  $("t-pct").textContent = ordinal(totalPct);
  $("t-pct-note").textContent =
    `S+B+D total of ${t.sex === "M" ? "male" : "female"} raw competitors near ${toDisp(t.bw).toFixed(0)} ${unit}`;
  $("t-bar").style.width = `${clamp(totalPct, 0, 100)}%`;

  // --- maintain-percentile allocator ---
  const key = `${t.sex}|${t.bw.toFixed(2)}|${t.target}`;
  if (!t.alloc || t.allocKey !== key) resetAlloc(t);

  const allocTotal = LIFTS3.reduce((s, l) => s + t.alloc[l], 0);
  const allocPct = percentileOf(t.sex, "total", t.bw, allocTotal);
  $("maintain-total").textContent = fmtW(allocTotal, 0);
  $("maintain-total-pct").textContent = ordinal(allocPct);

  for (const lift of LIFTS3) {
    const o = t.alloc[lift];
    const p = percentileOf(t.sex, lift, t.bw, o);
    const lo = weightAtPercentile(t.sex, lift, t.bw, 1);
    const hi = weightAtPercentile(t.sex, lift, t.bw, 99);
    const sl = $(`alloc-${lift}-slider`);
    sl.min = toDisp(lo).toFixed(1);
    sl.max = toDisp(hi).toFixed(1);
    sl.step = unit === "kg" ? 2.5 : 5;
    sl.value = toDisp(o).toFixed(1);
    $(`alloc-${lift}-val`).textContent = fmtW(o, 0);
    $(`alloc-${lift}-pct`).textContent = ordinal(p);
    const bar = $(`alloc-${lift}-bar`);
    bar.style.width = `${clamp(p, 0, 100)}%`;
    paintBar(bar, t.sex);
  }
  $("maintain-note").innerHTML =
    `Holding a <strong>${ordinal(t.target)}</strong> total (<strong>${fmtW(allocTotal, 0)}</strong>): ` +
    `drag any lift and the other two move to keep the total fixed. ` +
    `A bigger squat &ldquo;buys&rdquo; a smaller bench &amp; deadlift, and vice-versa.`;
}

/* ---------------- mode dispatch ---------------- */
function renderAll() {
  if (state.mode === "compare") renderCompare();
  else if (state.mode === "me") renderMe();
  else renderTotal();
}

/* ---------------- init ---------------- */
function refreshNumberInputs() {
  $("a-bw").value = +toDisp(state.a.bw).toFixed(1);
  $("a-weight").value = +toDisp(state.a.weight).toFixed(1);
  $("b-bw").value = +toDisp(state.b.bw).toFixed(1);
  $("m-bw").value = +toDisp(state.m.bw).toFixed(1);
  $("m-weight").value = +toDisp(state.m.weight).toFixed(1);
  $("t-bw").value = +toDisp(state.t.bw).toFixed(1);
  for (const lift of LIFTS3) {
    $(`t-${lift}-weight`).value = +toDisp(state.t.lifts[lift].weight).toFixed(1);
  }
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

  // unit toggle (persisted across visits)
  const setUnit = (u) => {
    unit = u;
    document.querySelectorAll("#unitToggle button").forEach((b) =>
      b.classList.toggle("active", b.dataset.unit === u));
    try { localStorage.setItem("ironpct-unit", u); } catch (e) { /* private mode */ }
    refreshNumberInputs();
    renderAll();
  };
  document.querySelectorAll("#unitToggle button").forEach((btn) => {
    btn.addEventListener("click", () => setUnit(btn.dataset.unit));
  });
  try {
    const saved = localStorage.getItem("ironpct-unit");
    if (saved === "lb" || saved === "kg") setUnit(saved);
  } catch (e) { /* private mode */ }

  segInit("a-sex", (v) => { state.a.sex = v; renderAll(); });
  segInit("b-sex", (v) => { state.b.sex = v; renderAll(); });
  segInit("lift", (v) => { state.lift = v; renderAll(); });
  segInit("m-sex", (v) => { state.m.sex = v; renderAll(); });
  segInit("m-lift", (v) => { state.m.lift = v; renderAll(); });
  segInit("t-sex", (v) => { state.t.sex = v; renderAll(); });

  bindNum("a-bw", state.a, "bw", renderAll);
  bindNum("a-weight", state.a, "weight", renderAll);
  bindNum("b-bw", state.b, "bw", renderAll);
  bindNum("m-bw", state.m, "bw", renderAll);
  bindNum("m-weight", state.m, "weight", renderAll);
  bindNum("t-bw", state.t, "bw", renderAll);

  bindSlider("a-reps", "a-reps-out", state.a, "reps", renderAll);
  bindSlider("a-rpe", "a-rpe-out", state.a, "rpe", renderAll);
  bindSlider("b-reps", "b-reps-out", state.b, "reps", renderAll);
  bindSlider("b-rpe", "b-rpe-out", state.b, "rpe", renderAll);
  bindSlider("m-reps", "m-reps-out", state.m, "reps", renderAll);
  bindSlider("m-rpe", "m-rpe-out", state.m, "rpe", renderAll);
  bindSlider("m-target", "m-target-out", state.m, "target", renderAll);

  // total mode: three lift entries
  for (const lift of LIFTS3) {
    bindNum(`t-${lift}-weight`, state.t.lifts[lift], "weight", renderAll);
    bindSlider(`t-${lift}-reps`, `t-${lift}-reps-out`, state.t.lifts[lift], "reps", renderAll);
    bindSlider(`t-${lift}-rpe`, `t-${lift}-rpe-out`, state.t.lifts[lift], "rpe", renderAll);
  }
  bindSlider("t-target", "t-target-out", state.t, "target", () => {
    resetAlloc(state.t);   // new target → fresh balanced allocation
    renderAll();
  });
  // maintain allocator sliders (operate in display units)
  for (const lift of LIFTS3) {
    $(`alloc-${lift}-slider`).addEventListener("input", (e) => {
      if (!state.t.alloc) resetAlloc(state.t);
      redistribute(state.t, lift, fromDisp(parseFloat(e.target.value)));
      renderTotal();
    });
  }

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
  module.exports = { repPct, est1RM, percentileOf, weightAtPercentile, bodyweightForPercentile, probit, normCdf, rowAt };
}
