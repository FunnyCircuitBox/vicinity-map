# Vicinity

**Represent your city.** A community map where every city gets its own page: check in, post local memes, vote weekly. Cities rank by community activity, not coin holdings.

Live: https://vicinitycity.net (backup address: https://vicinity-map.noyonsakibul.workers.dev)

> **No token exists yet.** $VICINITY has not launched. No presale, no airdrop, no contract address. When it launches, the official address will be published in this README and on the website. Use the site's "Is this link really Vicinity?" checker if in doubt.

## What's on the site
- Scroll-driven animated story (pure SVG + JavaScript, no video files, respects "reduce motion")
- Playable weekly-vote demo (fictional towns, nothing saved)
- **Solana wallet connect + ownership verification**: the visitor signs a plain-text message (not a transaction). The server checks the Ed25519 signature. Nothing is stored.
- **Official link checker**: paste a link, @handle or token address to see if it's official
- **Live token proof + top holders** read straight from the Solana blockchain
- **Claim your city**: 13,000+ cities in 244 countries on an interactive world map with real city boundaries that never overlap (zoom into a country to see them; ◎ finds the city you're in). One wallet = one city. To claim, a wallet must hold 1,000,000+ $VICINITY (checked live on-chain), be inside the city's boundary (browser location, checked once, never saved) and sign a free message. Missing cities can be added (the adder becomes its founder). Claims open automatically once `VICINITY_MINT` is set.
- Dark / light theme toggle (follows the device setting until you pick one)
- Token facts, roadmap, transparency, FAQ, risk disclosure

## Project layout
```
public/            Website (HTML, CSS, JS, logo, security headers)
src/index.js       Backend (Cloudflare Worker): API routes
src/solana.js      Base58, sign-in message format, Ed25519 signature check
src/official.js    The single list of official links + the checker logic
src/chain.js       Read-only Solana data: token facts, top holders, wallet balance
src/cities.js      City list + boundary file loaders, claim rules (1M hold, inside the city's boundary)
src/geo.js         Boundary file format, point-in-boundary checks
src/store.js       Claims database (Cloudflare D1) — tables are created automatically
public/data/       cities.json (GeoNames, CC BY 4.0), world.json (Natural Earth),
                   bounds/XX.txt city boundaries per country (OpenStreetMap, ODbL): built by scripts/boundaries/
migrations/        The database schema, for reference
scripts/           Build helpers: self-hosted fonts; boundaries/ builds the city boundaries
test/              Automated tests (npm test)
wrangler.jsonc     Cloudflare settings (build runs fonts + tests before every deploy)
```

## API
| Route | What it does |
|---|---|
| `GET /api/health` | Backend status |
| `GET /api/official` | Official links list |
| `GET /api/check?q=` | Is this link / address / handle official? |
| `GET /api/message?address=` | The exact text a wallet signs |
| `POST /api/verify` | Checks `{address, message, signature(base64)}` |
| `GET /api/token` / `GET /api/holders` | Live token facts / top holders |
| `GET /api/claims` | Every claimed city + community-added cities |
| `POST /api/claim` | `{address, message, signature, location}` → claim a city |

## Moderating city claims
Cloudflare dashboard → Storage & databases → D1 → `vicinity-claims` → Console.
- Hide a community-added city: `UPDATE added_cities SET hidden = 1 WHERE id = 3;`
- Release a claim: `DELETE FROM claims WHERE city_id = '5142056';`
- Before the Launchpad snapshot, re-check every founder still holds 1,000,000+ $VICINITY.

## Run it locally
Requires Node.js 20+.
```
npm install
npm test          # automated tests
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
Cloudflare Workers Builds deploys automatically whenever `main` changes on GitHub. Before each deploy, `npm run build` copies the fonts and runs every test, so a failing test blocks the deploy.

## Security
- Verifying a wallet stores nothing. Claiming a city stores only: city, wallet, time (shown publicly). Visitor locations are never stored.
- Wallet verification is message signing only: it can't move funds. Messages are bound to this site's address and expire after 10 minutes.
- Strict Content-Security-Policy: the page loads nothing from other websites (fonts are self-hosted).
- A community-added city's center is the adder's location rounded to ~10 km.
- Found a security problem? Please report it privately via GitHub's "Security" tab.

## Risk disclosure
Meme coins are highly speculative, and most lose all or nearly all their value. Nothing here is financial advice or a promise of profit.

## License
Code: MIT. Fonts: Inter and Space Grotesk, SIL Open Font License 1.1. City data: GeoNames (geonames.org), CC BY 4.0. City boundaries: © OpenStreetMap contributors, ODbL 1.0. Country outlines: Natural Earth (public domain).
