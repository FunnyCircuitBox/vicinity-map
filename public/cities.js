// Vicinity: the city map + "Claim your city". No trackers, nothing loaded from other sites.
// Needs app.js (window.vicinity: wallet bridge) and ticker.js (window.vicinityTicker).
(() => {
  "use strict";
  const sec = document.getElementById("cities");
  if (!sec) return;
  const $ = (s, r = document) => r.querySelector(s);
  const V = () => window.vicinity || {};
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const MIN_HOLD = 1_000_000;
  const fmt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  // Wallets are shown as first 5 + ***** + last 3, with a Solscan link so anyone can check the full address.
  const mask = (a) => (a && a.length > 10 ? `${a.slice(0, 5)}*****${a.slice(-3)}` : a || "");
  const solscan = (a) => { const l = el("a", "mono", mask(a)); l.href = `https://solscan.io/account/${a}`; l.target = "_blank"; l.rel = "noopener"; l.title = "Check this wallet on Solscan"; return l; };
  const norm = (s) => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}]+/gu, "");
  const kmBetween = (a, b, c, d) => { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 12742 * Math.asin(Math.min(1, Math.sqrt(x))); };
  const radiusOf = (c) => ((c.pop || 0) >= 1_000_000 ? 50 : 25);
  const ago = (iso) => { const s = Math.max(1, (Date.now() - Date.parse(iso)) / 1000); return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };

  const canvas = $("#city-canvas"), ctx = canvas.getContext("2d"), tip = $("#city-tip"), wrapEl = $(".citymap__stage");
  const listEl = $("#city-list"), qEl = $("#city-q"), countryEl = $("#city-country"), filterEl = $("#city-filter");
  const btn = $("#claim-btn"), errEl = $("#claim-error"), addForm = $("#add-form");
  let cities = [], byId = new Map(), countries = {}, admin = {}, claims = new Map(), tickers = new Map(), open = false, loaded = false;
  let selected = null, mode = "claim", busy = false, followHandle = null;
  const me = () => V().address || null;

  const placeOf = (c) => [admin[`${c.cc}.${c.adm}`], countries[c.cc] || c.cc].filter(Boolean).join(", ");
  const setErr = (m) => { errEl.textContent = m || ""; errEl.hidden = !m; };
  const req = (k, state, text) => {
    const li = $(`[data-req="${k}"]`); if (!li) return;
    li.classList.toggle("is-ok", state === "ok"); li.classList.toggle("is-bad", state === "bad");
    if (text && k === "here") $("#req-here-text").textContent = text;
  };

  /* =================== the map =================== */
  // World → screen: equirectangular, latitude 84°N … 60°S. view: zoom k, offset tx/ty (CSS px).
  // s0 = pixels per degree at zoom 1, chosen so the world always fills the map box (wide screens and phones).
  // Shapes are Path2D objects in "degree space" (x = lon + 180, y = 84 − lat), drawn with a single transform.
  let W = 0, H = 0, s0 = 1, dpr = 1, k = 1, tx = 0, ty = 0, hover = null, hoverCountry = null, onScreen = false, raf = 0, needDraw = true;
  const ripples = [];
  const wx = (lon) => (lon + 180) * s0;
  const wy = (lat) => (84 - lat) * s0;
  const sx = (lon) => wx(lon) * k + tx;
  const sy = (lat) => wy(lat) * k + ty;
  const clampView = () => { tx = Math.min(0, Math.max(W - 360 * s0 * k, tx)); ty = Math.min(0, Math.max(H - 144 * s0 * k, ty)); };
  const canPan = () => 360 * s0 * k > W + 1 || 144 * s0 * k > H + 1;
  const MAXK = 900;
  const AREA_K = 5; // city boundaries appear from this zoom

  // colours come from the theme (style.css --map-*), so the map follows the dark / light toggle
  let pal = {};
  function readPalette() {
    const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
    const light = document.documentElement.dataset.theme === "light";
    pal = { light, land: v("--map-land"), landLine: v("--map-land-line"), area: v("--map-area"), areaLine: v("--map-area-line"), dot: v("--map-dot"), label: v("--map-label"), halo: v("--map-halo"),
      hoverFill: light ? "rgba(43,91,255,.14)" : "rgba(127,163,214,.2)", claimedText: light ? "#C23A1C" : "#FFB39C",
      tagBg: light ? "rgba(255,255,255,.95)" : "rgba(7,14,25,.9)", tagText: light ? "#8A5A00" : "#FFE3A3", grid: light ? "rgba(11,22,38,.06)" : "rgba(149,162,184,.07)" };
    needDraw = true; kick();
  }
  window.addEventListener("vicinity:theme", readPalette);

  // ---- geometry (same encoding as src/geo.js) ----
  const decodeRing = (flat, unit) => { const out = new Array(flat.length / 2); let x = 0, y = 0; for (let i = 0; i < flat.length; i += 2) { x += flat[i]; y += flat[i + 1]; out[i / 2] = [x * unit, y * unit]; } return out; };
  const inRing = (lon, lat, r) => { let inside = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside; } return inside; };
  const inArea = (lon, lat, area) => area.some(([outer, ...holes]) => inRing(lon, lat, outer) && !holes.some((h) => inRing(lon, lat, h)));
  const inBox = (lon, lat, b) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
  const boxOf = (area) => { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const [o] of area) for (const [x, y] of o) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; } return [a, b, c, d]; };
  const toPath = (area) => { const p = new Path2D(); for (const poly of area) for (const ring of poly) { ring.forEach(([lon, lat], i) => (i ? p.lineTo(lon + 180, 84 - lat) : p.moveTo(lon + 180, 84 - lat))); p.closePath(); } return p; };
  const kmArea = (area) => { let s = 0; for (const poly of area) poly.forEach((r, i) => { let t = 0; for (let a = 0, b = r.length - 1; a < r.length; b = a++) t += (r[b][0] - r[a][0]) * (r[b][1] + r[a][1]); s += (i ? -1 : 1) * Math.abs(t / 2) * 111.32 * Math.cos((r[0][1] * Math.PI) / 180) * 110.57; }); return s; };

  // ---- map data: country outlines + city boundaries (loaded one country at a time) ----
  let world = [];                // [{ cc, box, area, path }]
  let boundsIndex = {};          // cc → { box, bytes }
  let parts = new Map();         // neighbourhood id → id of the city it's part of (one coin per big city)
  let members = new Map();       // city id → the listed places that share its coin
  let joined = new Set();        // parts that were just outside the city and got added to its area
  const areas = new Map();       // city id → { kind: "r" official | "n" nearest land, box, area, path, km2 }
  const boundsLoads = new Map(); // cc → Promise
  function loadBounds(cc) {
    if (!boundsIndex[cc]) return Promise.resolve();
    if (!boundsLoads.has(cc)) {
      boundsLoads.set(cc, fetch(`/data/bounds/${cc}.txt`).then((r) => { if (!r.ok) throw new Error("bounds"); return r.text(); }).then((text) => {
        for (const line of text.split("\n")) {
          const [id, kind, box, json] = line.split("\t");
          if (!json) continue; // "part of" lines carry no shape
          const area = JSON.parse(json).map((poly) => poly.map((r) => decodeRing(r, 1e-4)));
          areas.set(id, { kind, box: box.split(",").map(Number), area, path: toPath(area), km2: kmArea(area) });
        }
        needDraw = true; kick();
      }).catch(() => { boundsLoads.delete(cc); }));
    }
    return boundsLoads.get(cc);
  }
  // the visible part of the world in degrees: [west, south, east, north]
  const view = () => { const s = s0 * k; return [-tx / s - 180, 84 - (H - ty) / s, (W - tx) / s - 180, 84 + ty / s]; };
  const boxInView = (b, v) => b[0] <= v[2] && b[2] >= v[0] && b[1] <= v[3] && b[3] >= v[1];
  const toLonLat = (px, py) => [(px - tx) / (s0 * k) - 180, 84 - (py - ty) / (s0 * k)];
  function loadVisible() { const v = view(); for (const [cc, x] of Object.entries(boundsIndex)) if (boxInView(x.box, v)) loadBounds(cc); }
  const countryAt = (lon, lat) => world.find((w) => inBox(lon, lat, w.box) && inArea(lon, lat, w.area)) || null;
  function cityAtPoint(lon, lat) {
    for (const [id, a] of areas) if (inBox(lon, lat, a.box) && inArea(lon, lat, a.area)) return byId.get(id) || null;
    return null;
  }
  /** Load every country file whose box holds the point, then find the city there. */
  async function findCityAt(lon, lat) {
    await Promise.all(Object.entries(boundsIndex).filter(([, x]) => inBox(lon, lat, x.box)).map(([cc]) => loadBounds(cc)));
    return cityAtPoint(lon, lat);
  }

  function size() {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    // keep the same place in the middle when the box resizes
    const lon = W ? (W / 2 - tx) / (s0 * k) - 180 : 10, lat = H ? 84 - (H / 2 - ty) / (s0 * k) : 20;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height; s0 = Math.max(W / 360, H / 144);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    tx = W / 2 - wx(lon) * k; ty = H / 2 - wy(lat) * k; clampView();
    needDraw = true; kick();
  }
  const zoomLabel = () => { canvas.style.touchAction = k > 1.01 ? "none" : "pan-y"; $("#map-zoom-level").textContent = `${k < 10 ? k.toFixed(1) : Math.round(k)}×`; };
  function zoomAt(px, py, factor) {
    const nk = Math.min(MAXK, Math.max(1, k * factor));
    tx = px - (px - tx) * (nk / k); ty = py - (py - ty) * (nk / k); k = nk; clampView();
    zoomLabel(); needDraw = true; kick();
  }
  // Smooth "fly to" a place (used when you pick a city or a country).
  let flight = null;
  function flyTo(lon, lat, targetK, ms = 1100) {
    if (reduced || !onScreen || document.hidden) ms = 0; // off-screen: jump straight there
    const k0 = k, cx0 = (W / 2 - tx) / k, cy0 = (H / 2 - ty) / k;
    flight = { t0: performance.now(), ms, k0, k1: Math.min(MAXK, Math.max(1, targetK)), cx0, cy0, cx1: wx(lon), cy1: wy(lat) };
    if (!ms) stepFlight(performance.now());
    kick();
  }
  function stepFlight(now) {
    if (!flight) return;
    const f = flight, t = f.ms ? Math.min(1, (now - f.t0) / f.ms) : 1;
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    k = Math.exp(Math.log(f.k0) + (Math.log(f.k1) - Math.log(f.k0)) * e);
    tx = W / 2 - (f.cx0 + (f.cx1 - f.cx0) * e) * k; ty = H / 2 - (f.cy0 + (f.cy1 - f.cy0) * e) * k; clampView();
    zoomLabel();
    if (t >= 1) flight = null;
    needDraw = true;
  }
  /** Fly so the box [west, south, east, north] fills most of the map. */
  function flyToBox(b, minK = 1) {
    const fit = Math.min(W / Math.max(0.02, (b[2] - b[0]) * s0), H / Math.max(0.02, (b[3] - b[1]) * s0)) * 0.72;
    flyTo((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, Math.min(MAXK, Math.max(minK, fit)));
  }
  function flyToCity(c) {
    const a = areas.get(c.id);
    if (a) return flyToBox(a.box, AREA_K + 0.5);
    const r = radiusOf(c);
    flyTo(c.lon, c.lat, Math.min(MAXK, Math.max(AREA_K + 0.5, (Math.min(W, H) * 0.3) / ((r / 111.32) * s0))));
  }
  function flyToCountry(cc) {
    const list = cities.filter((c) => c.cc === cc);
    if (!list.length) return;
    const lons = list.map((c) => c.lon), lats = list.map((c) => c.lat);
    flyToBox([Math.min(...lons) - 0.3, Math.min(...lats) - 0.3, Math.max(...lons) + 0.3, Math.max(...lats) + 0.3]);
  }

  // pulse phase per city, so claimed cities don't all breathe in sync
  const phase = (id) => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return (h % 1000) / 1000; };

  function draw(now) {
    const t = now / 1000, s = s0 * k, v = view();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // graticule
    const step = k < 3 ? 30 : k < 12 ? 10 : k < 40 ? 5 : k < 200 ? 1 : 0.25;
    ctx.lineWidth = 1; ctx.strokeStyle = pal.grid;
    ctx.beginPath();
    for (let lon = Math.ceil(v[0] / step) * step; lon <= v[2]; lon += step) { const x = Math.round(sx(lon)) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let lat = Math.ceil(v[1] / step) * step; lat <= v[3]; lat += step) { const y = Math.round(sy(lat)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();

    // land and country borders
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * tx, dpr * ty);
    ctx.lineJoin = "round";
    ctx.fillStyle = pal.land;
    for (const w of world) if (boxInView(w.box, v)) ctx.fill(w.path, "evenodd");
    ctx.strokeStyle = pal.landLine; ctx.lineWidth = 1 / s;
    for (const w of world) if (boxInView(w.box, v)) ctx.stroke(w.path);
    if (hoverCountry && k < AREA_K) {
      ctx.fillStyle = pal.light ? "rgba(232,67,31,.08)" : "rgba(255,138,91,.1)"; ctx.fill(hoverCountry.path, "evenodd");
      ctx.strokeStyle = "rgba(255,120,80,.8)"; ctx.lineWidth = 1.5 / s; ctx.stroke(hoverCountry.path);
    }

    // city areas: coloured by status, every boundary drawn as a clear line on top of the fills
    if (k >= AREA_K) {
      loadVisible();
      ctx.globalAlpha = Math.min(1, 0.35 + (k - AREA_K) / 3);
      const shown = [];
      for (const [id, a] of areas) {
        if (!boxInView(a.box, v)) continue;
        const c = byId.get(id); if (!c) continue;
        const cl = claims.get(id), mine = cl && me() && cl.wallet === me();
        ctx.fillStyle = mine ? "rgba(255,200,87,.24)" : cl ? "rgba(255,90,54,.2)" : c === hover ? pal.hoverFill : pal.area;
        ctx.fill(a.path, "evenodd");
        shown.push([a, cl, mine]);
      }
      ctx.lineWidth = (k > 80 ? 1.6 : 1.15) / s;
      for (const [a, cl, mine] of shown) {
        ctx.strokeStyle = mine ? "rgba(255,200,87,.95)" : cl ? "rgba(255,90,54,.9)" : pal.areaLine;
        ctx.setLineDash(a.kind === "n" ? [5 / s, 4 / s] : []);
        ctx.stroke(a.path);
      }
      ctx.setLineDash([]);
      const ha = hover && hover !== selected && areas.get(hover.id);
      if (ha) { ctx.lineWidth = 2.4 / s; ctx.strokeStyle = pal.label; ctx.stroke(ha.path); }
      ctx.globalAlpha = 1;
    }
    // the selected city's boundary: gold with moving dashes
    const sa = selected && areas.get(selected.id);
    if (sa && boxInView(sa.box, v)) {
      ctx.fillStyle = "rgba(255,200,87,.14)"; ctx.fill(sa.path, "evenodd");
      ctx.lineWidth = 3 / s; ctx.strokeStyle = "rgba(255,200,87,.95)";
      if (!reduced) { ctx.setLineDash([8 / s, 6 / s]); ctx.lineDashOffset = (-t * 20) / s; }
      ctx.stroke(sa.path); ctx.setLineDash([]); ctx.lineDashOffset = 0;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const m = 60;
    const inView = (x, y) => x > -m && x < W + m && y > -m && y < H + m;
    const visible = [];
    // open cities: soft dots, bigger as you zoom in (smaller once their areas are showing)
    const zs = Math.min(3.2, Math.pow(k, 0.45)) * (k >= AREA_K ? 0.55 : 1);
    ctx.fillStyle = pal.dot;
    ctx.globalAlpha = 0.7;
    for (const c of cities) {
      if (parts.has(c.id)) continue;
      const x = sx(c.lon), y = sy(c.lat);
      if (!inView(x, y)) continue;
      visible.push(c);
      if (claims.has(c.id)) continue;
      const r = Math.max(0.9, (Math.log10(c.pop || 20000) - 3.7) * 0.7) * zs * (W < 600 ? 0.8 : 1);
      ctx.fillRect(x - r / 2, y - r / 2, r, r);
    }
    ctx.globalAlpha = 1;
    // claimed cities: glowing markers with a slow pulse
    for (const c of visible) {
      const cl = claims.get(c.id); if (!cl) continue;
      const x = sx(c.lon), y = sy(c.lat), mine = me() && cl.wallet === me();
      const col = mine ? "255,200,87" : "255,90,54";
      if (!reduced) {
        const p = (t * 0.55 + phase(c.id)) % 1;
        ctx.beginPath(); ctx.arc(x, y, 4 + p * 16, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${col},${(1 - p) * 0.55})`; ctx.lineWidth = 1.5; ctx.stroke();
      }
      ctx.shadowColor = `rgb(${col})`; ctx.shadowBlur = 12;
      ctx.fillStyle = `rgb(${col})`; ctx.beginPath(); ctx.arc(x, y, 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
    // labels once you zoom in (biggest first, never overlapping)
    if (k >= 2.5) {
      const boxes = [], maxLabels = W < 600 ? 18 : k >= AREA_K ? 70 : 42;
      ctx.font = "600 11px Inter, system-ui, sans-serif"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
      const order = visible.filter((c) => c !== selected).sort((a, b) => (claims.has(b.id) - claims.has(a.id)) || b.pop - a.pop);
      for (const c of order) {
        if (boxes.length >= maxLabels) break;
        const x = sx(c.lon) + 7, y = sy(c.lat), w = ctx.measureText(c.name).width;
        if (x < 0 || x + w > W || y < 8 || y > H - 8) continue;
        if (boxes.some((b) => x < b[0] + b[2] + 6 && x + w + 6 > b[0] && Math.abs(y - b[1]) < 15)) continue;
        boxes.push([x, y, w]);
        ctx.strokeStyle = pal.halo; ctx.lineWidth = 3; ctx.strokeText(c.name, x, y);
        ctx.fillStyle = claims.has(c.id) ? pal.claimedText : pal.label; ctx.fillText(c.name, x, y);
      }
    }
    // hover + selected
    if (hover && hover !== selected && k < AREA_K) {
      ctx.strokeStyle = pal.label; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx(hover.lon), sy(hover.lat), 7, 0, Math.PI * 2); ctx.stroke();
    }
    if (selected && sx(selected.lon) > -20 && sx(selected.lon) < W + 20 && sy(selected.lat) > -20 && sy(selected.lat) < H + 20) {
      const x = sx(selected.lon), y = sy(selected.lat), b = reduced ? 0 : (Math.sin(t * 3) + 1) / 2;
      ctx.fillStyle = "#FFC857"; ctx.shadowColor = "#FFC857"; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.arc(x, y, 4.5 + b * 1.5, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(255,200,87,.9)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 10 + b * 3, 0, Math.PI * 2); ctx.stroke();
      const tk = tickers.get(selected.id), label = tk ? `${selected.name} · $${tk.ticker}` : selected.name;
      ctx.font = "700 12px Inter, system-ui, sans-serif";
      const w = ctx.measureText(label).width + 18, lx = Math.min(W - w - 6, Math.max(6, x - w / 2)), ly = Math.max(6, y - 40);
      ctx.fillStyle = pal.tagBg; ctx.strokeStyle = "rgba(255,200,87,.7)"; ctx.lineWidth = 1;
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(lx, ly, w, 24, 12); else ctx.rect(lx, ly, w, 24); ctx.fill(); ctx.stroke();
      ctx.fillStyle = pal.tagText; ctx.textBaseline = "middle"; ctx.fillText(label, lx + 9, ly + 12);
    }
    // ripples (a tap, a fresh claim, your location)
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i], p = (now - r.t0) / 1300;
      if (p >= 1) { ripples.splice(i, 1); continue; }
      ctx.beginPath(); ctx.arc(sx(r.lon), sy(r.lat), 6 + p * 46, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${r.col},${(1 - p) * 0.8})`; ctx.lineWidth = 2; ctx.stroke();
    }
  }
  const animating = () => !reduced && (flight || ripples.length || selected || claims.size > 0);
  function loop(now) {
    raf = 0;
    if (!onScreen || document.hidden || !W) return;
    stepFlight(now);
    if (needDraw || animating()) { draw(now); needDraw = false; }
    if (flight || ripples.length || animating()) raf = requestAnimationFrame(loop);
  }
  function kick() { if (!raf) raf = requestAnimationFrame(loop); }
  const ripple = (c, col = "255,200,87") => { ripples.push({ lon: c.lon, lat: c.lat, t0: performance.now(), col }); kick(); };

  function nearest(px, py, maxPx = 16) {
    let best = null, bd = maxPx * maxPx;
    for (const c of cities) {
      if (parts.has(c.id)) continue;
      const x = sx(c.lon), y = sy(c.lat);
      if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (d < bd || (d === bd && best && c.pop > best.pop)) { bd = d; best = c; }
    }
    return best;
  }
  /** The city under the pointer: a nearby dot first (small cities stay easy to hit), then the area around it. */
  function pick(px, py, maxPx) {
    const c = nearest(px, py, k >= AREA_K ? Math.min(maxPx, 9) : maxPx);
    if (c || k < AREA_K) return c;
    const [lon, lat] = toLonLat(px, py);
    return cityAtPoint(lon, lat);
  }
  const areaNote = (a, c) => {
    if (!a) return "";
    const plus = c && (members.get(c.id) || []).some((m) => joined.has(m.id)) ? " + nearby towns" : "";
    return `${a.kind === "r" ? "Official boundary + nearest land" : "Nearest land"}${plus} · ${a.km2 >= 10 ? fmt(a.km2) : a.km2.toFixed(1)} km²`;
  };
  // "One coin for Manhattan, Brooklyn, Queens and 38 more listed places"
  const sharedNote = (c) => {
    const m = (members.get(c.id) || []).slice().sort((a, b) => b.pop - a.pop);
    if (!m.length) return "";
    const names = m.slice(0, 3).map((x) => x.name).join(", ");
    return m.length > 3 ? `One coin for ${names} and ${m.length - 3} more listed places` : `One coin, including ${names}`;
  };
  function showTip(c, px, py) {
    if (!c) { tip.hidden = true; return; }
    const cl = claims.get(c.id), tk = tickers.get(c.id), a = areas.get(c.id);
    tip.replaceChildren(el("strong", null, c.name), el("span", null, ` ${placeOf(c)}`), document.createElement("br"),
      el("span", cl ? "tip-claimed" : "tip-open", cl ? `Claimed by ${mask(cl.wallet)}` : "Open"), el("span", "tip-ticker", tk ? `  $${tk.ticker}` : ""));
    if (a) tip.append(document.createElement("br"), el("span", "tip-area", areaNote(a, c)));
    const n = (members.get(c.id) || []).length;
    if (n) tip.append(document.createElement("br"), el("span", "tip-area", `Includes ${n} listed place${n === 1 ? "" : "s"}`));
    tip.style.left = `${Math.min(W - 10, Math.max(10, px))}px`; tip.style.top = `${py}px`; tip.hidden = false;
  }
  const cityCount = (cc) => cities.reduce((n, c) => n + (c.cc === cc && !parts.has(c.id)), 0);
  function showCountryTip(w, px, py) {
    const n = cityCount(w.cc);
    tip.replaceChildren(el("strong", null, countries[w.cc] || w.cc), document.createElement("br"),
      el("span", "tip-open", n ? `${fmt(n)} ${n === 1 ? "city" : "cities"} · click to zoom in` : "No listed cities yet"));
    tip.style.left = `${Math.min(W - 10, Math.max(10, px))}px`; tip.style.top = `${py}px`; tip.hidden = false;
  }

  // pointer: drag to move, pinch or double-tap to zoom, tap to pick a city (or a country when zoomed out)
  const pts = new Map();
  let drag = null, lastTap = 0, wheelOK = false;
  const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener("pointerdown", (e) => {
    if (!loaded) return;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = local(e);
    pts.set(e.pointerId, { x, y });
    drag = { x, y, tx, ty, moved: false, pinch: pts.size === 2 ? pinchInfo() : null };
    wheelOK = true; $("#map-hint").classList.remove("is-shown");
  });
  function pinchInfo() { const [a, b] = [...pts.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, k }; }
  canvas.addEventListener("pointermove", (e) => {
    if (!loaded) return;
    const [x, y] = local(e);
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x, y });
    if (drag && pts.size === 2) {
      const p = pinchInfo();
      if (!drag.pinch) drag.pinch = p;
      const f = (p.d / Math.max(1, drag.pinch.d)) * drag.pinch.k / k;
      zoomAt(p.cx, p.cy, f); drag.moved = true; return;
    }
    if (drag && pts.size === 1) {
      if (Math.hypot(x - drag.x, y - drag.y) > 5) drag.moved = true;
      if (drag.moved && canPan()) { tx = drag.tx + (x - drag.x); ty = drag.ty + (y - drag.y); clampView(); needDraw = true; kick(); canvas.classList.add("is-dragging"); }
      return;
    }
    if (e.pointerType === "mouse") {
      const c = pick(x, y, 16);
      const w = !c && k < AREA_K ? countryAt(...toLonLat(x, y)) : null;
      if (c !== hover || w !== hoverCountry) { hover = c; hoverCountry = w; needDraw = true; kick(); }
      canvas.style.cursor = c || w ? "pointer" : "";
      if (c) showTip(c, x, y - 14); else if (w) showCountryTip(w, x, y - 14); else tip.hidden = true;
    }
  });
  const end = (e) => {
    const was = drag; pts.delete(e.pointerId);
    canvas.classList.remove("is-dragging");
    if (pts.size) { const [rest] = [...pts.values()]; drag = { x: rest.x, y: rest.y, tx, ty, moved: true, pinch: null }; return; }
    drag = null;
    if (!was || was.moved || e.type === "pointercancel") return;
    const [x, y] = local(e), now = performance.now();
    if (now - lastTap < 320) { lastTap = 0; flight = null; zoomAt(x, y, 2.4); return; }
    lastTap = now;
    const c = pick(x, y, e.pointerType === "mouse" ? 14 : 22);
    if (c) { select(c, true); ripple(c); return; }
    const w = k < AREA_K ? countryAt(...toLonLat(x, y)) : null;
    if (w && cityCount(w.cc)) { countryEl.value = w.cc; renderList(); flyToCountry(w.cc); hoverCountry = null; tip.hidden = true; }
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", () => { hover = null; hoverCountry = null; tip.hidden = true; needDraw = true; kick(); });
  wrapEl.addEventListener("mouseleave", () => { wheelOK = false; });
  canvas.addEventListener("wheel", (e) => {
    if (!loaded) return;
    if (!wheelOK && !e.ctrlKey && !e.metaKey) { $("#map-hint").classList.add("is-shown"); clearTimeout(canvas._h); canvas._h = setTimeout(() => $("#map-hint").classList.remove("is-shown"), 1600); return; }
    e.preventDefault(); flight = null;
    const [x, y] = local(e);
    zoomAt(x, y, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0022)));
  }, { passive: false });
  // keyboard: arrows move, + / − zoom (the map is focusable)
  canvas.addEventListener("focus", () => { wheelOK = true; });
  canvas.addEventListener("keydown", (e) => {
    if (!loaded) return;
    const pan = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] }[e.key];
    if (pan) { e.preventDefault(); flight = null; tx += pan[0]; ty += pan[1]; clampView(); needDraw = true; kick(); }
    else if (e.key === "+" || e.key === "=") { e.preventDefault(); flight = null; zoomAt(W / 2, H / 2, 1.6); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); flight = null; zoomAt(W / 2, H / 2, 1 / 1.6); }
  });
  $("#map-in").addEventListener("click", () => { flight = null; zoomAt(W / 2, H / 2, 1.8); });
  $("#map-out").addEventListener("click", () => { flight = null; zoomAt(W / 2, H / 2, 1 / 1.8); });
  $("#map-reset").addEventListener("click", () => flyTo(10, 12, 1, 800));
  // ◎: find the city you're standing in (location is used on this device only, never sent)
  $("#map-locate").addEventListener("click", async () => {
    const b = $("#map-locate");
    if (!loaded || b.disabled) return;
    b.disabled = true; b.classList.add("is-busy");
    try {
      const loc = await getLocation();
      ripples.push({ lon: loc.lon, lat: loc.lat, t0: performance.now(), col: "55,194,154" });
      const c = await findCityAt(loc.lon, loc.lat);
      const home = c && parts.has(c.id) ? byId.get(parts.get(c.id)) : c;
      if (home) { select(home, true); V().toast?.(`📍 You're in ${home.name}`); }
      else { flyTo(loc.lon, loc.lat, 60); V().toast?.("You're not inside a listed city yet. You can add yours below the map."); }
    } catch (e) { V().toast?.(e?.message || "Couldn't get your location."); }
    finally { b.disabled = false; b.classList.remove("is-busy"); }
  });
  window.addEventListener("resize", () => { if (loaded) size(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { needDraw = true; kick(); } });
  new IntersectionObserver((es) => { onScreen = es.some((x) => x.isIntersecting); if (onScreen) { needDraw = true; kick(); } }).observe(canvas);

  /* =================== search list =================== */
  function renderList() {
    const q = norm(qEl.value.trim()), cc = countryEl.value, f = filterEl.value;
    const pass = (c) => (!cc || c.cc === cc) && (f === "all" || (f === "claimed") === claims.has(c.id));
    let hits;
    if (q) {
      const starts = [], has = [];
      for (const c of cities) { if (!pass(c)) continue; if (c.n.startsWith(q)) starts.push(c); else if (c.n.includes(q)) has.push(c); }
      hits = starts.concat(has);
    } else hits = cities.filter(pass);
    const total = hits.length; hits = hits.slice(0, 60);
    $("#city-count").textContent = total > 60 ? `Showing 60 of ${fmt(total)}. Type to narrow it down.` : `${fmt(total)} ${total === 1 ? "city" : "cities"}`;
    if (!hits.length) { listEl.replaceChildren(el("li", "muted", q ? "No match. You can add it below." : "Nothing here yet.")); return; }
    listEl.replaceChildren(...hits.map((c) => {
      const li = document.createElement("li");
      const b = el("button", "city-row" + (selected === c ? " is-selected" : "")); b.type = "button";
      const tk = tickers.get(c.id);
      const nm = el("span", "city-row__name");
      nm.append(el("strong", null, c.name), el("span", null, `${placeOf(c)}${c.pop ? " · " + fmt(c.pop) : ""}${c.added ? " · community-added" : ""}${tk ? " · $" + tk.ticker : ""}`));
      const cl = claims.get(c.id), mine = cl && me() && cl.wallet === me(), parent = parts.has(c.id) && byId.get(parts.get(c.id));
      b.append(nm, parent ? el("span", "tag", `Part of ${parent.name}`)
        : el("span", mine ? "tag tag--warn" : cl ? "tag tag--no" : "tag tag--ok", mine ? "Yours" : cl ? "Claimed" : "Open"));
      b.addEventListener("click", () => select(c, true));
      li.append(b); return li;
    }));
  }
  let typing; qEl.addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(renderList, 120); });
  countryEl.addEventListener("change", () => { renderList(); if (countryEl.value) flyToCountry(countryEl.value); });
  filterEl.addEventListener("change", renderList);

  /* =================== coin preview + moderator =================== */
  function renderCoin(c) {
    const box = $("#coin-preview");
    if (!c) { box.hidden = true; return; }
    const tk = tickers.get(c.id) || { ticker: (c.name || "CITY").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10), shared: 1 };
    box.hidden = false;
    $("#coin-face").textContent = tk.ticker.slice(0, 4);
    $("#coin-ticker").textContent = `$${tk.ticker}`;
    $("#coin-name").textContent = `${c.name} Coin`;
    $("#coin-where").textContent = `${placeOf(c)} · city #${c.id}`;
    const note = $("#coin-same");
    if (tk.shared > 1) {
      note.hidden = false;
      note.textContent = tk.ticker === tk.base
        ? `${tk.shared} listed places share the name "${c.name}". This one is the biggest, so it keeps $${tk.ticker}; the others add their country or state code.`
        : `${tk.shared} listed places share the name "${c.name}". The biggest keeps $${tk.base}; this one is $${tk.ticker}.`;
    } else note.hidden = true;
    const coin = $("#coin-disc");
    coin.classList.remove("is-flip"); void coin.offsetWidth; if (!reduced) coin.classList.add("is-flip");
  }
  const modCache = new Map();
  async function renderModerator(c) {
    const row = $("#mod-row");
    if (!c) { row.hidden = true; return; }
    row.hidden = false;
    const cname = countries[c.cc] || c.cc;
    row.replaceChildren(el("span", "mod-row__icon", "🛡"), el("span", null, `Country moderator (${cname}): loading…`));
    try {
      let d = modCache.get(c.cc);
      if (!d) { d = await (await fetch(`/api/moderator?country=${c.cc}`)).json(); modCache.set(c.cc, d); }
      if (selected !== c && mode === "claim") return;
      const txt = el("span");
      if (d.moderator) {
        txt.append(document.createTextNode(`Country moderator (${cname}): `), solscan(d.moderator.wallet),
          document.createTextNode(` · founder of ${d.moderator.city} · holds ${fmt(d.moderator.amount)} $VICINITY`));
      } else txt.textContent = `Country moderator (${cname}): ${d.launched ? "no founders here yet." : "picked at launch."} It's the city founder in ${cname} who holds the most $VICINITY.`;
      row.replaceChildren(el("span", "mod-row__icon", "🛡"), txt);
    } catch { row.replaceChildren(el("span", "mod-row__icon", "🛡"), el("span", null, `Country moderator (${cname}): the city founder holding the most $VICINITY.`)); }
  }

  /* =================== claim panel =================== */
  function refreshPanel(keepError = false) {
    if (!keepError) setErr("");
    $("#claim-done").hidden = true;
    $("#claim-reqs").hidden = false;
    addForm.hidden = mode !== "add";
    const addr = me();
    const myCity = addr ? [...claims.entries()].find(([, v]) => v.wallet === addr) : null;
    const wt = $("#req-wallet-text");
    req("wallet", addr ? "ok" : null);
    if (addr) wt.replaceChildren(document.createTextNode("Connected: "), solscan(addr));
    else wt.replaceChildren(document.createTextNode("Any Solana wallet. "), Object.assign(el("a", null, "Connect here"), { href: "#wallet" }), document.createTextNode("."));
    const sub = $("#claim-sub");
    if (mode === "add") {
      $("#claim-kicker").textContent = "Add a city"; $("#claim-title").textContent = "Put your city on the map";
      sub.textContent = "Only if it isn't listed yet. You'll be its founder.";
      renderCoin(null); $("#mod-row").hidden = true;
    } else if (selected) {
      const cl = claims.get(selected.id);
      $("#claim-kicker").textContent = cl ? "Claimed" : "Open city";
      $("#claim-title").textContent = selected.name;
      sub.textContent = `${placeOf(selected)}${selected.pop ? " · " + fmt(selected.pop) + " people" : ""}`;
      const a = areas.get(selected.id);
      if (a) sub.append(document.createElement("br"), el("span", a.kind === "r" ? "area-note" : "area-note area-note--near", areaNote(a, selected)));
      const shared = sharedNote(selected);
      if (shared) sub.append(document.createElement("br"), el("span", "shared-note", shared));
      if (cl) sub.append(document.createElement("br"), document.createTextNode("Founder: "), solscan(cl.wallet), document.createTextNode(` · since ${new Date(cl.claimed_at).toLocaleDateString()}`));
    }
    let label = "Pick a city first", disabled = true;
    if (!open) label = "Claims open when $VICINITY launches";
    else if (myCity) label = `Your wallet already founded ${myCity[1].city_name}`;
    else if (mode === "claim" && !selected) label = "Pick a city first";
    else if (mode === "claim" && claims.has(selected.id)) label = "Already claimed";
    else if (!addr) { label = "Connect your wallet"; disabled = false; }
    else { label = mode === "add" ? "Add & claim this city" : `Claim ${selected.name}`; disabled = false; }
    btn.textContent = label; btn.disabled = disabled || busy;
  }
  function select(c, fly = false) {
    // a neighbourhood inside another city's official boundary belongs to that city
    if (parts.has(c.id) && byId.get(parts.get(c.id))) {
      const home = byId.get(parts.get(c.id));
      V().toast?.(`${c.name} is part of ${home.name}`);
      c = home;
    }
    mode = "claim"; selected = c;
    req("here", null, "Share your location once. We check you're inside the city's boundary on the map and that your internet connection is local too. VPNs are blocked. Nothing is saved.");
    refreshPanel(); renderList(); renderCoin(c); renderModerator(c);
    if (fly) flyToCity(c);
    // the boundary may still be loading: show it (and re-frame the map) once it's here
    if (!areas.has(c.id)) loadBounds(c.cc).then(() => { if (selected !== c) return; refreshPanel(true); if (fly && areas.has(c.id)) flyToCity(c); });
    needDraw = true; kick();
  }
  $("#city-add-open").addEventListener("click", () => {
    mode = "add"; selected = null;
    if (countryEl.value) $("#add-country").value = countryEl.value;
    $("#add-name").value = qEl.value.trim();
    refreshPanel(); renderList(); needDraw = true; kick();
    $("#claim-panel").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });
    $("#add-name").focus();
  });
  document.addEventListener("vicinity:wallet", () => { if (loaded) { refreshPanel(); renderList(); needDraw = true; kick(); } });
  $("#follow-ok")?.addEventListener("change", (e) => req("follow", e.target.checked ? "ok" : null));

  function getLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("Your browser can't share location."));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: Math.round(p.coords.accuracy || 0) }),
        (e) => reject(new Error(e.code === 1 ? "Location is blocked. Allow location for this site in your browser settings, then try again." : "Couldn't get your location. Turn on location (GPS) and try again.")),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
  }
  const ERR = {
    not_launched: () => "Claims open the moment $VICINITY launches.",
    not_enough_tokens: (d) => `This wallet holds ${fmt(d.amount || 0)} $VICINITY. You need ${fmt(MIN_HOLD)} to claim a city.`,
    not_in_city: (d) => (d.km != null ? `You're about ${d.km} km from the city center. You need to be within ${d.radiusKm} km.` : "You're not inside this city's boundary right now."),
    part_of: (d) => `This place is part of ${byId.get(d.parentId)?.name || "a bigger city"}. Claim that city instead.`,
    inside_listed_city: (d) => `You're inside ${byId.get(d.cityId)?.name || "a listed city"}. Claim it instead of adding a new one.`,
    vpn_detected: () => "It looks like you're on a VPN, proxy or cloud network. Turn it off and use your normal home or mobile internet, then try again.",
    network_mismatch: (d) => d.networkCountry ? `Your internet connection is in a different country (${d.networkCountry}). Turn off any VPN and try again from the city.` : `Your internet connection looks about ${fmt(d.networkKm)} km away from your GPS location. Turn off any VPN and try again.`,
    city_taken: () => "Someone else already claimed this city.",
    wallet_has_city: (d) => `This wallet already founded ${d.city?.city_name || "a city"}. It's one city per wallet.`,
    already_listed: (d) => `${d.cityName} is already listed. We've selected it for you.`,
    location_required: () => "We need your location to confirm you're in the city.",
    location_too_rough: () => "Your location isn't precise enough. Turn on precise location / GPS and try again.",
    chain_unavailable: () => "Couldn't reach the blockchain. Please try again in a minute.",
    unknown_country: () => "Please pick a country.",
    expired: () => "That message expired. Please try again.",
  };

  btn.addEventListener("click", async () => {
    setErr("");
    const addr = me(), wallet = V().wallet;
    if (!addr || !wallet) { $("#wallet").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" }); return; }
    let target;
    if (mode === "add") {
      const name = $("#add-name").value.trim().replace(/\s+/g, " "), cc = $("#add-country").value;
      if (!/^[\p{L}\p{M}][\p{L}\p{M} .'’-]{0,58}[\p{L}\p{M}.]$/u.test(name)) return setErr("Use letters only for the city name (spaces, - . ' are fine).");
      if (!cc) return setErr("Please pick a country.");
      const dup = cities.find((c) => c.cc === cc && c.n === norm(name));
      if (dup) { select(dup, true); return setErr(`${dup.name} is already listed. We've selected it for you. (Different place with the same name? Stand in it and tap "Add it" from there.)`); }
      target = `action=add&name=${encodeURIComponent(name)}&country=${cc}`;
    } else target = `action=claim&city=${encodeURIComponent(selected.id)}&country=${selected.cc}`;
    if (followHandle && !$("#follow-ok").checked) return setErr("Please follow Vicinity on X first, then tick the box.");

    busy = true; btn.disabled = true;
    try {
      btn.textContent = "Getting your location…";
      const loc = await getLocation();
      // the same boundary check the server does, so people see the answer before signing anything
      const here = await findCityAt(loc.lon, loc.lat);
      const hereCity = here && parts.has(here.id) ? byId.get(parts.get(here.id)) : here;
      if (mode === "claim") {
        await loadBounds(selected.cc);
        const a = areas.get(selected.id);
        if (a ? !inArea(loc.lon, loc.lat, a.area) : kmBetween(loc.lat, loc.lon, selected.lat, selected.lon) > radiusOf(selected)) {
          req("here", "bad", hereCity ? `You're in ${hereCity.name}, not ${selected.name}.` : `You're outside ${selected.name}'s boundary.`);
          throw new Error(hereCity ? `You're in ${hereCity.name} right now. You can only claim the city you're standing in.` : `You're not inside ${selected.name} right now. Tap ◎ on the map to find the city you're in.`);
        }
        req("here", "ok", `You're in ${selected.name} ✓ (location not saved)`);
      } else {
        if (hereCity) { select(hereCity, true); throw new Error(`You're inside ${hereCity.name}, which is already on the map. Claim it instead of adding a new city.`); }
        req("here", "ok", "Location checked ✓ (not saved)");
      }
      btn.textContent = "Check your wallet…";
      const m = await (await fetch(`/api/message?address=${encodeURIComponent(addr)}&${target}`, { cache: "no-store" })).json();
      if (!m.message) throw new Error("Couldn't prepare the message. Please try again.");
      const sig = await wallet.signMessage(new TextEncoder().encode(m.message));
      req("sign", "ok");
      btn.textContent = "Claiming…";
      const r = await fetch("/api/claim", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: addr, message: m.message, signature: btoa(String.fromCharCode(...new Uint8Array(sig))), location: loc }) });
      const d = await r.json();
      if (!d.claimed) {
        if (d.error === "already_listed" && byId.get(d.cityId)) select(byId.get(d.cityId), true);
        if (d.error === "city_taken" && d.by && selected) { claims.set(selected.id, { wallet: d.by, city_name: selected.name, country: selected.cc, claimed_at: new Date().toISOString() }); renderList(); updateStats(); }
        if (d.error === "not_enough_tokens") req("hold", "bad");
        if (d.error === "vpn_detected" || d.error === "network_mismatch") req("here", "bad", "Your internet connection doesn't match your location.");
        throw new Error((ERR[d.error] || (() => "Claim failed. Please try again."))(d));
      }
      req("hold", "ok");
      if (!byId.has(d.cityId)) {
        const c = { id: d.cityId, name: d.cityName, cc: d.country, adm: "", lat: Math.round(loc.lat * 10) / 10, lon: Math.round(loc.lon * 10) / 10, pop: 0, n: norm(d.cityName), added: true };
        cities.push(c); byId.set(c.id, c); retick();
      }
      claims.set(d.cityId, { city_id: d.cityId, wallet: addr, city_name: d.cityName, country: d.country, claimed_at: d.claimedAt });
      selected = byId.get(d.cityId); mode = "claim";
      refreshPanel(); renderList(); updateStats(); renderFeed(); renderCoin(selected);
      $("#claim-reqs").hidden = true; addForm.hidden = true;
      $("#claim-done-title").textContent = `You founded ${d.cityName}!`;
      $("#claim-done-text").textContent = `${d.cityName} is now linked to ${mask(addr)}. Keep holding ${fmt(MIN_HOLD)}+ $VICINITY: founders are re-checked at the Launchpad snapshot.`;
      $("#claim-done").hidden = false;
      V().toast?.(`📍 ${d.cityName} is yours`);
      ripple(selected); ripple(selected, "255,90,54");
      const rr = btn.getBoundingClientRect(); V().burst?.(rr.left + rr.width / 2, rr.top);
    } catch (e) {
      const msg = String(e?.message || "");
      setErr(/reject|cancel|denied/i.test(msg) || e?.code === 4001 ? "Signing cancelled in your wallet. Nothing happened." : msg || "Claim failed. Please try again.");
    } finally {
      busy = false;
      if ($("#claim-done").hidden) refreshPanel(true); else btn.disabled = true;
    }
  });

  /* =================== live claims feed + stats =================== */
  function updateStats() {
    $("#cs-cities").textContent = fmt(cities.length - parts.size);
    $("#cs-countries").textContent = fmt(new Set(cities.map((c) => c.cc)).size);
    $("#cs-claimed").textContent = fmt(claims.size);
    $("#cs-status").textContent = open ? "Open" : "At launch";
  }
  function renderFeed(fresh = new Set()) {
    const feed = $("#claim-feed");
    const list = [...claims.values()].sort((a, b) => Date.parse(b.claimed_at) - Date.parse(a.claimed_at)).slice(0, 8);
    if (!list.length) { feed.replaceChildren(el("li", "claim-feed__empty", open ? "No cities claimed yet. Be the first founder." : "No cities claimed yet. Claims open when $VICINITY launches.")); return; }
    feed.replaceChildren(...list.map((c) => {
      const li = el("li", fresh.has(c.city_id) ? "is-new" : null);
      const city = byId.get(c.city_id);
      const go = el("button", "claim-feed__city", `📍 ${c.city_name}, ${c.country}`); go.type = "button";
      if (city) go.addEventListener("click", () => select(city, true));
      li.append(go, el("span", "muted", " · founder "), solscan(c.wallet), el("span", "muted", ` · ${ago(c.claimed_at)}`));
      return li;
    }));
  }
  // neighbourhoods that are part of another city don't get a coin of their own
  function retick() { tickers = window.vicinityTicker ? window.vicinityTicker.assign(cities.filter((c) => !parts.has(c.id))) : new Map(); }

  let firstClaims = true;
  async function refreshClaims() {
    try {
      const cl = await (await fetch("/api/claims", { cache: "no-store" })).json();
      if (!cl.claims) return;
      const fresh = new Set();
      for (const a of cl.added || []) if (!byId.has(a.id)) { const c = { id: a.id, name: a.name, cc: a.country, adm: "", lat: a.lat, lon: a.lon, pop: 0, n: norm(a.name), added: true }; cities.push(c); byId.set(c.id, c); }
      if ((cl.added || []).length) retick();
      if (!firstClaims) for (const c of cl.claims) if (!claims.has(c.city_id)) { fresh.add(c.city_id); const city = byId.get(c.city_id); if (city) ripple(city, "255,90,54"); }
      firstClaims = false;
      claims = new Map(cl.claims.map((c) => [c.city_id, c]));
      open = Boolean(cl.open);
      updateStats(); renderFeed(fresh);
      if (fresh.size) { renderList(); refreshPanel(true); }
      needDraw = true; kick();
    } catch {}
  }

  async function load() {
    if (loaded) return; loaded = true;
    try {
      const [data, off, wd, bi] = await Promise.all([
        fetch("/data/cities.json").then((r) => r.json()),
        fetch("/api/official", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
        fetch("/data/world.json").then((r) => r.json()).catch(() => null),        // map background (optional)
        fetch("/data/bounds/index.json").then((r) => r.json()).catch(() => null), // city boundaries (optional)
      ]);
      countries = data.countries; admin = data.admin;
      readPalette();
      world = wd ? Object.entries(wd.countries).map(([cc, enc]) => { const area = enc.map((poly) => poly.map((r) => decodeRing(r, wd.unit))); return { cc, area, box: boxOf(area), path: toPath(area) }; }) : [];
      boundsIndex = bi?.countries || {};
      parts = new Map(Object.entries(bi?.parts || {}));
      joined = new Set(bi?.joined || []);
      cities = Object.entries(data.byCountry).flatMap(([cc, rows]) => rows.map(([id, name, adm, lat, lon, pop]) => ({ id: String(id), name, cc, adm, lat, lon, pop, n: norm(name) })));
      cities.sort((a, b) => b.pop - a.pop);
      byId = new Map(cities.map((c) => [c.id, c]));
      members = new Map();
      for (const [child, parent] of parts) if (byId.has(child)) members.set(parent, [...(members.get(parent) || []), byId.get(child)]);
      retick();
      await refreshClaims();
      retick();
      const handle = (off.socials || []).find((h) => /^@[A-Za-z0-9_]{1,15}$/.test(h));
      if (handle) { followHandle = handle; $("#req-follow").hidden = false; $("#follow-link").href = `https://x.com/${handle.slice(1)}`; $("#follow-link").textContent = `Follow ${handle} ↗`; }
      const counts = {}; for (const c of cities) if (!parts.has(c.id)) counts[c.cc] = (counts[c.cc] || 0) + 1;
      const opts = Object.keys(countries).sort((a, b) => countries[a].localeCompare(countries[b]));
      countryEl.append(...opts.filter((c) => counts[c]).map((c) => Object.assign(document.createElement("option"), { value: c, textContent: `${countries[c]} (${counts[c]})` })));
      $("#add-country").append(Object.assign(document.createElement("option"), { value: "", textContent: "Choose a country" }),
        ...opts.map((c) => Object.assign(document.createElement("option"), { value: c, textContent: countries[c] })));
      sec.classList.add("is-ready");
      size(); renderList(); refreshPanel(); renderFeed();
      setInterval(() => { if (!document.hidden && onScreen) refreshClaims(); }, 30000);
    } catch {
      loaded = false;
      listEl.replaceChildren(el("li", "muted", "Couldn't load the city list. Refresh the page to try again."));
    }
  }
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); load(); } }, { rootMargin: "900px 0px" });
  io.observe(sec);
  if (location.hash === "#cities") load();
})();
