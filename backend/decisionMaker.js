import axios from 'axios';
import * as cheerio from 'cheerio';
import { search, SafeSearchType } from 'duck-duck-scrape';
import { getRandomUA } from './utils.js';
import { verifyEmail } from './verifier.js';

// =========================
// CONFIG
// =========================
const OWNER_KEYWORDS = [
  'owner', 'founder', 'ceo', 'director',
  'president', 'principal', 'manager', 'co-founder'
];

const TEAM_PATHS = [
  '/',          // homepage — fastest win
  '/about',     // most common
  '/about-us',  // second most common
];

const NAME_REGEX =
  /([A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2})(?=\s*(CEO|Owner|Founder|Director))/i;

// =========================
// MAIN FUNCTION (FAST)
// =========================
export async function extractDecisionMaker(websiteUrl) {
  if (!websiteUrl || !websiteUrl.startsWith('http')) return '';

  const base = normalizeDomain(websiteUrl);

  const urls = TEAM_PATHS.map(path => buildUrl(base, path)).filter(Boolean);

  try {
    // ✅ PARALLEL + TIME LIMIT
    const results = await Promise.race([
      Promise.allSettled(
        urls.map(url => fetchAndParse(url))
      ),
      timeout(4000) // 🔥 HARD LIMIT (VERY IMPORTANT)
    ]);

    if (!Array.isArray(results)) return '';

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        console.log(`👤 Found owner: ${r.value}`);
        return r.value;
      }
    }

  } catch (err) {
    // silent — don't crash the worker pool
  }

  return '';
}

// =========================
// MEDICAL MULTI-LAYER OSINT ENGINE 
// =========================
export async function extractMedicalDecisionMaker(businessName, websiteUrl) {
  let ownerName = "";
  let email = "";
  let fallbackEmail = "";
  
  const base = normalizeDomain(websiteUrl || "");
  const cleanDomain = base ? (base.includes('//') ? base.split('//')[1].replace('www.', '').toLowerCase() : base.replace('www.', '').toLowerCase()) : '';

  const MEDICAL_KEYWORDS = ['medical director', 'lead dentist', 'dds', 'd.m.d', 'chief medical officer', 'owner', 'founder', 'ceo', 'president'];

  // --------------------------------
  // Layer 1: Generalized Dorking
  // --------------------------------
  if (businessName) {
      try {
          const query = `"${businessName}" AND ("Medical Director" OR "Owner" OR "Dentist" OR "CEO" OR "Founder")`;
          const searchResults = await search(query, { safeSearch: SafeSearchType.MODERATE });
          
          if (searchResults && searchResults.results) {
              for (const r of searchResults.results.slice(0, 7)) {
                  const title = r.title.toLowerCase();
                  if (MEDICAL_KEYWORDS.some(k => title.includes(k) || r.description.toLowerCase().includes(k))) {
                      // Attempt to extract name explicitly
                      const titleMatch = r.title.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,2})\s*(?:-|\||,|is the|:)\s*(?:CEO|Owner|Founder|Director|Medical|Lead|DDS|Dentist|President)/i) || 
                                         r.title.match(/(?:CEO|Owner|Founder|Director|Medical|Lead|DDS|Dentist|Dr\.|Dr|President)\s*(?:-|\||,|:|\s)\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,2})/i);
                      if (titleMatch) {
                          ownerName = (titleMatch[1] || titleMatch[2]).trim();
                          break;
                      }
                  }
              }
          }
      } catch (err) {}
  }

  // --------------------------------
  // Layer 2: Deep Website Parsing (Fallback if Dorking failed)
  // --------------------------------
  if (!ownerName && websiteUrl) {
      // Re-use current system which does deeper parsing
      ownerName = await extractDecisionMaker(websiteUrl).catch(() => '');
  }

  // Sanitize extracted owner name
  if (ownerName) {
     ownerName = ownerName.replace(/owner|founder|ceo|director|medical|lead|dentist|dds/ig, '').trim();
  }

  // --------------------------------
  // Layer 3: The Blind SMTP Ping
  // --------------------------------
  if (cleanDomain && !cleanDomain.includes('google.com')) {
      const pings = [];
      
      // Inject derived names if we found an owner
      if (ownerName) {
          const parts = ownerName.split(' ').map(s => s.toLowerCase().replace(/[^a-z]/g, '')).filter(Boolean);
          const first = parts[0];
          const last = parts.length > 1 ? parts[parts.length - 1] : '';
          
          if (first && last) {
              pings.push(`${first}.${last}@${cleanDomain}`);
              pings.push(`${first[0]}${last}@${cleanDomain}`);
              pings.push(`dr${last}@${cleanDomain}`);
              pings.push(`${first}@${cleanDomain}`);
          } else if (first) {
              pings.push(`${first}@${cleanDomain}`);
              pings.push(`dr${first}@${cleanDomain}`);
          }
      }
      
      // Blind generalized fallbacks
      pings.push(`director@${cleanDomain}`);
      pings.push(`owner@${cleanDomain}`);
      pings.push(`founder@${cleanDomain}`);
      pings.push(`ceo@${cleanDomain}`);
      pings.push(`management@${cleanDomain}`);

      // De-duplicate
      const uniquePings = [...new Set(pings)];
      
      for (const p of uniquePings) {
          try {
             const status = await verifyEmail(p);
             if (status === 'verified') {
                 email = p;
                 break;
             } else if (status === 'risky' && !fallbackEmail) {
                 fallbackEmail = `[RISKY] ${p}`;
             }
          } catch {}
      }
  }

  return { ownerName, email, fallbackEmail };
}

// =========================
// HELPERS
// =========================

function normalizeDomain(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return url;
  }
}

function buildUrl(base, path) {
  try {
    return new URL(path, base).toString();
  } catch {
    return null;
  }
}

async function fetchAndParse(url) {
  try {
    const res = await axios.get(url, {
      timeout: 3000,
      headers: {
        'User-Agent': getRandomUA(),
        'Accept': 'text/html,*/*;q=0.9',
      },
      maxRedirects: 2,
    });

    return parseOwnerFromHtml(res.data);

  } catch {
    return '';
  }
}

function parseOwnerFromHtml(html) {
  const $ = cheerio.load(html);

  $('script, style, nav, footer').remove();

  let found = '';

  $('h1,h2,h3,h4,.title,.name,[class*="team"],[class*="owner"]').each((i, el) => {
    if (found) return;

    const text = $(el).text().trim();

    if (!text) return;

    const lower = text.toLowerCase();

    if (OWNER_KEYWORDS.some(k => lower.includes(k))) {
      const match =
        text.match(NAME_REGEX) ||
        text.match(/([A-Z][a-z]+\s[A-Z][a-z]+)/);

      if (match) {
        found = match[1];
      }
    }
  });

  return found;
}

// =========================
// TIMEOUT HELPER
// =========================
function timeout(ms) {
  return new Promise(resolve => {
    setTimeout(() => resolve(null), ms);
  });
}