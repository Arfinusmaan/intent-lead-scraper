import { chromium } from "playwright";
import { log, processInBatches } from "./utils.js";
import { getSubLocations } from "./cityService.js";
import { getJob, updateJob, setPauseFlag } from "./store.js";
import { extractDecisionMaker } from "./decisionMaker.js";

// Normalize phone numbers — strip everything except digits and leading +
function cleanPhone(phone) {
  if (!phone) return '';
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

  async run(website, callback) {
    if (this.activeWorkers >= this.maxWorkers) {
      return new Promise((resolve) => {
        this.queue.push({ website, callback, resolve });
      });
    }

    this.activeWorkers++;
    try {
      const result = await this.extract(website);
      await callback(result); // await — callback is async (calls extractDecisionMaker)
    } finally {
      this.activeWorkers--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        this.run(next.website, next.callback).then(next.resolve);
      }
    }
  }

  async extract(website) {
    if (!website) return { primary: "", secondary: [], owner: "" };
    
    let emails = [];
    let owner = "";
    const cleanWeb = website.replace(/\/$/, '');
    
    const isValidEmail = (email) => {
        const JUNK_DOMAINS = ['sentry.io', 'wix.com', 'google.com', 'example.com', 'domain.com', 'cloudflare.com', 'amazonaws.com'];
        const JUNK_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.mp4', '.css', '.js'];
        if (!email || email.includes('google.com')) return false;
        if (JUNK_EXTENSIONS.some(ext => email.toLowerCase().endsWith(ext))) return false;
        const domain = email.split('@')[1];
        if (!domain) return false;
        return !JUNK_DOMAINS.some(d => domain.includes(d));
    };

    const extractOwner = (text) => {
        if (owner) return;
        const roles = "CEO|Owner|Founder|Director|President|Principal|Manager|Partner";
        const res = text.match(new RegExp(`([A-Z][a-z]+(?:\\s[A-Z][a-z]+){1,2})\\s*(?:-|,|is the|:)?\\s*(${roles})`, "i")) || 
                    text.match(new RegExp(`(${roles})\\s*(?:-|,|:)?\\s*([A-Z][a-z]+(?:\\s[A-Z][a-z]+){1,2})`, "i"));
        if (res) owner = (res[1].length > res[2].length ? res[1] : res[2]).trim();
    };

    // =========================
    // RAM SAVER: Block images & media, allow fonts & CSS
    // =========================
    const blockRoute = async (page) => {
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        // Block heavy resources but allow scripts/websockets so modern sites don't break and skip
        if (['image', 'media'].includes(type)) {
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
      extractOwner(text);
      
      const found = [...html.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g)]
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
            extractOwner(pText);
            const pHtml = await p.content();
            const pEmails = [
              ...[...pHtml.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g)].map(m => m[0].toLowerCase()),
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
    
    return { primary, secondary: emails.filter(e => e !== primary), owner };
  }
}

async function checkPause(jobId) {
    while (getJob(jobId)?.pauseFlag) {
        await new Promise(r => setTimeout(r, 1000));
    }
}

export async function scrapeGoogleMaps(niche, location, filterType, jobId, mode = 'hybrid', workerCount = 3, onProgress = () => {}) {
  const job = getJob(jobId);
  if (!job) return [];

  const browser = await chromium.launch({ headless: false, args: ['--window-size=1920,1080'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const workerPool = new WebsiteWorkerPool(context, parseInt(workerCount));

  let subLocations = await getSubLocations(location);
  let allLeads = [];

  const processSubLocation = async (subLoc, sIdx) => {
    updateJob(jobId, { lastProcessedIndex: sIdx });
    await checkPause(jobId);
    if (getJob(jobId)?.stopFlag) return;
    const page = await context.newPage();
    
    try {
      const query = `${niche} in ${subLoc}`;
      log(`🚀 Searching: ${query}`, jobId);
      await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded' });
      
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

      await page.waitForSelector('div[role="feed"]', { timeout: 10000 }).catch(() => {});
      
      let noNewCount = 0;
      const processedNames = new Set();
      let lastPaneTitle = "";
      let totalFoundInCity = 0;

      while (noNewCount < 3 && !getJob(jobId)?.stopFlag) {
          const feedLocator = page.locator('div[role="feed"]');
          if (await feedLocator.count() === 0) break; // Check if the feed exists before scrolling
          
          const listings = feedLocator.locator('a[href*="/place"]');
          const batchCount = await listings.count();
          let foundNewInBatch = false;

          for (let i = 0; i < batchCount; i++) {
              await checkPause(jobId);
              if (getJob(jobId)?.stopFlag) break;
              
              let name = "";
              let item;
              try {
                 item = listings.nth(i);
                 name = await item.getAttribute("aria-label");
              } catch { continue; }
              
              if (!name || processedNames.has(name)) continue;
              processedNames.add(name);
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

                  try { await targetItem.scrollIntoViewIfNeeded(); } catch {}
                  
                  try {
                     await targetItem.click({ force: true, timeout: 3000 });
                  } catch {
                     await targetItem.evaluate(node => node.click()).catch(() => {});
                  }

          let paneFound = false;
          for (let attempt = 0; attempt < 15; attempt++) {
              if (attempt === 5 && !paneFound) {
                  // Force a re-click if Google Maps ignored the first virtual click
                  try { await targetItem.evaluate(node => node.click()).catch(() => {}); } catch {}
              }

              const paneTitle = await page.locator('h1.DUwDvf').first().textContent().catch(() => "");
              
              if (paneTitle && paneTitle !== lastPaneTitle) {
                  paneFound = true;
                  lastPaneTitle = paneTitle;
                  break;
              }
              
              const paneLower = paneTitle.toLowerCase().trim();
              const nameLower = name.toLowerCase().trim();
              const nameAnchor = nameLower.split(/\s+/).slice(0, 3).join(' ');
              if (attempt > 4 && paneLower.length > 2 && (nameLower.includes(paneLower) || paneLower.includes(nameLower) || paneLower.includes(nameAnchor))) {
                  paneFound = true;
                  lastPaneTitle = paneTitle;
                  break;
              }
              
              await page.waitForTimeout(400);
          }
          if (!paneFound) {
              log(`⚠️ Timeout loading pane for ${name}, Skipping.`, jobId);
              continue;
          }

          const phone = await page.locator('button[data-item-id^="phone:tel:"]').first().textContent({ timeout: 500 }).catch(() => "");
          const website = await page.locator('a[data-item-id="authority"]').first().getAttribute("href", { timeout: 500 }).catch(() => "");
          const address = await page.locator('button[data-item-id="address"]').first().textContent({ timeout: 500 }).catch(() => "");

          let rating = '';
          let reviews = '';
          try {
            const sidePane = page.locator(`div[role="main"][aria-label="${name.replace(/"/g, '\\"')}"]`).first();
            const ratingBtnLabel = await sidePane
              .locator('button[aria-label*="star"]')
              .first()
              .getAttribute('aria-label', { timeout: 500 })
              .catch(() => '');

            if (ratingBtnLabel) {
              const rMatch = ratingBtnLabel.match(/([\d.]+)\s*star/i);
              const vMatch = ratingBtnLabel.match(/([\d,]+)\s*(?:rating|review)/i);
              if (rMatch) rating  = rMatch[1];
              if (vMatch) reviews = vMatch[1].replace(/,/g, '');
            }

            if (!rating) {
              rating  = (await sidePane.locator('span.MW4etd').first().textContent({ timeout: 500 }).catch(() => '')).trim();
              reviews = (await sidePane.locator('span.UY7F9').first().textContent({ timeout: 500 }).catch(() => '')).replace(/[^\d]/g, '');
            }
          } catch { /* rating is optional, never crash */ }

          if (!phone && !website) {
              log(`⏭️ Skipping ${name} (No Phone/Web)`, jobId);
              continue;
          }

          if (website && website.includes('google.com')) {
               log(`⏭️ Skipping Google Link for ${name}`, jobId);
               continue;
          }

          const lead = {
            business_name: name.trim(),
            phone: cleanPhone(phone),
            website: website || "",
            address: address.trim(),
            rating: rating || "",
            reviews: reviews || "0",
            city: subLoc,
            primary_email: "",
            owner_name: "",
            intent: "LOW"
          };

          if (lead.website) {
            const workerTask = async (data) => {
              let ownerName = data.owner;
              if (!ownerName) {
                ownerName = await extractDecisionMaker(lead.website).catch(() => '');
              }

              if (data.primary || ownerName) {
                const enriched = {
                  ...lead,
                  primary_email: data.primary || lead.primary_email,
                  owner_name: ownerName || lead.owner_name,
                };
                const score = (enriched.website ? 1 : 0) + (enriched.primary_email ? 2 : 0) + (enriched.owner_name ? 1 : 0);
                enriched.intent = score >= 3 ? "HIGH" : score >= 1 ? "MEDIUM" : "LOW";
                
                if (data.primary) log(`📧 Found Email for ${name}: ${data.primary}`, jobId);
                
                updateJob(jobId, { enrichLead: enriched });
              }
            };
            
            if (mode === 'normal') {
              await workerPool.run(lead.website, workerTask);
            } else {
              workerPool.run(lead.website, workerTask);
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
          await feedLocatorNode.evaluate(el => el.scrollTop = el.scrollHeight).catch(() => {});
      }
      await page.waitForTimeout(1000);
    }
    } finally {
      await page.close();
    }
  };

  if (mode === 'parallel') {
      const concurrency = Math.max(1, Math.min(parseInt(workerCount), 5));
      let currentIdx = job.lastProcessedIndex || 0;
      const tasks = Array.from({ length: concurrency }, async () => {
          while (currentIdx < subLocations.length && !getJob(jobId)?.stopFlag) {
              const idx = currentIdx++;
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

  log(`✅ Scan Finished. Total: ${allLeads.length}`, jobId);
  onProgress(100);
  await browser.close();
  return allLeads;
}

// =========================
// CSV ENRICHMENT ENGINE
// =========================
export async function enrichCSVList(leads, jobId, workerCount = 3, onProgress = () => {}) {
  const job = getJob(jobId);
  if (!job) return [];
  
  log(`🚀 Starting Email Enrichment for ${leads.length} leads...`, jobId);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const workerPool = new WebsiteWorkerPool(context, parseInt(workerCount));
  
  let completed = 0;
  
  const batchSize = 100;
  
  await processInBatches(leads, batchSize, async (lead) => {
     if (!lead.website || getJob(jobId)?.stopFlag) {
        completed++;
        return;
     }

     return workerPool.run(lead.website, async (data) => {
        if (getJob(jobId)?.stopFlag) return;
        
        let ownerName = data.owner;
        if (!ownerName) {
           ownerName = await extractDecisionMaker(lead.website).catch(() => '');
        }
        
        const enriched = {
           ...lead,
           primary_email: data.primary || lead.primary_email,
           owner_name: ownerName || lead.owner_name,
        };
        const score = (enriched.website ? 1 : 0) + (enriched.primary_email ? 2 : 0) + (enriched.owner_name ? 1 : 0);
        enriched.intent = score >= 3 ? "HIGH" : score >= 1 ? "MEDIUM" : "LOW";
        
        if (data.primary) log(`📧 Found Email for ${lead.business_name}: ${data.primary}`, jobId);
        
        updateJob(jobId, { enrichLead: enriched });
        
        completed++;
        onProgress({ progress: Math.floor((completed / leads.length) * 100), city: "Enriching Websites" });
     });
  });
  
  log(`✅ Enrichment Complete. Processed: ${completed}`, jobId);
  
  if (!getJob(jobId)?.stopFlag) {
    onProgress(100);
  }
  
  await browser.close();
  return leads;
}
