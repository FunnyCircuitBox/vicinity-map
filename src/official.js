/**
 * The ONE list of official Vicinity places. The website and the
 * "Is this link official?" checker both read from here.
 * Change it only by a public commit so everyone can see the history.
 */
export const OFFICIAL = {
  updated: "2026-09-23", // vicinitycity.net is the main address
  websites: ["vicinitycity.net", "vicinity-map.noyonsakibul.workers.dev"],
  github: ["github.com/funnycircuitbox/vicinity-map"],
  socials: [],            // none yet: any "Vicinity" social account is not us
  tokenContract: null,    // not launched: no official contract address exists
  teamWallets: [],        // none yet: will be listed before any launch
};

const clean = (s) => String(s || "").trim().slice(0, 300);

/** Decide whether something a visitor pasted is an official Vicinity place. */
export function checkOfficial(input, isSolanaAddress) {
  const raw = clean(input);
  if (!raw) return { verdict: "empty", message: "Paste a link, address or @handle to check it." };

  // Solana address (token contract or wallet)
  if (isSolanaAddress(raw)) {
    if (OFFICIAL.tokenContract && raw === OFFICIAL.tokenContract)
      return { verdict: "official", kind: "contract", message: "This is the official $VICINITY contract address." };
    if (OFFICIAL.teamWallets.includes(raw))
      return { verdict: "official", kind: "wallet", message: "This is a published Vicinity team wallet." };
    return {
      verdict: "not_official", kind: "address",
      message: OFFICIAL.tokenContract
        ? "This address is NOT the official $VICINITY contract or a team wallet."
        : "$VICINITY has not launched, so there is no official contract address yet. Any token using this name right now is fake.",
    };
  }

  // Social handle like @vicinity
  if (/^@[A-Za-z0-9_.]{1,40}$/.test(raw)) {
    const ok = OFFICIAL.socials.map((h) => h.toLowerCase()).includes(raw.toLowerCase());
    return ok
      ? { verdict: "official", kind: "social", message: "This is an official Vicinity account." }
      : { verdict: "not_official", kind: "social", message: "Vicinity has no official social accounts yet, so this account is not us." };
  }

  // Website link
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw); } catch { url = null; }
  if (url && url.hostname.includes(".")) {
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const hostPath = (host + url.pathname.toLowerCase()).replace(/\/+$/, "");
    if (url.protocol === "http:" && OFFICIAL.websites.includes(host))
      return { verdict: "warning", kind: "website", message: "Right site, but the link uses http. Use the https version." };
    if (OFFICIAL.websites.includes(host))
      return { verdict: "official", kind: "website", message: "This is the official Vicinity website." };
    if (host === "github.com" && OFFICIAL.github.some((g) => hostPath === g || hostPath.startsWith(g + "/")))
      return { verdict: "official", kind: "github", message: "This is the official Vicinity code repository." };
    const lookalike = /v[i1l]c[i1l]n[i1l]ty/i.test(host);
    return {
      verdict: "not_official", kind: "website",
      message: lookalike
        ? "Careful: this looks like a copy of our name, but it is NOT an official Vicinity site. Don't connect your wallet there."
        : "This link is not on our official list.",
    };
  }

  return { verdict: "unknown", message: "That doesn't look like a link, Solana address or @handle." };
}
