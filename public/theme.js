// Dark / light theme. Loaded in <head> (not deferred) so the page never flashes the wrong theme.
// First visit follows the device setting; the header toggle remembers the choice on this device.
(() => {
  const KEY = "vicinity-theme";
  const root = document.documentElement;
  const saved = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
  const system = () => (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");

  function apply(theme) {
    root.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === "light" ? "#F5F7FB" : "#070E19";
    document.querySelectorAll("[data-theme-toggle]").forEach((b) => {
      b.setAttribute("aria-pressed", String(theme === "light"));
      b.setAttribute("aria-label", theme === "light" ? "Switch to dark mode" : "Switch to light mode");
    });
    window.dispatchEvent(new CustomEvent("vicinity:theme", { detail: theme }));
  }

  apply(saved === "light" || saved === "dark" ? saved : system());
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    let pinned = null;
    try { pinned = localStorage.getItem(KEY); } catch {}
    if (!pinned) apply(system());
  });

  document.addEventListener("DOMContentLoaded", () => {
    apply(root.dataset.theme);
    document.querySelectorAll("[data-theme-toggle]").forEach((b) =>
      b.addEventListener("click", () => {
        const next = root.dataset.theme === "light" ? "dark" : "light";
        try { localStorage.setItem(KEY, next); } catch {}
        apply(next);
      }));
  });
})();
