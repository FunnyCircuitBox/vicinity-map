// Shows whether the backend is responding. No tracking, no cookies.
(async () => {
  const el = document.getElementById("status");
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    const data = await res.json();
    el.textContent = data.ok ? "online ✓" : "problem";
  } catch {
    el.textContent = "offline";
  }
})();
