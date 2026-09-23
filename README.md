# Vicinity Map

**Represent your city.** A community map where every city gets its own page: check in, post local memes, vote weekly. Cities rank by community activity, not coin holdings.

> **No token exists yet.** $VICINITY has not launched. No presale, no airdrop, no contract address. When it launches, the official address will be published in this README and on the website.

## Status
Milestone 1 of 6 — landing page + health check. See the roadmap on the site.

## Project layout
```
public/        Website files anyone can see (HTML, CSS, JS, security headers)
src/index.js   Backend (Cloudflare Worker) — currently only /api/health
test/          Automated tests (run with: npm test)
wrangler.jsonc Cloudflare settings
```

## Run it on your own computer
Requires Node.js 20+.
```
npm install
npm test          # runs the automated tests
npm run dev       # opens a local copy at http://localhost:8787
```

## Deploy
Deployed automatically by Cloudflare Workers Builds whenever `main` changes on GitHub. Manual deploy: `npm run deploy` (needs a Cloudflare login).

## Security
- No secrets are stored in this repo. Future secrets go in Cloudflare's encrypted settings, never in code. Local secrets go in `.dev.vars`, which is git-ignored.
- Strict security headers are applied to every page (`public/_headers`).
- The site will only ever store a user's **city**, never exact GPS.
- Found a security problem? Please open a private report via GitHub's "Security" tab instead of a public issue.

## Risk disclosure
Meme coins are highly speculative, and most lose all or nearly all their value. Nothing here is financial advice or a promise of profit.

## License
MIT
