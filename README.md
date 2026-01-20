# Car Spotter

Car Spotter is a Chrome extension that adds an analysis overlay to Facebook Marketplace vehicle listings. It extracts listing details (year, make, model, price, mileage, and specs) and sends a snapshot to a backend service that returns structured insights, risk flags, and a rating.

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

## Notes
This extension runs only on Facebook Marketplace item pages.
