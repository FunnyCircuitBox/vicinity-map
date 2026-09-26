# Vicinity

**One city. One coin. One community.** Every real city on one map, with real boundaries. Each community gets one official coin, local leaders, and its own feed of memes, check-ins, discussions and weekly votes. $VICINITY holders get in first; the Vicinity Launchpad opens November 10, 2026.

Live: https://vicinitycity.net (backup address: https://vicinity-map.noyonsakibul.workers.dev)

> **No token exists yet.** $VICINITY has not launched. No presale, no airdrop, no contract address. When it launches, the official address will be published in this README and on the website. Use the site's "Is this link really Vicinity?" checker if in doubt.

## What's on the site
Separate pages, one shared menu (top menu on computers, bottom menu bar on phones), dark / light theme:
- **/** How it works: the problem, a step-by-step walkthrough on the real New York City boundaries (73 places, one coin), how the app works, incentives for holders and for the Launchpad, roles, roadmap, FAQ (including why $VICINITY launched on pump.fun).
- **/token** Token and holders: live facts from the blockchain (minting/freezing off, supply, price), every holder in a table that scrolls on its own, "where does this wallet stand?" (paste any address: rank, percentile, gap to the next wallet), the official token list and link checker.
- **/cities** The live map: 8,000+ communities in 244 countries with real boundaries that never overlap; claimed vs open; the communities filling up. The claim button leads to the dashboard.
- **/launchpad** Countdown to November 10, the planned phases, who gets in first, add-to-calendar.
- **/connect** Sign in: any Solana wallet (Wallet Standard + older ones; app links for phones), "wallet on my phone" (QR code + 2-digit check number), and a tiny-transfer proof for app wallets that can't connect (FOMO, exchanges). Then X or Google. One wallet + one login = one account.
- **/dashboard** Onboarding (live rank + home community from one location check; people in empty land pick one of the three nearest communities), then: role and badges re-checked live (selling removes them), founder race with a progress bar and claiming, community and country cards, local and national feeds (memes with pictures, check-ins, discussions, weekly votes weighted 1 / 2 founders / 3 managers), reports, moderator tools, "add my town" requests, roles and responsibilities.

## Project layout
```
public/             Website: generated pages (*.html), style.css, page scripts (site.js shared; home, token, cities,
                    launchpad, connect, dashboard, wallets.js), data/ (cities, boundaries, NYC example, stats)
scripts/pages/      Page sources + shared layout: edit here, then `npm run pages` (a test checks public/*.html match)
scripts/demo/       nyc.mjs builds the New York City example + site numbers (`npm run demo:nyc`)
scripts/boundaries/ Builds the city boundaries; scripts/cities/ builds the city list
src/index.js        Backend (Cloudflare Worker): API routes, claims
src/auth.js         Accounts: wallet sign-in, X / Google, phone pairing, tiny-transfer proof, sessions
src/me.js           Dashboard data: live rank, roles, badges, claim progress, home community
src/social.js       Feeds, votes, reports, moderation, "add my town" requests
src/roles.js        Admin / country manager / city founder / holder, checked live
src/community.js    Which community a point is in (or the three nearest)
src/chain.js        Read-only Solana data: token facts, every holder + ranks, balances, transfer lookup
src/solana.js       Base58, sign-in message format, Ed25519 signature check
src/official.js     Official links, the mint address, the Launchpad opening time
src/cities.js       City list + boundary file loaders, claim rules; src/geo.js boundary format
src/store.js        Database schema (Cloudflare D1; tables are created automatically) + claims store
test/               Automated tests (npm test); test/helpers/d1.js runs the real SQL on Node's SQLite
wrangler.jsonc      Cloudflare settings (build copies fonts + QR library, builds pages, runs tests)
```

## Settings (Cloudflare → Workers → vicinity-map → Settings → Variables and secrets)
| Name | What it's for |
|---|---|
| `SOLANA_RPC_URL` (secret) | A Helius (or similar) RPC URL. Needed for the full holder list and ranks; without it only the top 20 show. |
| `VICINITY_MINT` | The token address, the moment it launches (or edit `src/official.js`). |
| `ADMIN_WALLETS` | Your wallet address(es), comma-separated: admin powers on the dashboard. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (secret) | Google sign-in. Google Cloud console → Credentials → OAuth client (Web application). Redirect URI: `https://vicinitycity.net/api/auth/google/callback` |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` (secret) | X sign-in. X developer portal → your app → User authentication settings (OAuth 2.0, Web App). Callback: `https://vicinitycity.net/api/auth/x/callback` |

Without the Google / X settings the site works, but new people can't finish signing up (the connect page says sign-in is being switched on).

## API
| Route | What it does |
|---|---|
| `GET /api/health` · `GET /api/official` · `GET /api/check?q=` | Status · official links (+ Launchpad time) · is this link official? |
| `GET /api/message?address=&action=verify / login / claim / add` | The exact text a wallet signs |
| `POST /api/verify` | Checks `{address, message, signature(base64)}`; nothing stored |
| `GET /api/token` · `GET /api/holders` · `GET /api/rank?address=` | Live token facts + price · every holder (top 1,000) · one wallet's rank |
| `GET /api/claims` · `POST /api/claim` · `GET /api/moderator?country=` | Claimed cities · claim (signed in, or signed message) · a country's manager |
| `GET /api/members` | How many members call each community home (no names) |
| `POST /api/auth/wallet` · `POST /api/auth/transfer` (+ `/check`) · `POST /api/pair` · `GET /api/pair?code=` · `POST /api/pair/finish` | Prove a wallet |
| `GET /api/auth/google/start` (and `/x/`, `/callback`) · `POST /api/auth/logout` | X / Google sign-in |
| `GET /api/me` · `POST /api/home` | Dashboard data · set home community |
| `GET /api/posts` · `POST /api/posts` · `POST /api/posts/vote` (`report`, `hide`, `ban`) · `GET /api/mod` · `GET /api/media/:id` | Feeds and moderation |
| `GET /api/requests` · `POST /api/requests` · `POST /api/requests/decide` | "Add my town" requests |

## Moderating
Most moderation happens on the dashboard: city founders hide posts in their city; country managers hide posts, ban people and decide "add my town" requests in their country; admins (`ADMIN_WALLETS`) can do all of it everywhere. For anything else: Cloudflare dashboard → Storage & databases → D1 → `vicinity-claims` → Console.
- Release a claim that broke the rules: `DELETE FROM claims WHERE city_id = '5142056';`
- Hide a community-added city: `UPDATE added_cities SET hidden = 1 WHERE id = 3;`
- Lift a ban: `DELETE FROM bans WHERE user_id = 12;`
- Approved "add my town" requests: `SELECT * FROM requests WHERE status = 'approved';` (add them to the city list at the next map build)
- Before the Launchpad snapshot, re-check every founder still holds 1,000,000+ $VICINITY.

## Run it locally
Requires Node.js 20+.
```
npm install
npm test          # automated tests
npm run pages     # rebuild public/*.html after editing scripts/pages/
npm run dev       # local copy at http://localhost:8787
```

## City boundaries
Every listed city gets one area, and areas never overlap:
- **Official boundary** (solid line): the city's own boundary from OpenStreetMap, matched by Wikidata item or by name, and only if it contains the city's point. Where two only partly overlap, the smaller city keeps the shared part. Boundaries that are mostly sea are trimmed to the coastline.
- **Communities**: a place with 4,000+ people (and every country's three biggest places) is a community with its own coin and area. A smaller place is part of the community around it (search "Mohawk" → part of Herkimer), or "outside" in empty land; people there are offered the three nearest communities. Missing towns will be requestable from where you stand, approved by the country manager.
- **Part of a bigger community**: inside its official boundary, Wikidata says it's located in it, or at the same spot (Manhattan, Brooklyn, East New York, Financial District → New York City; Mirpur, Motijheel → Dhaka). Not if it's far from the centre of a very large boundary (15 / 25 / 35 km for cities under 1M / 1–5M / 5M+).
- **The bigger the place, the farther it reaches**: each community reaches 4 + 12 × log10(people / 5,000) km (≈ 4 km at 5,000 people, 16 km at 50,000, 28 km at 500,000, 40 km at 5M). A community inside a bigger one's reach joins it when the bigger one has 500k+ people (New York City keeps Newark, Jersey City, Yonkers; Denver keeps Aurora; Dhaka keeps Narayanganj), when it's at most half the size (Syracuse + Clay, Albany + Troy), or when it's right next door (within 40% of the reach, at least 5 km: Herkimer + Ilion). Other 500k+ cities keep their own coin (Gazipur next to Dhaka), and nothing merges across a country border. When merged towns are about the same size, the county seat names the coin. Hand corrections (the country manager's changes, for now) go in `scripts/boundaries/metro-overrides.json` (`keepSeparate`, `merge`).
- **Nearest land** fills the gaps between cities: every city also gets the land nearest to it, cut to its country's borders and around official boundaries. Cities with an official boundary keep it as their core and add nearest land up to about 25 km beyond its edge (solid line on the map); cities without one get up to 25 km around their centre, 50 km for 1M+ cities (dashed line). Only land farther than that from every city stays empty. A founder can claim from anywhere in the city's area.

The files in `public/data/bounds/` are generated. To rebuild them (takes 1–2 hours, mostly downloading):
```
node scripts/cities/build-list.mjs      # (optional) the city list: every place with 1,000+ people (GeoNames)
node scripts/boundaries/1-links.mjs     # GeoNames id → Wikidata item (Wikidata query service)
node scripts/boundaries/1b-located-in.mjs  # which listed places Wikidata puts inside another (Brooklyn → NYC)
node scripts/boundaries/2-shapes.mjs    # boundary shapes from OpenStreetMap (Overpass API); add --server=1 or
                                        # --reverse to run extra workers side by side
node scripts/boundaries/3-build.mjs     # non-overlapping areas → public/data/bounds/, public/data/world.json
```
Downloads are cached in `.cache/boundaries/` (not committed), so re-running step 3 with different rules is quick.

**No overlaps.** Step 3 rounds every area to the stored precision (about 11 m) and then cuts any overlap bigger than 1 m² out of one side (an official boundary beats a nearest-land area, otherwise the smaller area keeps it), across all countries. To check the files yourself:
```
npm run check:boundaries   # exact geometry, every pair of neighbouring areas; exit code 1 if anything overlaps
```
The test suite runs the same check, so a build with overlapping areas can't deploy.

## Deploy
Cloudflare Workers Builds deploys automatically whenever `main` changes on GitHub. Before each deploy, `npm run build` copies the fonts and the QR library, builds the pages and runs every test, so a failing test blocks the deploy.

## Security
- One account per person: one wallet + one X or Google login, enforced by the database. From Google we keep the account id and first name; from X the id, @handle and name. No e-mail, no passwords. Only a hash of the session cookie is stored (HttpOnly, Secure, SameSite=Lax, 30 days); requests that change something must come from this site (Origin check).
- Wallet proof is message signing (can't move funds; bound to this site; expires after 10 minutes), a phone approving a computer's sign-in (one-time code + 2-digit check number), or a tiny exact SOL transfer the wallet sends to itself (only the owner can send from a wallet).
- Locations are never stored: they're used once to find a community, check in, claim, or request a town (requests keep a point rounded to about 5 km). VPNs, proxies and far-away connections are refused.
- Feeds never show wallets; contract addresses can't be posted; pictures are checked (JPEG / PNG / WebP only) and served with a locked-down policy.
- Strict Content-Security-Policy: pages load nothing from other websites (fonts and the QR library are self-hosted; the price is fetched by the server).
- Found a security problem? Please report it privately via GitHub's "Security" tab.

## Risk disclosure
Meme coins are highly speculative, and most lose all or nearly all their value. Nothing here is financial advice or a promise of profit.

## License
Code: MIT. Fonts: Inter and Space Grotesk, SIL Open Font License 1.1. City data: GeoNames (geonames.org), CC BY 4.0. City boundaries: © OpenStreetMap contributors, ODbL 1.0. Country outlines: Natural Earth (public domain).
