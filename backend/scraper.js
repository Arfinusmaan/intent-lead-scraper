import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";
chromium.use(stealthPlugin());

import { log, processInBatches } from "./utils.js";
import { getSubLocations } from "./cityService.js";
import { getJob, updateJob, setPauseFlag } from "./store.js";
import { scoreLead } from "./intentScorer.js";

function isSharedPlatform(domain) {
  if (!domain) return false;
  const shared = [
    'facebook.com', 'instagram.com', 'yelp.com', 'google.com', 'twitter.com', 
    'linkedin.com', 'youtube.com', 'manta.com', 'yellowpages.com', 'foursquare.com',
    'mapquest.com', 'tripadvisor.com', 'groupon.com', 'angis.com', 'homeadvisor.com'
  ];
  return shared.some(s => domain.includes(s));
}

export function isNicheAligned(niche, businessName, category, sidePaneText) {
  const cleanNiche = niche.toLowerCase().trim();
  const cleanName = businessName.toLowerCase();
  const cleanCategory = (category || '').toLowerCase();
  const cleanText = (sidePaneText || '').toLowerCase();

  // =========================
  // 1. RESTORATION (Property Damage only — water, fire, flood, mold)
  // =========================
  if (cleanNiche.includes('restoration') || cleanNiche.includes('water damage') ||
      cleanNiche.includes('fire damage') || cleanNiche.includes('mold')) {

    // --- STEP 1: HARD BLOCK by name or category ---
    // These indicate clearly non-property businesses — reject immediately.
    const hardBlockName = [
      'auto ', 'automotive', 'car ', 'vehicle', 'motorcycle', 'boat ', 'marine ',
      'furniture', 'upholstery', 'antique', 'art ', 'artwork', 'canvas',
      'book ', 'paper ', 'photo', 'photograph', 'watch', 'clock', 'jewelry', 'jewellery',
      'leather', 'shoe ', 'boot ', 'clothing', 'textile', 'fabric',
      'dental', 'teeth', 'tooth', 'hair ', 'salon', 'spa ',
      'body shop', 'collision', 'transmission',
      'computer', 'electronics', 'screen repair', 'phone repair',
      'food ', 'kitchen', 'restaurant', 'catering',
      'lawn ', 'garden', 'landscap',
      'pool ', 'pest ', 'janitorial',
      'roofing', 'roofer', 'gutter', 'siding', 'masonry', 'chimney', 'brick',
      'plumbing', 'hvac', 'electrical', 'electrician', 'flooring',
      'painting', 'painter', 'remodel', 'remodeling', 'renovation',
      'excavat', 'septic', 'well drill', 'insulation', 'handyman',
      'tree service', 'arborist', 'towing', 'locksmith', 'moving'
    ];
    const hardBlockCategory = [
      'auto body shop', 'auto repair', 'car repair', 'collision', 'motorcycle',
      'furniture store', 'antique store', 'art gallery', 'art restoration',
      'painting', 'painter', 'roofing', 'roofer', 'gutter', 'masonry',
      'plumber', 'plumbing', 'hvac', 'electrician', 'electrical contractor',
      'flooring', 'remodeler', 'general contractor', 'home builder',
      'landscaping', 'lawn care', 'tree service', 'pest control',
      'janitorial', 'cleaning service', 'pressure washing',
      'dental', 'hair salon', 'nail salon', 'spa', 'massage',
      'restaurant', 'food', 'hotel', 'bed & breakfast', 'inn',
      'excavating', 'septic', 'insulation contractor', 'well drilling',
      'handyman', 'towing', 'locksmith', 'moving', 'storage',
      'real estate', 'property management', 'home inspector',
      'auto parts', 'tire', 'transmission', 'engine repair',
      'electronics', 'phone repair', 'computer repair',
      'brewery', 'winery', 'distillery', 'coffee shop', 'bakery',
      'gym', 'fitness', 'yoga', 'counselor', 'therapist',
      'non-profit', 'government', 'school', 'church',
      'truck repair', 'farm', 'agricultural', 'logging'
    ];
    if (hardBlockName.some(kw => cleanName.includes(kw))) return false;
    if (hardBlockCategory.some(kw => cleanCategory.includes(kw))) return false;

    // --- STEP 2: GOOGLE CATEGORY — PRIMARY SIGNAL ---
    // If Google Maps assigned a category, trust it fully.
    // Only these exact restoration-related categories are accepted.
    const ACCEPTED_CATEGORIES = [
      'water damage restoration',
      'fire damage restoration',
      'mold remediation',
      'mold removal',
      'flood restoration',
      'smoke damage restoration',
      'storm damage restoration',
      'disaster restoration',
      'disaster recovery',
      'restoration service',
      'remediation service',
      'water mitigation',
      'fire restoration',
      'environmental remediation',
      'biohazard remediation'   // biohazard is adjacent/acceptable
    ];
    if (cleanCategory.length > 0) {
      // Category is present — it's the authoritative Google signal.
      // If it matches an accepted restoration category → KEEP
      if (ACCEPTED_CATEGORIES.some(kw => cleanCategory.includes(kw))) return true;
      // Category is present but is NOT a restoration category → REJECT
      // This eliminates: guitar stores, general contractors, repair services, etc.
      return false;
    }

    // --- STEP 3: NO CATEGORY LOADED — fall back to name + pane text signals ---
    // Only reach here if Google Maps didn't provide a category (rare).

    // Known franchise brands that are always property restoration
    const BRAND_SIGNALS = [
      'servpro', 'belfor', 'servicemaster', 'paul davis', 'rainbow restoration',
      'steamatic', '911 restoration', 'bnr restoration', 'puroclean',
      'first onsite', 'rytech', 'lemarg', 'restoration 1'
    ];
    if (BRAND_SIGNALS.some(kw => cleanName.includes(kw))) return true;

    // Name must include a SPECIFIC property-damage term (not just "restoration")
    const STRONG_NAME_SIGNALS = [
      'water damage', 'fire damage', 'mold remediation', 'mold removal',
      'flood damage', 'flood restoration', 'smoke damage', 'storm damage',
      'disaster restoration', 'disaster recovery', 'remediation',
      'mitigation'
    ];
    if (STRONG_NAME_SIGNALS.some(kw => cleanName.includes(kw))) return true;

    // Pane text loaded — must contain SPECIFIC property damage terms (not just "restoration")
    if (cleanText.length > 50) {
      const PANE_DAMAGE_SIGNALS = [
        'water damage', 'fire damage', 'mold', 'flood damage', 'smoke damage',
        'storm damage', 'remediation', 'mitigation'
      ];
      // "restoration" alone is NOT enough — car/art restoration also uses that word
      return PANE_DAMAGE_SIGNALS.some(kw => cleanText.includes(kw));
    }

    // No category, no pane, no strong name signal → REJECT
    return false;
  }

  // =========================
  // 2. Med Spa
  // =========================
  if (cleanNiche.includes('med spa') || cleanNiche.includes('medspa') || cleanNiche.includes('medical spa')) {
    const reject = [
      'massage parlour', 'massage therapist', 'thai massage', 'foot massage', 'reflexology',
      'nail salon', 'hair salon', 'barber', 'chiropractor'
    ];
    if (reject.some(kw => cleanCategory.includes(kw) || cleanName.includes(kw))) return false;
    if (cleanCategory.includes('massage') || cleanName.includes('massage')) {
      const medTerms = ['medical', 'med', 'aesthetic', 'laser', 'clinic', 'plastic', 'dermatology', 'skin'];
      if (!medTerms.some(t => cleanCategory.includes(t) || cleanName.includes(t))) return false;
    }
    return true;
  }

  // =========================
  // 3. Roofing
  // =========================
  if (cleanNiche.includes('roofing') || cleanNiche.includes('roofer')) {
    const reject = ['roof bar', 'restaurant', 'hotel', 'lounge', 'rooftop', 'roof top'];
    if (reject.some(kw => cleanName.includes(kw) || cleanCategory.includes(kw))) return false;
    return true;
  }

  // =========================
  // 4. Generic fallback
  // =========================
  const noiseWords = new Set(['in', 'service', 'services', 'company', 'and', 'near', 'me', 'the', 'of', 'for', 'a', 'an', 'agency', 'firm']);
  const nicheWords = cleanNiche.split(/\s+/).filter(w => w.length > 2 && !noiseWords.has(w));
  
  if (nicheWords.length > 0) {
    // If ANY of the core niche words appear in the business name or Google category, keep it
    if (nicheWords.some(w => cleanName.includes(w) || cleanCategory.includes(w))) {
      return true;
    }
    
    // If the Google side pane text loaded, check if the niche words appear there
    if (cleanText.length > 20) {
      if (nicheWords.some(w => cleanText.includes(w))) return true;
      return false; // Pane loaded, but no niche words found
    }
    
    // If pane didn't load, and name/category didn't match, REJECT. 
    // Do not blindly accept just because it failed to load.
    return false;
  }

  // If the user's search was literally just noise words (e.g., "company"), accept it
  return true;
}

// Normalize phone numbers — strip everything except digits and leading +
function cleanPhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return '';
  return phone.replace(/[^\d+\-()\s]/g, '').trim();
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
    // RAM SAVER: Block images, media, fonts, stylesheets & icons
    // =========================
    const blockRoute = async (page) => {
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        const url = route.request().url();
        // Block heavy/decorative resources — scripts needed for modern sites
        if (['image', 'media', 'font', 'stylesheet'].includes(type)) return route.abort();
        // Block icon/analytics CDNs that add zero value
        if (url.includes('googletagmanager') || url.includes('google-analytics') ||
            url.includes('hotjar') || url.includes('intercom') || url.includes('typekit') ||
            url.includes('fonts.googleapis') || url.includes('fonts.gstatic')) {
          return route.abort();
        }
        return route.continue();
      });
    };

    let pagesToVisit = [website];
    let homePage;
    try {
      homePage = await this.context.newPage();
      await blockRoute(homePage);
      await homePage.goto(website, { timeout: 8000, waitUntil: "domcontentloaded" });
      
      const html = await homePage.content();
      const text = await homePage.evaluate(() => document.body?.innerText || '');
      
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

    // Limit to top 4 pages total (home + about + contact + appointment)
    pagesToVisit = [...new Set(pagesToVisit)].slice(0, 4);
    
    for (const url of pagesToVisit.slice(1)) {
        let p;
        try {
            p = await this.context.newPage();
            await blockRoute(p);
            await p.goto(url, { timeout: 6000, waitUntil: "domcontentloaded" });
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
    
    return { primary, secondary: emails.filter(e => e !== primary) };
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
function expandNicheToQueries(niche) {
  const n = niche.toLowerCase().trim();

  // RESTORATION — expand into specific damage/remediation types
  if (n.includes('restoration') || n.includes('water damage') ||
      n.includes('fire damage') || n.includes('mold') ||
      n.includes('flood') || n.includes('remediation')) {
    return [
      'water damage restoration',
      'fire damage restoration',
      'mold remediation',
      'flood damage restoration',
      'smoke damage restoration',
    ];
  }

  // MED SPA — prevent returning massage spas
  if (n.includes('med spa') || n.includes('medspa') || n.includes('medical spa')) {
    return ['medical spa', 'aesthetic clinic', 'laser skin clinic', 'botox clinic', 'cosmetic clinic'];
  }

  // ROOFING — specific
  if (n.includes('roofing') || n.includes('roofer')) {
    return ['roofing contractor', 'roof repair company'];
  }

  // Default: return the niche as-is (no expansion)
  return [niche];
}

export async function scrapeGoogleMaps(niche, location, filterType, negativeKeywords, jobId, mode = 'hybrid', workerCount = 3, onProgress = () => {}) {
  const job = getJob(jobId);
  if (!job) return [];

  const browser = await chromium.launch({ headless: false, args: ['--window-size=1920,1080'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const workerPool = new WebsiteWorkerPool(context, parseInt(workerCount));

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
    const page = await context.newPage();
    
    // =========================
    // SPEED: Aggressively block all non-essential resources on Google Maps
    // Kills: images, icons, map tiles, earth imagery, Street View, stylesheets,
    // fonts, analytics, tracking, and Google's own CDN decoration.
    // =========================
    await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        const url = route.request().url();

        // Block by resource type
        if (['image', 'media', 'font', 'stylesheet'].includes(type)) return route.abort();

        // Block Google's CDN hosts for tiles, earth imagery, Street View, icons
        const blockedHosts = [
          'maps.gstatic.com',        // Map tile sprites & icons
          'khm.googleapis.com',      // Earth/satellite imagery
          'mt0.googleapis.com',      // Map tiles
          'mt1.googleapis.com',
          'mt2.googleapis.com',
          'mt3.googleapis.com',
          'geo0.ggpht.com',          // Street View imagery
          'geo1.ggpht.com',
          'geo2.ggpht.com',
          'geo3.ggpht.com',
          'lh3.googleusercontent.com', // Business photos
          'lh4.googleusercontent.com',
          'lh5.googleusercontent.com',
          'streetviewpixels-pa.googleapis.com',
          'fonts.googleapis.com',
          'fonts.gstatic.com',
          'googletagmanager.com',
          'google-analytics.com',
          'analytics.google.com',
          'doubleclick.net',
          'googlesyndication.com',
          'adservice.google.com',
          'hotjar.com',
          'intercom.io',
          'clarity.ms',
          'facebook.net',
          'connect.facebook.net',
        ];
        if (blockedHosts.some(h => url.includes(h))) return route.abort();

        return route.continue();
    });
    
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
          log(`🛑 CAPTCHA DETECTED! Pausing Engine automatically...`, jobId);
          setPauseFlag(jobId, true);
          updateJob(jobId, { currentCity: "PAUSED: Captcha Action Required" });
          // Wait safely until the user manually hits 'Resume'
          while (getJob(jobId)?.pauseFlag) {
             await new Promise(r => setTimeout(r, 2000));
          }
          log(`▶️ Engine Resumed after Captcha!`, jobId);
          // Refresh the page now that it's solved
          await page.reload({ waitUntil: 'domcontentloaded' });
      }

      try {
        const rejectBtn = page.locator('button:has-text("Reject"), button:has-text("Accept")').first();
        if (await rejectBtn.count()) await rejectBtn.click();
      } catch {}

      await page.waitForSelector('div[role="feed"]', { timeout: 5000 }).catch(() => {});
      
      let noNewCount = 0;
      let lastPaneTitle = "";
      let totalFoundInCity = 0;

      while (noNewCount < 6 && !getJob(jobId)?.stopFlag) {
          const feedLocator = page.locator('div[role="feed"]');
          if (await feedLocator.count() === 0) break; // Check if the feed exists before scrolling
          
          const listings = feedLocator.locator('a[href*="/place"]');
          const batchCount = await listings.count();
          let foundNewInBatch = false;

          // negWords already parsed once at the top of scrapeGoogleMaps

          for (let i = 0; i < batchCount; i++) {
              await checkPause(jobId);
              if (getJob(jobId)?.stopFlag) break;
              
              let name = "";
              let item;
              try {
                 item = listings.nth(i);
                 name = await item.getAttribute("aria-label");
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
                      await targetItem.scrollIntoViewIfNeeded(); 
                      await page.waitForTimeout(100); 
                  } catch {}
                  
                  try {
                     await targetItem.click({ timeout: 1500 });
                  } catch {
                     try { 
                         // Robust fallback click using JS to bypass any visible overlay
                         await targetItem.evaluate(node => node.click()); 
                     } catch {
                         try { await targetItem.focus(); await page.keyboard.press('Enter'); } catch {}
                     }
                  }

          let paneFound = false;
          for (let attempt = 0; attempt < 25; attempt++) {
              if (attempt === 5 && !paneFound) {
                  // Force a fast fallback click if Google Maps ignored it
                  try { await targetItem.focus(); await page.keyboard.press('Enter'); } catch {}
              }

              // Broader selector set — Google Maps changes class names frequently
              const paneTitle = await page.evaluate(() => {
                  // Try known class names first, then fall back to any visible h1 inside the detail pane
                  const selectors = [
                    'h1.DUwDvf',
                    'h1.fontHeadlineLarge', 
                    '[role="main"] h1',
                    'div[aria-label] h1',
                    'h1'
                  ];
                  for (const sel of selectors) {
                    const els = Array.from(document.querySelectorAll(sel));
                    const visible = els.find(el => el.offsetParent !== null && el.innerText.trim().length > 1);
                    if (visible) return visible.innerText.trim();
                  }
                  return '';
              }).catch(() => '');
              
              if (paneTitle && paneTitle !== lastPaneTitle) {
                  paneFound = true;
                  lastPaneTitle = paneTitle;
                  break;
              }

              // Franchise/chain fallback: pane title matches our target name
              // even if it's the same text as lastPaneTitle (two branches of same chain)
              const paneLower = paneTitle.toLowerCase().trim();
              const nameLower = name.toLowerCase().trim();
              const nameAnchor = nameLower.split(/\s+/).slice(0, 3).join(' ');
              if (paneTitle && attempt > 2 && (
                nameLower.includes(paneLower) || paneLower.includes(nameLower) || paneLower.includes(nameAnchor)
              )) {
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

          // Capture Google Maps URL now that the place pane is open
          const mapsUrl = page.url();
          
          // CRITICAL FIX: Locate the active, visible side pane container
          let sidePane = null;
          try {
              const escapedName = name.replace(/"/g, '\\"');
              const exactPane = page.locator(`div[role="main"][aria-label="${escapedName}"]`).first();
              if (await exactPane.count() > 0 && await exactPane.isVisible()) {
                  sidePane = exactPane;
              } else {
                  const panes = page.locator('div[role="main"]');
                  const count = await panes.count();
                  for (let k = 0; k < count; k++) {
                      const p = panes.nth(k);
                      if (await p.isVisible()) {
                          sidePane = p;
                          break;
                      }
                  }
              }
          } catch {}
          if (!sidePane) {
              sidePane = page.locator('div[role="main"]').first();
          }

          // CRITICAL FIX: Avoid grabbing stale details from previous pane.
          // If the phone, website or address is exactly identical to the previous scraped lead,
          // it is extremely likely that the pane hasn't updated yet. We wait and re-read.
          let phone = "";
          let website = "";
          let address = "";
          let detailsUpdated = false;

          for (let attempt = 0; attempt < 8; attempt++) {
              phone = await sidePane.locator('button[data-item-id^="phone:tel:"]').first().textContent({ timeout: 500 }).catch(() => "");
              website = await sidePane.locator('a[data-item-id="authority"]').first().getAttribute("href", { timeout: 500 }).catch(() => "");
              address = await sidePane.locator('button[data-item-id="address"]').first().textContent({ timeout: 500 }).catch(() => "");

              const phoneClean = cleanPhone(phone).replace(/[^\d]/g, '');
              const websiteClean = website ? website.toLowerCase().trim().replace('www.', '') : '';
              const addrClean = (address || '').trim();

              // Only consider stale if BOTH phone AND website match the previous lead
              // (address alone is too unreliable — offices share buildings)
              const phoneStale = phoneClean && lastScrapedDetails && phoneClean === lastScrapedDetails.phone.replace(/[^\d]/g, '');
              const websiteStale = websiteClean && lastScrapedDetails && websiteClean === lastScrapedDetails.website.toLowerCase().trim().replace('www.', '');

              if (phoneStale && websiteStale) {
                  await page.waitForTimeout(300);
              } else {
                  detailsUpdated = true;
                  break;
              }
          }

          let rating = '';
          let reviews = '';
          let sidePaneText = '';
          let category = '';

          try {
            sidePaneText = await sidePane.textContent({ timeout: 500 }).catch(() => "");
            
            // Extract category robustly
            category = await sidePane.locator('button[jsaction*="category"]').first().textContent({ timeout: 300 }).catch(() => "");
            if (!category) {
                category = await sidePane.locator('button.D75GSc').first().textContent({ timeout: 300 }).catch(() => "");
            }
            if (!category) {
                const match = sidePaneText.match(/(?:stars|\d\.\d)\s*(?:\([\d,]+\))?\s*·\s*([^·\n\r\t]+)/i);
                if (match) {
                    category = match[1].trim();
                }
            }

            const ratingData = await sidePane.evaluate((pane) => {
              // Try common classes first
              const ratingEl = pane.querySelector('span.MW4etd, .ceaeq');
              const reviewEl = pane.querySelector('span.UY7F9, .dK32cf');
              
              if (ratingEl && reviewEl) {
                return { 
                  r: ratingEl.innerText.trim(), 
                  v: reviewEl.innerText.replace(/[^\d]/g, '') 
                };
              }

              // Fallback 1: aria-label on star button
              const starBtn = pane.querySelector('button[aria-label*="star"]');
              if (starBtn) {
                const label = starBtn.getAttribute('aria-label');
                const rMatch = label.match(/([\d.]+)\s*star/i);
                const vMatch = label.match(/([\d,]+)\s*(?:rating|review)/i);
                if (rMatch && vMatch) {
                   return { r: rMatch[1], v: vMatch[1].replace(/,/g, '') };
                }
              }

              // Fallback 2: Regex on the main visible text
              const text = pane.innerText;
              const rMatch = text.match(/(?:^|\n)([\d.]+)\s*\n?\s*\(([\d,]+)\)/);
              if (rMatch) {
                 return { r: rMatch[1], v: rMatch[2].replace(/,/g, '') };
              }

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
          if (websiteCleanKey && processedWebsites.has(websiteCleanKey) && !isSharedPlatform(websiteCleanKey)) {
              log(`⏭️ Skipping ${name} (Duplicate website: ${website})`, jobId);
              continue;
          }

          // STRICT NICHE ALIGNMENT CHECK
          if (!isNicheAligned(niche, name, category, sidePaneText)) {
              log(`⏭️ Skipping ${name} (Not aligned with niche: "${niche}" | Category: "${category || 'Unknown'}")`, jobId);
              continue;
          }

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
            score: 0
          };

          const initialScore = scoreLead(lead);
          lead.intent = initialScore.intent_tag;
          lead.score = initialScore.score;

          if (lead.website) {
            const workerTask = async (data) => {
              if (data.isRejected) {
                 log(`🚫 Purging ${name} (Negative keyword found on their website!)`, jobId);
                 updateJob(jobId, { enrichLead: { business_name: lead.business_name, isRejected: true } });
                 return;
              }

              if (data.primary) {
                // Store email immediately — no SMTP verification (blocks workers 5-10s, usually ISP-blocked)
                const enriched = {
                  ...lead,
                  primary_email: data.primary,
                };
                const scoreResult = scoreLead(enriched);
                enriched.intent = scoreResult.intent_tag;
                enriched.score = scoreResult.score;
                log(`📧 Found Email for ${name}: ${data.primary}`, jobId);
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
          let waited = 0;
          while (waited < 4000) { // Max 4s wait for slow connections
             await page.waitForTimeout(300);
             waited += 300;
             const afterCount = await listings.count();
             if (afterCount > beforeScrollCount) break; // Found new items quickly!
          }
      } else {
          await page.waitForTimeout(1000);
      }
    }
      }
    } catch(err) {
      log(`❌ Sub-location ${subLoc} error: ${err.message}`, jobId);
    } finally {
      await page.close();
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
          }
      });
      await Promise.all(tasks);
  } else {
      const startIdx = job.lastProcessedIndex || 0;
      for (let sIdx = startIdx; sIdx < subLocations.length; sIdx++) {
         if (getJob(jobId)?.stopFlag) break;
         await processSubLocation(subLocations[sIdx], sIdx);
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
    const url = route.request().url();

    // Block by resource type
    if (['image', 'media', 'font', 'stylesheet'].includes(type)) return route.abort();

    // Block Google's CDN hosts for tiles, earth imagery, Street View, icons
    const blockedHosts = [
      'maps.gstatic.com',        // Map tile sprites & icons
      'khm.googleapis.com',      // Earth/satellite imagery
      'mt0.googleapis.com',      // Map tiles
      'mt1.googleapis.com',
      'mt2.googleapis.com',
      'mt3.googleapis.com',
      'geo0.ggpht.com',          // Street View imagery
      'geo1.ggpht.com',
      'geo2.ggpht.com',
      'geo3.ggpht.com',
      'lh3.googleusercontent.com', // Business photos
      'lh4.googleusercontent.com',
      'lh5.googleusercontent.com',
      'streetviewpixels-pa.googleapis.com',
      'fonts.googleapis.com',
      'fonts.gstatic.com',
      'googletagmanager.com',
      'google-analytics.com',
      'analytics.google.com',
      'doubleclick.net',
      'googlesyndication.com',
      'adservice.google.com',
      'hotjar.com',
      'intercom.io',
      'clarity.ms',
      'facebook.net',
      'connect.facebook.net',
    ];
    if (blockedHosts.some(h => url.includes(h))) return route.abort();

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

          // Use the exact same ruleset as scraping to validate
          const isAligned = isNicheAligned('restoration', lead.business_name, category, sidePaneText);

          if (isAligned) {
            log(`✅ KEPT: ${lead.business_name} (Category: "${category || 'Unknown'}")`, jobId);
            const enriched = { ...lead, maps_url: finalMapsUrl };
            kept.push(enriched);
            updateJob(jobId, { leads: [enriched] });
          } else {
            log(`❌ DROPPED: ${lead.business_name} (Category: "${category || 'Unknown'}")`, jobId);
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
