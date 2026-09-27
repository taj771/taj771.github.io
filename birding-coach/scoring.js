// Birding Coach scoring, ported line for line from serve/score.ts in
// github.com/taj771/birding-coach. The fitted model is a lookup table plus a
// sum, so a static page can run it with no server and no ML runtime.
//
// Keep this in step with score.ts. Term names must match pipeline/publish.py:
//   intercept, log_dur, log_dist, n_observers, traveling,
//   wind_max, temp_mean, precip_sum, cloud_mean,
//   hour_06 .. hour_20, week_00 .. week_52, site_<locId>, site_PERSONAL,
//   support_06 .. support_21, meta_*

const pad = n => String(n).padStart(2, "0");

/** Week index must match Python's `doy // 7`. */
export function weekOf(d) {
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const doy = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(),
                                   d.getUTCDate()) - start) / 86_400_000);
  return Math.floor(doy / 7);
}

/**
 * Why a cell cannot be scored, or null when it can. A missing week term is
 * not "an average week": reading it as 0 would silently drop seasonality,
 * which is most of what the model knows about migrants.
 */
export function unavailable(c, date, hour, minSupport = 50) {
  if ((c[`support_${pad(hour)}`] ?? 0) < minSupport) return "hour";
  if (c[`week_${pad(weekOf(date))}`] === undefined) return "week";
  return null;
}

/** P(reported) for one outing, or null when the model cannot back a number. */
export function score(c, date, hour, o, w, locId, minSupport = 50) {
  if (unavailable(c, date, hour, minSupport)) return null;

  // a known hotspot uses its own effect; anywhere else falls back to the
  // pooled baseline
  const site = (locId && c[`site_${locId}`] !== undefined)
    ? c[`site_${locId}`]
    : (c.site_PERSONAL ?? 0);

  const logit =
    (c.intercept ?? 0) +
    (c[`hour_${pad(hour)}`] ?? 0) +
    (c[`week_${pad(weekOf(date))}`] ?? 0) +
    site +
    (c.log_dur ?? 0) * Math.log(o.durationHrs) +
    (c.log_dist ?? 0) * Math.log1p(o.distanceKm) +
    (c.n_observers ?? 0) * o.observers +
    (c.traveling ?? 0) * (o.traveling ? 1 : 0) +
    (c.wind_max ?? 0) * w.windMax +
    (c.temp_mean ?? 0) * w.tempMean +
    (c.precip_sum ?? 0) * w.precipSum +
    (c.cloud_mean ?? 0) * w.cloudMean;

  return 1 / (1 + Math.exp(-logit));
}

/**
 * Weather over the hours an outing spans, from an Open-Meteo hourly block.
 * Wind is the MAX, not the mean — the same aggregation the training table
 * used (build_model_table.py), because a gust that masks birdsong matters
 * more than the average across two hours.
 */
export function outingWeather(hourly, day, hour, durationHrs) {
  const want = new Set();
  for (let i = 0; i < Math.max(1, Math.ceil(durationHrs)); i++) {
    want.add(`${day}T${pad(hour + i)}:00`);
  }
  const idx = [];
  hourly.time.forEach((t, i) => { if (want.has(t)) idx.push(i); });
  if (!idx.length) return null;          // outside the forecast horizon

  const pick = k => idx.map(i => hourly[k][i]);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  return {
    windMax: Math.max(...pick("wind_speed_10m")),
    tempMean: mean(pick("temperature_2m")),
    precipSum: pick("precipitation").reduce((x, y) => x + y, 0),
    cloudMean: mean(pick("cloud_cover")),
  };
}
