// Vicinity front-end. No trackers, no cookies, no outside requests.
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const seg = (p, a, b) => clamp((p - a) / (b - a));
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const backOut = (t) => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia("(pointer: fine)").matches;
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (reduced) document.documentElement.classList.add("reduced");

  const toast = (msg) => {
    const t = $("#toast"); if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
  };

  /* ---------- intro + reveal ---------- */
  requestAnimationFrame(() => document.body.classList.add("is-loaded"));
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
  }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
  $$(".reveal").forEach((el, i) => { el.style.transitionDelay = `${(i % 4) * 70}ms`; io.observe(el); });

  /* ---------- hero spotlight + magnetic buttons + tilt cards ---------- */
  const hero = $("#hero");
  if (hero && finePointer && !reduced) {
    hero.addEventListener("pointermove", (e) => {
      const r = hero.getBoundingClientRect();
      hero.style.setProperty("--mx", `${e.clientX - r.left}px`);
      hero.style.setProperty("--my", `${e.clientY - r.top}px`);
    });
    $$(".magnetic").forEach((b) => {
      b.addEventListener("pointermove", (e) => {
        const r = b.getBoundingClientRect();
        b.style.setProperty("--tx", `${(e.clientX - r.left - r.width / 2) * 0.18}px`);
        b.style.setProperty("--ty", `${(e.clientY - r.top - r.height / 2) * 0.25}px`);
      });
      b.addEventListener("pointerleave", () => { b.style.setProperty("--tx", "0px"); b.style.setProperty("--ty", "0px"); });
    });
    $$(".vote-card").forEach((c) => {
      c.addEventListener("pointermove", (e) => {
        const r = c.getBoundingClientRect();
        c.style.setProperty("--ry", `${((e.clientX - r.left) / r.width - 0.5) * 10}deg`);
        c.style.setProperty("--rx", `${-((e.clientY - r.top) / r.height - 0.5) * 10}deg`);
      });
      c.addEventListener("pointerleave", () => { c.style.setProperty("--rx", "0deg"); c.style.setProperty("--ry", "0deg"); });
    });
  }

  /* ---------- scroll-driven story ---------- */
  const story = $("#story");
  const world = $("#s-world");
  const W = { city: $("#s-city"), glow: $("#s-glow"), rings: $("#s-rings"), pin: $("#s-pin"),
              memes: $$("#s-memes .meme"), board: $("#s-board"), bars: $$("#s-board .bar"),
              coin: $("#s-coin"), coinFace: $("#s-coin-face") };
  const captions = $$(".caption");
  const dots = $$(".story__dots span");

  // scatter "cities" across the world view (deterministic so it looks the same every visit)
  if (world) {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const NS = "http://www.w3.org/2000/svg";
    for (let i = 0; i < 170; i++) {
      const x = 40 + rnd() * 720, y = 40 + rnd() * 520;
      const d = Math.hypot((x - 400) / 380, (y - 300) / 280);
      if (d > 1 && rnd() > 0.25) continue;
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", x.toFixed(1)); c.setAttribute("cy", y.toFixed(1));
      c.setAttribute("r", (1.6 + rnd() * 2.6).toFixed(1));
      c.setAttribute("class", rnd() > 0.86 ? "world-dot hot" : "world-dot");
      world.appendChild(c);
    }
  }

  let lastStep = -1;
  function renderStory(p) {
    // p: 0 → 1 across the whole story
    const s1 = seg(p, 0.14, 0.36);   // zoom into the city
    const s2 = seg(p, 0.22, 0.40);   // pin drop
    const s3 = seg(p, 0.42, 0.60);   // memes appear
    const s4 = seg(p, 0.62, 0.78);   // leaderboard
    const s5 = seg(p, 0.80, 0.95);   // coin

    // world dots fade + scale away as we zoom in
    if (world) {
      const k = lerp(1, 3.2, easeInOut(s1));
      world.setAttribute("transform", `translate(400 300) scale(${k.toFixed(3)}) translate(-400 -300)`);
      world.setAttribute("opacity", (1 - easeOut(s1)).toFixed(3));
    }
    const cityScale = lerp(0.2, 1, easeInOut(s1)) * lerp(1, 0.9, s5);
    W.city.setAttribute("transform", `translate(400 300) scale(${cityScale.toFixed(3)})`);
    W.city.setAttribute("opacity", (easeOut(s1) * lerp(1, 0.35, s5)).toFixed(3));

    const drop = backOut(s2);
    W.pin.setAttribute("transform", `translate(400 ${lerp(-120, 300, drop).toFixed(1)}) scale(${lerp(1, 0.55, s5).toFixed(3)})`);
    const dim = 1 - 0.75 * easeOut(s4);
    W.pin.setAttribute("opacity", ((1 - s5) * dim).toFixed(3));
    W.glow.setAttribute("opacity", (easeOut(s2) * (1 - s5 * 0.6)).toFixed(3));
    const ringScale = lerp(0.2, 1, easeOut(seg(p, 0.30, 0.46))) + Math.sin(p * 40) * 0.015;
    W.rings.setAttribute("transform", `translate(400 300) scale(${ringScale.toFixed(3)})`);
    W.rings.setAttribute("opacity", (seg(p, 0.30, 0.40) * (1 - s5) * dim).toFixed(3));

    W.memes.forEach((m, i) => {
      const t = seg(s3, i * 0.22, i * 0.22 + 0.5);
      const out = 1 - seg(p, 0.60 + i * 0.02, 0.70 + i * 0.02);
      const x = Number(m.dataset.x), y = Number(m.dataset.y);
      const fromX = lerp(400, x, backOut(t)), fromY = lerp(300, y, backOut(t));
      m.setAttribute("transform", `translate(${fromX.toFixed(1)} ${(fromY - (1 - out) * 30).toFixed(1)}) scale(${lerp(0.4, 1, backOut(t)).toFixed(3)}) rotate(${((i - 1) * 3 * (1 - t)).toFixed(2)})`);
      m.style.opacity = (t * out).toFixed(3);
    });

    W.board.setAttribute("opacity", (easeOut(s4) * (1 - seg(p, 0.82, 0.9))).toFixed(3));
    W.board.setAttribute("transform", `translate(${lerp(40, 250, easeOut(s4)).toFixed(1)} ${lerp(420, 215, easeOut(s4)).toFixed(1)})`);
    W.bars.forEach((b, i) => b.setAttribute("width", (Number(b.dataset.w) * easeOut(seg(s4, 0.2 + i * 0.15, 0.7 + i * 0.1))).toFixed(1)));

    W.coin.setAttribute("opacity", easeOut(s5).toFixed(3));
    W.coin.setAttribute("transform", `translate(400 ${lerp(360, 280, easeOut(s5)).toFixed(1)}) scale(${lerp(0.6, 1, backOut(s5)).toFixed(3)})`);
    const spin = 0.35 + 0.65 * Math.abs(Math.cos(p * Math.PI * 6));
    W.coinFace.setAttribute("transform", `scale(${lerp(spin, 1, easeOut(seg(p, 0.86, 0.93))).toFixed(3)} 1)`);

    const step = p < 0.16 ? 0 : p < 0.41 ? 1 : p < 0.61 ? 2 : p < 0.80 ? 3 : 4;
    if (step !== lastStep) {
      captions.forEach((c, i) => c.classList.toggle("is-active", i === step));
      dots.forEach((d, i) => d.classList.toggle("is-on", i === step));
      lastStep = step;
    }
  }

  function storyProgress() {
    const r = story.getBoundingClientRect();
    return clamp(-r.top / (r.height - window.innerHeight));
  }

  /* ---------- scroll loop (only work while something changes) ---------- */
  const bar = $("#progress-bar");
  const timeline = $("#timeline");
  let ticking = false;
  function onScroll() {
    if (ticking) return; ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const h = document.documentElement;
      if (bar) bar.style.transform = `scaleX(${clamp(h.scrollTop / (h.scrollHeight - h.clientHeight)).toFixed(4)})`;
      if (story && !reduced) renderStory(storyProgress());
      if (timeline) {
        const r = timeline.getBoundingClientRect();
        timeline.style.setProperty("--fill", clamp((window.innerHeight * 0.7 - r.top) / r.height).toFixed(3));
      }
    });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  if (reduced && story) { renderStory(0.9); captions.forEach((c) => c.classList.add("is-active")); }
  onScroll();

  /* ---------- vote demo ---------- */
  const board = $("#demo-board");
  const cards = $$(".vote-card");
  const initial = cards.map((c) => ({ city: c.dataset.city, votes: Number(c.dataset.votes) }));
  let tally = initial.map((x) => ({ ...x }));
  function renderBoard() {
    const max = Math.max(...tally.map((t) => t.votes));
    const sorted = [...tally].sort((a, b) => b.votes - a.votes);
    board.replaceChildren(...sorted.map((t, i) => {
      const li = document.createElement("li");
      const name = document.createElement("strong"); name.textContent = `${i + 1}. ${t.city}`;
      const v = document.createElement("span"); v.className = "votes"; v.textContent = `${t.votes} votes`;
      const track = document.createElement("div"); track.className = "bar-track";
      const fill = document.createElement("div"); fill.className = "bar-fill"; fill.style.transform = `scaleX(${(t.votes / max).toFixed(3)})`;
      track.append(fill); li.append(name, v, track); return li;
    }));
  }
  function burst(x, y) {
    if (reduced) return;
    for (let i = 0; i < 10; i++) {
      const s = document.createElement("span"); s.className = "burst"; s.textContent = ["📍", "✨", "🔥", "😂"][i % 4];
      s.style.left = `${x}px`; s.style.top = `${y}px`;
      const a = Math.random() * Math.PI * 2, d = 50 + Math.random() * 70;
      s.style.setProperty("--bx", `${Math.cos(a) * d}px`); s.style.setProperty("--by", `${Math.sin(a) * d}px`);
      document.body.append(s); setTimeout(() => s.remove(), 950);
    }
  }
  if (board) {
    cards.forEach((c) => c.addEventListener("click", (e) => {
      if (c.classList.contains("is-voted")) { toast("One vote per meme in the demo 🙂"); return; }
      tally.find((t) => t.city === c.dataset.city).votes += 1;
      c.classList.add("is-voted"); $(".vote-card__cta", c).textContent = "Voted ✓";
      renderBoard(); burst(e.clientX || c.getBoundingClientRect().left + 40, e.clientY || c.getBoundingClientRect().top + 40);
    }));
    $("#demo-reset").addEventListener("click", () => {
      tally = initial.map((x) => ({ ...x }));
      cards.forEach((c) => { c.classList.remove("is-voted"); $(".vote-card__cta", c).textContent = "Vote"; });
      renderBoard();
    });
    renderBoard();
  }

  /* ---------- official link checker ---------- */
  const checker = $("#checker"), result = $("#check-result");
  if (checker) checker.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("#check-input").value.trim();
    try {
      const res = await fetch(`/api/check?q=${encodeURIComponent(q)}`, { cache: "no-store" });
      const data = await res.json();
      const icon = { official: "✓", not_official: "✕", warning: "!", unknown: "?", empty: "?" }[data.verdict] || "?";
      const title = { official: "Official", not_official: "Not official", warning: "Be careful" }[data.verdict] || "Hmm";
      const i = document.createElement("span"); i.className = "check-result__icon"; i.textContent = icon;
      const body = document.createElement("div");
      const h = document.createElement("strong"); h.textContent = title;
      const p = document.createElement("p"); p.textContent = data.message;
      body.append(h, p);
      result.className = `check-result check-result--${data.verdict}`;
      result.replaceChildren(i, body); result.hidden = false;
    } catch {
      result.className = "check-result check-result--unknown";
      result.textContent = "Couldn't reach the checker. Please try again."; result.hidden = false;
    }
  });

  /* ---------- wallet: discovery (Wallet Standard + Phantom fallback) ---------- */
  const panel = $("#wallet-panel");
  const list = $("#wallet-list");
  const errBox = $("#wallet-error");
  const wallets = new Map(); // name -> adapter
  const hostHint = $("#host-hint"); if (hostHint) hostHint.textContent = location.host;

  function standardAdapter(w) {
    return {
      name: w.name, icon: w.icon,
      async connect() {
        const { accounts } = await w.features["standard:connect"].connect();
        const acc = accounts.find((a) => a.chains?.some((c) => c.startsWith("solana:"))) || accounts[0];
        if (!acc) throw new Error("No account was shared.");
        this.account = acc; return acc.address;
      },
      async signMessage(bytes) {
        const [out] = await w.features["solana:signMessage"].signMessage({ account: this.account, message: bytes });
        return out.signature;
      },
      async disconnect() { try { await w.features["standard:disconnect"]?.disconnect(); } catch {} },
    };
  }
  function register(...ws) {
    for (const w of ws) {
      const ok = w && w.name && w.features && w.features["standard:connect"] && w.features["solana:signMessage"] &&
        (w.chains || []).some((c) => String(c).startsWith("solana:"));
      if (ok && !wallets.has(w.name)) wallets.set(w.name, standardAdapter(w));
    }
    renderWalletList();
    return () => {};
  }
  window.addEventListener("wallet-standard:register-wallet", (e) => { try { e.detail({ register }); } catch {} });
  try { window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: { register } })); } catch {}

  function legacyPhantom() {
    const p = window.phantom?.solana;
    if (!p?.isPhantom || [...wallets.keys()].some((n) => /phantom/i.test(n))) return;
    wallets.set("Phantom", {
      name: "Phantom", icon: null,
      async connect() { const r = await p.connect(); return r.publicKey.toString(); },
      async signMessage(bytes) { const r = await p.signMessage(bytes, "utf8"); return r.signature; },
      async disconnect() { try { await p.disconnect(); } catch {} },
    });
  }

  function renderWalletList() {
    if (!list) return;
    const safeIcon = (src) => (typeof src === "string" && /^data:image\/(svg\+xml|png|webp|jpeg);base64,/.test(src) ? src : "/logo.svg");
    list.replaceChildren(...[...wallets.values()].map((w) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "wallet-option";
      const img = document.createElement("img"); img.alt = ""; img.src = safeIcon(w.icon);
      const n = document.createElement("span"); n.textContent = w.name;
      const d = document.createElement("span"); d.className = "detected"; d.textContent = "Detected";
      b.append(img, n, d); b.addEventListener("click", () => connect(w)); return b;
    }));
    $("#wallet-empty").hidden = wallets.size > 0;
    if (isMobile) {
      const here = encodeURIComponent(location.href), ref = encodeURIComponent(location.origin);
      $("#open-phantom").href = `https://phantom.app/ul/browse/${here}?ref=${ref}`;
      $("#open-solflare").href = `https://solflare.com/ul/v1/browse/${here}?ref=${ref}`;
    }
  }

  let active = null, address = null;
  const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
  function show(state) {
    $$(".wallet__state", panel).forEach((s) => (s.hidden = s.dataset.state !== state));
    document.dispatchEvent(new CustomEvent("vicinity:wallet", { detail: { address: state === "idle" ? null : address } }));
    errBox.hidden = true;
    const label = $("[data-wallet-label]");
    const headerBtn = label?.closest(".btn");
    if (state === "idle") { label.textContent = "Connect wallet"; headerBtn.classList.remove("is-verified"); }
    if (state === "connected") label.textContent = short(address);
    if (state === "verified") { label.textContent = `${short(address)} ✓`; headerBtn.classList.add("is-verified"); }
  }
  const fail = (msg) => { errBox.textContent = msg; errBox.hidden = false; };

  async function connect(w) {
    try {
      address = await w.connect(); active = w;
      $("#addr-short").textContent = short(address);
      $("#wallet-name").textContent = w.name;
      show("connected");
      preloadMessage();
    } catch (e) { fail(e?.message?.includes("reject") || e?.code === 4001 ? "Connection cancelled in your wallet." : "Couldn't connect. Please try again."); }
  }

  let pending = null;
  async function preloadMessage() {
    pending = null; $("#msg-preview").textContent = "Loading…";
    try {
      const r = await fetch(`/api/message?address=${encodeURIComponent(address)}`, { cache: "no-store" });
      const d = await r.json(); if (!r.ok) throw new Error(d.error);
      pending = d.message; $("#msg-preview").textContent = d.message;
    } catch { $("#msg-preview").textContent = "Couldn't load the message. Try again."; }
  }

  async function verify() {
    const btn = $("#verify-btn");
    if (!pending) await preloadMessage();
    if (!pending) return fail("Couldn't prepare the message. Please try again.");
    btn.disabled = true; btn.textContent = "Check your wallet…";
    try {
      const sig = await active.signMessage(new TextEncoder().encode(pending));
      const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
      const r = await fetch("/api/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, message: pending, signature: b64 }) });
      const d = await r.json();
      if (!d.verified) throw new Error(d.error || "failed");
      $("#addr-verified").textContent = short(address);
      const badge = $("#badge-icon"), title = $("#verify-title"), detail = $("#verify-detail");
      badge.classList.remove("is-gold", "is-plain");
      if (!d.launched) {
        badge.textContent = "✓"; title.textContent = "Wallet verified";
        detail.textContent = "$VICINITY isn't live yet. Come back after launch and your holder status will show here.";
      } else if (d.holder) {
        badge.textContent = "🏅"; badge.classList.add("is-gold"); title.textContent = "Founding Supporter";
        detail.textContent = `You hold ${fmt(d.amount)} $VICINITY. You're in line for early access to the Vicinity Launchpad.`;
      } else if (d.holderCheck === "unavailable") {
        badge.textContent = "✓"; title.textContent = "Wallet verified";
        detail.textContent = "We couldn't reach the blockchain just now. Try again in a minute.";
      } else {
        badge.textContent = "✓"; badge.classList.add("is-plain"); title.textContent = "Wallet verified";
        detail.textContent = "This wallet doesn't hold $VICINITY yet. Grab some to become a Founding Supporter.";
      }
      show("verified"); toast(d.holder ? "Founding Supporter ✓" : "Wallet verified ✓");
    } catch (e) {
      const msg = String(e?.message || "");
      fail(/reject|cancel|denied/i.test(msg) || e?.code === 4001 ? "Signing cancelled in your wallet. Nothing happened."
        : msg === "expired" ? "That message expired. Tap verify again for a fresh one." : "Verification failed. Please try again.");
      preloadMessage();
    } finally { btn.disabled = false; btn.textContent = "Verify my $VICINITY"; }
  }

  async function disconnect() {
    await active?.disconnect(); active = null; address = null; pending = null; show("idle");
  }

  if (panel) {
    $("#verify-btn").addEventListener("click", verify);
    $$("[data-disconnect]").forEach((b) => b.addEventListener("click", disconnect));
    $("#copy-addr").addEventListener("click", async () => { try { await navigator.clipboard.writeText(address); toast("Address copied"); } catch { toast(address); } });
    $$("[data-open-wallet]").forEach((b) => b.addEventListener("click", () => {
      $("#wallet").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
      if (!active && wallets.size === 1) setTimeout(() => connect([...wallets.values()][0]), reduced ? 0 : 600);
    }));
    setTimeout(() => { legacyPhantom(); renderWalletList(); }, 400);
    renderWalletList();
  }

  /* ---------- live token facts, registry, holders ---------- */
  const fmt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 0 });
  const shortAddr = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const isAddr = (a) => typeof a === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

  function renderRegistry(list) {
    const body = $("#registry-body"); if (!body || !Array.isArray(list)) return;
    body.replaceChildren(...list.map((t) => {
      const tr = document.createElement("tr");
      const ca = el("td"); if (isAddr(t.contract)) { const c = el("code", null, t.contract); ca.append(c); } else ca.textContent = t.status === "Launching soon" ? "Launching soon" : "—";
      const st = el("td"); st.append(el("span", t.contract ? "tag tag--ok" : t.status === "Launching soon" ? "tag tag--warn" : "tag", t.contract ? "Live" : t.status));
      tr.append(el("td", null, t.network), el("td", null, `${t.name} (${t.symbol.startsWith("e.g.") ? t.symbol : "$" + t.symbol})`), ca, st);
      return tr;
    }));
  }

  async function loadToken() {
    try {
      const d = await (await fetch("/api/token", { cache: "no-store" })).json();
      renderRegistry(d.registry);
      if (!d.launched || !d.facts) return;
      const f = d.facts, m = f.mint;
      $("#ca-text").textContent = m;
      const copy = $("#ca-copy"); copy.hidden = false;
      copy.onclick = async () => { try { await navigator.clipboard.writeText(m); toast("Contract address copied"); } catch { toast(m); } };
      $("#lnk-solscan").href = `https://solscan.io/token/${m}`;
      $("#lnk-jup").href = `https://jup.ag/tokens/${m}`;
      $("#lnk-pump").href = `https://pump.fun/coin/${m}`;
      $("#lnk-dex").href = `https://dexscreener.com/solana/${m}`;
      $("#ca-links").hidden = false;
      const live = (key, ok, okText, badText) => { const e = $(`[data-live="${key}"]`); if (!e) return; e.textContent = ok ? okText : badText; e.classList.add(ok ? "is-live" : "is-bad"); };
      live("mint", f.mintingDisabled, "Verified on-chain", "Warning: minting is ON");
      live("freeze", f.freezingDisabled, "Verified on-chain", "Warning: freezing is ON");
      $("#supply-text").textContent = fmt(f.supply);
      live("supply", true, "Verified on-chain", "");
    } catch {}
  }

  async function loadHolders() {
    const status = $("#holders-status"), table = $("#holders-table"), body = $("#holders-body"), refresh = $("#holders-refresh");
    if (!status) return;
    try {
      const r = await fetch("/api/holders", { cache: "no-store" });
      const d = await r.json();
      if (!d.launched) return;
      refresh.hidden = false;
      if (!r.ok || d.error) { status.textContent = "The blockchain is busy right now. Try refresh in a minute."; return; }
      const max = Math.max(...d.holders.map((h) => h.percent), 1);
      body.replaceChildren(...d.holders.map((h) => {
        const tr = document.createElement("tr");
        const w = el("td"); const a = el("a", null, shortAddr(h.owner)); a.href = `https://solscan.io/account/${h.owner}`; a.target = "_blank"; a.rel = "noopener"; a.title = h.owner; w.append(a);
        if (h.label) w.append(el("span", "tag tag--ok", h.label));
        const pct = el("td", "num", `${h.percent.toFixed(2)}%`); const bar = el("span", "pct-bar"); const fill = el("span"); fill.style.width = `${(h.percent / max) * 100}%`; bar.append(fill); pct.append(bar);
        tr.append(el("td", null, String(h.rank)), w, el("td", "num", fmt(h.amount)), pct);
        return tr;
      }));
      table.hidden = false;
      status.textContent = `Top ${d.holders.length} wallets · updated ${new Date(d.updatedAt).toLocaleTimeString()}`;
    } catch { status.textContent = "Couldn't load holders. Try refresh."; }
  }
  $("#holders-refresh")?.addEventListener("click", loadHolders);
  loadToken(); loadHolders();

  /* ---------- claim your city ---------- */
  const citySec = $("#cities");
  if (citySec) {
    const MIN_HOLD = 1_000_000;
    const norm = (s) => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}]+/gu, "");
    const km = (a, b, c, d) => { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 12742 * Math.asin(Math.min(1, Math.sqrt(x))); };
    const radiusOf = (c) => ((c.pop || 0) >= 1_000_000 ? 50 : 25);
    const canvas = $("#city-canvas"), ctx = canvas.getContext("2d"), tip = $("#city-tip");
    const listEl = $("#city-list"), qEl = $("#city-q"), countryEl = $("#city-country"), filterEl = $("#city-filter");
    const btn = $("#claim-btn"), errEl = $("#claim-error"), addForm = $("#add-form");
    let cities = [], byId = new Map(), countries = {}, admin = {}, claims = new Map(), open = false, loaded = false;
    let selected = null, mode = "claim", myCity = null, lastLoc = null, busy = false, followHandle = null;

    const placeOf = (c) => [admin[`${c.cc}.${c.adm}`], countries[c.cc] || c.cc].filter(Boolean).join(", ");
    const setErr = (m) => { errEl.textContent = m || ""; errEl.hidden = !m; };
    const req = (k, state, text) => {
      const li = $(`[data-req="${k}"]`); if (!li) return;
      li.classList.toggle("is-ok", state === "ok"); li.classList.toggle("is-bad", state === "bad");
      if (text && k === "here") $("#req-here-text").textContent = text;
      if (text && k === "wallet") $("#req-wallet-text").textContent = text;
    };

    /* map */
    let W = 0, H = 0, dpr = 1, hover = null;
    const proj = (c) => [((c.lon + 180) / 360) * W, ((84 - c.lat) / 144) * H];
    function sizeCanvas() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      draw();
    }
    function draw() {
      if (!W) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const k = W / 1200;
      ctx.fillStyle = "rgba(127,163,214,.55)";
      for (const c of cities) {
        if (claims.has(c.id)) continue;
        const [x, y] = proj(c), r = Math.max(0.6, (Math.log10(c.pop || 20000) - 3.6) * 0.75) * Math.max(k, 0.45);
        ctx.fillRect(x - r / 2, y - r / 2, r, r);
      }
      for (const c of cities) {
        const cl = claims.get(c.id); if (!cl) continue;
        const [x, y] = proj(c), mine = address && cl.wallet === address;
        ctx.shadowColor = mine ? "#FFC857" : "#FF5A36"; ctx.shadowBlur = 10;
        ctx.fillStyle = mine ? "#FFC857" : "#FF5A36";
        ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.shadowBlur = 0;
      for (const [c, color] of [[hover, "rgba(255,255,255,.8)"], [selected, "#FFC857"]]) {
        if (!c) continue;
        const [x, y] = proj(c);
        ctx.strokeStyle = color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke();
      }
    }
    function nearest(ev) {
      const r = canvas.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
      let best = null, bd = 14 * 14;
      for (const c of cities) {
        const [x, y] = proj(c), d = (x - mx) ** 2 + (y - my) ** 2;
        if (d < bd || (d === bd && best && c.pop > best.pop)) { bd = d; best = c; }
      }
      return { best, mx, my };
    }
    let moveQueued = false;
    canvas.addEventListener("pointermove", (ev) => {
      if (moveQueued || !loaded) return; moveQueued = true;
      requestAnimationFrame(() => {
        moveQueued = false;
        const { best, mx, my } = nearest(ev);
        if (best !== hover) { hover = best; draw(); }
        if (best) {
          const cl = claims.get(best.id);
          tip.textContent = `${best.name}, ${countries[best.cc] || best.cc}${cl ? " · claimed" : ""}`;
          tip.style.left = `${mx + 14}px`; tip.style.top = `${my + 14}px`; tip.hidden = false;
        } else tip.hidden = true;
      });
    });
    canvas.addEventListener("pointerleave", () => { hover = null; tip.hidden = true; draw(); });
    canvas.addEventListener("click", (ev) => { const { best } = nearest(ev); if (best) { select(best); $("#claim-panel").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" }); } });
    window.addEventListener("resize", () => { if (loaded) sizeCanvas(); });

    /* list */
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
        const nm = el("span", "city-row__name"); nm.append(el("strong", null, c.name), el("span", null, `${placeOf(c)}${c.pop ? " · " + fmt(c.pop) : ""}${c.added ? " · community-added" : ""}`));
        const cl = claims.get(c.id), mine = cl && address && cl.wallet === address;
        b.append(nm, el("span", mine ? "tag tag--warn" : cl ? "tag tag--no" : "tag tag--ok", mine ? "Yours" : cl ? "Claimed" : "Open"));
        b.addEventListener("click", () => select(c));
        li.append(b); return li;
      }));
    }
    let typing; qEl.addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(renderList, 120); });
    countryEl.addEventListener("change", renderList); filterEl.addEventListener("change", renderList);

    /* panel */
    function refreshPanel(keepError = false) {
      if (!keepError) setErr("");
      $("#claim-done").hidden = true;
      $("#claim-reqs").hidden = false;
      addForm.hidden = mode !== "add";
      myCity = address ? [...claims.entries()].find(([, v]) => v.wallet === address) : null;
      req("wallet", address ? "ok" : null, address ? `Connected: ${short(address)}` : null);
      if (!address) $("#req-wallet-text").replaceChildren(document.createTextNode("Any Solana wallet. "), Object.assign(el("a", null, "Connect here"), { href: "#wallet" }), document.createTextNode("."));
      if (mode === "add") {
        $("#claim-kicker").textContent = "Add a city"; $("#claim-title").textContent = "Put your city on the map";
        $("#claim-sub").textContent = "Only if it isn't listed yet. You'll be its founder.";
      } else if (selected) {
        const cl = claims.get(selected.id);
        $("#claim-kicker").textContent = cl ? "Claimed" : "Open city";
        $("#claim-title").textContent = selected.name;
        $("#claim-sub").textContent = `${placeOf(selected)}${selected.pop ? " · " + fmt(selected.pop) + " people" : ""}`;
        if (cl) {
          const a = el("a", null, short(cl.wallet)); a.href = `https://solscan.io/account/${cl.wallet}`; a.target = "_blank"; a.rel = "noopener";
          $("#claim-sub").append(document.createElement("br"), document.createTextNode("Founder: "), a, document.createTextNode(` since ${new Date(cl.claimed_at).toLocaleDateString()}`));
        }
      }
      let label = "Pick a city first", disabled = true;
      if (!open) label = "Claims open when $VICINITY launches";
      else if (myCity) label = `Your wallet already founded ${myCity[1].city_name}`;
      else if (mode === "claim" && !selected) label = "Pick a city first";
      else if (mode === "claim" && claims.has(selected.id)) label = "Already claimed";
      else if (!address) { label = "Connect your wallet"; disabled = false; }
      else { label = mode === "add" ? "Add & claim this city" : `Claim ${selected.name}`; disabled = false; }
      btn.textContent = label; btn.disabled = disabled || busy;
    }
    function select(c) {
      mode = "claim"; selected = c; lastLoc = null; req("here", null, "Share your location once. We only check you're inside the city (25 km, or 50 km for cities over 1M people) and never save it.");
      refreshPanel(); renderList(); draw();
    }
    $("#city-add-open").addEventListener("click", () => {
      mode = "add"; selected = null;
      if (countryEl.value) $("#add-country").value = countryEl.value;
      $("#add-name").value = qEl.value.trim();
      refreshPanel(); renderList(); draw();
      $("#claim-panel").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });
      $("#add-name").focus();
    });
    document.addEventListener("vicinity:wallet", () => { if (loaded) { refreshPanel(); renderList(); draw(); } });
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
      if (!address || !active) { $("#wallet").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" }); return; }
      let target;
      if (mode === "add") {
        const name = $("#add-name").value.trim().replace(/\s+/g, " "), cc = $("#add-country").value;
        if (!/^[\p{L}\p{M}][\p{L}\p{M} .'’-]{0,58}[\p{L}\p{M}.]$/u.test(name)) return setErr("Use letters only for the city name (spaces, - . ' are fine).");
        if (!cc) return setErr("Please pick a country.");
        const dup = cities.find((c) => c.cc === cc && c.n === norm(name));
        if (dup) { select(dup); return setErr(`${dup.name} is already listed. We've selected it for you.`); }
        target = `action=add&name=${encodeURIComponent(name)}&country=${cc}`;
      } else target = `action=claim&city=${encodeURIComponent(selected.id)}&country=${selected.cc}`;
      if (followHandle && !$("#follow-ok").checked) return setErr("Please follow Vicinity on X first, then tick the box.");

      busy = true; btn.disabled = true;
      try {
        btn.textContent = "Getting your location…";
        const loc = await getLocation();
        if (mode === "claim") {
          const d = km(loc.lat, loc.lon, selected.lat, selected.lon), rad = radiusOf(selected);
          if (d > rad) { req("here", "bad", `You're about ${Math.round(d)} km from ${selected.name}. You need to be within ${rad} km.`); throw new Error(`You're about ${Math.round(d)} km away. Claim the city you're in right now.`); }
          req("here", "ok", `You're in ${selected.name} ✓ (location not saved)`);
        } else req("here", "ok", "Location checked ✓ (not saved)");
        btn.textContent = "Check your wallet…";
        const m = await (await fetch(`/api/message?address=${encodeURIComponent(address)}&${target}`, { cache: "no-store" })).json();
        if (!m.message) throw new Error("Couldn't prepare the message. Please try again.");
        const sig = await active.signMessage(new TextEncoder().encode(m.message));
        req("sign", "ok");
        btn.textContent = "Claiming…";
        const r = await fetch("/api/claim", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ address, message: m.message, signature: btoa(String.fromCharCode(...new Uint8Array(sig))), location: loc }) });
        const d = await r.json();
        if (!d.claimed) {
          if (d.error === "already_listed" && byId.get(d.cityId)) select(byId.get(d.cityId));
          if (d.error === "city_taken" && d.by && selected) { claims.set(selected.id, { wallet: d.by, city_name: selected.name, country: selected.cc, claimed_at: new Date().toISOString() }); renderList(); draw(); updateStats(); }
          if (d.error === "not_enough_tokens") req("hold", "bad");
          throw new Error((ERR[d.error] || (() => "Claim failed. Please try again."))(d));
        }
        req("hold", "ok");
        if (!byId.has(d.cityId)) {
          const c = { id: d.cityId, name: d.cityName, cc: d.country, adm: "", lat: loc.lat, lon: loc.lon, pop: 0, n: norm(d.cityName), added: true };
          cities.push(c); byId.set(c.id, c);
        }
        claims.set(d.cityId, { wallet: address, city_name: d.cityName, country: d.country, claimed_at: d.claimedAt });
        selected = byId.get(d.cityId); mode = "claim";
        refreshPanel(); renderList(); draw(); updateStats();
        $("#claim-reqs").hidden = true; addForm.hidden = true;
        $("#claim-done-title").textContent = `You founded ${d.cityName}!`;
        $("#claim-done-text").textContent = `${d.cityName} is now linked to ${short(address)}. Keep holding ${fmt(MIN_HOLD)}+ $VICINITY: founders are re-checked at the Launchpad snapshot.`;
        $("#claim-done").hidden = false;
        toast(`📍 ${d.cityName} is yours`);
        const rr = btn.getBoundingClientRect(); burst(rr.left + rr.width / 2, rr.top);
      } catch (e) {
        const msg = String(e?.message || "");
        setErr(/reject|cancel|denied/i.test(msg) || e?.code === 4001 ? "Signing cancelled in your wallet. Nothing happened." : msg || "Claim failed. Please try again.");
      } finally {
        busy = false;
        if ($("#claim-done").hidden) refreshPanel(true); else { btn.disabled = true; }
      }
    });

    function updateStats() {
      $("#cs-cities").textContent = fmt(cities.length);
      $("#cs-countries").textContent = fmt(new Set(cities.map((c) => c.cc)).size);
      $("#cs-claimed").textContent = fmt(claims.size);
      $("#cs-status").textContent = open ? "Open" : "At launch";
    }

    async function loadCities() {
      if (loaded) return; loaded = true;
      try {
        const [data, cl, off] = await Promise.all([
          fetch("/data/cities.json").then((r) => r.json()),
          fetch("/api/claims", { cache: "no-store" }).then((r) => r.json()).catch(() => ({ claims: [], added: [] })),
          fetch("/api/official", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
        ]);
        countries = data.countries; admin = data.admin;
        cities = Object.entries(data.byCountry).flatMap(([cc, rows]) => rows.map(([id, name, adm, lat, lon, pop]) => ({ id: String(id), name, cc, adm, lat, lon, pop, n: norm(name) })));
        cities.sort((a, b) => b.pop - a.pop);
        for (const a of cl.added || []) cities.push({ id: a.id, name: a.name, cc: a.country, adm: "", lat: a.lat, lon: a.lon, pop: 0, n: norm(a.name), added: true });
        byId = new Map(cities.map((c) => [c.id, c]));
        claims = new Map((cl.claims || []).map((c) => [c.city_id, c]));
        open = Boolean(cl.open);
        const handle = (off.socials || []).find((h) => /^@[A-Za-z0-9_]{1,15}$/.test(h));
        if (handle) { followHandle = handle; $("#req-follow").hidden = false; $("#follow-link").href = `https://x.com/${handle.slice(1)}`; $("#follow-link").textContent = `Follow ${handle} ↗`; }
        const counts = {}; for (const c of cities) counts[c.cc] = (counts[c.cc] || 0) + 1;
        const opts = Object.keys(countries).sort((a, b) => countries[a].localeCompare(countries[b]));
        countryEl.append(...opts.filter((c) => counts[c]).map((c) => Object.assign(document.createElement("option"), { value: c, textContent: `${countries[c]} (${counts[c]})` })));
        $("#add-country").append(Object.assign(document.createElement("option"), { value: "", textContent: "Choose a country" }),
          ...opts.map((c) => Object.assign(document.createElement("option"), { value: c, textContent: countries[c] })));
        updateStats(); sizeCanvas(); renderList(); refreshPanel();
      } catch {
        loaded = false;
        listEl.replaceChildren(el("li", "muted", "Couldn't load the city list. Refresh the page to try again."));
      }
    }
    const cityIo = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { cityIo.disconnect(); loadCities(); } }, { rootMargin: "800px 0px" });
    cityIo.observe(citySec);
  }

  /* ---------- backend status ---------- */
  (async () => {
    const el = $("#status"); if (!el) return;
    try { const d = await (await fetch("/api/health", { cache: "no-store" })).json(); el.textContent = d.ok ? "online ✓" : "problem"; }
    catch { el.textContent = "offline"; }
  })();
})();
