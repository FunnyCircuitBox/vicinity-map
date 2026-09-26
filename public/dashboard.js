// Dashboard: first-visit onboarding (rank + home community), then the live dashboard:
// identity + role, rank everywhere, founder race, badges (re-checked every minute), community and country,
// local / national feeds (memes, check-ins, discussions, weekly votes), moderator tools, town requests.
(() => {
  "use strict";
  const { $, $$, el, api, toast, copy, fmt, compact, mask, ago, initials, getLocation, burst, reveal } = window.V;
  const params = new URLSearchParams(location.search);
  const LEVEL = { admin: "Admin", manager: "Country Manager", founder: "City Founder", holder: "Holder", member: "Member" };
  const regionNames = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; } })();
  const countryName = (cc) => { try { return (regionNames && regionNames.of(cc)) || cc; } catch { return cc; } };
  const ticker = (name) => (window.vicinityTicker ? window.vicinityTicker.baseTicker(name) : String(name).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10));
  const pctText = (p) => (p >= 10 ? p.toFixed(1) : p >= 0.01 ? p.toFixed(2) : "<0.01");
  let me = null, checkedAt = 0;

  const LOC_ERR = {
    vpn_detected: "It looks like you're on a VPN, proxy or cloud network. Turn it off and use your normal home or mobile internet.",
    network_mismatch: (d) => d.networkCountry ? `Your internet connection is in a different country (${d.networkCountry}). Turn off any VPN and try again.` : "Your internet connection is far from your GPS location. Turn off any VPN and try again.",
    location_too_rough: "Your location isn't precise enough. Turn on precise location / GPS and try again.",
    location_required: "We need your location for this.",
    unknown_country: "We couldn't tell which country you're in. Turn off any VPN and try again.",
    cities_unavailable: "The map is busy. Please try again in a minute.",
    home_locked: (d) => `You can change your home community once a week (next: ${new Date(d.until).toLocaleDateString()}).`,
    sign_in: "Your session ended. Please sign in again.",
  };
  const errText = (map, d, fallback) => { const f = map[d.error]; return typeof f === "function" ? f(d) : f || fallback; };

  /* ---------- identity (shared by onboarding and the dashboard) ---------- */
  function identity(d) {
    const u = d.user, name = u.handle || u.name || mask(u.wallet);
    $$("[data-me-name]").forEach((e) => (e.textContent = name));
    $$("[data-me-wallet]").forEach((e) => (e.textContent = mask(u.wallet)));
    $$("[data-me-login]").forEach((e) => (e.textContent = u.provider === "x" ? `X ${u.handle || ""}`.trim() : `Google · ${u.name || ""}`));
    $("#me-avatar").textContent = initials(name);
  }

  /* ---------- first visit: position + home community ---------- */
  let lastLoc = null;
  function onboard(d) {
    $("#dash-onboard").hidden = false;
    const li = $("#ob-rank"), t = $("#ob-rank-text"), h = d.holding;
    li.classList.add("is-ok");
    if (!d.launched) t.textContent = "Ranks go live the moment $VICINITY launches. You joined before launch: 🌱 Early member badge unlocked.";
    else if (h.rank) t.textContent = `#${fmt(h.rank)} of ${fmt(h.total)} holders · top ${pctText(h.percentile)}% · ${fmt(h.amount)} $VICINITY`;
    else if (h.amount > 0) t.textContent = `${fmt(h.amount)} $VICINITY`;
    else t.textContent = "This wallet doesn't hold $VICINITY yet. You can still join your city; holding unlocks posting, voting and your rank.";
    $("#ob-locate").addEventListener("click", () => findHome());
    $("#ob-enter").addEventListener("click", () => location.assign("/dashboard"));
  }
  async function findHome(choice) {
    const li = $("#ob-city"), err = $("#ob-error");
    li.classList.remove("is-bad"); li.classList.add("is-busy"); err.hidden = true;
    $("#ob-locate").disabled = true;
    try {
      if (!lastLoc || !choice) lastLoc = await getLocation();
      const d = await api("/api/home", { location: lastLoc, ...(choice ? { choice } : {}) });
      li.classList.remove("is-busy");
      if (d.ok) {
        li.classList.add("is-ok");
        $("#ob-city-text").textContent = `${d.joinedNearby ? "You joined" : "You're in"} ${d.home.name} ✓ (your location wasn't saved)`;
        $("#ob-nearby").hidden = true; $("#ob-locate").hidden = true; $("#ob-enter").hidden = false;
        const r = li.getBoundingClientRect(); burst(r.left + 40, r.top);
        return;
      }
      if (d.needsChoice) {
        $("#ob-city-text").textContent = "You're not inside a community yet. Join one of the three nearest:";
        $("#ob-locate").hidden = true;
        const ul = $("#ob-nearby"); ul.hidden = false;
        ul.replaceChildren(...d.nearby.map((c) => {
          const b = el("button", "city-row"); b.type = "button";
          const nm = el("span", "city-row__name"); nm.append(el("strong", null, c.name), el("span", null, `${c.km < 10 ? c.km.toFixed(1) : Math.round(c.km)} km away`));
          b.append(nm, el("span", "tag tag--ok", "Join"));
          b.addEventListener("click", () => findHome(c.id));
          const x = el("li"); x.append(b); return x;
        }));
        return;
      }
      throw new Error(errText(LOC_ERR, d, "Couldn't set your community. Please try again."));
    } catch (e) {
      li.classList.remove("is-busy"); li.classList.add("is-bad");
      err.textContent = e.message; err.hidden = false;
    } finally { $("#ob-locate").disabled = false; }
  }

  /* ---------- the dashboard ---------- */
  const BADGE_NAMES = {};
  function render(d) {
    me = d; checkedAt = Date.now();
    identity(d);
    const u = d.user, h = d.holding, home = u.home;
    const pill = $("#me-role"); pill.textContent = LEVEL[d.level] || "Member"; pill.dataset.level = d.level;
    $("#me-home").textContent = home ? `${home.name}, ${countryName(home.country)}` : "No home community yet";

    // stats
    $("#d-amount").textContent = d.launched ? compact(h.amount) : "At launch";
    $("#d-amount-sub").textContent = d.launched ? `${fmt(h.amount)} $VICINITY` : "$VICINITY isn't live yet";
    $("#d-rank").textContent = h.rank ? `#${fmt(h.rank)}` : "—";
    $("#d-rank-sub").textContent = h.rank ? `of ${fmt(h.total)} · top ${pctText(h.percentile)}%` : d.launched ? (h.amount > 0 ? "ranking…" : "not holding yet") : "live at launch";
    const c = d.community, n = d.national;
    $("#d-city-label").textContent = home ? home.name : "your city";
    $("#d-country-label").textContent = n ? countryName(n.country) : "your country";
    $("#d-crank").textContent = c && c.rank ? `#${c.rank}` : "—";
    $("#d-crank-sub").textContent = c ? (c.rank ? `of ${c.holders} holders here` : `${fmt(c.members)} member${c.members === 1 ? "" : "s"}`) : "";
    $("#d-nrank").textContent = n && n.rank ? `#${n.rank}` : "—";
    $("#d-nrank-sub").textContent = n ? (n.rank ? `of ${n.holders} holders` : `${fmt(n.members)} member${n.members === 1 ? "" : "s"}`) : "";

    // lost badges / founder at risk
    for (const b of d.badges) BADGE_NAMES[b.id] = b.name;
    const alert = $("#lost-alert");
    const lostNames = d.lost.map((id) => BADGE_NAMES[id] || id);
    if (d.claim && d.claim.atRisk) {
      alert.textContent = `⚠️ You hold less than 1,000,000 $VICINITY, so you're not counted as ${d.claim.cityName}'s founder right now. Buy back above 1,000,000 before the snapshot to keep the seat.`;
      alert.hidden = false;
    } else if (lostNames.length) {
      alert.textContent = `⚠️ Badge${lostNames.length > 1 ? "s" : ""} removed after your balance dropped: ${lostNames.join(", ")}. Hold again to earn ${lostNames.length > 1 ? "them" : "it"} back.`;
      alert.hidden = false;
    } else alert.hidden = true;

    renderProgress(d);
    renderCommunity(d);
    renderBadges(d);
    $$(".role-row").forEach((r) => r.classList.toggle("is-you", r.dataset.role === (d.level === "member" ? "" : d.level)));
    $("#f-city").textContent = home ? home.name : "Local";
    $("#f-country").textContent = n ? countryName(n.country) : "National";
  }

  function renderProgress(d) {
    const p = d.progress, home = d.user.home;
    $("#p-city").textContent = home ? home.name : "your city";
    $("#p-pct").textContent = `${p.percent}%`;
    requestAnimationFrame(() => ($("#p-bar").style.width = `${p.percent}%`));
    $("#p-steps").replaceChildren(...p.steps.map((s) => {
      const li = el("li", s.done ? "is-ok" : s.blocked ? "is-bad" : "");
      li.append(el("span", "req__dot"), el("span", null, s.label));
      if (s.id === "hold" && !s.done) {
        if (s.progress > 0) { const m = el("span", "mini"), f = el("span"); f.style.width = `${Math.round(s.progress * 100)}%`; m.append(f); li.append(m); }
        li.append(el("span", "detail", s.detail || ""));
      }
      return li;
    }));
    const note = $("#p-note"), c = d.community, pick = params.get("claim");
    let text = "";
    if (d.claim) text = d.claim.active ? `👑 You're the founder of ${d.claim.cityName}. Keep 1,000,000+ $VICINITY to keep the seat.` : `You claimed ${d.claim.cityName}. Hold 1,000,000+ $VICINITY to count as its founder.`;
    else if (!d.launched) text = "Claims open the moment $VICINITY launches, first come, first served. Get founder-ready now: hold 1,000,000+ at launch and be in the city.";
    else if (c && c.founder && !c.founder.you) text = `${home.name} was founded by ${c.founder.wallet}. If they drop below 1,000,000, the seat is re-checked at the snapshot.`;
    else if (d.holding.founderGap > 0) text = `Hold ${fmt(Math.ceil(d.holding.founderGap))} more $VICINITY to claim ${home ? home.name : "your city"}.`;
    else if (p.claimable) text = `You're founder-ready. Stand inside ${home.name} and claim it before someone else does.`;
    if (pick && home && pick !== home.id) text += ` (You picked a different city on the map. You can only found the community you live in, ${home.name}.)`;
    note.textContent = text;
    $("#p-claim").hidden = !p.claimable;
  }
  $("#p-claim").addEventListener("click", async (e) => {
    const btn = e.currentTarget, err = $("#p-error"), home = me.user.home;
    err.hidden = true; btn.disabled = true; btn.textContent = "Getting your location…";
    try {
      const loc = await getLocation();
      btn.textContent = "Claiming…";
      const d = await api("/api/claim", { cityId: home.id, country: home.country, location: loc });
      if (!d.claimed) {
        const CLAIM_ERR = { ...LOC_ERR, not_in_city: `You're not inside ${home.name}'s boundary right now.`, city_taken: "Someone else just claimed it.",
          not_enough_tokens: (x) => `This wallet holds ${fmt(x.amount || 0)} $VICINITY. You need 1,000,000.`, wallet_has_city: "This wallet already founded a city.",
          not_launched: "Claims open when $VICINITY launches.", chain_unavailable: "Couldn't reach the blockchain. Try again in a minute.",
          part_of: "This place is part of a bigger community.", not_a_community: "This place isn't a community of its own." };
        throw new Error(errText(CLAIM_ERR, d, "Claim failed. Please try again."));
      }
      toast(`👑 ${d.cityName} is yours`);
      const r = btn.getBoundingClientRect(); burst(r.left + r.width / 2, r.top);
      refresh();
    } catch (x) { err.textContent = x.message; err.hidden = false; }
    finally { btn.disabled = false; btn.textContent = "Claim it now (checks your location)"; }
  });

  function renderCommunity(d) {
    const c = d.community, n = d.national;
    if (c) {
      const tk = ticker(c.name);
      $("#cc-face").textContent = tk.slice(0, 5);
      $("#cc-name").textContent = c.name;
      $("#cc-ticker").textContent = `$${tk} · city coin preview · ${countryName(c.country)}`;
      $("#cc-members").textContent = fmt(c.members);
      $("#cc-holders").textContent = d.launched ? (c.holders != null ? fmt(c.holders) : "…") : "At launch";
      $("#cc-founder").textContent = c.founder ? (c.founder.you ? "You 👑" : c.founder.wallet) : "Open seat 🔥";
      const others = c.members - 1;
      $("#cc-fomo").textContent = c.founder && !c.founder.you
        ? `${c.name} has a founder. Climb the local board: the top holders here are the first people the city sees.`
        : others <= 0 ? `You're the first member of ${c.name}. Bring your locals in: every member makes the city's coin stronger, and the founder seat is still open.`
        : `${fmt(others)} other ${others === 1 ? "person" : "people"} from ${c.name} ${others === 1 ? "is" : "are"} here, and the founder seat is still open. Whoever claims it first leads the city.`;
      const top = $("#cc-top");
      top.replaceChildren(...(c.top && c.top.length ? c.top.map((t) => { const li = el("li", t.you ? "is-you" : ""); li.append(el("span", "mono", t.you ? "You" : t.wallet), el("span", "amt", compact(t.amount))); return li; })
        : [el("li", "muted small", d.launched ? "No holders here yet. Be the first." : "Live at launch.")]));
    }
    if (n) {
      $("#nc-name").textContent = countryName(n.country);
      $("#nc-members").textContent = fmt(n.members);
      $("#nc-manager").textContent = n.manager ? (n.manager.you ? "You 🛡️" : `${n.manager.wallet} · ${n.manager.city}`) : d.launched ? "Open: top founder takes it" : "Picked after launch";
    }
  }
  $("#cc-share").addEventListener("click", () => {
    const name = me?.community?.name || "my city";
    copy(`I'm repping ${name} on Vicinity. One city, one coin: join us → ${location.origin}/connect`, "Invite copied. Send it to your locals!");
  });

  function renderBadges(d) {
    $("#badge-grid").replaceChildren(...d.badges.map((b) => {
      const lost = d.lost.includes(b.id);
      const li = el("li", `badge ${b.earned ? "is-earned" : lost ? "is-lost" : "is-locked"}`);
      li.title = `${b.name}: ${b.detail}${b.earned ? " ✓" : ""}`;
      li.tabIndex = 0;
      li.append(el("span", "badge__icon", b.icon), el("span", "badge__name", b.name));
      if (!b.earned && b.progress > 0) { const p = el("span", "badge__prog"), f = el("span"); f.style.width = `${Math.round(b.progress * 100)}%`; p.append(f); li.append(p); }
      li.addEventListener("click", () => toast(`${b.icon} ${b.name}: ${b.detail}`));
      return li;
    }));
  }

  /* ---------- feeds ---------- */
  let scope = "city", kind = "meme", sort = "new", oldest = 0, loading = false, picture = null;
  const PLACEHOLDER = { meme: "Caption a local meme…", checkin: "Say something about where you are (optional)", talk: "Start a discussion with your neighbours…" };
  const POST_ERR = {
    ...LOC_ERR,
    holders_only: "Only $VICINITY holders can post and vote now that it's live. Holding any amount unlocks it.",
    slow_down: "You're posting fast. Take a breather and try again in a bit.",
    no_addresses: "Contract addresses can't be posted. The only official one is on the Token page.",
    too_long: (d) => `That's too long (max ${d.max} characters).`,
    empty: "Write something or add a picture.",
    banned: "You've been banned from posting here.",
    checked_in_today: "You already checked in today. Come back tomorrow 🔥",
    not_in_city: (d) => d.here ? `You're in ${d.here} right now, not ${me.user.home.name}.` : `You're not inside ${me.user.home.name} right now.`,
    bad_image: "That picture couldn't be used. Try a JPG or PNG.",
    no_home: "Set your home community first.",
    own_post: "You can't do that on your own post.",
    not_found: "That post is gone.",
    not_allowed: "Only moderators can do that.",
  };
  function setupComposer() {
    const national = scope === "country";
    const checkin = kind === "checkin";
    $("#composer").hidden = national && checkin; // check-ins are local: you check in where you are
    $("#c-text").placeholder = PLACEHOLDER[kind];
    $("#c-text").maxLength = kind === "talk" ? 1000 : kind === "meme" ? 280 : 140;
    $("#c-pic-label").hidden = kind !== "meme";
    $("#c-post").textContent = checkin ? "📍 Check in here" : "Post";
    if (kind !== "meme") clearPicture();
    count();
  }
  const count = () => { const t = $("#c-text"); $("#c-count").textContent = t.value.length ? `${t.value.length}/${t.maxLength}` : ""; };
  $("#c-text").addEventListener("input", count);

  $$(".seg [data-scope]").forEach((b) => b.addEventListener("click", () => {
    scope = b.dataset.scope;
    $$(".seg [data-scope]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    setupComposer(); loadFeed(true);
  }));
  $$(".chips [data-kind]").forEach((b) => b.addEventListener("click", () => {
    kind = b.dataset.kind;
    $$(".chips [data-kind]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    setupComposer(); loadFeed(true);
  }));
  $$("[data-sort]").forEach((b) => b.addEventListener("click", () => {
    sort = b.dataset.sort;
    $$("[data-sort]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    loadFeed(true);
  }));
  $("#f-more").addEventListener("click", () => loadFeed(false));

  function emptyFeed() {
    const li = el("li", "empty-feed");
    const where = scope === "city" ? me.user.home.name : countryName(me.user.home.country);
    const what = { meme: "No memes yet", checkin: "No check-ins yet", talk: "No discussions yet" }[kind];
    li.append(el("strong", null, `${what} in ${where}.`), el("span", null, kind === "checkin" && scope === "country" ? "Check in from your city's Local tab." : "Be the first: the first posts set the tone for everyone who joins after you."));
    return li;
  }
  async function loadFeed(reset) {
    if (loading) return; loading = true;
    const list = $("#posts");
    if (reset) { oldest = 0; list.replaceChildren(el("li", "muted", "Loading…")); }
    const d = await api(`/api/posts?scope=${scope}&kind=${kind}&sort=${sort}${!reset && oldest ? `&before=${oldest}` : ""}`);
    loading = false;
    if (!d.ok) { list.replaceChildren(el("li", "muted", errText(POST_ERR, d, "Couldn't load posts. Try again."))); return; }
    if (reset) list.replaceChildren();
    if (reset && !d.posts.length) list.append(emptyFeed());
    for (const p of d.posts) list.append(postEl(p));
    if (d.posts.length) oldest = d.posts[d.posts.length - 1].id;
    $("#f-more").hidden = sort === "top" || d.posts.length < 20;
    $("#f-note").textContent = sort === "top" ? `This week's vote · since ${new Date(d.weekStart).toLocaleDateString()}` : scope === "city" ? `Only people from ${me.user.home.name} see this` : `Everyone in ${countryName(me.user.home.country)} sees this`;
  }

  function postEl(p, { reply = false } = {}) {
    const li = el("li", `post${p.hidden ? " is-hidden" : ""}`);
    if (!reply) {
      const v = el("div", "post__vote");
      const up = el("button", null, "▲"); up.type = "button"; up.setAttribute("aria-pressed", String(p.voted)); up.setAttribute("aria-label", "Vote");
      if (p.mine) { up.disabled = true; up.title = "Your post"; }
      const score = el("strong", null, fmt(p.score));
      up.addEventListener("click", async () => {
        const r = await api("/api/posts/vote", { id: p.id });
        if (!r.ok) return toast(errText(POST_ERR, r, "Couldn't vote."));
        up.setAttribute("aria-pressed", String(r.voted)); score.textContent = fmt(r.score);
        if (r.voted && r.weight > 1) toast(`Your vote counts ×${r.weight}`);
      });
      v.append(up, score); li.append(v);
    }
    const meta = el("div", "post__meta");
    meta.append(el("b", null, p.author.name));
    if (p.author.manager) meta.append(el("span", "tag tag--gold", "🛡️ Manager"));
    if (p.author.founder) meta.append(el("span", "tag tag--gold", `👑 ${p.author.founder}`));
    if (p.where && scope === "country") meta.append(el("span", "tag", `📍 ${p.where}`));
    meta.append(el("span", null, `· ${ago(p.at)}`));
    if (p.hidden) meta.append(el("span", "tag tag--no", "Hidden"));
    if (p.reports) meta.append(el("span", "tag tag--warn", `${p.reports} report${p.reports === 1 ? "" : "s"}`));
    li.append(meta);
    if (p.body) li.append(el("p", "post__body", p.kind === "checkin" && !reply ? `📍 ${p.body}` : p.body));
    if (p.image) { const img = el("img", "post__img"); img.src = p.image; img.alt = "Meme picture"; img.loading = "lazy"; li.append(img); }
    const actions = el("div", "post__actions");
    const act = (label, fn) => { const b = el("button", "link-btn", label); b.type = "button"; b.addEventListener("click", fn); actions.append(b); return b; };
    if (!reply && p.kind !== "checkin") {
      const rb = act(p.replies ? `💬 ${p.replies} repl${p.replies === 1 ? "y" : "ies"}` : "💬 Reply", () => toggleReplies(li, p, rb));
    }
    if (!p.mine) act("Report", async () => {
      const reason = prompt("Why are you reporting this? (optional)");
      if (reason === null) return;
      const r = await api("/api/posts/report", { id: p.id, reason });
      toast(r.ok ? "Reported. Thanks for keeping your city clean." : errText(POST_ERR, r, "Couldn't report."));
    });
    if (p.canModerate) {
      act(p.hidden ? "Unhide" : "Hide", async () => {
        const r = await api("/api/posts/hide", { id: p.id, hidden: !p.hidden });
        if (!r.ok) return toast(errText(POST_ERR, r, "Couldn't do that."));
        toast(r.hidden ? "Hidden" : "Visible again"); loadFeed(true); loadMod();
      });
      if (!p.mine && (me.level === "manager" || me.level === "admin")) act("Ban author", async () => {
        if (!confirm(`Ban ${p.author.name} from posting${me.level === "admin" ? " anywhere" : " in this country"}? Their post will be hidden.`)) return;
        const r = await api("/api/posts/ban", { id: p.id });
        if (!r.ok) return toast(errText(POST_ERR, r, "Couldn't ban."));
        toast("Banned"); loadFeed(true); loadMod();
      });
    }
    if (actions.children.length) li.append(actions);
    return li;
  }
  async function toggleReplies(li, p, btn) {
    const open = li.querySelector(".post__replies");
    if (open) { open.remove(); li.querySelector(".reply-form")?.remove(); return; }
    const ul = el("ul", "post__replies"); ul.append(el("li", "muted", "Loading…"));
    const form = el("form", "reply-form");
    const input = el("input"); input.maxLength = 500; input.placeholder = "Write a reply…"; input.setAttribute("aria-label", "Reply");
    const send = el("button", "btn btn--primary btn--sm", "Reply"); send.type = "submit";
    form.append(input, send);
    li.append(ul, form);
    const d = await api(`/api/posts?parent=${p.id}`);
    ul.replaceChildren(...(d.posts || []).map((r) => postEl(r, { reply: true })));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim(); if (!text) return;
      send.disabled = true;
      const r = await api("/api/posts", { parent: p.id, body: text });
      send.disabled = false;
      if (!r.ok) return toast(errText(POST_ERR, r, "Couldn't reply."));
      input.value = ""; ul.append(postEl(r.post, { reply: true }));
      p.replies += 1; btn.textContent = `💬 ${p.replies} repl${p.replies === 1 ? "y" : "ies"}`;
    });
  }

  // pictures: shrunk in the browser (max 900 px, under 190 KB) before they're sent
  function clearPicture() { picture = null; $("#c-preview").hidden = true; $("#c-pic").value = ""; }
  $("#c-pic").addEventListener("change", async () => {
    const file = $("#c-pic").files[0]; if (!file) return;
    try {
      const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      let max = 900, quality = 0.82, out = "";
      for (let i = 0; i < 6; i++) {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        out = c.toDataURL("image/webp", quality);
        if (!out.startsWith("data:image/webp")) out = c.toDataURL("image/jpeg", quality);
        if (out.length * 0.75 < 190_000) break;
        max = Math.round(max * 0.8); quality -= 0.08;
      }
      picture = out.slice(out.indexOf(",") + 1);
      $("#c-preview").src = out; $("#c-preview").hidden = false;
    } catch { toast("That picture couldn't be read."); clearPicture(); }
  });

  $("#composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#c-err"), btn = $("#c-post"); err.hidden = true;
    const body = { scope, kind, body: $("#c-text").value.trim() };
    if (picture) body.image = picture;
    btn.disabled = true;
    try {
      if (kind === "checkin") { btn.textContent = "Getting your location…"; body.location = await getLocation(); }
      const r = await api("/api/posts", body);
      if (!r.ok) throw new Error(errText(POST_ERR, r, "Couldn't post. Please try again."));
      $("#c-text").value = ""; clearPicture(); count();
      if (sort !== "new") $("[data-sort='new']").click(); else {
        const list = $("#posts"); list.querySelector(".empty-feed")?.remove();
        list.prepend(postEl(r.post));
      }
      toast(kind === "checkin" ? `📍 Checked in to ${me.user.home.name}` : "Posted ✓");
      if (kind === "checkin") { const rr = btn.getBoundingClientRect(); burst(rr.left + rr.width / 2, rr.top); refresh(); }
    } catch (x) { err.textContent = x.message; err.hidden = false; }
    finally { btn.disabled = false; setupComposer(); }
  });

  /* ---------- moderator tools ---------- */
  async function loadMod() {
    const d = await api("/api/mod");
    if (!d.ok || !d.moderator) { $("#mod").hidden = true; return; }
    $("#mod").hidden = false;
    $("#mod-scope").textContent = d.scope;
    $("#mod-posts").replaceChildren(...(d.posts.length ? d.posts.map((p) => postEl(p, { reply: true })) : [el("li", "muted small", "No reports. All clean.")]));
    $("#mod-requests").replaceChildren(...(d.requests.length ? d.requests.map((r) => {
      const li = el("li");
      li.append(el("strong", null, `${r.name} (${r.country})`), el("span", "muted", `${r.near || ""} · by ${r.by || "member"} · ${ago(r.at)}`));
      const acts = el("span", "req-actions");
      for (const [label, approve] of [["Approve", true], ["Decline", false]]) {
        const b = el("button", `btn btn--sm ${approve ? "btn--primary" : "btn--glass"}`, label); b.type = "button";
        b.addEventListener("click", async () => {
          const note = approve ? "" : prompt("Why? (optional, the requester sees this)") || "";
          const x = await api("/api/requests/decide", { id: r.id, approve, note });
          toast(x.ok ? `${r.name}: ${x.status}` : errText(POST_ERR, x, "Couldn't decide.")); loadMod();
        });
        acts.append(b);
      }
      li.append(acts); return li;
    }) : [el("li", "muted small", "No requests waiting.")]));
  }

  /* ---------- "add my town" requests ---------- */
  async function loadRequests() {
    const d = await api("/api/requests");
    if (!d.ok) return;
    $("#req-mine").replaceChildren(...d.requests.map((r) => {
      const li = el("li");
      li.append(el("strong", null, r.name), el("span", `tag ${r.status === "approved" ? "tag--ok" : r.status === "declined" ? "tag--no" : "tag--warn"}`, r.status));
      if (r.note) li.append(el("span", "muted small", `“${r.note}”`));
      return li;
    }));
  }
  $("#req-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#req-err"), name = $("#req-name").value.trim().replace(/\s+/g, " ");
    err.hidden = true;
    if (!/^[\p{L}\p{M}][\p{L}\p{M} .'’-]{0,58}[\p{L}\p{M}.]$/u.test(name)) { err.textContent = "Use letters only for the town name (spaces, - . ' are fine)."; err.hidden = false; return; }
    try {
      const loc = await getLocation();
      const d = await api("/api/requests", { name, location: loc });
      if (!d.ok) throw new Error(errText({ ...LOC_ERR, one_at_a_time: "You already have a request waiting. One at a time.", bad_name: "Please check the town name." }, d, "Couldn't send. Please try again."));
      toast(`Request sent: ${name}. Your Country Manager will decide.`);
      $("#req-name").value = ""; loadRequests();
    } catch (x) { err.textContent = x.message; err.hidden = false; }
  });

  /* ---------- live refresh ---------- */
  async function refresh() {
    const d = await api("/api/me");
    if (d.signedIn && d.user.home) render(d);
  }
  setInterval(() => {
    if (!checkedAt) return;
    const s = Math.round((Date.now() - checkedAt) / 1000);
    $("#me-checked").textContent = s < 5 ? "live · just checked" : `live · checked ${s < 60 ? s + "s" : Math.round(s / 60) + "m"} ago`;
  }, 5000);
  $("#me-copy").addEventListener("click", () => me && copy(me.user.wallet, "Wallet address copied"));
  $("#me-logout").addEventListener("click", async () => { await api("/api/auth/logout", {}); location.assign("/"); });

  /* ---------- start ---------- */
  (async () => {
    const d = await api("/api/me");
    if (!d.signedIn) {
      if (d.pending || d.proof) { location.assign("/connect"); return; }
      $("#dash-out").hidden = false; return;
    }
    identity(d);
    if (!d.user.home) { onboard(d); return; }
    $("#dash-main").hidden = false;
    render(d);
    setupComposer(); loadFeed(true); loadMod(); loadRequests();
    reveal();
    if (params.get("welcome")) toast(`Welcome to Vicinity, ${d.user.handle || d.user.name} 🎉`);
    if (params.get("claim")) $("#progress").scrollIntoView({ block: "center" });
    setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
  })();
})();
