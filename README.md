# 🔍 LeadEngine — Autonomous Google Maps Lead Scraper

A high-performance, autonomous lead extraction engine for Google Maps, built for overnight unattended operation. Searches any niche across any city/state/province and extracts business name, phone, website, email, rating, and intent score into a clean CSV.

---

## 🚀 Features

- **Multi-tab parallel scraping** — 1 browser window with N tabs, each processing a different ZIP code
- **Context-aware filtering** — search "water damage" → only water damage leads (not mold, not HVAC)
- **Email enrichment** — auto-crawls business websites to extract contact emails
- **Intent scoring** — scores each lead 0–100 based on online presence gaps
- **CAPTCHA self-healing** — auto-pauses and waits on detection, resumes automatically
- **CSV export** — split into "with email" and "without email" sections, saved to disk on every new lead
- **Session resume** — if server restarts mid-run, it picks up from where it left off
- **History panel** — view all past jobs with lead counts and intent stats
- **Franchise dedup** — SERVPRO/PaulDavis locations share domains but are never deduplicated

---

## 📁 Project Structure

```
Lead-Project/
├── backend/
│   ├── server.js          # Express API server
│   ├── scraper.js         # Playwright scraping engine
│   ├── filter.js          # Search-context-aware lead filter
│   ├── categoryMap.js     # Google Maps official category mappings
│   ├── cityService.js     # ZIP/FSA → sub-location expansion
│   ├── intentScorer.js    # Lead scoring algorithm
│   ├── store.js           # In-memory job store + disk persistence
│   └── utils.js           # Shared utilities
├── frontend/
│   └── src/
│       ├── App.jsx        # React UI
│       └── index.css      # Global styles
├── uszips.csv             # US ZIP code database (required)
└── zipcodes.ca.csv        # Canadian FSA database (required)
```

---

## ⚙️ Setup

### 1. Backend
```bash
cd backend
npm install
npx playwright install chromium
npm start
```

### 2. Frontend
```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` in your browser.

---

## 🖥️ Usage

1. **Enter a niche** — e.g. `Water Damage Restoration` (type and press Enter to add as tag)
2. **Enter a location** — city, state, province, or ZIP code (e.g. `Tampa, FL` or `Ontario`)
3. **Choose a mode:**
   - **Standard** — 1 browser window with tabs (recommended for overnight runs)
   - **Hyper-Scale** — parallel windows for maximum speed (RAM intensive)
   - **Background** — fully headless, no browser window visible
4. **Choose workers** — number of concurrent ZIP code tabs (3 is a good balance)
5. Click **Start** — the engine sweeps through all ZIP codes in the target area

---

## 🔧 Filter Logic

The filter is **search-context-aware**:

| You Search | ✅ Accepted | ❌ Denied |
|---|---|---|
| `Water Damage Restoration` | Water damage, flood, storm, disaster | Mold only companies |
| `Mold Remediation` | Mold, mildew, indoor air, water damage | Fire-only companies |
| `Fire Damage Restoration` | Fire, smoke, disaster, building restoration | — |

Hard-blocked industries (dentists, gyms, restaurants, car washes, etc.) are always rejected regardless of niche.

---

## 📊 Lead Fields

| Column | Description |
|---|---|
| Name | Business name |
| Phone | Primary phone |
| Website | Business website |
| Maps Link | Google Maps URL |
| Primary Email | Best contact email found |
| Rating | Google star rating |
| Reviews | Review count |
| Intent | HIGH / MEDIUM / LOW |
| Lead Score | 0–100 opportunity score |
| City | Location scraped |

---

## 🛡️ Anti-Bot Features

- Randomized User-Agent rotation
- Resource blocking (images, media, fonts, analytics) to reduce fingerprint
- Random 5–15s human-like delay between ZIP codes
- CAPTCHA auto-detection with 3–7 minute cool-down pause
- Stealth plugin via `playwright-extra`

---

## 📋 Requirements

- Node.js 18+
- Chromium (installed via `npx playwright install chromium`)
- 4GB+ RAM recommended for 3 concurrent workers
