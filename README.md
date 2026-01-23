# StraightShot Auto

StraightShot Auto is a Chrome extension that adds an analysis overlay to Facebook Marketplace vehicle listings. It extracts listing details (year, make, model, price, mileage, and specs) and sends a snapshot to a backend service that returns structured insights, risk flags, and a rating.

## Features
- Listing snapshot extraction
- Structured AI analysis (issues, upsides, inspection checks, buyer questions)
- Market value estimate and price opinion
- Spectrum rating bar with tags
- Collapsible listing details

## Development
1) Load the extension in Chrome:
   - Go to `chrome://extensions`
   - Enable Developer mode
   - Click "Load unpacked" and select this folder

2) Run the backend (Cloudflare Worker):
   - `cd worker`
   - `wrangler login`
   - `wrangler secret put OPENAI_API_KEY`
   - `wrangler deploy`

3) Update the API endpoint if needed:
   - `content.js` → `API_URL`

## Privacy Policy
Text policy: `docs/privacy-policy.txt`  
HTML policy: `docs/privacy-policy.html`

## Chrome Web Store Auto-Release
This repo includes a GitHub Actions workflow that uploads and publishes the extension on every push to `main`.

Required GitHub Secrets:
- `CHROME_EXTENSION_ID`
- `CHROME_CLIENT_ID`
- `CHROME_CLIENT_SECRET`
- `CHROME_REFRESH_TOKEN`

Notes:
- You must create a Chrome Web Store API project and OAuth credentials to get the client ID/secret and refresh token.
- Ensure `manifest.json` version is bumped before pushing to `main`.

## Notes
This extension runs only on Facebook Marketplace item pages.
