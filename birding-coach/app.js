// Live forecast for the Birding Coach page.
//
// Everything here is fetched from public sources at page load, so the page
// never needs redeploying to stay current:
//   - coefficients, hotspots, calibration: the public Hugging Face dataset the
//     monthly refit publishes to (CORS allows this origin; no token needed)
//   - status.json: aggregate counts the daily scrape publishes beside them
//   - weather: the Open-Meteo forecast, fetched per visit
//   - pipeline health: the public GitHub Actions API
import { score, unavailable, outingWeather, weekOf } from "./scoring.js";

const HF = "https://huggingface.co/datasets/taj771/birding-coach-model/resolve/main/";
const RUNS = "https://api.github.com/repos/taj771/birding-coach/actions/workflows/pipeline.yml/runs?per_page=10";
// Hours in the checklists are local clock time, so the forecast must be too.
// Every hotspot is in Pennsylvania, so one zone covers them all.
const TZ = "America/New_York";
const HOURS = Array.from({ length: 15 }, (_, i) => i + 6);   // 06:00 .. 20:00
// The outing the app assumes when nobody has said otherwise.
const OUTING = { distanceKm: 1, observers: 1, traveling: true };
// Used only when the forecast cannot be fetched, and the page says so.
const TYPICAL_WX = { windMax: 12, tempMean: 15, precipSum: 0, cloudMean: 50 };
// A year-round bird whose chances sit mid-range in every season and swing
// strongly by hour, so the first thing a visitor sees shows "when" matters.
// Blue Jay, the first choice, sits at 92-99% everywhere in autumn and makes
// the grid a solid block that says nothing.
const DEFAULT_SPECIES = "tuftit";

const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, "0");
const pct = p => p < 0.01 ? "<1%" : `${Math.round(p * 100)}%`;
const fmt = n => Number(n).toLocaleString("en-US");

const state = {
  meta: null, hotspots: [], species: [], photos: {}, calibration: null,
  coef: null, code: null, days: [], dayIdx: 0, hour: 8, dur: 1, loc: null,
  cells: new Map(),          // cell key -> Open-Meteo hourly block
  forecastOk: false,
};
const coefCache = new Map();

// ── helpers ──────────────────────────────────────────────────────────────

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function niceDate(iso) {
  return new Date(iso).toLocaleDateString("en-US",
    { month: "short", day: "numeric", year: "numeric" });
}

// The sequential ramp is read from CSS so light and dark mode each use their
// own steps rather than an automatic flip.
function ramp() {
  const cs = getComputedStyle(document.documentElement);
  const hex = v => {
    const h = cs.getPropertyValue(v).trim().replace("#", "");
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  };
  const lo = hex("--seq-lo"), hi = hex("--seq-hi");
  return t => `rgb(${lo.map((v, i) => Math.round(v + (hi[i] - v) * t)).join(",")})`;
}
const cssVar = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const isDark = () => matchMedia("(prefers-color-scheme: dark)").matches
  && document.documentElement.dataset.theme !== "light"
  || document.documentElement.dataset.theme === "dark";

const cellKey = (lat, lon) =>
  `${(Math.round(lat * 4) / 4).toFixed(2)},${(Math.round(lon * 4) / 4).toFixed(2)}`;

// ── tooltip shared by the grid and the chart ─────────────────────────────

const tip = $("tip");
function showTip(e, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
  const y = Math.min(e.clientY + 14, innerHeight - tip.offsetHeight - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
const hideTip = () => { tip.hidden = true; };

// ── map ──────────────────────────────────────────────────────────────────

let map, tiles, markers = [];

// Standard OpenStreetMap tiles; dark mode dims them with a CSS filter on the
// tile pane rather than swapping providers (CARTO's free basemaps now need a
// key and render a watermark without one).
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

function initMap() {
  const e = state.meta.extent;
  map = L.map("map", { scrollWheelZoom: false, zoomSnap: 0.25 })
    .fitBounds([[e.latMin, e.lonMin], [e.latMax, e.lonMax]], { padding: [10, 10] });
  tiles = L.tileLayer(TILE_URL, {
    maxZoom: 16,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  markers = state.hotspots.map(h => {
    const m = L.circleMarker([h.latitude, h.longitude], {
      radius: 7, weight: 1.5, color: cssVar("--dot-ring"), fillOpacity: 1,
    }).addTo(map);
    m.on("click", () => selectLoc(h.loc_id));
    return m;
  });
}

// ── weather ──────────────────────────────────────────────────────────────

// One request for every 0.25° cell that holds a hotspot, rather than one per
// hotspot: neighbouring hotspots share a forecast grid cell anyway.
async function loadForecast() {
  const keys = [...new Set(state.hotspots.map(h => cellKey(h.latitude, h.longitude)))];
  const lat = keys.map(k => k.split(",")[0]).join(",");
  const lon = keys.map(k => k.split(",")[1]).join(",");
  const url = "https://api.open-meteo.com/v1/forecast"
    + `?latitude=${lat}&longitude=${lon}`
    + "&hourly=temperature_2m,precipitation,wind_speed_10m,cloud_cover"
    + `&forecast_days=8&timezone=${encodeURIComponent(TZ)}`;
  try {
    let res = await getJSON(url);
    if (!Array.isArray(res)) res = [res];
    keys.forEach((k, i) => state.cells.set(k, res[i].hourly));
    const times = res[0].hourly.time;
    state.days = [...new Set(times.map(t => t.slice(0, 10)))].slice(0, 7);
    state.forecastOk = true;
    $("st-wx").innerHTML = `Weather: <b>Open-Meteo forecast</b>, fetched ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  } catch (err) {
    // Without a forecast the map can still show the seasonal and hourly
    // pattern, as long as it says plainly that the weather is a placeholder.
    const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
    state.days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });
    $("st-wx").innerHTML = `Weather: <b>forecast unavailable</b>, using typical conditions`;
  }
}

function weatherFor(h, day, hour) {
  if (!state.forecastOk) return TYPICAL_WX;
  const hourly = state.cells.get(cellKey(h.latitude, h.longitude));
  return hourly ? outingWeather(hourly, day, hour, state.dur) : null;
}

// ── scoring and rendering ────────────────────────────────────────────────

const dayDate = day => new Date(day + "T12:00:00Z");

function scoreAt(h, day, hour) {
  const w = weatherFor(h, day, hour);
  if (!w) return null;
  return score(state.coef, dayDate(day), hour,
               { ...OUTING, durationHrs: state.dur }, w, h.loc_id);
}

function renderMap() {
  const day = state.days[state.dayIdx];
  const why = unavailable(state.coef, dayDate(day), state.hour);
  const color = ramp();
  const na = cssVar("--na");
  const name = speciesName(state.code);

  $("msg").textContent =
    why === "hour" ? `Too few checklists at ${pad(state.hour)}:00 for ${name} to back a number. Try another hour.`
    : why === "week" ? `The model has no seasonal term for week ${weekOf(dayDate(day))}, so it will not guess.`
    : "";

  const scored = state.hotspots.map(h => ({ h, p: why ? null : scoreAt(h, day, state.hour) }));
  const ps = scored.map(s => s.p).filter(p => p !== null);
  const lo = Math.min(...ps), hi = Math.max(...ps);

  scored.forEach(({ h, p }, i) => {
    const t = p === null ? 0 : (hi > lo ? (p - lo) / (hi - lo) : 1);
    markers[i].setStyle({
      fillColor: p === null ? na : color(t),
      color: cssVar("--dot-ring"),
      radius: h.loc_id === state.loc ? 10 : 7,
      weight: h.loc_id === state.loc ? 3 : 1.5,
    });
    markers[i].unbindTooltip().bindTooltip(
      `<b>${h.name}</b><br>${p === null ? "no estimate" : `${pct(p)} chance you report ${name}`}`
      + `<br><span style="opacity:.7">${fmt(h.n_checklists)} checklists</span>`,
      { direction: "top", offset: [0, -6] });
    if (h.loc_id === state.loc) markers[i].bringToFront();
  });

  $("lg-lo").textContent = ps.length ? pct(lo) : "–";
  $("lg-hi").textContent = ps.length ? pct(hi) : "–";

  const top = scored.filter(s => s.p !== null).sort((a, b) => b.p - a.p).slice(0, 5);
  $("top5").innerHTML = top.map(s =>
    `<li data-loc="${s.h.loc_id}"><span>${s.h.name}</span><span>${pct(s.p)}</span></li>`).join("")
    || `<li style="cursor:default"><span>–</span><span></span></li>`;
  $("top5").querySelectorAll("li[data-loc]").forEach(li =>
    li.addEventListener("click", () => selectLoc(li.dataset.loc, true)));

  // first render: open the grid on the best hotspot so the "when" view is
  // visible without anyone having to discover that dots are clickable
  if (!state.loc && top.length) state.loc = top[0].h.loc_id;
  renderWhen();
}

// The day x hour grid for one hotspot: the question the project answers.
function renderWhen() {
  const h = state.hotspots.find(x => x.loc_id === state.loc);
  if (!h) { $("when").hidden = true; return; }
  $("when").hidden = false;
  const name = speciesName(state.code);
  const siteSpecific = state.coef[`site_${h.loc_id}`] !== undefined;
  $("when-title").textContent = `When to go: ${h.name}`;
  $("when-sub").textContent = `${name}, ${state.dur === 0.5 ? "30 minutes" : state.dur === 1 ? "one hour" : "two hours"} of birding. `
    + `${fmt(h.n_checklists)} checklists here${siteSpecific ? "" : "; no site-specific term, so this uses the pooled baseline"}. Darker = better within this week. Click a cell to put it on the map.`;

  const grid = state.days.map(day => HOURS.map(hr => scoreAt(h, day, hr)));
  const all = grid.flat().filter(p => p !== null);
  // Stretched from this hotspot's worst hour to its best, like the map: a
  // scale anchored at zero turns a 92-99% week into one flat colour, and the
  // difference between hours is the whole point of the grid. The tooltip and
  // the line below carry the absolute numbers.
  const max = all.length ? Math.max(...all) : 0;
  const min = all.length ? Math.min(...all) : 0;
  const t = p => max > min ? (p - min) / (max - min) : 1;
  let best = null;
  grid.forEach((row, di) => row.forEach((p, hi) => {
    if (p !== null && (!best || p > best.p)) best = { p, di, hr: HOURS[hi] };
  }));
  const color = ramp();

  const dayLabel = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US",
    { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  let html = `<thead><tr><th></th>${HOURS.map(hr => `<th scope="col">${hr}</th>`).join("")}</tr></thead><tbody>`;
  grid.forEach((row, di) => {
    html += `<tr><th scope="row">${dayLabel(state.days[di])}</th>`;
    row.forEach((p, hi) => {
      const hr = HOURS[hi];
      const cls = [p === null ? "na" : "",
                   di === state.dayIdx && hr === state.hour ? "sel" : "",
                   best && di === best.di && hr === best.hr ? "best" : ""].join(" ").trim();
      const bg = p === null ? "" : `background:${color(t(p))}`;
      html += `<td class="${cls}" style="${bg}" data-d="${di}" data-h="${hr}" data-p="${p ?? ""}">${best && di === best.di && hr === best.hr ? pct(p) : ""}</td>`;
    });
    html += "</tr>";
  });
  $("heat").innerHTML = html + "</tbody>";
  $("heat").setAttribute("aria-label", `Chance of reporting ${name} at ${h.name}, by day and start hour`);

  $("best-line").innerHTML = best
    ? `Best in the next week: <b>${dayLabel(state.days[best.di])}, ${pad(best.hr)}:00</b> at <b>${pct(best.p)}</b>.`
      + (all.length ? ` The worst hour shown is ${pct(Math.min(...all))}.` : "")
    : "The model cannot back a number for any hour this week.";

  $("heat").querySelectorAll("td").forEach(td => {
    td.addEventListener("mousemove", e => {
      const di = +td.dataset.d, hr = +td.dataset.h;
      showTip(e, `${dayLabel(state.days[di])}, ${pad(hr)}:00<br><b>${td.dataset.p === "" ? "no estimate" : pct(+td.dataset.p)}</b>`);
    });
    td.addEventListener("mouseleave", hideTip);
    if (!td.classList.contains("na")) td.addEventListener("click", () => {
      state.dayIdx = +td.dataset.d;
      state.hour = +td.dataset.h;
      syncControls();
      renderMap();
    });
  });
}

function selectLoc(loc, pan) {
  state.loc = loc;
  const h = state.hotspots.find(x => x.loc_id === loc);
  if (pan && h) map.panTo([h.latitude, h.longitude]);
  renderMap();
}

// ── controls ─────────────────────────────────────────────────────────────

const speciesName = code => state.species.find(s => s.species_code === code)?.common_name ?? code;

function syncControls() {
  $("hour").value = state.hour;
  $("hourval").textContent = `${pad(state.hour)}:00`;
  $("days").querySelectorAll("button").forEach((b, i) =>
    b.setAttribute("aria-pressed", String(i === state.dayIdx)));
  $("durs").querySelectorAll("button").forEach(b =>
    b.setAttribute("aria-pressed", String(+b.dataset.d === state.dur)));
}

function buildControls() {
  const sel = $("species");
  sel.innerHTML = [...state.species]
    .sort((a, b) => a.common_name.localeCompare(b.common_name))
    .map(s => `<option value="${s.species_code}">${s.common_name}</option>`).join("");
  sel.value = state.code;
  sel.disabled = false;
  sel.addEventListener("change", () => setSpecies(sel.value));

  $("days").innerHTML = state.days.map((d, i) => {
    const dt = new Date(d + "T12:00:00Z");
    const wd = i === 0 ? "Today" : dt.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
    return `<button aria-pressed="${i === 0}" aria-label="${dt.toDateString()}">${wd}<b>${dt.getUTCDate()}</b></button>`;
  }).join("");
  $("days").querySelectorAll("button").forEach((b, i) =>
    b.addEventListener("click", () => { state.dayIdx = i; syncControls(); renderMap(); }));

  $("hour").addEventListener("input", e => {
    state.hour = +e.target.value; syncControls(); renderMap();
  });
  $("durs").querySelectorAll("button").forEach(b =>
    b.addEventListener("click", () => { state.dur = +b.dataset.d; syncControls(); renderMap(); }));
}

function renderPhoto() {
  const p = state.photos[state.code]?.main?.[0];
  $("photo").innerHTML = p
    ? `<img src="${p.url}" alt="${speciesName(state.code)}" loading="lazy"><span class="cap"><b>${speciesName(state.code)}</b>${p.attribution}</span>`
    : `<span class="cap"><b>${speciesName(state.code)}</b></span>`;
}

async function setSpecies(code) {
  state.code = code;
  const u = new URL(location.href);
  u.searchParams.set("species", code);
  history.replaceState(null, "", u);
  if (!coefCache.has(code)) coefCache.set(code, await getJSON(`${HF}coef/${code}.json`));
  state.coef = coefCache.get(code);
  renderPhoto();
  renderMap();
  renderEval();
}

// ── status strip ─────────────────────────────────────────────────────────

async function loadStatus() {
  const m = state.meta;
  $("st-fit").innerHTML = `Model: <b>${m.species}</b> species, <b>${m.hotspots}</b> hotspots, fitted ${niceDate(m.fitted_at)}`;

  getJSON(RUNS).then(r => {
    const done = r.workflow_runs.find(x => x.status === "completed");
    const running = r.workflow_runs.some(x => x.status !== "completed");
    if (!done) return;
    const ok = done.conclusion === "success";
    $("st-run").innerHTML = `<span class="pulse ${ok ? "ok" : "fail"}"></span>`
      + `Pipeline <a href="${done.html_url}" target="_blank" rel="noopener"><b>${ok ? "passed" : done.conclusion}</b></a> ${ago(done.updated_at)}`
      + (running ? " · running now" : "");
  }).catch(() => { $("st-run").innerHTML = `<span class="pulse"></span>Pipeline status unavailable`; });

  // status.json appears once the scrape has published it; absent is not an
  // error, just less to say
  getJSON(`${HF}status.json`).then(s => {
    state.status = s;
    $("st-data").innerHTML = `Data: <b>${fmt(s.counts.checklists)}</b> checklists, <b>${fmt(s.counts.observations)}</b> observations through ${niceDate(s.obs_dates.last + "T12:00:00Z")}`;
    renderTiles();
  }).catch(() => {});
}

// ── evaluation section ───────────────────────────────────────────────────

function renderTiles() {
  const c = state.calibration;
  if (!c) return;
  const tiles = [
    [fmt(c.held_out_checklists), "held-out checklists scored"],
    [c.species_scored, "species evaluated"],
    [`${(c.mean_decile_gap * 100).toFixed(1)} pts`, "mean gap between predicted and observed rate"],
    [c.verdict, "calibration verdict"],
  ];
  if (state.status) tiles.push([fmt(state.status.species_seen), "species seen in the checklists so far"]);
  $("tiles").innerHTML = tiles.map(([v, k]) => `<div class="tile"><div class="v">${v}</div><div class="k">${k}</div></div>`).join("");
  $("eval-note").textContent = `evaluates the model fitted ${niceDate(c.model_fitted_at)}; scored ${niceDate(c.evaluated_at)}`;
}

function renderEval() {
  const c = state.calibration;
  if (!c) return;
  renderTiles();

  const W = 420, H = 360, L = 46, R = 12, T = 12, B = 40;
  const pts = Object.values(c.species).flatMap(s => s.deciles.map(d => ({ ...d, code: s.species_code })));
  const top = Math.min(1, Math.ceil(Math.max(...pts.map(d => Math.max(d.predicted, d.observed))) * 10) / 10);
  const x = v => L + (v / top) * (W - L - R);
  const y = v => H - B - (v / top) * (H - T - B);
  const ticks = Array.from({ length: Math.round(top * 10) + 1 }, (_, i) => i / 10)
    .filter((_, i, a) => a.length <= 6 || i % 2 === 0);

  let s = "";
  ticks.forEach(t => {
    s += `<line class="grid" x1="${x(0)}" x2="${x(top)}" y1="${y(t)}" y2="${y(t)}"/>`;
    s += `<text class="tick" x="${L - 6}" y="${y(t) + 3}" text-anchor="end">${Math.round(t * 100)}%</text>`;
    s += `<text class="tick" x="${x(t)}" y="${H - B + 14}" text-anchor="middle">${Math.round(t * 100)}%</text>`;
  });
  s += `<line class="axis" x1="${x(0)}" x2="${x(top)}" y1="${y(0)}" y2="${y(0)}"/>`;
  s += `<line class="axis" x1="${x(0)}" x2="${x(0)}" y1="${y(0)}" y2="${y(top)}"/>`;
  s += `<line class="diag" x1="${x(0)}" y1="${y(0)}" x2="${x(top)}" y2="${y(top)}"/>`;
  pts.forEach(d => { s += `<circle class="pt" cx="${x(d.predicted)}" cy="${y(d.observed)}" r="3"/>`; });

  // the selected species drawn on top, so the chart answers "and this bird?"
  const mine = Object.entries(c.species).find(([, v]) => v.species_code === state.code);
  if (mine) {
    const ds = mine[1].deciles;
    s += `<polyline class="sel" points="${ds.map(d => `${x(d.predicted)},${y(d.observed)}`).join(" ")}"/>`;
    ds.forEach((d, i) => {
      s += `<circle class="selpt" cx="${x(d.predicted)}" cy="${y(d.observed)}" r="4.5" data-i="${i}"/>`;
    });
  }
  s += `<text class="lab" x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">predicted chance</text>`;
  s += `<text class="lab" transform="translate(12 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">observed rate</text>`;
  $("calib").innerHTML = s;

  if (mine) {
    $("calib").querySelectorAll(".selpt").forEach(el => {
      const d = mine[1].deciles[+el.dataset.i];
      el.addEventListener("mousemove", e => showTip(e,
        `<b>${mine[0]}</b>, decile ${+el.dataset.i + 1}<br>predicted ${(d.predicted * 100).toFixed(1)}% · observed ${(d.observed * 100).toFixed(1)}%<br>${fmt(d.n)} checklists`));
      el.addEventListener("mouseleave", hideTip);
    });
    $("calib-cap").innerHTML = `Faint dots: every species, one per decile, on held-out checklists. <b style="color:var(--accent)">Line: ${mine[0]}</b>. On the dashed diagonal, a predicted 40% came true 40% of the time.`;
  } else {
    $("calib-cap").textContent = `Each dot is one decile of one species on held-out checklists. ${speciesName(state.code)} was not in the last evaluation. On the dashed diagonal, a predicted 40% came true 40% of the time.`;
  }

  const k = state.coef;
  $("sp-eval").innerHTML = k.meta_by_date_auc !== undefined
    ? `<strong>${speciesName(state.code)}</strong>, from ${fmt(k.meta_detections)} detections: AUC <strong>${k.meta_by_date_auc.toFixed(2)}</strong> held out by date, ${k.meta_by_site_auc.toFixed(2)} by site; calibration error ${(k.meta_by_date_cal_mae * 100).toFixed(1)} points. Seasonal birds found by song tend to score highest; year-round residents lowest, since there is little to predict when a bird is everywhere all the time.`
    : "";
}

// ── start ────────────────────────────────────────────────────────────────

async function main() {
  try {
    const [meta, hotspots, species, photos] = await Promise.all([
      getJSON(`${HF}meta.json`), getJSON(`${HF}hotspots.json`),
      getJSON(`${HF}species.json`), getJSON(`${HF}photos.json`).catch(() => ({})),
    ]);
    Object.assign(state, { meta, hotspots, species, photos });
    $("lim-hs").textContent = `The model covers ${meta.hotspots} of the busiest public hotspots across ${meta.region_name}`;
    loadStatus();
    getJSON(`${HF}calibration.json`).then(c => { state.calibration = c; if (state.coef) renderEval(); })
      .catch(() => { $("eval-note").textContent = "calibration results unavailable"; });

    initMap();
    await loadForecast();

    const asked = new URL(location.href).searchParams.get("species");
    const codes = new Set(species.map(s => s.species_code));
    const code = codes.has(asked) ? asked : codes.has(DEFAULT_SPECIES) ? DEFAULT_SPECIES : species[0].species_code;
    state.code = code;
    buildControls();
    syncControls();
    await setSpecies(code);
    $("loading").hidden = true;
  } catch (err) {
    console.error(err);
    $("loading").textContent = "Could not load the model right now. The explanation below still stands; try again shortly.";
  }

  // Follow the OS theme live: new basemap, and the ramp re-read from CSS.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!state.coef) return;
    renderMap();
    renderEval();
  });
}

main();
