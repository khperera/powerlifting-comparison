#!/usr/bin/env python3
"""Build percentile lookup tables from the OpenPowerlifting dataset.

Input:  openpowerlifting.csv (the full OpenPowerlifting / Kaggle dump)
Output: ../app/percentiles.json

Methodology
-----------
- Raw (unequipped) entries only, tested + untested federations.
- One data point per lifter per lift: their best competition single
  (Best3*Kg) along with the bodyweight at that meet.
- For a grid of bodyweights we take all lifters within a +/- window of
  that bodyweight and compute quantiles 1..99 of their best lift.
- Quantiles are forced monotone in both the percentile axis and
  (lightly smoothed) along the bodyweight axis.
"""

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

CSV = sys.argv[1] if len(sys.argv) > 1 else "/tmp/openpowerlifting.csv"
OUT = Path(__file__).resolve().parent.parent / "app" / "percentiles.json"

LIFTS = {
    "squat": "Best3SquatKg",
    "bench": "Best3BenchKg",
    "deadlift": "Best3DeadliftKg",
}

# Bodyweight grid (kg) and half-window for the rolling quantile pool.
GRIDS = {
    "M": np.arange(50, 152.5, 2.5),
    "F": np.arange(40, 122.5, 2.5),
}
HALF_WINDOW = 3.75  # kg each side -> 7.5 kg pool per grid point
PCTS = np.arange(1, 100)  # 1..99

usecols = ["Name", "Sex", "Equipment", "BodyweightKg"] + list(LIFTS.values())
print("Loading CSV ...", flush=True)
df = pd.read_csv(CSV, usecols=usecols, low_memory=False)
print(f"  {len(df):,} rows total")

df = df[df["Sex"].isin(["M", "F"])]
df = df[df["Equipment"] == "Raw"]
df = df[(df["BodyweightKg"] > 25) & (df["BodyweightKg"] < 250)]
print(f"  {len(df):,} raw M/F rows with valid bodyweight")

result = {}
counts = {}
for sex in ["M", "F"]:
    sub = df[df["Sex"] == sex]
    result[sex] = {}
    counts[sex] = {}
    grid = GRIDS[sex]
    for lift, col in LIFTS.items():
        d = sub[(sub[col] > 0)][["Name", "BodyweightKg", col]].dropna()
        # Best entry per lifter (their PR), bodyweight from that meet.
        idx = d.groupby("Name")[col].idxmax()
        d = d.loc[idx]
        counts[sex][lift] = int(len(d))
        print(f"{sex} {lift}: {len(d):,} lifters", flush=True)

        bw = d["BodyweightKg"].to_numpy()
        w = d[col].to_numpy()
        order = np.argsort(bw)
        bw, w = bw[order], w[order]

        table = np.empty((len(grid), len(PCTS)))
        for i, g in enumerate(grid):
            lo = np.searchsorted(bw, g - HALF_WINDOW, "left")
            hi = np.searchsorted(bw, g + HALF_WINDOW, "right")
            pool = w[lo:hi]
            if len(pool) < 50:  # widen window at sparse extremes
                lo = np.searchsorted(bw, g - 3 * HALF_WINDOW, "left")
                hi = np.searchsorted(bw, g + 3 * HALF_WINDOW, "right")
                pool = w[lo:hi]
            table[i] = np.percentile(pool, PCTS)

        # Light smoothing along the bodyweight axis (3-point moving avg).
        sm = table.copy()
        sm[1:-1] = (table[:-2] + table[1:-1] + table[2:]) / 3
        # Enforce monotone non-decreasing along percentile axis.
        sm = np.maximum.accumulate(sm, axis=1)
        result[sex][lift] = {
            "bw": [round(float(x), 1) for x in grid],
            "q": [[round(float(v), 1) for v in row] for row in sm],
        }

out = {
    "meta": {
        "source": "OpenPowerlifting dataset (openpowerlifting.org), raw entries, best lift per lifter",
        "pcts": [int(p) for p in PCTS],
        "halfWindowKg": HALF_WINDOW,
        "counts": counts,
    },
    "data": result,
}
OUT.write_text(json.dumps(out, separators=(",", ":")))
print(f"Wrote {OUT} ({OUT.stat().st_size/1024:.0f} KB)")

# Also emit a JS module so the app works when opened directly from file://
js_out = OUT.with_suffix(".js")
js_out.write_text("const PERCENTILE_DATA = " + json.dumps(out, separators=(",", ":")) + ";\n")
print(f"Wrote {js_out} ({js_out.stat().st_size/1024:.0f} KB)")
