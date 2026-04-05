import axios from 'axios';
import * as cheerio from 'cheerio';
import { log } from './utils.js';

const OWNER_KEYWORDS = ['owner', 'founder', 'ceo', 'director', 'president', 'principal', 'managing partner', 'co-founder'];
const TEAM_PATHS = ['/about', '/about-us', '/team', '/our-team', '/staff', '/leadership', '/meet-the-team'];

const NAME_REGEX = /\b([A-Z][a-z]+ [A-Z][a-z]+)\b/g;

export async function extractDecisionMaker(websiteUrl) {
  if (!websiteUrl || !websiteUrl.startsWith('http')) return '';

  for (const path of TEAM_PATHS) {
    const url = buildUrl(websiteUrl, path);
    if (!url) continue;

    try {
      const response = await axios.get(url, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadEngine/1.0)' },
        maxRedirects: 3,
      });

      const name = parseOwnerFromHtml(response.data);
      if (name) {
        log(`Found decision maker at ${url}: ${name}`);
        return name;
      }
    } catch (_) {
      continue;
    }
  }

  return '';
}

function buildUrl(base, path) {
  try {
    const url = new URL(base);
    url.pathname = path;
    return url.toString();
  } catch (_) {
    return null;
  }
}

function parseOwnerFromHtml(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, nav, footer').remove();

  const text = $('body').text();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    const isOwnerLine = OWNER_KEYWORDS.some(kw => line.includes(kw));

    if (isOwnerLine) {
      const nearby = [
        i > 0 ? lines[i - 1] : '',
        lines[i],
        i < lines.length - 1 ? lines[i + 1] : '',
      ].join(' ');

      const nameMatch = nearby.match(NAME_REGEX);
      if (nameMatch && nameMatch.length > 0) {
        const filtered = nameMatch.filter(n => !OWNER_KEYWORDS.some(kw => n.toLowerCase().includes(kw)));
        if (filtered.length > 0) return filtered[0];
      }
    }
  }

  const elements = $('[class*="owner"], [class*="founder"], [class*="ceo"], [class*="director"], [data-role]');
  let found = '';
  elements.each((_, el) => {
    if (found) return;
    const text = $(el).text().trim();
    const nameMatch = text.match(NAME_REGEX);
    if (nameMatch) found = nameMatch[0];
  });

  return found;
}
