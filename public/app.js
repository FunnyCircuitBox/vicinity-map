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
      show("verified"); toast("Wallet verified ✓");
    } catch (e) {
      const msg = String(e?.message || "");
      fail(/reject|cancel|denied/i.test(msg) || e?.code === 4001 ? "Signing cancelled in your wallet. Nothing happened."
        : msg === "expired" ? "That message expired. Tap verify again for a fresh one." : "Verification failed. Please try again.");
      preloadMessage();
    } finally { btn.disabled = false; btn.textContent = "Verify ownership (free)"; }
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

  /* ---------- backend status ---------- */
  (async () => {
    const el = $("#status"); if (!el) return;
    try { const d = await (await fetch("/api/health", { cache: "no-store" })).json(); el.textContent = d.ok ? "online ✓" : "problem"; }
    catch { el.textContent = "offline"; }
  })();
})();
