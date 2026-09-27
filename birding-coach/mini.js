// Compact live forecast for the home page's Capstone section.
//
// Same data and the same scoring module as the full page (./app.js), cut down
// to one question: at this hour today, which hotspots give you the best chance
// of this bird? Everything else — the day x hour grid, the evaluation, the
// write-up — lives on birding-coach/, which the section links to.
import { score, unavailable, outingWeather } from "./scoring.js";

const HF = "https://huggingface.co/datasets/taj771/birding-coach-model/resolve/main/";
const RUNS = "https://api.github.com/repos/taj771/birding-coach/actions/workflows/pipeline.yml/runs?per_page=10";
const LEAFLET = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/";
const TZ = "America/New_York";         // checklist hours are PA local time
const OUTING = { durationHrs: 1, distanceKm: 1, observers: 1, traveling: true };
// Chosen for the full page too: mid-range chances in every season and a
// strong hour-of-day swing, so the map is not one flat colour on first load.
const DEFAULT_SPECIES = "tuftit";

const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, "0");
const pct = p => p < 0.01 ? "<1%" : `${Math.round(p * 100)}%`;
const fmt = n => Number(n).toLocaleString("en-US");
const getJSON = url => fetch(url).then(r => { if (!r.ok) throw new Error(url); return r.json(); });
const cellKey = (lat, lon) =>
  `${(Math.round(lat * 4) / 4).toFixed(2)},${(Math.round(lon * 4) / 4).toFixed(2)}`;

function loadLeaflet() {
  if (window.L) return Promise.resolve();
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = LEAFLET + "leaflet.min.css";
  document.head.append(css);
  return new Promise((ok, fail) => {
    const js = document.createElement("script");
    js.src = LEAFLET + "leaflet.min.js";
    js.onload = ok;
    js.onerror = fail;
    document.head.append(js);
  });
}

// Read from the section, which carries its own light and dark ramp steps.
function ramp() {
  const cs = getComputedStyle($("capstone"));
  const hex = v => {
    const h = cs.getPropertyValue(v).trim().replace("#", "");
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  };
  const lo = hex("--seq-lo"), hi = hex("--seq-hi");
  return t => `rgb(${lo.map((v, i) => Math.round(v + (hi[i] - v) * t)).join(",")})`;
}
const sectionVar = v => getComputedStyle($("capstone")).getPropertyValue(v).trim();

const st = { hotspots: [], species: [], coef: null, code: null, day: null, hour: 8, cells: new Map(), markers: [] };
const cache = new Map();

async function loadForecast() {
  const keys = [...new Set(st.hotspots.map(h => cellKey(h.latitude, h.longitude)))];
  const url = "https://api.open-meteo.com/v1/forecast"
    + `?latitude=${keys.map(k => k.split(",")[0]).join(",")}`
    + `&longitude=${keys.map(k => k.split(",")[1]).join(",")}`
    + "&hourly=temperature_2m,precipitation,wind_speed_10m,cloud_cover"
    + `&forecast_days=2&timezone=${encodeURIComponent(TZ)}`;
  let res = await getJSON(url);
  if (!Array.isArray(res)) res = [res];
  keys.forEach((k, i) => st.cells.set(k, res[i].hourly));
}

// Today, from the next whole hour; after the last modelled hour, tomorrow
// morning — a map of hours that have already passed would answer nothing.
function pickDayHour() {
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map(p => [p.type, p.value]));
  let day = `${parts.year}-${parts.month}-${parts.day}`;
  let hour = +parts.hour + 1;
  let label = "today";
  if (hour > 20) {
    const d = new Date(day + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    day = d.toISOString().slice(0, 10);
    hour = 7;
    label = "tomorrow";
  }
  return { day, hour: Math.max(6, hour), label };
}

function render() {
  const date = new Date(st.day + "T12:00:00Z");
  const name = st.species.find(s => s.species_code === st.code)?.common_name ?? st.code;
  $("cap-when").textContent = `${st.dayLabel} ${pad(st.hour)}:00`;
  const why = unavailable(st.coef, date, st.hour);

  const scored = st.hotspots.map(h => {
    if (why) return { h, p: null };
    const hourly = st.cells.get(cellKey(h.latitude, h.longitude));
    const w = hourly && outingWeather(hourly, st.day, st.hour, OUTING.durationHrs);
    return { h, p: w ? score(st.coef, date, st.hour, OUTING, w, h.loc_id) : null };
  });
  const ps = scored.map(s => s.p).filter(p => p !== null);
  const lo = Math.min(...ps), hi = Math.max(...ps);
  const color = ramp(), na = sectionVar("--na"), ring = sectionVar("--dot-ring");

  scored.forEach(({ h, p }, i) => {
    const t = p === null ? 0 : (hi > lo ? (p - lo) / (hi - lo) : 1);
    st.markers[i].setStyle({ fillColor: p === null ? na : color(t), color: ring });
    st.markers[i].unbindTooltip().bindTooltip(
      `<b>${h.name}</b><br>${p === null ? "no estimate" : `${pct(p)} chance you report ${name}`}`,
      { direction: "top", offset: [0, -5] });
  });
  $("cap-lo").textContent = ps.length ? pct(lo) : "–";
  $("cap-hi").textContent = ps.length ? pct(hi) : "–";

  const best = scored.filter(s => s.p !== null).sort((a, b) => b.p - a.p)[0];
  $("cap-best").innerHTML = why === "hour"
    ? `Too few checklists at ${pad(st.hour)}:00 for ${name} to back a number. Try another hour.`
    : why === "week" ? `The model has no seasonal term for ${name} this week, so it will not guess.`
    : best ? `Best right now: <b>${best.h.name}</b> at <b>${pct(best.p)}</b>`
      + (st.coef.meta_by_date_auc !== undefined
         ? ` · model AUC <b>${st.coef.meta_by_date_auc.toFixed(2)}</b> for ${name} on held-out dates` : "")
    : "";
  $("cap-full").href = `birding-coach/?species=${st.code}`;
}

async function setSpecies(code) {
  st.code = code;
  if (!cache.has(code)) cache.set(code, await getJSON(`${HF}coef/${code}.json`));
  st.coef = cache.get(code);
  render();
}

async function status(meta) {
  const bits = [`Model: <b>${meta.species}</b> species, <b>${meta.hotspots}</b> hotspots`];
  const box = $("cap-status");
  const paint = () => { box.innerHTML = bits.map(b => `<span>${b}</span>`).join(""); };
  paint();
  const [runs, s] = await Promise.allSettled([getJSON(RUNS), getJSON(`${HF}status.json`)]);
  if (s.status === "fulfilled") bits.push(`<b>${fmt(s.value.counts.checklists)}</b> checklists`);
  if (runs.status === "fulfilled") {
    const done = runs.value.workflow_runs.find(r => r.status === "completed");
    if (done) {
      const ok = done.conclusion === "success";
      const h = Math.round((Date.now() - new Date(done.updated_at)) / 3.6e6);
      bits.unshift(`<span class="cap-pulse ${ok ? "ok" : "fail"}"></span>Pipeline ${ok ? "passed" : done.conclusion} ${h < 1 ? "within the hour" : `${h} h ago`}`);
    }
  }
  paint();
}

export async function start() {
  try {
    await loadLeaflet();
    const [meta, hotspots, species] = await Promise.all([
      getJSON(`${HF}meta.json`), getJSON(`${HF}hotspots.json`), getJSON(`${HF}species.json`),
    ]);
    Object.assign(st, { hotspots, species });
    status(meta);

    const e = meta.extent;
    $("cap-map").innerHTML = "";
    const map = L.map("cap-map", { scrollWheelZoom: false, zoomSnap: 0.25 })
      .fitBounds([[e.latMin, e.lonMin], [e.latMax, e.lonMax]], { padding: [8, 8] });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 16, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    st.markers = hotspots.map(h =>
      L.circleMarker([h.latitude, h.longitude], { radius: 5.5, weight: 1.2, fillOpacity: 1 }).addTo(map));

    await loadForecast();
    const { day, hour, label } = pickDayHour();
    Object.assign(st, { day, hour, dayLabel: label });

    const sel = $("cap-species");
    sel.innerHTML = [...species].sort((a, b) => a.common_name.localeCompare(b.common_name))
      .map(s => `<option value="${s.species_code}">${s.common_name}</option>`).join("");
    const code = species.some(s => s.species_code === DEFAULT_SPECIES) ? DEFAULT_SPECIES : species[0].species_code;
    sel.value = code;
    sel.disabled = false;
    sel.addEventListener("change", () => setSpecies(sel.value));

    const slider = $("cap-hour");
    slider.value = hour;
    slider.disabled = false;
    slider.addEventListener("input", () => { st.hour = +slider.value; render(); });

    await setSpecies(code);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
  } catch (err) {
    console.error(err);
    $("cap-map").innerHTML = `<div class="cap-wait">The live forecast is unavailable right now. <a href="birding-coach/">See the full page →</a></div>`;
  }
}
