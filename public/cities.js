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
  let W = 0, H = 0, s0 = 1, dpr = 1, k = 1, tx = 0, ty = 0, hover = null, onScreen = false, raf = 0, needDraw = true;
  const ripples = [];
  const wx = (lon) => (lon + 180) * s0;
  const wy = (lat) => (84 - lat) * s0;
  const sx = (lon) => wx(lon) * k + tx;
  const sy = (lat) => wy(lat) * k + ty;
  const pxPerDeg = () => s0 * k;
  const clampView = () => { tx = Math.min(0, Math.max(W - 360 * s0 * k, tx)); ty = Math.min(0, Math.max(H - 144 * s0 * k, ty)); };
  const canPan = () => 360 * s0 * k > W + 1 || 144 * s0 * k > H + 1;
  const MAXK = 220;

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
  function zoomAt(px, py, factor) {
    const nk = Math.min(MAXK, Math.max(1, k * factor));
    tx = px - (px - tx) * (nk / k); ty = py - (py - ty) * (nk / k); k = nk; clampView();
    canvas.style.touchAction = k > 1.01 ? "none" : "pan-y";
    $("#map-zoom-level").textContent = `${k < 10 ? k.toFixed(1) : Math.round(k)}×`;
    needDraw = true; kick();
  }
  // Smooth "fly to" a place (used when you pick a city).
  let flight = null;
  function flyTo(lon, lat, targetK, ms = 1100) {
    if (reduced || !onScreen || document.hidden) ms = 0; // off-screen: jump straight there
    const k0 = k, cx0 = (W / 2 - tx) / k, cy0 = (H / 2 - ty) / k;
    const cx1 = wx(lon), cy1 = wy(lat);
    flight = { t0: performance.now(), ms, k0, k1: Math.min(MAXK, Math.max(1, targetK)), cx0, cy0, cx1, cy1 };
    if (!ms) stepFlight(performance.now());
    kick();
  }
  function stepFlight(now) {
    if (!flight) return;
    const f = flight, t = f.ms ? Math.min(1, (now - f.t0) / f.ms) : 1;
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const kk = Math.exp(Math.log(f.k0) + (Math.log(f.k1) - Math.log(f.k0)) * e);
    const cx = f.cx0 + (f.cx1 - f.cx0) * e, cy = f.cy0 + (f.cy1 - f.cy0) * e;
    k = kk; tx = W / 2 - cx * k; ty = H / 2 - cy * k; clampView();
    canvas.style.touchAction = k > 1.01 ? "none" : "pan-y";
    $("#map-zoom-level").textContent = `${k < 10 ? k.toFixed(1) : Math.round(k)}×`;
    if (t >= 1) flight = null;
    needDraw = true;
  }
  const zoomForCity = (c) => { const r = radiusOf(c); return Math.min(MAXK, (Math.min(W, H) * 0.3) / ((r / 111.32) * s0)); };

  // pulse phase per city, so claimed cities don't all breathe in sync
  const phase = (id) => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return (h % 1000) / 1000; };

  function draw(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const t = now / 1000;
    // graticule
    const step = k < 3 ? 30 : k < 12 ? 10 : k < 40 ? 5 : 1;
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(149,162,184,.07)";
    ctx.beginPath();
    for (let lon = -180; lon <= 180; lon += step) { const x = Math.round(sx(lon)) + 0.5; if (x >= 0 && x <= W) { ctx.moveTo(x, 0); ctx.lineTo(x, H); } }
    for (let lat = -60; lat <= 84; lat += step) { const y = Math.round(sy(lat)) + 0.5; if (y >= 0 && y <= H) { ctx.moveTo(0, y); ctx.lineTo(W, y); } }
    ctx.stroke();
    ctx.strokeStyle = "rgba(149,162,184,.14)"; ctx.beginPath(); const eq = Math.round(sy(0)) + 0.5; ctx.moveTo(0, eq); ctx.lineTo(W, eq); ctx.stroke();

    const ppd = pxPerDeg(), m = 60;
    const inView = (x, y) => x > -m && x < W + m && y > -m && y < H + m;
    const visible = [];
    // open cities: soft dots, bigger as you zoom in
    const zs = Math.min(3.2, Math.pow(k, 0.45));
    ctx.fillStyle = "rgba(127,163,214,.62)";
    for (const c of cities) {
      const x = sx(c.lon), y = sy(c.lat);
      if (!inView(x, y)) continue;
      visible.push(c);
      if (claims.has(c.id)) continue;
      const r = Math.max(0.7, (Math.log10(c.pop || 20000) - 3.7) * 0.7) * zs * (W < 600 ? 0.8 : 1);
      ctx.fillRect(x - r / 2, y - r / 2, r, r);
    }
    // claim zones = the area that counts as "in the city" (25 km, or 50 km for 1M+ people)
    if (k >= 4 && visible.length < 900) {
      for (const c of visible) {
        const cl = claims.get(c.id), mine = cl && me() && cl.wallet === me(), sel = c === selected;
        const ry = (radiusOf(c) / 111.32) * ppd, rx = ry / Math.max(0.2, Math.cos((c.lat * Math.PI) / 180));
        if (rx < 3) continue;
        ctx.beginPath(); ctx.ellipse(sx(c.lon), sy(c.lat), rx, ry, 0, 0, Math.PI * 2);
        ctx.fillStyle = mine ? "rgba(255,200,87,.12)" : cl ? "rgba(255,90,54,.10)" : sel ? "rgba(255,200,87,.07)" : "rgba(127,163,214,.035)";
        ctx.fill();
        ctx.lineWidth = sel ? 2 : 1;
        ctx.strokeStyle = mine ? "rgba(255,200,87,.7)" : cl ? "rgba(255,90,54,.55)" : sel ? "rgba(255,200,87,.9)" : "rgba(127,163,214,.22)";
        if (sel && !reduced) { ctx.setLineDash([7, 6]); ctx.lineDashOffset = -t * 18; }
        ctx.stroke(); ctx.setLineDash([]);
      }
    }
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
      const boxes = [], maxLabels = W < 600 ? 18 : 42;
      ctx.font = "600 11px Inter, system-ui, sans-serif"; ctx.textBaseline = "middle";
      const order = visible.filter((c) => c !== selected).sort((a, b) => (claims.has(b.id) - claims.has(a.id)) || b.pop - a.pop);
      for (const c of order) {
        if (boxes.length >= maxLabels) break;
        const x = sx(c.lon) + 7, y = sy(c.lat), w = ctx.measureText(c.name).width;
        if (x < 0 || x + w > W || y < 8 || y > H - 8) continue;
        if (boxes.some((b) => x < b[0] + b[2] + 6 && x + w + 6 > b[0] && Math.abs(y - b[1]) < 15)) continue;
        boxes.push([x, y, w]);
        ctx.fillStyle = "rgba(7,14,25,.75)"; ctx.fillText(c.name, x + 1, y + 1);
        ctx.fillStyle = claims.has(c.id) ? "#FFB39C" : "rgba(238,242,248,.78)"; ctx.fillText(c.name, x, y);
      }
    }
    // hover + selected
    if (hover && hover !== selected) {
      ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 1.5;
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
      ctx.fillStyle = "rgba(7,14,25,.9)"; ctx.strokeStyle = "rgba(255,200,87,.6)"; ctx.lineWidth = 1;
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(lx, ly, w, 24, 12); else ctx.rect(lx, ly, w, 24); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#FFE3A3"; ctx.textBaseline = "middle"; ctx.fillText(label, lx + 9, ly + 12);
    }
    // ripples (a tap, a fresh claim)
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
      const x = sx(c.lon), y = sy(c.lat);
      if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (d < bd || (d === bd && best && c.pop > best.pop)) { bd = d; best = c; }
    }
    return best;
  }
  function showTip(c, px, py) {
    if (!c) { tip.hidden = true; return; }
    const cl = claims.get(c.id), tk = tickers.get(c.id);
    tip.replaceChildren(el("strong", null, c.name), el("span", null, ` ${placeOf(c)}`), document.createElement("br"),
      el("span", cl ? "tip-claimed" : "tip-open", cl ? `Claimed by ${mask(cl.wallet)}` : "Open"), el("span", "tip-ticker", tk ? `  $${tk.ticker}` : ""));
    tip.style.left = `${Math.min(W - 10, Math.max(10, px))}px`; tip.style.top = `${py}px`; tip.hidden = false;
  }

  // pointer: drag to move, pinch or double-tap to zoom, tap to pick
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
      const c = nearest(x, y);
      if (c !== hover) { hover = c; needDraw = true; kick(); }
      showTip(c, x, y - 14);
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
    const c = nearest(x, y, e.pointerType === "mouse" ? 14 : 22);
    if (c) { select(c, true); ripple(c); }
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", () => { hover = null; tip.hidden = true; needDraw = true; kick(); });
  wrapEl.addEventListener("mouseleave", () => { wheelOK = false; });
  canvas.addEventListener("wheel", (e) => {
    if (!loaded) return;
    if (!wheelOK && !e.ctrlKey && !e.metaKey) { $("#map-hint").classList.add("is-shown"); clearTimeout(canvas._h); canvas._h = setTimeout(() => $("#map-hint").classList.remove("is-shown"), 1600); return; }
    e.preventDefault(); flight = null;
    const [x, y] = local(e);
    zoomAt(x, y, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0022)));
  }, { passive: false });
  $("#map-in").addEventListener("click", () => { flight = null; zoomAt(W / 2, H / 2, 1.8); });
  $("#map-out").addEventListener("click", () => { flight = null; zoomAt(W / 2, H / 2, 1 / 1.8); });
  $("#map-reset").addEventListener("click", () => flyTo(10, 12, 1, 800));
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
      const cl = claims.get(c.id), mine = cl && me() && cl.wallet === me();
      b.append(nm, el("span", mine ? "tag tag--warn" : cl ? "tag tag--no" : "tag tag--ok", mine ? "Yours" : cl ? "Claimed" : "Open"));
      b.addEventListener("click", () => select(c, true));
      li.append(b); return li;
    }));
  }
  let typing; qEl.addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(renderList, 120); });
  countryEl.addEventListener("change", () => {
    renderList();
    const list = cities.filter((c) => c.cc === countryEl.value);
    if (!list.length) return;
    const lons = list.map((c) => c.lon), lats = list.map((c) => c.lat);
    const [a, b, c2, d] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
    const fit = Math.min(W / Math.max(0.5, (b - a) * s0), H / Math.max(0.5, (d - c2) * s0)) * 0.8;
    flyTo((a + b) / 2, (c2 + d) / 2, Math.min(60, Math.max(1, fit)));
  });
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
    mode = "claim"; selected = c;
    req("here", null, "Share your location once. We check you're inside the city (25 km, or 50 km for cities over 1M people) and that your internet connection is local too. VPNs are blocked. Nothing is saved.");
    refreshPanel(); renderList(); renderCoin(c); renderModerator(c);
    if (fly) flyTo(c.lon, c.lat, zoomForCity(c));
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
    not_in_city: (d) => `You're about ${d.km} km from the city center. You need to be within ${d.radiusKm} km.`,
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
      if (mode === "claim") {
        const d = kmBetween(loc.lat, loc.lon, selected.lat, selected.lon), rad = radiusOf(selected);
        if (d > rad) { req("here", "bad", `You're about ${Math.round(d)} km from ${selected.name}. You need to be within ${rad} km.`); throw new Error(`You're about ${Math.round(d)} km away. Claim the city you're in right now.`); }
        req("here", "ok", `You're in ${selected.name} ✓ (location not saved)`);
      } else req("here", "ok", "Location checked ✓ (not saved)");
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
    $("#cs-cities").textContent = fmt(cities.length);
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
  function retick() { tickers = window.vicinityTicker ? window.vicinityTicker.assign(cities) : new Map(); }

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
      const [data, off] = await Promise.all([
        fetch("/data/cities.json").then((r) => r.json()),
        fetch("/api/official", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
      ]);
      countries = data.countries; admin = data.admin;
      cities = Object.entries(data.byCountry).flatMap(([cc, rows]) => rows.map(([id, name, adm, lat, lon, pop]) => ({ id: String(id), name, cc, adm, lat, lon, pop, n: norm(name) })));
      cities.sort((a, b) => b.pop - a.pop);
      byId = new Map(cities.map((c) => [c.id, c]));
      retick();
      await refreshClaims();
      retick();
      const handle = (off.socials || []).find((h) => /^@[A-Za-z0-9_]{1,15}$/.test(h));
      if (handle) { followHandle = handle; $("#req-follow").hidden = false; $("#follow-link").href = `https://x.com/${handle.slice(1)}`; $("#follow-link").textContent = `Follow ${handle} ↗`; }
      const counts = {}; for (const c of cities) counts[c.cc] = (counts[c.cc] || 0) + 1;
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
