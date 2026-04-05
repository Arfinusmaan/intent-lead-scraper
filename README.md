# Lead Generation Engine

A production-grade Google Maps lead generation system using Playwright.

## Setup

```bash
cd lead-engine
npm install
npx playwright install chromium
```

## Usage

### Basic run (uses defaults):
```bash
node index.js
```

### Custom configuration via environment variables:

```bash
NICHE="plumbers" LOCATION="Toronto" node index.js
NICHE="medspa" LOCATION="California" node index.js
NICHE="dentist" LOCATION="TX" ONLY_WITH_WEBSITE=true node index.js
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `NICHE` | `plumbers` | Business niche to search (e.g. "medspa", "dentist") |
| `LOCATION` | `Toronto` | City name OR state/province name |
| `COUNTRY` | `Canada` | Country context (informational) |
| `ONLY_WITH_WEBSITE` | `false` | Set `true` to only include businesses with a website |
| `MAX_RESULTS` | `100` | Max results to scrape per city |
| `OUTPUT_FILE` | `./leads.csv` | Path to the output CSV file |

## State/Province Support

If `LOCATION` is a US state or Canadian province (full name or 2-letter abbreviation), the engine automatically generates a list of 10–20 major cities and loops through each one.

**Examples:**
- `LOCATION="California"` → loops through 20 CA cities
- `LOCATION="CA"` → same as above
- `LOCATION="Ontario"` → loops through 15 ON cities
- `LOCATION="Toronto"` → runs a single city search

## Output

Exports `leads.csv` with these columns:

```
Name | Owner | Email | Email Status | Phone | Website | City | State | Niche | Rating | Reviews | Intent | Score
```

### Email Status values:
- `verified` — MX + SMTP confirmed deliverable
- `risky` — domain exists but catch-all or uncertain
- `not_found` — no email found or invalid domain

### Intent Tags:
- `HIGH_INTENT` — score ≥ 6
- `MEDIUM` — score 3–5
- `LOW` — score < 3

### Scoring breakdown:
- +2 → has a website
- +2 → email found
- +1 → reviews > 20
- +2 → rating < 4.5
- +2 → reviews < 10

## Project Structure

```
lead-engine/
├── index.js           — Main entry point, orchestrates the pipeline
├── scraper.js         — Playwright Google Maps scraper
├── emailExtractor.js  — Email extraction (axios + cheerio, Playwright fallback)
├── verifier.js        — MX + SMTP email verification
├── intentScorer.js    — Lead scoring and intent tagging
├── decisionMaker.js   — Owner/founder name extraction from team pages
├── locationHandler.js — City/state detection and city list generation
├── exporter.js        — CSV export
└── utils.js           — Shared helpers (logging, delays)
```
