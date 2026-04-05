import { chromium } from 'playwright';
import { randomDelay, log, safeText } from './utils.js';

const MAPS_URL = 'https://www.google.com/maps/search/';

export async function scrapeGoogleMaps(query, maxResults = 100) {
  const leads = [];
  let browser = null;

  try {
    log(`Launching browser for query: "${query}"`);
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    const searchUrl = `${MAPS_URL}${encodeURIComponent(query)}`;
    log(`Navigating to: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await randomDelay(2000, 3000);

    await scrollAndCollectListings(page, maxResults, leads, query);

    log(`Collected ${leads.length} listings from "${query}"`);
  } catch (err) {
    log(`ERROR in scrapeGoogleMaps: ${err.message}`);
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }

  return leads;
}

async function scrollAndCollectListings(page, maxResults, leads, query) {
  const seenNames = new Set();

  let scrollAttempts = 0;
  const maxScrollAttempts = 30;

  while (leads.length < maxResults && scrollAttempts < maxScrollAttempts) {
    const listingElements = await page.$$('a[href*="/maps/place/"]');
    log(`Found ${listingElements.length} listing elements (scroll attempt ${scrollAttempts + 1})`);

    for (let i = 0; i < listingElements.length && leads.length < maxResults; i++) {
      let retries = 0;
      let extracted = null;

      while (retries < 2 && !extracted) {
        try {
          const elements = await page.$$('a[href*="/maps/place/"]');
          if (i >= elements.length) break;

          const el = elements[i];
          const name = await el.getAttribute('aria-label') || '';
          if (!name || seenNames.has(name)) { retries = 2; break; }

          log(`Scraping ${leads.length + 1}/${maxResults}: ${name}`);
          await el.click({ timeout: 5000 });
          await randomDelay(2000, 4000);

          extracted = await extractBusinessDetails(page, name, query);
          if (extracted) {
            seenNames.add(name);
            leads.push(extracted);
          }

          await page.goBack({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
          await randomDelay(1500, 3000);
        } catch (err) {
          log(`Retry ${retries + 1} for listing ${i}: ${err.message}`);
          retries++;
          await randomDelay(2000, 3000);
        }
      }
    }

    const endOfList = await page.$('span.HlvSq');
    if (endOfList) {
      log('Reached end of listing results');
      break;
    }

    try {
      const panel = await page.$('div[role="feed"]');
      if (panel) {
        await panel.evaluate(el => el.scrollBy(0, 800));
      } else {
        await page.evaluate(() => window.scrollBy(0, 800));
      }
    } catch (_) {}

    await randomDelay(1500, 2500);
    scrollAttempts++;
  }
}

async function extractBusinessDetails(page, name, query) {
  try {
    await page.waitForSelector('h1', { timeout: 8000 });

    const businessName = safeText(await page.$eval('h1', el => el.textContent).catch(() => name));

    const phone = await extractPhone(page);
    const website = await extractWebsite(page);
    const rating = await extractRating(page);
    const reviews = await extractReviews(page);
    const address = await extractAddress(page);

    const parts = query.split(' in ');
    const niche = parts[0] || query;
    const location = parts[1] || '';

    return {
      business_name: businessName,
      owner_name: '',
      email: '',
      email_status: 'not_found',
      phone: phone || '',
      website: website || '',
      city: location,
      state: '',
      niche: niche,
      rating: rating || '',
      reviews: reviews || 0,
      intent_tag: '',
      score: 0,
      address: address || '',
    };
  } catch (err) {
    log(`Failed to extract details for "${name}": ${err.message}`);
    return null;
  }
}

async function extractPhone(page) {
  try {
    const phoneEl = await page.$('button[data-tooltip="Copy phone number"], [data-item-id*="phone"] span, button[aria-label*="phone"] span');
    if (phoneEl) return safeText(await phoneEl.textContent());

    const allButtons = await page.$$('button[data-item-id]');
    for (const btn of allButtons) {
      const dataItemId = await btn.getAttribute('data-item-id');
      if (dataItemId && dataItemId.includes('phone')) {
        const span = await btn.$('span.Io6YTe');
        if (span) return safeText(await span.textContent());
      }
    }
  } catch (_) {}
  return '';
}

async function extractWebsite(page) {
  try {
    const websiteEl = await page.$('a[data-item-id="authority"]');
    if (websiteEl) return await websiteEl.getAttribute('href');

    const allLinks = await page.$$('a[data-item-id]');
    for (const link of allLinks) {
      const href = await link.getAttribute('href');
      if (href && !href.includes('google') && href.startsWith('http')) {
        return href;
      }
    }
  } catch (_) {}
  return '';
}

async function extractRating(page) {
  try {
    const ratingEl = await page.$('div.F7nice span[aria-hidden="true"]');
    if (ratingEl) return parseFloat(safeText(await ratingEl.textContent())) || '';
    const ratingEl2 = await page.$('span.ceNzKf[aria-label*="stars"]');
    if (ratingEl2) {
      const label = await ratingEl2.getAttribute('aria-label');
      const match = label && label.match(/([\d.]+)/);
      return match ? parseFloat(match[1]) : '';
    }
  } catch (_) {}
  return '';
}

async function extractReviews(page) {
  try {
    const reviewEl = await page.$('div.F7nice span[aria-label*="review"]');
    if (reviewEl) {
      const label = await reviewEl.getAttribute('aria-label');
      const match = label && label.match(/([\d,]+)/);
      return match ? parseInt(match[1].replace(/,/g, ''), 10) : 0;
    }
    const reviewEl2 = await page.$('button[jsaction*="pane.rating.moreReviews"] span');
    if (reviewEl2) {
      const text = safeText(await reviewEl2.textContent());
      const match = text.match(/([\d,]+)/);
      return match ? parseInt(match[1].replace(/,/g, ''), 10) : 0;
    }
  } catch (_) {}
  return 0;
}

async function extractAddress(page) {
  try {
    const addrButtons = await page.$$('button[data-item-id*="address"]');
    for (const btn of addrButtons) {
      const span = await btn.$('span.Io6YTe');
      if (span) return safeText(await span.textContent());
    }
  } catch (_) {}
  return '';
}
