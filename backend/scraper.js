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

function isNicheAligned(niche, businessName, category, sidePaneText) {
  const cleanNiche = niche.toLowerCase().trim();
  const cleanName = businessName.toLowerCase();
  const cleanCategory = (category || '').toLowerCase();
  const cleanText = (sidePaneText || '').toLowerCase();

  // 1. Restoration — water/fire/flood/mold damage only. No cleaning, auto, art, etc.
  if (cleanNiche.includes('restoration') || cleanNiche.includes('water damage') || cleanNiche.includes('fire damage') || cleanNiche.includes('mold') || cleanNiche.includes('flood')) {
    // Hard block: non-property restoration types
    const hardBlock = [
      'car ', 'auto ', 'vehicle', 'furniture', 'book ', 'art ', 'watch', 'pen ', 'antique',
      'leather', 'classic car', 'engine', 'motor', 'cycle', 'collision',
      'body shop', 'transmission', 'upholstery', 'dental', 'teeth', 'hair',
      // Block cleaning companies that aren't damage restoration
      'maid', 'janitorial', 'house cleaning', 'home cleaning', 'office cleaning',
      'commercial cleaning', 'residential cleaning', 'cleaning service', 'cleaning company',
      'pressure wash', 'window clean', 'gutter clean', 'pool clean', 'chimney clean'
    ];
    if (hardBlock.some(kw => cleanName.includes(kw) || cleanCategory.includes(kw))) {
      return false;
    }

    // Block if the category is purely "cleaning" with no damage/restoration context
    if ((cleanCategory.includes('cleaning') || cleanCategory.includes('cleaner')) &&
        !cleanCategory.includes('restoration') && !cleanCategory.includes('remediation') &&
        !cleanCategory.includes('damage') && !cleanCategory.includes('mold') &&
        !cleanCategory.includes('flood') && !cleanCategory.includes('fire') &&
        !cleanCategory.includes('water damage') && !cleanCategory.includes('disaster')) {
      return false;
    }

    // Strong match — accept immediately
    const strongMatch = [
      'water damage', 'fire damage', 'mold', 'remediation', 'restoration',
      'flood', 'emergency service', 'mitigation', 'disaster', 'sewage', 'smoke damage'
    ];
    if (strongMatch.some(kw => cleanName.includes(kw) || cleanCategory.includes(kw))) {
      return true;
    }

    // Looser fallback — sidePaneText may mention the keyword
    const allowed = [
      'contractor', 'construction', 'builder', 'renovation',
      'roofing', 'plumbing', 'damage', 'dryer vent'
    ];
    if (cleanText.length > 0 && allowed.some(kw => cleanText.includes(kw))) {
      return true;
    }

    // If sidePaneText is empty, give benefit of the doubt
    if (!cleanText) return true;
    return false;
  }

  // 2. Med Spa — aesthetic/medical clinics only. No massage parlors, day spas, wellness spas.
  if (cleanNiche.includes('med spa') || cleanNiche.includes('medspa') || cleanNiche.includes('medical spa') || cleanNiche.includes('aesthetic')) {
    // Hard block: non-medical spa types
    const hardBlock = [
      'massage parlour', 'massage therapist', 'thai massage', 'foot massage', 'reflexology',
      'nail salon', 'hair salon', 'barber', 'chiropractor',
      'day spa', 'wellness spa', 'relaxation spa', 'resort spa', 'hotel spa',
      'spa & salon', 'salon & spa', 'beauty salon', 'tanning salon'
    ];
    if (hardBlock.some(kw => cleanCategory.includes(kw) || cleanName.includes(kw))) {
      return false;
    }

    // Block any generic "spa" or "massage" that doesn't have medical/aesthetic terms
    const medicalTerms = ['medical', 'med ', 'medspa', 'aesthetic', 'laser', 'clinic', 'plastic', 'dermatology', 'skin', 'botox', 'filler', 'injectable', 'cosmetic'];
    if (cleanCategory.includes('massage') || cleanName.includes('massage') ||
        cleanCategory.includes('day spa') || cleanName.includes('day spa') ||
        cleanCategory.includes('spa') || cleanName.includes('spa')) {
      if (!medicalTerms.some(term => cleanCategory.includes(term) || cleanName.includes(term) || cleanText.includes(term))) {
        return false;
      }
    }

    return true;
  }

  // 3. Roofing
  if (cleanNiche.includes('roofing') || cleanNiche.includes('roofer')) {
    const disallowed = ['roof bar', 'restaurant', 'hotel', 'lounge', 'rooftop', 'roof top'];
    if (disallowed.some(kw => cleanName.includes(kw) || cleanCategory.includes(kw))) {
      return false;
    }
    return true;
  }

  // 4. General fallback — match any niche word in name, category, OR pane text
  const noiseWords = new Set(['in', 'service', 'services', 'company', 'and', 'near', 'me', 'the', 'of', 'for', 'a', 'an']);
  const nicheWords = cleanNiche.split(/\s+/).filter(w => w.length > 2 && !noiseWords.has(w));

  if (nicheWords.length > 0) {
    const matched = nicheWords.some(w =>
      cleanName.includes(w) || cleanCategory.includes(w) || cleanText.includes(w)
    );
    // If sidePaneText is empty, only check name/category — don't reject solely because text is missing
    if (!matched && cleanText) return false;
  }

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
    // RAM SAVER: Block images, media, fonts & icons
    // =========================
    const blockRoute = async (page) => {
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        const url = route.request().url();
        // Block heavy/decorative resources — scripts needed for modern sites
        if (['image', 'media', 'font'].includes(type)) return route.abort();
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

export async function scrapeGoogleMaps(niche, location, filterType, negativeKeywords, jobId, mode = 'hybrid', workerCount = 3, onProgress = () => {}) {
  const job = getJob(jobId);
  if (!job) return [];

  const browser = await chromium.launch({ headless: false, args: ['--window-size=1920,1080'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const workerPool = new WebsiteWorkerPool(context, parseInt(workerCount));

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
    // SPEED: Block images, media, fonts on Google Maps page
    // =========================
    await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        const url = route.request().url();
        if (['image', 'media', 'font'].includes(type)) return route.abort();
        if (url.includes('googletagmanager') || url.includes('google-analytics') ||
            url.includes('fonts.googleapis') || url.includes('fonts.gstatic')) {
          return route.abort();
        }
        return route.continue();
    });
    
    try {
      const query = `${niche} in ${subLoc}`;
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
              
              // Early name-level skip for Restoration — block cleaning companies before clicking
              if (lowerNiche.includes('restoration') || lowerNiche.includes('water damage') || lowerNiche.includes('fire damage') || lowerNiche.includes('mold') || lowerNiche.includes('flood')) {
                  const cleaningNames = ['maid', 'janitorial', 'house cleaning', 'home cleaning', 'office cleaning', 'commercial cleaning', 'residential cleaning', 'cleaning service', 'pressure wash', 'window clean', 'gutter clean', 'pool clean', 'chimney clean'];
                  if (cleaningNames.some(kw => lowerName.includes(kw))) {
                      log(`⏭️ Skipping ${name} (Cleaning company in Restoration search)`, jobId);
                      continue;
                  }
              }

              // Early name-level skip for Med Spa — block massage, day spa, wellness spa before clicking
              if (lowerNiche.includes('med spa') || lowerNiche.includes('medspa') || lowerNiche.includes('medical spa') || lowerNiche.includes('aesthetic')) {
                  const medicalTerms = ['med', 'medical', 'aesthetic', 'laser', 'clinic', 'plastic', 'dermatology', 'skin', 'botox', 'filler', 'injectable', 'cosmetic'];
                  const genericSpaNames = ['massage', 'day spa', 'wellness spa', 'relaxation spa', 'resort spa', 'hotel spa', 'thai spa', 'nail salon', 'hair salon', 'tanning salon', 'beauty salon', 'spa & salon', 'salon & spa'];
                  if (genericSpaNames.some(kw => lowerName.includes(kw))) {
                      if (!medicalTerms.some(term => lowerName.includes(term))) {
                          log(`⏭️ Skipping ${name} (Non-medical spa/massage in Med Spa search)`, jobId);
                          continue;
                      }
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
          for (let attempt = 0; attempt < 45; attempt++) {
              if (attempt === 5 && !paneFound) {
                  try { await targetItem.evaluate(node => node.click()); } catch {}
              }
              if (attempt === 15 && !paneFound) {
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

            const parsed = await sidePane.evaluate((pane) => {
               let r = '', v = '';
               // 1. Try modern layout (div.F7nice)
               const f7 = pane.querySelector('div.F7nice');
               if (f7) {
                   const rSpan = f7.querySelector('span[aria-hidden="true"]');
                   if (rSpan) r = rSpan.innerText.trim();
                   
                   const vSpan = f7.querySelector('span[aria-label*="review"]') || f7.querySelector('span[aria-label*="rating"]');
                   if (vSpan) {
                       const match = vSpan.getAttribute('aria-label').match(/([\d,]+)/);
                       if (match) v = match[1].replace(/,/g, '');
                   }
               }
               // 2. Try aria-labels directly
               if (!r) {
                  const labelSpan = pane.querySelector('span[aria-label*="stars"]') || pane.querySelector('div[aria-label*="stars"]');
                  if (labelSpan) {
                     const label = labelSpan.getAttribute('aria-label');
                     const rMatch = label.match(/([\d.]+)\s*star/i);
                     const vMatch = label.match(/([\d,]+)\s*(?:rating|review)/i);
                     if (rMatch) r = rMatch[1];
                     if (vMatch) v = vMatch[1].replace(/,/g, '');
                  }
               }
               // 3. Try old class names
               if (!r) {
                  const mw4 = pane.querySelector('span.MW4etd');
                  if (mw4) r = mw4.innerText.trim();
                  const uy = pane.querySelector('span.UY7F9');
                  if (uy) v = uy.innerText.replace(/[^\d]/g, '');
               }
               return { r, v };
            }).catch(() => ({ r: '', v: '' }));
            
            if (parsed.r) rating = parsed.r;
            if (parsed.v) reviews = parsed.v;
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
