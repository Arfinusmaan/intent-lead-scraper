import axios from 'axios';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { log, randomDelay } from './utils.js';

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const IGNORE_DOMAINS = ['sentry.io', 'wixpress.com', 'example.com', 'yourdomain.com', 'domain.com', 'email.com'];

const CONTACT_PATHS = ['', '/contact', '/contact-us', '/about', '/about-us', '/team', '/contact.html', '/about.html'];

export async function extractEmails(websiteUrl) {
  if (!websiteUrl || !websiteUrl.startsWith('http')) return '';

  log(`Extracting emails from: ${websiteUrl}`);
  const emails = new Set();

  for (const path of CONTACT_PATHS) {
    const url = buildUrl(websiteUrl, path);
    if (!url) continue;

    let pageEmails = await extractFromAxios(url);
    if (!pageEmails || pageEmails.length === 0) {
      pageEmails = await extractFromPlaywright(url);
    }

    for (const email of pageEmails) {
      if (isValidEmail(email)) emails.add(email.toLowerCase());
    }

    if (emails.size > 0) break;

    await randomDelay(500, 1500);
  }

  return pickPrimaryEmail([...emails]);
}

function buildUrl(base, path) {
  try {
    const url = new URL(base);
    url.pathname = path || '/';
    return url.toString();
  } catch (_) {
    return null;
  }
}

async function extractFromAxios(url) {
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      maxRedirects: 3,
    });
    return parseEmailsFromHtml(response.data);
  } catch (_) {
    return [];
  }
}

async function extractFromPlaywright(url) {
  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    const content = await page.content();
    return parseEmailsFromHtml(content);
  } catch (_) {
    return [];
  } finally {
    if (browser) try { await browser.close(); } catch (_) {}
  }
}

function parseEmailsFromHtml(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  const text = $.html();
  const decoded = text.replace(/&#64;/g, '@').replace(/%40/g, '@').replace(/\[at\]/gi, '@').replace(/\(at\)/gi, '@');
  const matches = decoded.match(EMAIL_REGEX) || [];
  return matches.filter(e => !IGNORE_DOMAINS.some(d => e.includes(d)));
}

function isValidEmail(email) {
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email);
}

function pickPrimaryEmail(emails) {
  if (emails.length === 0) return '';
  const preferred = emails.find(e =>
    e.startsWith('info@') || e.startsWith('contact@') || e.startsWith('hello@') || e.startsWith('support@') || e.startsWith('admin@')
  );
  return preferred || emails[0];
}
