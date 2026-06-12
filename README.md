# Iron Percentile — powerlifting strength comparison

A dark, dependency-free web app that ranks bench / squat / deadlift strength
against **500k+ real competition lifters** from the
[OpenPowerlifting database](https://www.kaggle.com/datasets/open-powerlifting/powerlifting-database)
and translates strength **across sex and bodyweight** via percentiles.

## Run it

```
cd app
python3 -m http.server 8000   # or: npx http-server
```

…or just open `app/index.html` directly in a browser — no build step, no
server, no dependencies.

## Modes

### ⇄ Compare
Enter **Lifter A** (sex, bodyweight, lift, set weight × reps @ RPE). The app
estimates their 1RM, finds their percentile among raw competitors of the same
sex near that bodyweight, then tells **Lifter B** (you — your sex and
bodyweight) exactly what set you'd need (weight × reps @ RPE, reps on a
slider) to sit at the *same percentile* of your own population. A continuous
chart shows the required set weight for every rep count.

### ◎ My Percentile
Enter one hard set (weight × reps @ RPE) plus sex and bodyweight. You get:

- estimated 1RM and your percentile,
- a continuous **strength curve**: the 1RM needed at *every* percentile for
  your bodyweight, with you marked on it, plus a target-percentile slider
  ("p90 = X kg 1RM = Y kg × N @ RPE"),
- a **bodyweight leverage** curve: the bodyweight at which your *current*
  1RM would sit at each percentile (i.e. what you'd have to weigh to be a
  p90 lifter at today's strength).

Everything supports kg/lb toggling.

## Methodology

- **Ground truth**: full OpenPowerlifting dump (2.78M meet entries).
  Filtered to raw (unequipped) M/F entries with valid bodyweight; one data
  point per lifter per lift — their best competition single (~860k
  lifter-lift points: 167k/261k/201k male and 75k/95k/86k female lifters for
  squat/bench/deadlift).
- **Percentile tables** (`app/percentiles.json|.js`): quantiles 1–99 of best
  lift, computed on a 2.5 kg bodyweight grid using a ±3.75 kg rolling window
  (auto-widened where data is sparse), smoothed along the bodyweight axis and
  forced monotone. The app interpolates bilinearly — percentile↔weight in
  both directions, and inverts along the bodyweight axis for the leverage
  curve.
- **1RM estimation**: RTS-style RPE percentage chart (reps 1–12 × RPE 6–10),
  linearly extended beyond the chart.
- **Caveat**: percentiles are relative to *competitive powerlifters*, not
  the general population. A p50 here is already a strong human.

## Rebuilding the data

```
# get the full dataset (Kaggle "Powerlifting Database" or openpowerlifting.org)
python3 data-pipeline/build_percentiles.py /path/to/openpowerlifting.csv
```

Writes `app/percentiles.json` and `app/percentiles.js` (~125 KB each).

## Layout

```
app/                  the app (open index.html)
  index.html
  style.css
  app.js              engine (RPE chart, percentile interpolation) + UI + SVG charts
  percentiles.js(on)  precomputed quantile tables
data-pipeline/
  build_percentiles.py
```
