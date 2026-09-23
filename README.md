# Vicinity

**Represent your city.** A community map where every city gets its own page: check in, post local memes, vote weekly. Cities rank by community activity, not coin holdings.

Live: https://vicinitycity.net (backup address: https://vicinity-map.noyonsakibul.workers.dev)

> **No token exists yet.** $VICINITY has not launched. No presale, no airdrop, no contract address. When it launches, the official address will be published in this README and on the website. Use the site's "Is this link really Vicinity?" checker if in doubt.

## What's on the site
- Scroll-driven animated story (pure SVG + JavaScript, no video files, respects "reduce motion")
- Playable weekly-vote demo (fictional towns, nothing saved)
- **Solana wallet connect + ownership verification**: the visitor signs a plain-text message (not a transaction). The server checks the Ed25519 signature. Nothing is stored.
- **Official link checker**: paste a link, @handle or token address to see if it's official
- Token facts, roadmap, transparency, FAQ, risk disclosure

## Project layout
```
public/            Website (HTML, CSS, JS, logo, security headers)
src/index.js       Backend (Cloudflare Worker): API routes
src/solana.js      Base58, sign-in message format, Ed25519 signature check
src/official.js    The single list of official links + the checker logic
scripts/           Build helpers (copies self-hosted fonts in)
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

## Run it locally
Requires Node.js 20+.
```
npm install
npm test          # automated tests
npm run dev       # local copy at http://localhost:8787
```

## Deploy
Cloudflare Workers Builds deploys automatically whenever `main` changes on GitHub. Before each deploy, `npm run build` copies the fonts and runs every test, so a failing test blocks the deploy.

## Security
- No secrets, no database, no stored wallet addresses.
- Wallet verification is message signing only: it can't move funds. Messages are bound to this site's address and expire after 10 minutes.
- Strict Content-Security-Policy: the page loads nothing from other websites (fonts are self-hosted).
- Only the **city** will ever be stored for check-ins, never exact GPS.
- Found a security problem? Please report it privately via GitHub's "Security" tab.

## Risk disclosure
Meme coins are highly speculative, and most lose all or nearly all their value. Nothing here is financial advice or a promise of profit.

## License
Code: MIT. Fonts: Inter and Space Grotesk, SIL Open Font License 1.1.
