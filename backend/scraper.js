import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
chromium.use(stealthPlugin());

import { log, processInBatches } from "./utils.js";
import { getSubLocations } from "./cityService.js";
import { getJob, updateJob, setPauseFlag } from "./store.js";
import { scoreLead } from "./intentScorer.js";
import { classifyLead } from "./filter.js";

function isSharedPlatform(domain) {
  if (!domain) return false;
  const shared = [
    'facebook.com', 'instagram.com', 'yelp.com', 'google.com', 'twitter.com',
    'linkedin.com', 'youtube.com', 'manta.com', 'yellowpages.com', 'foursquare.com',
    'mapquest.com', 'tripadvisor.com', 'groupon.com', 'angis.com', 'homeadvisor.com'
  ];
  return shared.some(s => domain.includes(s));
}

// Franchise brand roots whose domains are shared across many legitimate locations.
// Multiple SERVPRO/PaulDavis locations share the same root domain — never dedup them.
const FRANCHISE_DOMAIN_ROOTS = [
  'servpro', 'pauldavis', 'rainbowrestoration',
  '911restoration', 'puroclean', 'restorationmaster', 'servicemaster',
  'firstonsite', 'rytech', 'restoration1', 'jenkinsrestorations',
  'blackmonmooring', 'bmscat', 'blusky', 'dkiservices',
];

function isFranchiseDomain(domain) {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return FRANCHISE_DOMAIN_ROOTS.some(fr => d.includes(fr));
}

// Thin compatibility shim — used by filterCSVByGoogleCategory.
export function isNicheAligned(niche, businessName, category, sidePaneText) {
  const classification = classifyLead({ name: businessName, categories: [category, sidePaneText].filter(Boolean) }, niche, false);
  return classification.status === 'KEEP';
}

// Normalize phone numbers — strip everything except digits and leading +
function cleanPhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return '';
  return phone.replace(/[^\d+\-()\s]/g, '').trim();
}

// Checks if the loaded pane title matches the clicked business name
function matchesClickedName(paneTitle, clickedName) {
    if (!paneTitle || !clickedName) return false;
    const cleanPane = paneTitle.toLowerCase().trim();
    const cleanName = clickedName.toLowerCase().trim();
    
    if (cleanPane.includes(cleanName) || cleanName.includes(cleanPane)) return true;
    
    const commonWords = new Set(['of', 'and', 'the', 'in', 'on', 'at', 'for', 'co', 'inc', 'llc', 'corp', 'services', 'service', 'company', 'restoration']);
    const nameWords = cleanName.split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !commonWords.has(w));
    if (nameWords.length > 0) {
        return nameWords.some(word => cleanPane.includes(word));
    }
    
    return cleanPane.slice(0, 4) === cleanName.slice(0, 4);
}

// =========================
// WEBSITE WORKER POOL (RAM OPTIMIZED)
// =========================
class WebsiteWorkerPool {
  constructor(context, maxWorkers = 3) {
    this.context = context;
    this.maxWorkers = maxWorkers;
    this.activeWorkers = 0;
    this.queue = [];
  }

  async run(website, callback, negWords = []) {
    if (this.activeWorkers >= this.maxWorkers) {
      return new Promise((resolve) => {
        this.queue.push({ website, callback, negWords, resolve });
      });
    }

    this.activeWorkers++;
    try {
      const result = await this.extract(website, negWords);
      await callback(result); // await — callback is async (calls extractDecisionMaker)
    } finally {
      this.activeWorkers--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        this.run(next.website, next.callback, next.negWords).then(next.resolve);
      }
    }
  }

  async extract(website, negWords = []) {
    if (!website) return { primary: "", secondary: [] };
    
    let emails = [];
    const cleanWeb = website.replace(/\/$/, '');
    
    const isValidEmail = (email) => {
        if (!email || email.includes(' ') || !email.includes('@')) return false;
        
        const [user, domain] = email.toLowerCase().split('@');
        if (!user || !domain) return false;
        
        // Block common test/template emails
        const JUNK_USERS = ['email', 'user', 'username', 'name', 'yourname', 'test', 'example', 'domain', 'info@example.com'];
        if (JUNK_USERS.includes(user)) return false;
        
        // Block common junk domains
        const JUNK_DOMAINS = [
          'sentry.io', 'wix.com', 'google.com', 'example.com', 'domain.com', 
          'cloudflare.com', 'amazonaws.com', 'wordpress.org', 'squarespace.com', 
          'shopify.com', 'weebly.com', 'godaddy.com', 'bluehost.com', 'hostgator.com',
          'gravatar.com', 'schema.org', 'openoffice.org'
        ];
        if (JUNK_DOMAINS.some(d => domain.includes(d))) return false;

        const JUNK_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.mp4', '.css', '.js', '.pdf', '.gifv'];
        if (JUNK_EXTENSIONS.some(ext => domain.endsWith(ext))) return false;

        // Ensure domain has a dot and a valid TLD
        const parts = domain.split('.');
        if (parts.length < 2) return false;
        const tld = parts[parts.length - 1];
        if (!/^[a-z]{2,8}$/.test(tld)) return false;

        // Check for gibberish/random strings (e.g. no vowels at all in a long string, or random hashes)
        const hasVowels = /[aeiouy]/.test(user);
        if (user.length > 12 && !hasVowels) return false;
        
        // Check if username is hex hash (e.g. 6a8ypcacevhcac)
        if (user.length > 16 && /^[a-f0-9]+$/.test(user)) return false;
        
        // Check if username has a mix of numbers and letters scattered throughout (indicates hash/random ID)
        if (user.length > 8 && /\d[a-z]|[a-z]\d/.test(user) && (user.match(/\d/g) || []).length > 1) {
            if (!/^[a-z]+[0-9]+$/.test(user)) {
                return false;
            }
        }

        // Check for common placeholders
        if (email.includes('placeholder') || email.includes('template')) return false;

        return true;
    };



    // =========================
    // RAM SAVER: Block only images and media to speed up loads without breaking layout/scripts
    // =========================
    const blockRoute = async (page) => {
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        // Block images and media to maximize crawl speed.
        // We allow stylesheets/fonts to prevent breaking some React/Angular apps.
        if (['image', 'media'].includes(type)) return route.abort();
        return route.continue();
      });
    };

    let pagesToVisit = [website];
    let homePage;
    try {
      homePage = await this.context.newPage();
      await blockRoute(homePage);
      await homePage.goto(website, { timeout: 6000, waitUntil: "domcontentloaded" });

      const html = await homePage.content();
      const text = await homePage.evaluate(() => document.body?.innerText || '');

      // Store website text for re-classification after crawl (Item 1)
      this._lastWebsiteText = text.slice(0, 8000); // cap at 8KB to avoid memory bloat

      let isRejected = false;
      if (negWords && negWords.length > 0) {
          const lowerText = text.toLowerCase();
          for (const nw of negWords) {
              if (lowerText.includes(nw)) {
                  isRejected = true;
                  break;
              }
          }
      }
      if (isRejected) {
          this._lastWebsiteText = '';
          return { primary: "", secondary: [], isRejected: true };
      }
      
      const found = [...text.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g)]
        .map(m => m[0].toLowerCase())
        .filter(isValidEmail);
      emails.push(...found);

      // Also scan for mailto: links
      const mailtoLinks = [...html.matchAll(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,})/gi)]
        .map(m => m[1].toLowerCase())
        .filter(isValidEmail);
      emails.push(...mailtoLinks);

      const navLinks = await homePage.$$eval('a', as => as.map(a => ({ href: a.href || '', text: (a.innerText || '').toLowerCase() })));
      const keywords = ['contact', 'about', 'team', 'staff', 'owner', 'meet', 'appointment', 'book'];
      
      for (const link of navLinks) {
          if (keywords.some(k => link.text.includes(k)) && link.href.startsWith(cleanWeb)) {
              pagesToVisit.push(link.href);
          }
      }
    } catch (e) {
      // Silently continue — page may have failed but we move on
    } finally {
      if (homePage) await homePage.close().catch(() => {});
    }

    // Limit to 3 pages total (home + contact + about). Fewer pages = faster per-lead.
    pagesToVisit = [...new Set(pagesToVisit)].slice(0, 3);
    
    for (const url of pagesToVisit.slice(1)) {
        let p;
        try {
            p = await this.context.newPage();
            await blockRoute(p);
            await p.goto(url, { timeout: 4000, waitUntil: "domcontentloaded" });
            const pText = await p.evaluate(() => document.body?.innerText || '');
            const pHtml = await p.content();
            const pEmails = [
              ...[...pText.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g)].map(m => m[0].toLowerCase()),
              ...[...pHtml.matchAll(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,})/gi)].map(m => m[1].toLowerCase())
            ].filter(isValidEmail);
            emails.push(...pEmails);
        } catch {
          // Skip failed sub-pages
        } finally {
            if (p) await p.close().catch(() => {});
        }
    }

    emails = [...new Set(emails)];
    const priority = ["contact@", "info@", "hello@", "support@"];
    let primary = emails.find(e => priority.some(p => e.startsWith(p))) || emails[0] || "";

    // Collect website body text for re-classification (Item 1)
    return { primary, secondary: emails.filter(e => e !== primary), websiteText: this._lastWebsiteText || '' };
  }
}

async function checkPause(jobId) {
    while (getJob(jobId)?.pauseFlag) {
        await new Promise(r => setTimeout(r, 1000));
    }
}

// =========================
// NICHE QUERY EXPANDER
// Maps broad niches to specific Google-searchable sub-queries.
// This is the cleanest filtering method — let Google's own search
// engine return only matching businesses instead of keyword-scrubbing.
// =========================
// =============================================================================
// SMART SEARCH EXPANSION ENGINE
// Generates buyer-intent search queries from a broad niche string.
// Each query is specifically crafted so Google Maps returns the RIGHT businesses,
// reducing dependence on post-scrape filtering.
// =============================================================================
function expandNicheToQueries(niche) {
  if (niche.includes(',')) {
    return niche.split(',').map(n => n.trim()).filter(Boolean);
  }
  return [niche.trim()];
}

export async function scrapeGoogleMaps(niche, location, filterType, negativeKeywords, jobId, mode = 'hybrid', workerCount = 3, onProgress = () => {}) {
  const job = getJob(jobId);
  if (!job) return [];

  const isBackground = mode === 'normal';
  const browser = await chromium.launch({
    headless: isBackground,
    args: [
      '--window-size=1920,1080',
      '--disable-gpu',            // saves VRAM
      '--no-sandbox',
      '--disable-dev-shm-usage',  // prevents /dev/shm OOM crashes
      '--js-flags=--max-old-space-size=256' // cap V8 heap per tab
    ]
  });

  // Single shared context — all ZIP tabs live inside ONE browser window
  const globalContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // Block images, media, fonts, and tracking pixels at the CONTEXT level.
  // This applies to every tab automatically — no per-tab routing needed.
  await globalContext.route('**/*', (route) => {
    const type = route.request().resourceType();
    const url  = route.request().url();
    // Block: images, video, audio, fonts, tracking pixels
    if (['image', 'media', 'font'].includes(type)) return route.abort();
    // Block known analytics/tracking domains that waste bandwidth
    if (url.includes('google-analytics') || url.includes('doubleclick') || url.includes('adservice')) return route.abort();
    return route.continue();
  });

  // Crawl browser: headless, capped at 2 workers max to prevent RAM spikes
  const crawlBrowser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'] });
  const crawlContext = await crawlBrowser.newContext({ viewport: { width: 1280, height: 720 } });
  const crawlWorkerCap = Math.min(parseInt(workerCount), 2); // max 2 crawl tabs regardless of UI setting
  const workerPool = new WebsiteWorkerPool(crawlContext, crawlWorkerCap);

  // Expand the niche into specific targeted queries
  const nicheQueries = expandNicheToQueries(niche);
  const isExpanded = nicheQueries.length > 1;
  if (isExpanded) {
    log(`🎯 Niche "${niche}" expanded into ${nicheQueries.length} targeted queries: ${nicheQueries.join(', ')}`, jobId);
  }

  let subLocations = await getSubLocations(location);
  let allLeads = [];
  let workerPromises = new Set();

  const processedNames = new Set();
  const processedPhones = new Set();
  const processedWebsites = new Set();
  let lastScrapedDetails = null;

  // Parse negative keywords once for the entire job
  const negWords = (negativeKeywords || '')
      .toLowerCase()
      .split(',')
      .map(w => w.trim())
      .filter(w => w.length > 0);

  const processSubLocation = async (subLoc, sIdx) => {
    updateJob(jobId, { lastProcessedIndex: sIdx });
    await checkPause(jobId);
    if (getJob(jobId)?.stopFlag) return;
    
    // SPINTAX: Randomize User Agents to simulate different devices
    const userAgents = [
       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
       "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/120.0",
       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0 Safari/537.36"
    ];
    const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];

    // Open a new tab within the single browser window
    const page = await globalContext.newPage();
    
    // Resource blocking is handled at the context level above — no per-page routing needed.
    
    try {
      // Run each targeted sub-query for this location
      // (or just the one query if niche wasn't expanded)
      for (const queryNiche of nicheQueries) {
        if (getJob(jobId)?.stopFlag) break;
        await checkPause(jobId);

        const query = `${queryNiche} in ${subLoc}`;
        log(`🚀 Searching: ${query}`, jobId);
        await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      
      // =========================
      // CAPTCHA / BOT DETECTION ENGINE AUTO-PAUSE
      // =========================
      const pageText = await page.content();
      if (pageText.includes('action="CaptchaRedirect"') || pageText.includes('Our systems have detected unusual traffic')) {
          const cooldownMinutes = Math.floor(Math.random() * 5) + 3; // Random 3 to 7 minutes
          log(`🛑 CAPTCHA DETECTED! Initiating Autonomous Cool-Down (${cooldownMinutes} minutes)...`, jobId);
          updateJob(jobId, { currentCity: `IP COOL-DOWN: ${cooldownMinutes} Minutes` });
          
          // Sleep to let the Google IP flag naturally expire
          await new Promise(r => setTimeout(r, cooldownMinutes * 60000));
          
          log(`▶️ Cool-Down Complete. Skipping to next ZIP with fresh fingerprint...`, jobId);
          // Break the niche loop: This forces the engine into the 'finally' block to DESTROY 
          // the poisoned browser context and generate a completely new Incognito instance.
          break;
      }

      try {
        const rejectBtn = page.locator('button:has-text("Reject"), button:has-text("Accept")').first();
        if (await rejectBtn.count()) await rejectBtn.click();
      } catch {}

      await page.waitForSelector('div[role="feed"]', { timeout: 8000 }).catch(() => {});
      
      let noNewCount = 0;
      let lastPaneTitle = "";
      let totalFoundInCity = 0;

      while (noNewCount < 6 && !getJob(jobId)?.stopFlag) {
          const feedLocator = page.locator('div[role="feed"]');
          if (await feedLocator.count() === 0) break; // Check if the feed exists before scrolling
          
          const listings = feedLocator.locator('a[href*="/place"]');
          const batchCount = Math.min(await listings.count(), 150);
          let foundNewInBatch = false;

          // negWords already parsed once at the top of scrapeGoogleMaps

          for (let i = 0; i < batchCount; i++) {
              await checkPause(jobId);
              if (getJob(jobId)?.stopFlag) break;
              
              let name = "";
              let item;
              let itemText = "";
              try {
                 item = listings.nth(i);
                 name = await item.getAttribute("aria-label");
                 const parent = item.locator('xpath=..');
                 itemText = await parent.textContent({ timeout: 500 }).catch(() => "");
              } catch { continue; }
              
              if (!name) continue;
              const cleanNameKey = name.toLowerCase().trim();
              if (processedNames.has(cleanNameKey)) continue;

              const lowerName = name.toLowerCase();
              const lowerNiche = niche.toLowerCase();
              
              let hasNegative = false;
              for (const nw of negWords) {
                  if (lowerName.includes(nw)) {
                      hasNegative = true;
                      break;
                  }
              }

              if (hasNegative) {
                  log(`⏭️ Skipping ${name} (Negative keyword match in name)`, jobId);
                  continue;
              }
              
              // Built-in heuristics for pure Massage Spas if looking for Med Spas
              if (lowerNiche.includes('med spa') || lowerNiche.includes('medspa') || lowerNiche.includes('medical spa')) {
                  if (lowerName.includes('massage') && !lowerName.match(/med|medical|aesthetic|laser|clinic|beauty/)) {
                      log(`⏭️ Skipping ${name} (Massage spa found in Med Spa search)`, jobId);
                      continue;
                  }
              }

              processedNames.add(cleanNameKey);
              foundNewInBatch = true;
              totalFoundInCity++;

              try {
                  log(`👉 Clicking: ${name}`, jobId);
                  const safeName = name.replace(/"/g, '\\"');
                  let targetItem = feedLocator.locator(`a[aria-label="${safeName}"]`).first();
                  
                  if (await targetItem.count() === 0) {
                      // Fallback: If label vanished from virtual DOM, grab directly by index
                      targetItem = listings.nth(i);
                      if (await targetItem.count() === 0) {
                          log(`⚠️ Element vanished entirely, skipping.`, jobId);
                          continue;
                      }
                  }

                  try {
                      // Standard click to center of element
                      await targetItem.click({ force: true, timeout: 2000 });
                  } catch {
                     try { 
                         // Robust fallback click using JS to bypass any visible overlay
                         await targetItem.evaluate(node => node.click()); 
                     } catch {
                         try { await targetItem.focus(); await page.keyboard.press('Enter'); } catch {}
                     }
                  }

          let paneFound = false;
          // Increased to 45 attempts × 200ms = max 9s wait. Prevents desync under parallel CPU load.
          for (let attempt = 0; attempt < 45; attempt++) {
              if (attempt === 6 && !paneFound) {
                  // Force keyboard re-click if pane hasn't responded after 1200ms
                  try { await targetItem.focus(); await page.keyboard.press('Enter'); } catch {}
              }
              if (attempt === 12 && !paneFound) {
                  // Second attempt: evaluate click directly in browser context
                  try { await targetItem.evaluate(node => node.click()); } catch {}
              }

              // Broader selector set — Google Maps changes class names frequently
              const paneTitle = await page.evaluate((expectedName) => {
                  const selectors = [
                    'h1.DUwDvf',
                    'h1.fontHeadlineLarge', 
                    '[role="main"] h1',
                    'div[aria-label] h1',
                    'h1'
                  ];
                  
                  const cleanExpected = expectedName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                  const expectedWords = cleanExpected.split(' ').filter(w => w.length > 2);

                  let bestMatch = '';
                  
                  for (const sel of selectors) {
                    const els = Array.from(document.querySelectorAll(sel));
                    for (const el of els) {
                        const text = el.textContent ? el.textContent.trim() : '';
                        if (text.length > 1 && text !== "Results") {
                            const cleanText = text.toLowerCase();
                            // If it's an exact match or contains at least one meaningful word from the name, prioritize it
                            if (cleanText.includes(cleanExpected) || (expectedWords.length > 0 && expectedWords.some(w => cleanText.includes(w)))) {
                                return text;
                            }
                            // Otherwise save it as a fallback in case the expected name is completely mismatched
                            if (!bestMatch) bestMatch = text;
                        }
                    }
                  }
                  return bestMatch;
              }, name).catch(() => '');

              const isDifferent = paneTitle && paneTitle !== lastPaneTitle;
              const matchesName = matchesClickedName(paneTitle, name);

              // Correct pane loaded (different title + matches clicked name)
              if (isDifferent && matchesName) {
                  paneFound = true;
                  lastPaneTitle = paneTitle;
                  break;
              }

              // Back-to-back franchise fallback: same brand title but we gave it 3 attempts (600ms) to load/refresh
              if (matchesName && attempt > 2) {
                  paneFound = true;
                  lastPaneTitle = paneTitle;
                  break;
              }
              
              await page.waitForTimeout(200);
          }
          if (!paneFound) {
              log(`⚠️ Timeout loading pane for ${name}, Skipping.`, jobId);
              continue;
          }

          // Allow React to fully hydrate the DOM so category and phone aren't empty
          await page.waitForTimeout(800);

          // Capture Google Maps URL now that the place pane is open
          const mapsUrl = page.url();
          
          // Locate the detail pane — it's the div that has the business's place URL in it
          // or the role=main that contains the phone button.
          let sidePane = null;
          try {
              // Approach 1: aria-label matches the business name exactly
              const escapedName = name.replace(/"/g, '\\"');
              const exactPane = page.locator(`div[role="main"][aria-label="${escapedName}"]`).first();
              if (await exactPane.count() > 0) {
                  sidePane = exactPane;
              }
          } catch {}
          
          if (!sidePane) {
              try {
                  // Approach 2: Find the div[role=main] that contains a phone button
                  // This reliably identifies the business detail panel, not the results list
                  const panes = page.locator('div[role="main"]');
                  const count = await panes.count();
                  for (let k = 0; k < count; k++) {
                      const p = panes.nth(k);
                      const hasPhone = await p.locator('button[data-item-id^="phone:tel:"]').count().catch(() => 0);
                      const hasAddr = await p.locator('button[data-item-id="address"]').count().catch(() => 0);
                      const hasWeb = await p.locator('a[data-item-id="authority"]').count().catch(() => 0);
                      if (hasPhone > 0 || hasAddr > 0 || hasWeb > 0) {
                          sidePane = p;
                          break;
                      }
                  }
              } catch {}
          }
          
          // Absolute fallback: first role=main that isn't the results feed
          if (!sidePane) {
              sidePane = page.locator('div[role="main"]').last();
          }

           // CRITICAL FIX: Avoid grabbing stale details from previous pane.
           // If the phone, website or address is exactly identical to the previous scraped lead,
           // it is extremely likely that the pane hasn't updated yet. We wait and re-read.
           let phone = "";
           let website = "";
           let address = "";
           let detailsUpdated = false;
 
           // Up to 8 attempts × 500ms = 4 seconds max wait for phone/website to load
           for (let attempt = 0; attempt < 8; attempt++) {
               // Try scoped selectors on sidePane first, then fall back to page-level
               const phoneLocator = sidePane
                   ? sidePane.locator('button[data-item-id^="phone:tel:"]').first()
                   : page.locator('button[data-item-id^="phone:tel:"]').first();
               const webLocator = sidePane
                   ? sidePane.locator('a[data-item-id="authority"]').first()
                   : page.locator('a[data-item-id="authority"]').first();
               const addrLocator = sidePane
                   ? sidePane.locator('button[data-item-id="address"]').first()
                   : page.locator('button[data-item-id="address"]').first();

               phone = (await phoneLocator.count().catch(() => 0) > 0)
                   ? await phoneLocator.textContent().catch(() => "") : "";
               website = (await webLocator.count().catch(() => 0) > 0)
                   ? await webLocator.getAttribute("href").catch(() => "") : "";
               address = (await addrLocator.count().catch(() => 0) > 0)
                   ? await addrLocator.textContent().catch(() => "") : "";

               // If we still got nothing, try page-level fallback (bypasses bad sidePane scope)
               if (!phone && !website) {
                   phone = await page.locator('button[data-item-id^="phone:tel:"]').first().textContent().catch(() => "") || "";
                   website = await page.locator('a[data-item-id="authority"]').first().getAttribute("href").catch(() => "") || "";
               }
 
               const phoneClean = cleanPhone(phone).replace(/[^\d]/g, '');
               const websiteClean = website ? website.toLowerCase().trim().replace('www.', '') : '';
 
               // Only consider stale if BOTH phone AND website match the previous lead
               const phoneStale = phoneClean && lastScrapedDetails && phoneClean === lastScrapedDetails.phone.replace(/[^\d]/g, '');
               const websiteStale = websiteClean && lastScrapedDetails && websiteClean === lastScrapedDetails.website.toLowerCase().trim().replace('www.', '');
 
               if (phoneStale && websiteStale) {
                   await page.waitForTimeout(500);
               } else if (!phoneClean && !websiteClean && attempt < 5) {
                   // Both empty — pane still loading, wait and retry
                   await page.waitForTimeout(500);
               } else {
                   detailsUpdated = true;
                   break;
               }
           }

          let rating = '';
          let reviews = '';
          let sidePaneText = '';
          let category = '';
          let gbpServices = '';   // Item 2: GBP listed services
          let gbpReviewsText = ''; // Item 3: sampled review text

          try {
            sidePaneText = await sidePane.textContent({ timeout: 500 }).catch(() => "");

            // Extract category robustly
            category = await sidePane.locator('button[jsaction*="category"], button.D75GSc').first().textContent({ timeout: 1500 }).catch(() => "");
            if (!category) {
                const match = sidePaneText.match(/(?:stars|\d\.\d)\s*(?:\([\d,]+\))?\s*·\s*([^·\n\r\t]+)/i);
                if (match) {
                    category = match[1].trim();
                } else {
                    // FOOLPROOF FALLBACK: Scan raw pane text for niche keyword
                    const lowerText = sidePaneText.toLowerCase();
                    const lowerNiche = niche.toLowerCase();
                    if (lowerText.includes(lowerNiche)) {
                        category = niche;
                    }
                }
            }

            // ── Item 2: GBP SERVICES EXTRACTION ─────────────────────────────
            // Google Maps shows a services list inside the side pane.
            // Multiple selector patterns tried for resilience against DOM changes.
            try {
              const serviceEls = await sidePane.locator('div[aria-label*="Services"] span, ul[aria-label*="Services"] li, div[jslog*="service"] span').allTextContents().catch(() => []);
              if (serviceEls.length > 0) {
                gbpServices = serviceEls.join(' ').toLowerCase();
              } else {
                // Fallback: regex the pane text for a services block
                const svcMatch = sidePaneText.match(/services[:\s]+([\w\s,;&]+)/i);
                if (svcMatch) gbpServices = svcMatch[1].toLowerCase().slice(0, 400);
              }
            } catch { /* services not critical */ }

            // ── Item 3: GBP REVIEWS SAMPLING ────────────────────────────────
            // Scrape first visible review snippets from the side pane.
            // Limited to first 5 reviews to keep this fast.
            try {
              const reviewSnippets = await sidePane
                .locator('span[data-expandable-section], div[data-review-id] span, div[jslog*="review"] span, div[class*="review"] span[jslog]')
                .allTextContents()
                .catch(() => []);
              if (reviewSnippets.length > 0) {
                gbpReviewsText = reviewSnippets.slice(0, 8).join(' ').toLowerCase().slice(0, 2000);
              } else {
                // Fallback: extract using sidebar aria text patterns
                const revMatch = sidePaneText.match(/(?:reviews?)[^]*?(?=hours|address|website|phone|$)/i);
                if (revMatch) gbpReviewsText = revMatch[0].toLowerCase().slice(0, 2000);
              }
            } catch { /* reviews not critical */ }

            const ratingData = await sidePane.evaluate((pane) => {
              const ratingEl = pane.querySelector('span.MW4etd, .ceaeq');
              const reviewEl = pane.querySelector('span.UY7F9, .dK32cf');
              if (ratingEl && reviewEl) {
                return { r: ratingEl.innerText.trim(), v: reviewEl.innerText.replace(/[^\d]/g, '') };
              }
              const starBtn = pane.querySelector('button[aria-label*="star"]');
              if (starBtn) {
                const label = starBtn.getAttribute('aria-label');
                const rMatch = label.match(/([\d.]+)\s*star/i);
                const vMatch = label.match(/([\d,]+)\s*(?:rating|review)/i);
                if (rMatch && vMatch) return { r: rMatch[1], v: vMatch[1].replace(/,/g, '') };
              }
              const text = pane.innerText;
              const rMatch = text.match(/(?:^|\n)([\d.]+)\s*\n?\s*\(([\d,]+)\)/);
              if (rMatch) return { r: rMatch[1], v: rMatch[2].replace(/,/g, '') };
              return { r: '', v: '' };
            }).catch(() => ({ r: '', v: '' }));

            if (ratingData.r) rating = ratingData.r;
            if (ratingData.v) reviews = ratingData.v;
          } catch { /* optional details */ }

          // Clean up phone and website for duplicate checks
          const cleanPhoneNum = cleanPhone(phone);
          const phoneCleanKey = cleanPhoneNum.replace(/[^\d]/g, '');
          const websiteCleanKey = website ? website.toLowerCase().trim().replace('www.', '') : '';

          if (!cleanPhoneNum && !website) {
              log(`⏭️ Skipping ${name} (No Phone/Web)`, jobId);
              continue;
          }

          if (website && website.includes('google.com')) {
               log(`⏭️ Skipping Google Link for ${name}`, jobId);
               continue;
          }

          // Check Job-Level duplicates before proceeding
          if (phoneCleanKey && processedPhones.has(phoneCleanKey)) {
              log(`⏭️ Skipping ${name} (Duplicate phone: ${cleanPhoneNum})`, jobId);
              continue;
          }
          // Item 6: Franchise brands (servpro.com/location, pauldavis.com/location) share a root domain
          // but represent genuinely different physical locations — never dedup them by domain.
          if (websiteCleanKey && processedWebsites.has(websiteCleanKey) && !isSharedPlatform(websiteCleanKey) && !isFranchiseDomain(websiteCleanKey)) {
              log(`⏭️ Skipping ${name} (Duplicate website: ${website})`, jobId);
              continue;
          }

          // =============================================================================
          // NEW HYBRID FILTERING ENGINE (BRAIN TRANSPLANT)
          // =============================================================================
          // CRITICAL FIX: Pass categories array, not types. Also include itemText as a fallback.
          const dummyLead = { 
              name: name.trim(), 
              categories: [category, sidePaneText, itemText].filter(Boolean) 
          };
          const isExact = (mode === 'exact');
          const classification = classifyLead(dummyLead, niche, isExact);

          if (classification.status === 'TRASH') {
              log(`⏭️ REJECTED ${name} — ${classification.reason}`, jobId);
              continue;
          }
          log(`✅ ACCEPTED ${name} — ${classification.reason.slice(0, 80)}`, jobId);

          // Check Negative Keywords inside sidePaneText
          if (sidePaneText) {
              const lowerPaneText = sidePaneText.toLowerCase();
              let hasNegativePane = false;
              for (const nw of negWords) {
                  if (lowerPaneText.includes(nw)) {
                      hasNegativePane = true;
                      break;
                  }
              }
              if (hasNegativePane) {
                  log(`⏭️ Skipping ${name} (Negative keyword found in business category/details)`, jobId);
                  continue;
              }
          }

          if (filterType === 'with_website' && !website) continue;
          if (filterType === 'without_website' && website) continue;

          // Track this lead to prevent duplicates and stale checks in future iterations
          if (phoneCleanKey) processedPhones.add(phoneCleanKey);
          if (websiteCleanKey) processedWebsites.add(websiteCleanKey);
          lastScrapedDetails = { phone: cleanPhoneNum, website: website || "", address: address || "" };

          let lead = {
            business_name: name.trim(),
            phone: cleanPhoneNum,
            website: website || "",
            maps_url: mapsUrl || "",
            address: address.trim(),
            rating: rating || "",
            reviews: reviews || "0",
            city: subLoc,
            primary_email: "",
            intent: "LOW",
            score: 0,
            niche_match_score: 100, // Legacy support
            classification_reason: classification.reason,
            classification_status: 'accepted',
            sms_ready_tier: 'Tier 1',
            _category: category,
            _sidePaneText: sidePaneText,
            _services: gbpServices,
            _reviews_text: gbpReviewsText,
          };

          const initialScore = scoreLead(lead);
          lead.intent = initialScore.intent_tag;
          lead.score = initialScore.score;

          if (lead.website) {
            const workerTask = async (data) => {
              if (data.isRejected) {
                 log(`🚫 Purging ${name} (Negative keyword on website)`, jobId);
                 updateJob(jobId, { enrichLead: { business_name: lead.business_name, isRejected: true } });
                 return;
              }


              // Update lead with email + re-scored intent
              const enriched = { ...lead, primary_email: data.primary || '' };
              if (data.primary) {
                const scoreResult = scoreLead(enriched);
                enriched.intent = scoreResult.intent_tag;
                enriched.score = scoreResult.score;
                log(`📧 Email for ${name}: ${data.primary}`, jobId);
              }
              if (data.primary || lead.niche_match_score !== enriched.niche_match_score) {
                updateJob(jobId, { enrichLead: enriched });
              }
            };
            
            if (mode === 'normal') {
              await workerPool.run(lead.website, workerTask, negWords);
            } else {
              const p = workerPool.run(lead.website, workerTask, negWords);
              workerPromises.add(p);
              p.finally(() => workerPromises.delete(p));
            }
          }

          allLeads.push(lead);
          updateJob(jobId, { leads: [lead] });
          
          // End of finding details
          const progress = Math.min(99, Math.floor(((sIdx * 100 + totalFoundInCity) / (subLocations.length * 100)) * 100));
          onProgress({ progress, city: subLoc });

        } catch (err) { log(`❌ Error: ${err.message}`, jobId); }
      }
      
      // Scroll to load the next batch
      if (getJob(jobId)?.stopFlag) break;
      if (foundNewInBatch) noNewCount = 0;
      else noNewCount++;
      
      const feedLocatorNode = page.locator('div[role="feed"]');
      if (await feedLocatorNode.count() > 0) {
          const beforeScrollCount = await listings.count();
          await feedLocatorNode.evaluate(el => el.scrollTop = el.scrollHeight).catch(() => {});
          
          // Flash Fast Dynamic Wait instead of rigid 2000ms
          // INCREASED TO 10000ms (10 seconds) to ensure heavy parallel CPU/network lag never skips leads
          let waited = 0;
          while (waited < 10000) { 
             await page.waitForTimeout(500);
             waited += 500;
             const afterCount = await listings.count();
             if (afterCount > beforeScrollCount) break; // Found new items quickly!
          }
          // KILL-SWITCH
          const afterCountFinal = await listings.count();
          if (afterCountFinal === beforeScrollCount) {
              log(`🛑 No new elements loaded after 10s. Force breaking scroll loop to prevent hanging...`, jobId);
              break;
          }
      } else {
          await page.waitForTimeout(1000);
      }
    }
      }
    } catch(err) {
      log(`❌ Sub-location ${subLoc} error: ${err.message}`, jobId);
    } finally {
      await page.close().catch(() => {});
    }
  };

  if (mode === 'parallel') {
      // Memory Optimization: Hard cap Maps page concurrency to 2 on 8GB RAM systems.
      const concurrency = Math.max(1, Math.min(parseInt(workerCount), 2));
      // Use a mutex-safe counter — JS is single-threaded but async interleaving
      // can cause two coroutines to read the same index before either increments.
      let currentIdx = job.lastProcessedIndex || 0;
      const getNextIdx = () => {
        const idx = currentIdx;
        currentIdx++;
        return idx;
      };
      const tasks = Array.from({ length: concurrency }, async () => {
          while (!getJob(jobId)?.stopFlag) {
              const idx = getNextIdx();
              if (idx >= subLocations.length) break;
              await processSubLocation(subLocations[idx], idx);
              
              if (idx < subLocations.length - 1 && !getJob(jobId)?.stopFlag) {
                  const delay = Math.floor(Math.random() * (15000 - 5000 + 1)) + 5000;
                  log(`⏱️ Human-like break: Pausing for ${Math.round(delay/1000)}s to prevent Google bot-detection...`, jobId);
                  await new Promise(r => setTimeout(r, delay));
              }
          }
      });
      await Promise.all(tasks);
  } else {
      const startIdx = job.lastProcessedIndex || 0;
      for (let sIdx = startIdx; sIdx < subLocations.length; sIdx++) {
         if (getJob(jobId)?.stopFlag) break;
         await processSubLocation(subLocations[sIdx], sIdx);
         
         if (sIdx < subLocations.length - 1 && !getJob(jobId)?.stopFlag) {
             const delay = Math.floor(Math.random() * (15000 - 5000 + 1)) + 5000;
             log(`⏱️ Human-like break: Pausing for ${Math.round(delay/1000)}s to prevent Google bot-detection...`, jobId);
             await new Promise(r => setTimeout(r, delay));
         }
      }
  }

  // Wait for background enrichment workers to finish BEFORE closing browser
  if (workerPromises.size > 0) {
      log(`⏳ Waiting for ${workerPromises.size} background email enrichment tasks to finish...`, jobId);
      await Promise.allSettled(Array.from(workerPromises));
  }

  log(`✅ Scan Finished. Total: ${allLeads.length}`, jobId);
  onProgress(100);
  await browser.close();
  await crawlBrowser.close().catch(() => {});
  return allLeads;
}

// =========================
// CSV ENRICHMENT ENGINE
// =========================
export async function enrichCSVList(leads, jobId, workerCount = 3, negativeKeywords = '', onProgress = () => {}) {
  const job = getJob(jobId);
  if (!job) return [];
  
  log(`🚀 Starting Email Enrichment for ${leads.length} leads...`, jobId);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const workerPool = new WebsiteWorkerPool(context, parseInt(workerCount));
  
  const negWords = (negativeKeywords || '')
      .toLowerCase()
      .split(',')
      .map(w => w.trim())
      .filter(w => w.length > 0);

  let completed = 0;
  
  const batchSize = parseInt(workerCount) || 3;
  
  await processInBatches(leads, batchSize, async (lead) => {
     if (!lead.website || getJob(jobId)?.stopFlag) {
        completed++;
        return;
     }

     return workerPool.run(lead.website, async (data) => {
        if (getJob(jobId)?.stopFlag) return;
        
        if (data.isRejected) {
           log(`🚫 Purging ${lead.business_name} (Negative keyword found on website)`, jobId);
           updateJob(jobId, { enrichLead: { business_name: lead.business_name, isRejected: true } });
           completed++;
           return;
        }

        const validatedEmail = data.primary || lead.primary_email;

        const enriched = {
           ...lead,
           primary_email: validatedEmail,
        };
        const scoreResult = scoreLead(enriched);
        enriched.intent = scoreResult.intent_tag;
        enriched.score = scoreResult.score;
        if (data.primary) log(`📧 Found Email for ${lead.business_name}: ${data.primary}`, jobId);
        updateJob(jobId, { enrichLead: enriched });
        completed++;
        onProgress({ progress: Math.floor((completed / leads.length) * 100), city: "Enriching Websites" });
     }, negWords);
  });
  
  log(`✅ Enrichment Complete. Processed: ${completed}`, jobId);
  
  if (!getJob(jobId)?.stopFlag) {
    onProgress(100);
  }
  
  await browser.close();
  return leads;
}

export async function filterCSVByGoogleCategory(leads, jobId, workerCount = 10, onProgress = () => {}) {
  const job = getJob(jobId);
  if (!job) return [];

  log(`🔍 Starting Google Category Filter — ${leads.length} leads, ${workerCount} parallel workers...`, jobId);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  // Shared route blocker for all pages in this context
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media'].includes(type)) return route.abort();
    return route.continue();
  });

  const kept = [];
  let completed = 0;
  // Shared atomic queue index — each worker atomically claims the next lead
  let queueIdx = 0;
  const getNext = () => {
    const idx = queueIdx;
    queueIdx++;
    return idx;
  };

  const runWorker = async () => {
    // Each worker gets its own persistent page — no page creation overhead per lead
    const page = await context.newPage();
    try {
      while (!getJob(jobId)?.stopFlag) {
        const idx = getNext();
        if (idx >= leads.length) break;
        const lead = leads[idx];

        let category = '';
        let sidePaneText = '';
        let finalMapsUrl = lead.maps_url || '';

        try {
          const isDirectUrl = lead.maps_url && (
            lead.maps_url.includes('google.com/maps') ||
            lead.maps_url.includes('maps.google.com') ||
            lead.maps_url.includes('/maps/place/')
          );

          if (isDirectUrl) {
            log(`📍 Going direct to Maps URL for: ${lead.business_name}`, jobId);
            await page.goto(lead.maps_url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForSelector('h1', { timeout: 4000 }).catch(() => {});

            // Extract category and full page text
            const details = await page.evaluate(() => {
              const catSelectors = [
                'button[jsaction*="category"]',
                'button.D75GSc',
                '.fontBodyMedium'
              ];
              let cat = '';
              for (const sel of catSelectors) {
                const el = document.querySelector(sel);
                if (el && el.innerText.trim().length > 1) {
                  cat = el.innerText.trim();
                  break;
                }
              }
              const mainEl = document.querySelector('div[role="main"]') || document.body;
              return {
                category: cat,
                text: mainEl ? mainEl.innerText : ''
              };
            }).catch(() => ({ category: '', text: '' }));

            category = details.category;
            sidePaneText = details.text;
          } else {
            // Search query fallback
            const query = `${lead.business_name} ${lead.city || lead.address || ''}`.trim();
            await page.goto(
              `https://www.google.com/maps/search/${encodeURIComponent(query)}`,
              { waitUntil: 'domcontentloaded', timeout: 12000 }
            );

            // Smart wait: poll for feed or direct load
            let feedReady = false;
            let directReady = false;
            for (let w = 0; w < 8; w++) {
              await page.waitForTimeout(250);
              const status = await page.evaluate(() => {
                const feed = document.querySelector('[role="feed"] a[href*="/maps/place/"]');
                const direct = !document.querySelector('[role="feed"]') && !!document.querySelector('h1');
                return { feed: !!feed, direct };
              }).catch(() => ({ feed: false, direct: false }));

              if (status.feed) { feedReady = true; break; }
              if (status.direct) { directReady = true; break; }
            }

            if (directReady) {
              const details = await page.evaluate(() => {
                const catSelectors = ['button[jsaction*="category"]', 'button.D75GSc'];
                let cat = '';
                for (const sel of catSelectors) {
                  const el = document.querySelector(sel);
                  if (el && el.innerText.trim().length > 1) { cat = el.innerText.trim(); break; }
                }
                const mainEl = document.querySelector('div[role="main"]') || document.body;
                return { category: cat, text: mainEl ? mainEl.innerText : '' };
              }).catch(() => ({ category: '', text: '' }));

              category = details.category;
              sidePaneText = details.text;
              finalMapsUrl = page.url();
            } else if (feedReady) {
              const cardData = await page.evaluate(() => {
                const feed = document.querySelector('[role="feed"]');
                if (!feed) return { text: '', mapsUrl: '' };
                const firstCard = feed.querySelector('a[href*="/maps/place/"]');
                const mapsUrl = firstCard ? firstCard.href : '';
                const firstItem = feed.firstElementChild;
                const cardText = firstItem ? firstItem.innerText : '';
                return { text: cardText, mapsUrl };
              }).catch(() => ({ text: '', mapsUrl: '' }));

              sidePaneText = cardData.text;
              finalMapsUrl = cardData.mapsUrl || lead.maps_url || '';
              
              // Extract category from card text (e.g. "Water damage restoration service · Address")
              const catMatch = sidePaneText.match(/(?:stars|\d\.\d)\s*(?:\([\d,]+\))?\s*·\s*([^·\n\r\t]+)/i);
              if (catMatch) {
                category = catMatch[1].trim();
              }
            } else {
              log(`⚠️ No results for: ${lead.business_name}`, jobId);
              completed++;
              onProgress({ progress: Math.floor((completed / leads.length) * 100), city: `Checked: ${lead.business_name}` });
              continue;
            }
          }

          // Classify using the same filter engine as the main scraper.
          // Use the job's actual niche keyword — not classification_reason which is a sentence.
          const jobNiche = getJob(jobId)?.niche || 'water damage restoration';
          const csvClassification = classifyLead(
            { name: lead.business_name, categories: [category, sidePaneText].filter(Boolean) },
            jobNiche,
            false
          );

          if (csvClassification.status === 'KEEP') {
            log(`✅ KEPT: ${lead.business_name} (Category: "${category || 'Unknown'}")`, jobId);
            const enriched = {
              ...lead,
              maps_url: finalMapsUrl,
              classification_reason: csvClassification.reason,
              classification_status: 'accepted',
            };
            kept.push(enriched);
            updateJob(jobId, { leads: [enriched] });
          } else {
            log(`❌ DROPPED: ${lead.business_name} — ${csvClassification.reason}`, jobId);
          }
        } catch (err) {
          log(`⚠️ Error on ${lead.business_name}: ${err.message?.slice(0, 60)}`, jobId);
        }

        completed++;
        onProgress({
          progress: Math.floor((completed / leads.length) * 100),
          city: `${completed}/${leads.length} checked — ${kept.length} restoration`
        });
      }
    } finally {
      await page.close().catch(() => {});
    }
  };

  // Launch all workers simultaneously
  const workers = Array.from({ length: Math.min(workerCount, leads.length) }, () => runWorker());
  await Promise.allSettled(workers);

  await browser.close();
  log(`✅ Filter done — ${kept.length} restoration leads kept from ${leads.length} total`, jobId);
  onProgress(100);
  return kept;
}
